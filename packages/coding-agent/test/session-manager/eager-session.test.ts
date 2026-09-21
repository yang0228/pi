import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function headerLine(file: string) {
	return JSON.parse(readFileSync(file, "utf-8").split("\n")[0]!);
}

describe("issue #9792 SessionManager eager session files", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-9792-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("writes a valid header during creation", () => {
		const session = SessionManager.create(testDir, testDir, { kind: "eager" });
		const sessionFile = session.getSessionFile()!;

		expect(session.isPersisted()).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
		expect(session.getSessionId()).toMatch(UUID_V7_RE);

		const header = headerLine(sessionFile);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.id).toBe(session.getSessionId());
		expect(header.cwd).toBe(testDir);
	});

	it("still defers the file when no kind is given", () => {
		const session = SessionManager.create(testDir, testDir);

		expect(session.isPersisted()).toBe(true);
		expect(existsSync(session.getSessionFile()!)).toBe(false);
	});

	it("keeps the file a single valid session across appends and reopen", () => {
		const session = SessionManager.create(testDir, testDir, { kind: "eager" });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(userMessage("first question"));

		const lines = readFileSync(sessionFile, "utf-8").trimEnd().split("\n");
		expect(lines.filter((line) => JSON.parse(line).type === "session")).toHaveLength(1);

		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getSessionId()).toBe(session.getSessionId());
		expect(reopened.buildSessionContext().messages.some((message) => message.role === "user")).toBe(true);
	});

	it("keeps the session durable before any assistant turn", () => {
		const session = SessionManager.create(testDir, testDir, { kind: "eager" });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(userMessage("survives without an assistant"));
		session.appendModelChange("anthropic", "claude-sonnet-4-5");

		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getEntries().some((entry) => entry.type === "model_change")).toBe(true);
		expect(reopened.getLeafId()).toBeTruthy();
		expect(reopened.buildSessionContext().messages).toHaveLength(1);
	});

	it("does not write a file for in-memory sessions", () => {
		const session = SessionManager.inMemory(testDir, { kind: "eager" });
		session.newSession({ kind: "eager" });

		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
	});
});
