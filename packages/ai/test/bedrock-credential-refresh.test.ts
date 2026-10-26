import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

let directory: string;
let credentialsFile: string;
const credentialsUsed: Array<{ accessKeyId: string; sessionToken?: string }> = [];
const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-bedrock-credentials-"));
	credentialsFile = join(directory, "credentials");
	const configFile = join(directory, "config");
	await writeFile(configFile, "");
	for (const name of [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_PROFILE",
		"AWS_DEFAULT_PROFILE",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_BEDROCK_SKIP_AUTH",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	]) {
		vi.stubEnv(name, undefined);
	}
	vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
	vi.stubEnv("AWS_CONFIG_FILE", configFile);
	vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
	credentialsUsed.length = 0;
	vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(async function (this: BedrockRuntimeClient) {
		const credentials = await this.config.credentials();
		credentialsUsed.push({ accessKeyId: credentials.accessKeyId, sessionToken: credentials.sessionToken });
		this.destroy();
		return {
			$metadata: {},
			stream: (async function* () {
				yield { messageStop: { stopReason: "end_turn" } };
			})(),
		};
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

describe("Bedrock shared credentials", () => {
	// Regression for #11221: a refreshed credentials file must be read without restarting pi.
	it.each([
		["default profile", "default", {}],
		["explicit profile", "session", { profile: "session" }],
		["scoped profile", "session", { env: { AWS_PROFILE: "session" } }],
	] satisfies Array<[string, string, BedrockOptions]>)(
		"reads rotated session credentials with %s",
		async (_name, profile, options) => {
			const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
			for (const token of ["old-token", "new-token"]) {
				await writeFile(
					credentialsFile,
					`[${profile}]\naws_access_key_id = example\naws_secret_access_key = example\naws_session_token = ${token}\n`,
				);
				const message = await streamBedrock(model, context, { cacheRetention: "none", ...options }).result();
				expect(message.stopReason).toBe("stop");
			}
			expect(credentialsUsed).toEqual([
				{ accessKeyId: "example", sessionToken: "old-token" },
				{ accessKeyId: "example", sessionToken: "new-token" },
			]);
		},
	);

	it("keeps ambient access keys ahead of an ambient profile", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "env-key");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "env-secret");
		vi.stubEnv("AWS_SESSION_TOKEN", "env-token");
		vi.stubEnv("AWS_PROFILE", "missing-profile");
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(message.stopReason).toBe("stop");
		expect(credentialsUsed).toEqual([{ accessKeyId: "env-key", sessionToken: "env-token" }]);
	});

	it("keeps skip-auth usable without AWS credentials", async () => {
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

		const message = await streamBedrock(model, context, {
			cacheRetention: "none",
			env: { AWS_BEDROCK_SKIP_AUTH: "1" },
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(credentialsUsed).toEqual([{ accessKeyId: "dummy-access-key", sessionToken: undefined }]);
	});
});
