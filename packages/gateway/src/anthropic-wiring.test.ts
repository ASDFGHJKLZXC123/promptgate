import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { openDatabase } from "./db/index.js";
import type { ProviderAdapter } from "./providers/types.js";

/**
 * Anthropic phase 2 step 2 wiring, exercised entirely offline (§11) against the
 * real default adapter: the default registry reaches the (stubbed) Anthropic
 * endpoint, an untranslatable client request surfaces as a safe 400 without any
 * fetch, and a malformed upstream 200 surfaces as a safe 502 provider_error that
 * never leaks the upstream body.
 */

const ADMIN_TOKEN = "test-admin-token-000000";
const PROVIDER_KEY_NAMES = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"DEEPSEEK_API_KEY",
] as const;

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../test/fixtures");
const ANTHROPIC_FIXTURE = readFileSync(
	join(FIXTURES_DIR, "anthropic-non-streaming.json"),
	"utf8",
);

interface OpenAIErrorResponse {
	error: { message: string; type: string; code: string };
}

let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;
let previousProviderKeys: Partial<
	Record<(typeof PROVIDER_KEY_NAMES)[number], string>
>;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	previousProviderKeys = {};
	for (const keyName of PROVIDER_KEY_NAMES) {
		const previous = process.env[keyName];
		if (previous !== undefined) {
			previousProviderKeys[keyName] = previous;
		}
		delete process.env[keyName];
	}
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-anthropic-wiring-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (previousDbPath === undefined) {
		delete process.env.DB_PATH;
	} else {
		process.env.DB_PATH = previousDbPath;
	}
	if (previousAdminToken === undefined) {
		delete process.env.ADMIN_TOKEN;
	} else {
		process.env.ADMIN_TOKEN = previousAdminToken;
	}
	for (const keyName of PROVIDER_KEY_NAMES) {
		const previous = previousProviderKeys[keyName];
		if (previous === undefined) {
			delete process.env[keyName];
		} else {
			process.env[keyName] = previous;
		}
	}
	if (tempDbDir) {
		rmSync(tempDbDir, { recursive: true, force: true });
		tempDbDir = undefined;
	}
});

function adminHeaders(): Record<string, string> {
	return { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" };
}

function openTestDb(): Database.Database {
	const dbPath = process.env.DB_PATH;
	if (!dbPath) {
		throw new Error("DB_PATH is not configured");
	}
	return openDatabase(dbPath);
}

function seedAnthropicPricing(db: Database.Database, model: string): void {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES ('anthropic', @model, 3000000, 15000000, '2020-01-01')`,
	).run({ model });
}

async function createClientKey(
	server: Awaited<ReturnType<typeof buildTestServer>>,
): Promise<Record<string, string>> {
	const keyResponse = await server.inject({
		method: "POST",
		url: "/admin/api/keys",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "anthropic-wiring-key" }),
	});
	const { plaintext_key } = keyResponse.json() as { plaintext_key: string };
	return {
		authorization: `Bearer ${plaintext_key}`,
		"content-type": "application/json",
	};
}

async function buildTestServer(options?: {
	adapters?: Partial<Record<"anthropic", ProviderAdapter>>;
}) {
	const { buildServer } = await import("./server.js");
	return buildServer(options);
}

test("default wiring routes a claude-* request through the Anthropic adapter to the stubbed endpoint", async () => {
	process.env.ANTHROPIC_API_KEY = "sk-ant-wiring-test";
	await vi.resetModules();

	const fetchMock = vi.fn(
		async (url: string | URL | Request, _init?: RequestInit) => {
			const href =
				typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (href === "https://api.anthropic.com/v1/messages") {
				return new Response(ANTHROPIC_FIXTURE, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch to ${href}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);

	const server = await buildTestServer();
	const db = openTestDb();

	try {
		seedAnthropicPricing(db, "claude-wiring-test");
		const clientHeaders = await createClientKey(server);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: clientHeaders,
			body: JSON.stringify({
				model: "claude-wiring-test",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			model: string;
			choices: { message: { content: string }; finish_reason: string }[];
			usage: { prompt_tokens: number; completion_tokens: number };
		};
		expect(body.choices[0]?.message.content).toContain(
			"PromptGate contract fixture",
		);
		expect(body.choices[0]?.finish_reason).toBe("stop");
		expect(body.usage).toMatchObject({
			prompt_tokens: 19,
			completion_tokens: 12,
		});
		expect(response.headers["x-pg-cost-usd"]).toBeDefined();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(init.headers).toMatchObject({
			"x-api-key": "sk-ant-wiring-test",
			"anthropic-version": "2023-06-01",
		});
	} finally {
		db.close();
		await server.close();
	}
});

test("the real default adapter maps untranslatable client input to HTTP 400 without any fetch", async () => {
	process.env.ANTHROPIC_API_KEY = "sk-ant-wiring-test";
	await vi.resetModules();

	// Guardrail: an untranslatable request must be rejected before any network call.
	const fetchMock = vi.fn(() => {
		throw new Error("network should not be used");
	});
	vi.stubGlobal("fetch", fetchMock);

	const server = await buildTestServer();
	const db = openTestDb();

	try {
		seedAnthropicPricing(db, "claude-wiring-test");
		const clientHeaders = await createClientKey(server);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: clientHeaders,
			body: JSON.stringify({
				model: "claude-wiring-test",
				messages: [{ role: "user", content: "hi" }],
				// Valid OpenAI, unsupported by Anthropic (Sonnet 5) — a caller error.
				temperature: 0.5,
			}),
		});

		expect(response.statusCode).toBe(400);
		const error = (response.json() as OpenAIErrorResponse).error;
		expect(error.type).toBe("invalid_request_error");
		expect(error.code).toBe("invalid_request_error");
		expect(fetchMock).not.toHaveBeenCalled();
	} finally {
		db.close();
		await server.close();
	}
});

test("the real default adapter maps a malformed upstream 200 to a safe 502 with no body leak", async () => {
	process.env.ANTHROPIC_API_KEY = "sk-ant-wiring-test";
	await vi.resetModules();

	const upstreamSecret = "UPSTREAM-SECRET-LEAK-MARKER";
	const fetchMock = vi.fn(
		async (url: string | URL | Request, _init?: RequestInit) => {
			const href =
				typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (href === "https://api.anthropic.com/v1/messages") {
				// HTTP 200 but a `thinking` block despite the request explicitly
				// disabling thinking, so the strict response contract rejects it.
				return new Response(
					JSON.stringify({
						id: "msg_leak",
						type: "message",
						role: "assistant",
						model: "claude-wiring-test",
						content: [{ type: "thinking", thinking: upstreamSecret }],
						stop_reason: "end_turn",
						usage: { input_tokens: 5, output_tokens: 3 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`unexpected fetch to ${href}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);

	const server = await buildTestServer();
	const db = openTestDb();

	try {
		seedAnthropicPricing(db, "claude-wiring-test");
		const clientHeaders = await createClientKey(server);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: clientHeaders,
			body: JSON.stringify({
				model: "claude-wiring-test",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(response.statusCode).toBe(502);
		const error = (response.json() as OpenAIErrorResponse).error;
		expect(error.code).toBe("provider_error");
		expect(error.type).toBe("server_error");
		// The upstream body must never reach the client.
		expect(response.payload).not.toContain(upstreamSecret);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	} finally {
		db.close();
		await server.close();
	}
});
