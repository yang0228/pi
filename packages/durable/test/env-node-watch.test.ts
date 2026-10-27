import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange } from "../src/env/index.ts";
import { NodeFileWatcher } from "../src/env/node-watch.ts";

type NativeWatch = {
	listener: Fs.WatchListener<string>;
	closed: boolean;
	close: () => void;
	error?: () => void;
};

const native = vi.hoisted(() => ({ watches: new Map<string, NativeWatch[]>() }));

// Inject native events so a dead handle cannot be rescued by an ancestor's OS event.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		watch: (path: string, _options: Fs.WatchOptions, listener: Fs.WatchListener<string>) => {
			const installed: NativeWatch = {
				listener,
				closed: false,
				close: () => {
					installed.closed = true;
				},
			};
			native.watches.set(path, [...(native.watches.get(path) ?? []), installed]);
			return {
				close: installed.close,
				on(event: string, listener: () => void) {
					if (event === "error") installed.error = listener;
					return this;
				},
			};
		},
	};
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const watchers: NodeFileWatcher[] = [];

beforeEach(() => {
	Object.defineProperty(process, "platform", { ...platform, value: "linux" });
});

afterEach(async () => {
	for (const watcher of watchers.splice(0)) await watcher.close(BACKGROUND_CONTEXT);
	native.watches.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	Object.defineProperty(process, "platform", platform);
});

async function open(): Promise<{ directory: string; changes: FileChange[] }> {
	const root = mkdtempSync(join(tmpdir(), "pi-durable-watch-"));
	roots.push(root);
	const directory = join(root, "a");
	mkdirSync(directory);
	const changes: FileChange[] = [];
	watchers.push(
		await NodeFileWatcher.open(
			[{ path: directory, recursive: true }],
			(path) => path,
			(change) => changes.push(change),
			{
				mode: "native",
			},
		),
	);
	return { directory, changes };
}

function paths(changes: FileChange[]): string[] {
	return changes.flatMap((change) => ("paths" in change ? change.paths : []));
}

function emit(directory: string, event: Fs.WatchEventType, filename: string): void {
	for (const record of native.watches.get(directory) ?? []) {
		if (!record.closed) record.listener(event, filename);
	}
}

describe("NodeFileWatcher native watch recovery", () => {
	// #11342: a shared mount can drop a watch while the directory keeps its identity.
	it("reports later writes after a self-rename invalidates a watch without replacing its directory", async () => {
		const { directory, changes } = await open();
		const dropped = native.watches.get(directory)![0];
		dropped.close();
		dropped.listener("rename", "a");
		await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));

		const file = join(directory, "y.md");
		writeFileSync(file, "new");
		emit(directory, "change", "y.md");
		await vi.waitFor(() => expect(paths(changes)).toContain(file));
		expect(paths(changes)).toContain(directory);
		expect(paths(changes)).not.toContain(join(directory, "a"));
	});

	it("keeps coverage when a closed watch delivers a late self-rename or error", async () => {
		const { directory, changes } = await open();
		const dropped = native.watches.get(directory)![0];
		dropped.close();
		dropped.listener("rename", "a");
		await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
		dropped.listener("rename", "a");
		dropped.error!();

		const file = join(directory, "later.md");
		writeFileSync(file, "later");
		emit(directory, "change", "later.md");
		await vi.waitFor(() => expect(paths(changes)).toContain(file));
		expect(native.watches.get(directory)).toHaveLength(2);
	});

	it("does not reinstall watches for an ordinary child rename", async () => {
		const { directory, changes } = await open();
		const file = join(directory, "child.md");
		writeFileSync(file, "child");
		emit(directory, "rename", "child.md");
		await vi.waitFor(() => expect(paths(changes)).toContain(file));
		expect(native.watches.get(directory)).toHaveLength(1);
	});

	it("preserves coverage of a child with the watched directory's name", async () => {
		const { directory, changes } = await open();
		const child = join(directory, "a");
		mkdirSync(child);
		emit(directory, "rename", "a");
		await vi.waitFor(() => expect(paths(changes)).toContain(child));

		const file = join(child, "child.md");
		writeFileSync(file, "child");
		emit(child, "change", "child.md");
		await vi.waitFor(() => expect(paths(changes)).toContain(file));
		expect(native.watches.get(directory)).toHaveLength(2);
	});
});
