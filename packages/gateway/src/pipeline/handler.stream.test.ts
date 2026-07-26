import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { StreamContractError } from "../providers/provider-error.js";
import type { RetryFetchDeps } from "../providers/retry.js";
import { parseSseData } from "../providers/sse-parse.js";
import type {
	ProviderAdapter,
	ProviderName,
	SseChunk,
} from "../providers/types.js";

interface OpenAIErrorResponse {
	error: { message: string; type: string; code: string };
}

interface RequestsRow {
	provider: string;
	model: string;
	streamed: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: number;
	first_token_ms: number | null;
	total_ms: number | null;
	status: string;
	error_code: string | null;
}

const ADMIN_TOKEN = "test-admin-token-000000";
const PLAINTEXT_KEY = "pg-test-stream-key";
const KEY_HASH = createHash("sha256").update(PLAINTEXT_KEY).digest("hex");
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-stream-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();
});

afterEach(() => {
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
	if (tempDbDir) {
		rmSync(tempDbDir, { recursive: true, force: true });
		tempDbDir = undefined;
	}
});

function openTestDb(): Database.Database {
	const dbPath = process.env.DB_PATH;
	if (!dbPath) {
		throw new Error("DB_PATH is not configured");
	}
	const db = openDatabase(dbPath);
	migrate(db);
	return db;
}

function seedApiKey(db: Database.Database): void {
	db.prepare(
		`INSERT INTO api_keys (name, key_hash, disabled) VALUES (@name, @key_hash, 0)`,
	).run({ name: "stream-test-key", key_hash: KEY_HASH });
}

function seedPricing(
	db: Database.Database,
	model: string,
	inputRate: number,
	outputRate: number,
	options: { provider?: ProviderName; cachedInputRate?: number } = {},
): void {
	db.prepare(
		`INSERT INTO model_pricing (
			provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from
		) VALUES (@provider, @model, @input_rate, @cached_input_rate, @output_rate, '2020-01-01')`,
	).run({
		provider: options.provider ?? "openai",
		model,
		input_rate: inputRate,
		cached_input_rate: options.cachedInputRate ?? null,
		output_rate: outputRate,
	});
}

const CHUNK_BASE = {
	id: "c",
	object: "chat.completion.chunk",
	created: 1,
	model: "m",
};
function frame(obj: unknown): SseChunk {
	return { data: JSON.stringify(obj), done: false };
}
const DONE: SseChunk = { data: "[DONE]", done: true };
function roleFrame(): SseChunk {
	return frame({
		...CHUNK_BASE,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: "" },
				finish_reason: null,
			},
		],
		usage: null,
	});
}
function contentFrame(text: string): SseChunk {
	return frame({
		...CHUNK_BASE,
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		usage: null,
	});
}
function reasoningFrame(text: string): SseChunk {
	return frame({
		...CHUNK_BASE,
		choices: [
			{ index: 0, delta: { reasoning_content: text }, finish_reason: null },
		],
		usage: null,
	});
}
function usageFrame(usage: Record<string, number>): SseChunk {
	return frame({ ...CHUNK_BASE, choices: [], usage });
}

function fakeStreamAdapter(
	chunks: SseChunk[],
	name: ProviderName = "openai",
): ProviderAdapter {
	return {
		name,
		async complete(): Promise<ChatResponse> {
			throw new Error("complete() must not be called for a streaming request");
		},
		async *stream(
			_req: ChatRequest,
			_signal: AbortSignal,
		): AsyncIterable<SseChunk> {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

async function buildTestServer(
	adapters: Partial<Record<ProviderName, ProviderAdapter>>,
	now?: () => number,
): Promise<FastifyInstance> {
	const { buildServer } = await import("../server.js");
	return buildServer({ adapters, now });
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encode(text));
			controller.close();
		},
	});
}

function sseResponse(
	text: string,
	contentType = "text/event-stream",
): Response {
	return new Response(streamFromString(text), {
		status: 200,
		headers: { "content-type": contentType },
	});
}

function noRetryDeps(fetch: RetryFetchDeps["fetch"]): RetryFetchDeps {
	return { fetch, sleep: () => Promise.resolve(), random: () => 0 };
}

/** Builds a server wired to the REAL OpenAI-compatible adapter over a fake fetch. */
async function serverWithRealOpenAi(
	fetch: RetryFetchDeps["fetch"],
	now?: () => number,
): Promise<FastifyInstance> {
	const { createOpenAiAdapter } = await import("../providers/openai.js");
	const { buildServer } = await import("../server.js");
	return buildServer({
		adapters: {
			openai: createOpenAiAdapter({
				apiKey: "sk-test",
				retryDeps: noRetryDeps(fetch),
			}),
		},
		now,
	});
}

/** Reparses the SSE bytes a client received, reconstructing each logical payload. */
async function parseClientSse(payload: string): Promise<string[]> {
	const out: string[] = [];
	for await (const p of parseSseData(streamFromString(payload), {
		pendingSentinel: "[DONE]",
	})) {
		out.push(p);
	}
	return out;
}

/** A deterministic clock: returns each scripted value once, then holds the last. */
function scriptedClock(values: number[]): () => number {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)] as number;
}

/** Raw SSE transcript text (single-`data:`-line events), `[DONE]` appended by default. */
function sseText(objs: unknown[], opts: { done?: boolean } = {}): string {
	const lines = objs.map((o) => `data: ${JSON.stringify(o)}`);
	if (opts.done !== false) {
		lines.push("data: [DONE]");
	}
	return `${lines.join("\n\n")}\n`;
}

const ROLE_OBJ = {
	...CHUNK_BASE,
	choices: [
		{
			index: 0,
			delta: { role: "assistant", content: "" },
			finish_reason: null,
		},
	],
	usage: null,
};
function contentObj(text: string): unknown {
	return {
		...CHUNK_BASE,
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		usage: null,
	};
}
function usageObj(usage: Record<string, number>): unknown {
	return { ...CHUNK_BASE, choices: [], usage };
}

function authHeaders(): Record<string, string> {
	return {
		authorization: `Bearer ${PLAINTEXT_KEY}`,
		"content-type": "application/json",
	};
}

function streamBody(model: string): string {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: "say hi" }],
		stream: true,
	});
}

/**
 * Bounded polling for the post-response `requests` row (blocker 6): the row is
 * written in the route's `onResponse` hook, so we poll until it lands rather
 * than sleeping a fixed interval. Returns as soon as it appears; throws if it
 * never does, so a missing row fails loudly instead of returning undefined.
 */
async function readRow(
	db: Database.Database,
	requestId: string,
): Promise<RequestsRow> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const row = db
			.prepare("SELECT * FROM requests WHERE request_id = ?")
			.get(requestId) as RequestsRow | undefined;
		if (row) {
			return row;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`requests row for ${requestId} was not persisted in time`);
}

describe("POST /v1/chat/completions — streaming success", () => {
	test("streams frames, sets SSE headers, omits x-pg-cost-usd, and persists a streamed row", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		const adapter = fakeStreamAdapter([
			roleFrame(),
			contentFrame("Hello"),
			usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
			DONE,
		]);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/event-stream");
			expect(response.headers["x-pg-cache"]).toBe("miss");
			expect(response.headers["x-pg-request-id"]).toMatch(UUID_RE);
			// A live stream never carries the cost header (§5.1).
			expect(response.headers["x-pg-cost-usd"]).toBeUndefined();
			expect(response.payload).toContain('data: {"id":"c"');
			expect(response.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);

			const requestId = response.headers["x-pg-request-id"] as string;
			const row = await readRow(db, requestId);
			expect(row.streamed).toBe(1);
			expect(row.provider).toBe("openai");
			expect(row.status).toBe("ok");
			expect(row.input_tokens).toBe(10);
			expect(row.output_tokens).toBe(5);
			// round(10*1e6/1e6) + round(5*2e6/1e6) = 10 + 10 = 20
			expect(row.cost_micro_usd).toBe(20);
			expect(row.cost_estimated).toBe(0);
			expect(row.first_token_ms).not.toBeNull();
			expect(row.first_token_ms as number).toBeLessThan(row.total_ms as number);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("meters Gemini hidden-thinking output from the terminal usage chunk", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gemini-2.5-flash", 300_000, 2_500_000, {
			provider: "gemini",
			cachedInputRate: 30_000,
		});
		const adapter = fakeStreamAdapter(
			[
				roleFrame(),
				contentFrame("hi"),
				frame({
					...CHUNK_BASE,
					choices: [],
					usage: {
						prompt_tokens: 1_000,
						completion_tokens: 10,
						total_tokens: 1_013,
						prompt_tokens_details: { cached_tokens: 400 },
					},
				}),
				DONE,
			],
			"gemini",
		);
		const server = await buildTestServer({ gemini: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gemini-2.5-flash"),
			});

			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.input_tokens).toBe(1_000);
			// output = total - prompt = 13 (candidates + hidden thinking)
			expect(row.output_tokens).toBe(13);
			// 400 cached @0.03 + 600 miss @0.30 + 13 @2.50 => 12 + 180 + 33 = 225
			expect(row.cost_micro_usd).toBe(225);
			expect(row.status).toBe("ok");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("meters DeepSeek cache-hit/cache-miss split from the terminal usage chunk", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "deepseek-stream", 140_000, 280_000, {
			provider: "deepseek",
			cachedInputRate: 2_800,
		});
		const adapter = fakeStreamAdapter(
			[
				roleFrame(),
				reasoningFrame("thinking out loud"),
				contentFrame("Hello"),
				frame({
					...CHUNK_BASE,
					choices: [],
					usage: {
						prompt_tokens: 3_000,
						completion_tokens: 500,
						total_tokens: 3_500,
						prompt_cache_hit_tokens: 1_000,
						prompt_cache_miss_tokens: 2_000,
					},
				}),
				DONE,
			],
			"deepseek",
		);
		const server = await buildTestServer({ deepseek: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("deepseek-stream"),
			});

			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.input_tokens).toBe(3_000);
			expect(row.output_tokens).toBe(500);
			// round(1000*2800/1e6)=3, round(2000*140000/1e6)=280, round(500*280000/1e6)=140 => 423
			expect(row.cost_micro_usd).toBe(423);
			expect(row.status).toBe("ok");
			expect(row.first_token_ms).not.toBeNull();
		} finally {
			await server.close();
			db.close();
		}
	});

	test("first_token_ms stays null when the model emits only role and reasoning deltas", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "deepseek-stream", 140_000, 280_000, {
			provider: "deepseek",
		});
		const adapter = fakeStreamAdapter(
			[
				roleFrame(),
				reasoningFrame("only thinking, no visible content"),
				usageFrame({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
				DONE,
			],
			"deepseek",
		);
		const server = await buildTestServer({ deepseek: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("deepseek-stream"),
			});

			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("ok");
			expect(row.first_token_ms).toBeNull();
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — streaming error paths", () => {
	test("a configured Anthropic streaming request is a safe 501, never a crash", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "claude-stream", 1_000_000, 2_000_000, {
			provider: "anthropic",
		});
		// Import through the same (post-resetModules) graph as the server so the
		// StreamNotImplementedError identity matches the handler's check.
		const { createAnthropicAdapter } = await import(
			"../providers/anthropic.js"
		);
		const server = await buildTestServer({
			anthropic: createAnthropicAdapter({ apiKey: "sk-ant-test-key" }),
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("claude-stream"),
			});

			expect(response.statusCode).toBe(501);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("rejected_stream_unsupported");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("a missing provider key at stream start maps to a 503 JSON envelope (headers not yet sent)", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		// The real adapter with an unconfigured key throws ProviderConfigError on
		// first iteration, before any fetch — exactly the missing-key path.
		const { createOpenAiAdapter } = await import("../providers/openai.js");
		const server = await buildTestServer({
			openai: createOpenAiAdapter({ apiKey: undefined }),
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});

			expect(response.statusCode).toBe(503);
			expect(response.headers["content-type"]).toContain("application/json");
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("a contract violation after headers closes the stream (no [DONE]) and logs provider_error", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			async *stream(): AsyncIterable<SseChunk> {
				yield roleFrame();
				yield contentFrame("Hello");
				throw new StreamContractError("openai", "boom after headers");
			},
		};
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});

			// Headers were already committed: 200 + event-stream, but the client
			// gets the good frames and NO terminal [DONE].
			expect(response.statusCode).toBe(200);
			expect(response.payload).toContain("Hello");
			expect(response.payload).not.toContain("[DONE]");
			expect(response.payload).not.toContain("boom after headers");

			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.streamed).toBe(1);
			expect(row.status).toBe("provider_error");
			expect(row.error_code).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — streaming forwards before upstream close", () => {
	test("delivers content frames to the client before the upstream produces the terminal chunk", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);

		let releaseTerminal: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseTerminal = resolve;
		});
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			async *stream(): AsyncIterable<SseChunk> {
				yield roleFrame();
				yield contentFrame("Hello");
				await gate; // block before the terminal usage chunk
				yield usageFrame({
					prompt_tokens: 4,
					completion_tokens: 1,
					total_tokens: 5,
				});
				yield DONE;
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });

		try {
			const response = await fetch(`${address}/v1/chat/completions`, {
				method: "POST",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});
			expect(response.status).toBe(200);
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let received = "";
			while (!received.includes("Hello")) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				received += decoder.decode(value, { stream: true });
			}
			// The content frame arrived while the generator is still gated before
			// the terminal chunk — proof the pipeline forwards without buffering.
			expect(received).toContain("Hello");
			expect(received).not.toContain("[DONE]");

			releaseTerminal?.();
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				received += decoder.decode(value, { stream: true });
			}
			expect(received).toContain("[DONE]");

			const requestId = response.headers.get("x-pg-request-id");
			expect(requestId).toMatch(UUID_RE);
			const row = await readRow(db, requestId ?? "");
			expect(row.streamed).toBe(1);
			expect(row.status).toBe("ok");
			expect(row.first_token_ms as number).toBeLessThan(row.total_ms as number);
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — deterministic streaming latency (blocker 3)", () => {
	test("guarantees first_token_ms < total_ms even when both fall in the same millisecond", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		const adapter = fakeStreamAdapter([
			roleFrame(),
			contentFrame("Hello"),
			usageFrame({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
			DONE,
		]);
		// A clock frozen at one instant: start, first token, and end all coincide.
		const server = await buildTestServer({ openai: adapter }, () => 5_000);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});
			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.first_token_ms).toBe(0);
			expect(row.total_ms).toBe(1);
			expect(row.first_token_ms as number).toBeLessThan(row.total_ms as number);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("records true integer-millisecond deltas under a normal monotonic clock", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		const adapter = fakeStreamAdapter([
			roleFrame(),
			contentFrame("Hello"),
			usageFrame({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
			DONE,
		]);
		// start = 1000, first content = 1007, end = 1030 → 7 ms and 30 ms.
		const server = await buildTestServer(
			{ openai: adapter },
			scriptedClock([1_000, 1_007, 1_030]),
		);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});
			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.first_token_ms).toBe(7);
			expect(row.total_ms).toBe(30);
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — multi-line payload reframing (blocker 1)", () => {
	test("reframes an embedded-newline payload so the client reconstructs it exactly", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		// A valid chunk JSON with a newline inserted between two tokens.
		const multiline = JSON.stringify(contentObj("hi")).replace(
			'],"usage"',
			']\n,"usage"',
		);
		expect(multiline).toContain("\n"); // guard: the payload really is multi-line
		const adapter = fakeStreamAdapter([
			{ data: multiline, done: false },
			usageFrame({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
			DONE,
		]);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});
			expect(response.statusCode).toBe(200);
			// The embedded newline became its own data: line (not one prefix around
			// a newline-bearing payload).
			expect(response.payload).toMatch(/data: [^\n]*\ndata: /);
			// A standards-compliant reparse reconstructs the exact original payload.
			const payloads = await parseClientSse(response.payload);
			expect(payloads[0]).toBe(multiline);
			expect(payloads.at(-1)).toBe("[DONE]");

			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("ok");
			expect(row.first_token_ms).not.toBeNull();
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — terminal ordering end-to-end (blocker 2)", () => {
	test("content after the terminal usage chunk fails the exchange, no [DONE] to the client", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-order-a", 1_000_000, 2_000_000);
		const transcript = sseText([
			ROLE_OBJ,
			usageObj({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
			contentObj("late"),
		]);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const server = await serverWithRealOpenAi(fetch);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-order-a"),
			});
			expect(response.statusCode).toBe(200); // headers committed on the role chunk
			expect(response.payload).not.toContain("[DONE]");
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("a data frame after [DONE] fails the exchange, and the client never receives [DONE]", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-order-b", 1_000_000, 2_000_000);
		// [DONE] and the trailing frame are both blank-line terminated (dispatched).
		const transcript = `data: ${JSON.stringify(ROLE_OBJ)}\n\ndata: ${JSON.stringify(
			usageObj({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
		)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(contentObj("after"))}\n\n`;
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const server = await serverWithRealOpenAi(fetch);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-order-b"),
			});
			expect(response.statusCode).toBe(200);
			// [DONE] was buffered pending clean EOF and never emitted once a later
			// frame appeared — the client must not see [DONE] then a failed row.
			expect(response.payload).not.toContain("[DONE]");
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — first-token across choices (blocker 4)", () => {
	test("records first_token_ms from a later choice's visible content", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		// choices[0] has empty content; only choices[1] carries the first token.
		const laterChoice = frame({
			...CHUNK_BASE,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "" },
					finish_reason: null,
				},
				{ index: 1, delta: { content: "later" }, finish_reason: null },
			],
			usage: null,
		});
		const adapter = fakeStreamAdapter([
			laterChoice,
			usageFrame({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
			DONE,
		]);
		const server = await buildTestServer(
			{ openai: adapter },
			scriptedClock([1_000, 1_004, 1_012]),
		);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream"),
			});
			expect(response.statusCode).toBe(200);
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			// Without inspecting every choice this would be null (choices[0] empty).
			expect(row.first_token_ms).toBe(4);
			expect(row.status).toBe("ok");
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — content-type guard end-to-end (blocker 7)", () => {
	test("a wrong-MIME 200 fails as a safe pre-header provider error with no body leak", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-mime", 1_000_000, 2_000_000);
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					JSON.stringify({ error: { message: "leak-me-route" } }),
					"application/json",
				),
			);
		const server = await serverWithRealOpenAi(fetch);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-mime"),
			});
			// Pre-header failure → a JSON envelope, never a committed event-stream.
			expect(response.statusCode).toBe(502);
			expect(response.headers["content-type"]).toContain("application/json");
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
			expect(response.payload).not.toContain("leak-me-route");
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.status).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});
});
