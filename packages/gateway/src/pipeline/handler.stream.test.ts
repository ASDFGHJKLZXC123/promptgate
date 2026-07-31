import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import { cacheKeyOf } from "./cache-key.js";

interface OpenAIErrorResponse {
	error: { message: string; type: string; code: string };
}

interface RequestsRow {
	provider: string;
	model: string;
	cache_hit: number;
	streamed: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: number;
	cache_saved_micro_usd: number | null;
	cache_saved_estimated: number | null;
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
let previousUpstreamTimeout: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	previousUpstreamTimeout = process.env.UPSTREAM_TIMEOUT_MS;
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
	if (previousUpstreamTimeout === undefined) {
		delete process.env.UPSTREAM_TIMEOUT_MS;
	} else {
		process.env.UPSTREAM_TIMEOUT_MS = previousUpstreamTimeout;
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

function seedApiKey(
	db: Database.Database,
	options: { budgetMicroUsdMonth?: number } = {},
): void {
	db.prepare(
		`INSERT INTO api_keys (
			name, key_hash, budget_micro_usd_month, disabled
		) VALUES (@name, @key_hash, @budget_micro_usd_month, 0)`,
	).run({
		name: "stream-test-key",
		key_hash: KEY_HASH,
		budget_micro_usd_month: options.budgetMicroUsdMonth ?? 10_000_000,
	});
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
function finishFrame(reason = "stop"): SseChunk {
	return frame({
		...CHUNK_BASE,
		choices: [{ index: 0, delta: {}, finish_reason: reason }],
		usage: null,
	});
}
function multiChoiceContentFrame(texts: string[]): SseChunk {
	return frame({
		...CHUNK_BASE,
		choices: texts.map((text, index) => ({
			index,
			delta: { content: text },
			finish_reason: null,
		})),
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

/** Builds a server wired to the REAL Anthropic adapter over a fake fetch. */
async function serverWithRealAnthropic(
	fetch: RetryFetchDeps["fetch"],
	now?: () => number,
): Promise<FastifyInstance> {
	const { createAnthropicAdapter } = await import("../providers/anthropic.js");
	const { buildServer } = await import("../server.js");
	return buildServer({
		adapters: {
			anthropic: createAnthropicAdapter({
				apiKey: "sk-ant-test",
				defaultMaxTokens: 512,
				retryDeps: noRetryDeps(fetch),
			}),
		},
		now,
	});
}

const ANTHROPIC_STREAM_FIXTURE = readFileSync(
	join(import.meta.dirname, "../../test/fixtures/anthropic-streaming.txt"),
	"utf8",
);

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

function seedStreamingCacheEntry(
	db: Database.Database,
	request: ChatRequest,
	response: ChatResponse,
): void {
	if (!response.usage) {
		throw new Error("Streaming cache fixture requires usage.");
	}
	db.prepare(
		`INSERT INTO cache_entries (
			hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at
		) VALUES (?, ?, ?, ?, ?, '2999-01-01 00:00:00')`,
	).run(
		cacheKeyOf(request),
		request.model,
		JSON.stringify(response),
		JSON.stringify(response.usage),
		9,
	);
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

async function readOnlyRowForModel(
	db: Database.Database,
	model: string,
): Promise<RequestsRow> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const rows = db
			.prepare("SELECT * FROM requests WHERE model = ? ORDER BY id ASC")
			.all(model) as RequestsRow[];
		if (rows.length === 1) {
			return rows[0] as RequestsRow;
		}
		if (rows.length > 1) {
			throw new Error(`more than one requests row was persisted for ${model}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`requests row for ${model} was not persisted in time`);
}

interface BufferedResponseGate {
	closed: Promise<void>;
	release: () => void;
}

function installBufferedResponseGate(
	server: FastifyInstance,
): BufferedResponseGate[] {
	const gates: BufferedResponseGate[] = [];
	server.addHook("onSend", async (request, reply, payload) => {
		if (request.headers["x-test-gate-buffered-response"] !== "1") {
			return payload;
		}
		if (payload instanceof Readable) {
			throw new Error("expected a buffered response payload");
		}
		const bytes = Buffer.isBuffer(payload)
			? payload
			: Buffer.from(String(payload), "utf8");
		let releaseResponse: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let didRelease = false;
		const gate: BufferedResponseGate = {
			closed: new Promise((resolve) => reply.raw.once("close", resolve)),
			release: () => {
				if (!didRelease) {
					didRelease = true;
					releaseResponse?.();
				}
			},
		};
		gates.push(gate);
		reply.removeHeader("content-length");
		return Readable.from(
			(async function* gateResponse() {
				yield bytes.subarray(0, 1);
				await released;
				yield bytes.subarray(1);
			})(),
		);
	});
	return gates;
}

async function resetGatedBufferedResponse(
	address: string,
	body: string,
	gates: BufferedResponseGate[],
): Promise<{ requestId: string; release: () => void }> {
	return await new Promise((resolve, reject) => {
		const client = httpRequest(
			`${address}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					...authHeaders(),
					"content-length": Buffer.byteLength(body),
					"x-test-gate-buffered-response": "1",
				},
			},
			(response) => {
				const requestId = response.headers["x-pg-request-id"];
				if (typeof requestId !== "string") {
					reject(new Error("missing request id"));
					return;
				}
				response.once("data", () => {
					const gate = gates.shift();
					if (!gate) {
						reject(new Error("buffered response gate was not installed"));
						return;
					}
					client.destroy();
					void gate.closed.then(
						() => resolve({ requestId, release: gate.release }),
						reject,
					);
				});
			},
		);
		client.on("error", (error: Error) => {
			if (error.message !== "socket hang up") {
				reject(error);
			}
		});
		client.end(body);
	});
}

describe("POST /v1/chat/completions — non-streaming client abort", () => {
	test("aborts a pending upstream after a complete loopback POST, logs once, and reconciles its reservation", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 6 });
		seedPricing(db, "gpt-nonstream-abort", 1_000_000, 2_000_000);
		let completeCalls = 0;
		let markFirstStarted: (() => void) | undefined;
		let rejectFirst: ((reason?: unknown) => void) | undefined;
		let markFirstAborted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstAborted = new Promise<void>((resolve) => {
			markFirstAborted = resolve;
		});
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(
				_req: ChatRequest,
				signal: AbortSignal,
			): Promise<ChatResponse> {
				completeCalls += 1;
				if (completeCalls === 1) {
					markFirstStarted?.();
					return new Promise<ChatResponse>((_resolve, reject) => {
						rejectFirst = reject;
						signal.addEventListener(
							"abort",
							() => {
								markFirstAborted?.();
								reject(signal.reason);
							},
							{ once: true },
						);
					});
				}
				return {
					id: "chatcmpl-after-abort",
					object: "chat.completion",
					created: 0,
					model: "gpt-nonstream-abort",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					},
				};
			},
			stream(): AsyncIterable<SseChunk> {
				throw new Error("unused");
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-nonstream-abort",
			messages: [{ role: "user", content: "12345678" }],
			max_tokens: 1,
			pg_no_cache: true,
		});

		try {
			let responseStarted = false;
			const client = httpRequest(
				`${address}/v1/chat/completions`,
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-length": Buffer.byteLength(body),
					},
				},
				(response) => {
					responseStarted = true;
					response.destroy();
				},
			);
			client.on("error", () => undefined);
			client.end(body);
			await firstStarted;
			client.destroy();

			const abortObserved = await Promise.race([
				firstAborted.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
			]);
			expect(abortObserved).toBe(true);
			expect(responseStarted).toBe(false);

			const row = await readOnlyRowForModel(db, "gpt-nonstream-abort");
			expect(row.streamed).toBe(0);
			expect(row.status).toBe("client_aborted");
			expect(row.error_code).toBeNull();
			expect(row.input_tokens).toBe(2);
			expect(row.output_tokens).toBe(0);
			expect(row.cost_micro_usd).toBe(2);
			expect(row.cost_estimated).toBe(1);
			expect(
				db.prepare("SELECT count(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				db
					.prepare("SELECT count(*) AS count FROM requests WHERE model = ?")
					.get("gpt-nonstream-abort"),
			).toEqual({ count: 1 });

			// The first reservation was released only after its durable estimated-cost
			// row. With a $0.000006 cap, a leaked reservation would reject this call.
			const afterAbort = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterAbort.statusCode).toBe(200);
			expect(completeCalls).toBe(2);
		} finally {
			rejectFirst?.(new Error("test cleanup"));
			await server.close();
			db.close();
		}
	});

	test("keeps timeout as the first cause when the client disconnects before the adapter rejects", async () => {
		process.env.UPSTREAM_TIMEOUT_MS = "20";
		await vi.resetModules();
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-timeout-before-reset", 1_000_000, 2_000_000);
		let completeCalls = 0;
		let markFirstStarted: (() => void) | undefined;
		let markTimeoutAbort: (() => void) | undefined;
		let rejectTimedOutCall: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const timeoutAbort = new Promise<void>((resolve) => {
			markTimeoutAbort = resolve;
		});
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(
				_req: ChatRequest,
				signal: AbortSignal,
			): Promise<ChatResponse> {
				completeCalls += 1;
				if (completeCalls === 1) {
					markFirstStarted?.();
					return new Promise<ChatResponse>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								markTimeoutAbort?.();
								rejectTimedOutCall = () => reject(signal.reason);
							},
							{ once: true },
						);
					});
				}
				return {
					id: "chatcmpl-after-timeout-reset",
					object: "chat.completion",
					created: 0,
					model: "gpt-timeout-before-reset",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					},
				};
			},
			stream(): AsyncIterable<SseChunk> {
				throw new Error("unused");
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-timeout-before-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
			pg_no_cache: true,
		});

		try {
			let responseStarted = false;
			const client = httpRequest(
				`${address}/v1/chat/completions`,
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-length": Buffer.byteLength(body),
					},
				},
				(response) => {
					responseStarted = true;
					response.destroy();
				},
			);
			client.on("error", () => undefined);
			client.end(body);
			await firstStarted;
			await timeoutAbort;
			client.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
			rejectTimedOutCall?.();

			const row = await readOnlyRowForModel(db, "gpt-timeout-before-reset");
			expect(responseStarted).toBe(false);
			expect(row).toMatchObject({
				streamed: 0,
				cache_hit: 0,
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: null,
				output_tokens: null,
				cost_micro_usd: null,
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM requests WHERE model = ?")
					.get("gpt-timeout-before-reset"),
			).toEqual({ count: 1 });

			// A leaked three-micro-USD timeout reservation would reject this call.
			const afterTimeout = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterTimeout.statusCode).toBe(200);
			expect(completeCalls).toBe(2);
		} finally {
			rejectTimedOutCall?.();
			await server.close();
			db.close();
		}
	});

	test("keeps the abort fallback armed after the adapter settles and while the buffered response flushes", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-buffered-flush-reset", 1_000_000, 2_000_000);
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				return {
					id: "chatcmpl-buffered-flush-reset",
					object: "chat.completion",
					created: 0,
					model: "gpt-buffered-flush-reset",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "buffered" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 3,
						completion_tokens: 5,
						total_tokens: 8,
					},
				};
			},
			stream(): AsyncIterable<SseChunk> {
				throw new Error("unused");
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const gates = installBufferedResponseGate(server);
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-buffered-flush-reset",
			messages: [{ role: "user", content: "hello" }],
			pg_no_cache: true,
		});

		try {
			const { requestId, release } = await resetGatedBufferedResponse(
				address,
				body,
				gates,
			);
			release();
			const row = await readRow(db, requestId);
			expect(row).toMatchObject({
				streamed: 0,
				cache_hit: 0,
				status: "client_aborted",
				error_code: null,
				input_tokens: 3,
				output_tokens: 5,
				cost_micro_usd: 13,
				cost_estimated: 0,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM requests").get(),
			).toEqual({ count: 1 });
		} finally {
			for (const gate of gates) {
				gate.release();
			}
			await server.close();
			db.close();
		}
	});

	test("logs a reset buffered cache hit once and releases its reservation", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-buffered-cache-reset", 1_000_000, 2_000_000);
		const request: ChatRequest = {
			model: "gpt-buffered-cache-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
		};
		seedStreamingCacheEntry(db, request, {
			id: "chatcmpl-buffered-cache-reset",
			object: "chat.completion",
			created: 0,
			model: request.model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "cached" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		const server = await buildTestServer({});
		const gates = installBufferedResponseGate(server);
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify(request);

		try {
			const { requestId, release } = await resetGatedBufferedResponse(
				address,
				body,
				gates,
			);
			release();
			const row = await readRow(db, requestId);
			expect(row).toMatchObject({
				streamed: 0,
				cache_hit: 1,
				status: "client_aborted",
				error_code: null,
				input_tokens: 1,
				output_tokens: 1,
				cost_micro_usd: 0,
				cost_estimated: 0,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM requests").get(),
			).toEqual({ count: 1 });

			// A leaked three-micro-USD reservation would reject this equal-budget hit.
			const afterReset = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterReset.statusCode).toBe(200);
			expect(afterReset.headers["x-pg-cache"]).toBe("hit");
		} finally {
			for (const gate of gates) {
				gate.release();
			}
			await server.close();
			db.close();
		}
	});

	test("preserves a provider failure when its buffered error response is reset", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-buffered-error-reset", 1_000_000, 2_000_000);
		let completeCalls = 0;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				completeCalls += 1;
				if (completeCalls === 1) {
					throw new Error("internal provider details");
				}
				return {
					id: "chatcmpl-after-buffered-error-reset",
					object: "chat.completion",
					created: 0,
					model: "gpt-buffered-error-reset",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					},
				};
			},
			stream(): AsyncIterable<SseChunk> {
				throw new Error("unused");
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const gates = installBufferedResponseGate(server);
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-buffered-error-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
			pg_no_cache: true,
		});

		try {
			const { requestId, release } = await resetGatedBufferedResponse(
				address,
				body,
				gates,
			);
			release();
			const row = await readRow(db, requestId);
			expect(row).toMatchObject({
				streamed: 0,
				cache_hit: 0,
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: null,
				output_tokens: null,
				cost_micro_usd: null,
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM requests WHERE model = ?")
					.get("gpt-buffered-error-reset"),
			).toEqual({ count: 1 });

			// The provider failure's full reservation must be available after logging.
			const afterFailure = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterFailure.statusCode).toBe(200);
			expect(completeCalls).toBe(2);
		} finally {
			for (const gate of gates) {
				gate.release();
			}
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — pre-header streaming timeout", () => {
	test("logs and reconciles when timeout wins before the client closes and the iterator rejects", async () => {
		process.env.UPSTREAM_TIMEOUT_MS = "20";
		await vi.resetModules();
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-stream-timeout-before-reset", 1_000_000, 2_000_000);
		let streamCalls = 0;
		let markFirstStarted: (() => void) | undefined;
		let markTimeoutAbort: (() => void) | undefined;
		let rejectTimedOutCall: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const timeoutAbort = new Promise<void>((resolve) => {
			markTimeoutAbort = resolve;
		});
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			stream(_req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk> {
				streamCalls += 1;
				if (streamCalls === 1) {
					return {
						[Symbol.asyncIterator](): AsyncIterator<SseChunk> {
							let started = false;
							return {
								next(): Promise<IteratorResult<SseChunk>> {
									if (started) {
										return Promise.resolve({ done: true, value: undefined });
									}
									started = true;
									markFirstStarted?.();
									return new Promise((_resolve, reject) => {
										signal.addEventListener(
											"abort",
											() => {
												markTimeoutAbort?.();
												rejectTimedOutCall = () => reject(signal.reason);
											},
											{ once: true },
										);
									});
								},
								async return(): Promise<IteratorResult<SseChunk>> {
									return { done: true, value: undefined };
								},
							};
						},
					};
				}
				return (async function* successfulStream() {
					yield roleFrame();
					yield contentFrame("ok");
					yield finishFrame();
					yield usageFrame({
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					});
					yield DONE;
				})();
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-stream-timeout-before-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
			stream: true,
			pg_no_cache: true,
		});

		try {
			let responseStarted = false;
			const client = httpRequest(
				`${address}/v1/chat/completions`,
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-length": Buffer.byteLength(body),
					},
				},
				(response) => {
					responseStarted = true;
					response.destroy();
				},
			);
			client.on("error", () => undefined);
			client.end(body);
			await firstStarted;
			await timeoutAbort;
			client.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
			rejectTimedOutCall?.();

			const row = await readOnlyRowForModel(
				db,
				"gpt-stream-timeout-before-reset",
			);
			expect(responseStarted).toBe(false);
			expect(row).toMatchObject({
				streamed: 1,
				cache_hit: 0,
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: null,
				output_tokens: null,
				cost_micro_usd: null,
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM requests WHERE model = ?")
					.get("gpt-stream-timeout-before-reset"),
			).toEqual({ count: 1 });

			// A leaked three-micro-USD reservation would reject this equal-budget call.
			const afterTimeout = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterTimeout.statusCode).toBe(200);
			expect(streamCalls).toBe(2);
		} finally {
			rejectTimedOutCall?.();
			await server.close();
			db.close();
		}
	});

	test("preserves a provider failure when the client closes during iterator cleanup", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-stream-error-before-reset", 1_000_000, 2_000_000);
		let streamCalls = 0;
		let markReturnStarted: (() => void) | undefined;
		let releaseReturn: (() => void) | undefined;
		const returnStarted = new Promise<void>((resolve) => {
			markReturnStarted = resolve;
		});
		const returnReleased = new Promise<void>((resolve) => {
			releaseReturn = resolve;
		});
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			stream(): AsyncIterable<SseChunk> {
				streamCalls += 1;
				if (streamCalls === 1) {
					return {
						[Symbol.asyncIterator](): AsyncIterator<SseChunk> {
							return {
								async next(): Promise<IteratorResult<SseChunk>> {
									throw new Error("sanitized provider failure");
								},
								async return(): Promise<IteratorResult<SseChunk>> {
									markReturnStarted?.();
									await returnReleased;
									return { done: true, value: undefined };
								},
							};
						},
					};
				}
				return (async function* successfulStream() {
					yield roleFrame();
					yield contentFrame("ok");
					yield finishFrame();
					yield usageFrame({
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					});
					yield DONE;
				})();
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify({
			model: "gpt-stream-error-before-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
			stream: true,
			pg_no_cache: true,
		});

		try {
			let responseStarted = false;
			const client = httpRequest(
				`${address}/v1/chat/completions`,
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-length": Buffer.byteLength(body),
					},
				},
				(response) => {
					responseStarted = true;
					response.destroy();
				},
			);
			client.on("error", () => undefined);
			client.end(body);
			await returnStarted;
			client.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
			releaseReturn?.();

			const row = await readOnlyRowForModel(
				db,
				"gpt-stream-error-before-reset",
			);
			expect(responseStarted).toBe(false);
			expect(row).toMatchObject({
				streamed: 1,
				cache_hit: 0,
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: null,
				output_tokens: null,
				cost_micro_usd: null,
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM requests WHERE model = ?")
					.get("gpt-stream-error-before-reset"),
			).toEqual({ count: 1 });

			// The failed call's full reservation must be available after its row lands.
			const afterFailure = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(afterFailure.statusCode).toBe(200);
			expect(streamCalls).toBe(2);
		} finally {
			releaseReturn?.();
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — streaming success", () => {
	test("writes a fully assembled successful stream and replays it without a second provider call", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream-write", 1_000_000, 2_000_000);
		let streamCalls = 0;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			async *stream(): AsyncIterable<SseChunk> {
				streamCalls += 1;
				yield roleFrame();
				yield contentFrame("cached live stream");
				yield finishFrame();
				yield usageFrame({
					prompt_tokens: 4,
					completion_tokens: 2,
					total_tokens: 6,
				});
				yield DONE;
			},
		};
		const server = await buildTestServer({ openai: adapter });

		try {
			const first = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream-write"),
			});
			expect(first.headers["x-pg-cache"]).toBe("miss");
			expect(streamCalls).toBe(1);
			const entry = db
				.prepare(
					"SELECT response_json, usage_json, priced_cost_micro_usd, priced_cost_estimated FROM cache_entries",
				)
				.get() as {
				response_json: string;
				usage_json: string;
				priced_cost_micro_usd: number;
				priced_cost_estimated: number;
			};
			expect(JSON.parse(entry.response_json)).toEqual({
				id: "c",
				object: "chat.completion",
				created: 1,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "cached live stream" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
			});
			expect(JSON.parse(entry.usage_json)).toEqual({
				prompt_tokens: 4,
				completion_tokens: 2,
				total_tokens: 6,
			});
			expect(entry.priced_cost_micro_usd).toBe(8);
			expect(entry.priced_cost_estimated).toBe(0);

			const replay = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream-write"),
			});
			expect(replay.headers["x-pg-cache"]).toBe("hit");
			expect(streamCalls).toBe(1);
			const replayRow = await readRow(
				db,
				replay.headers["x-pg-request-id"] as string,
			);
			expect(replayRow).toMatchObject({
				cache_hit: 1,
				cache_saved_micro_usd: 8,
				cache_saved_estimated: 0,
			});
			const payloads = await parseClientSse(replay.payload);
			expect(payloads.at(-1)).toBe("[DONE]");
			expect(JSON.parse(payloads[0] ?? "{}")).toMatchObject({
				id: "c",
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "cached live stream" },
						finish_reason: "stop",
					},
				],
			});
		} finally {
			await server.close();
			db.close();
		}
	});

	test("does not cache a successful stream when assembly cannot preserve a delta", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream-ineligible", 1_000_000, 2_000_000);
		const adapter = fakeStreamAdapter([
			roleFrame(),
			frame({
				...CHUNK_BASE,
				choices: [
					{
						index: 0,
						delta: { content: "visible", refusal: "provider extension" },
						finish_reason: null,
					},
				],
				usage: null,
			}),
			finishFrame(),
			usageFrame({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
			DONE,
		]);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("gpt-stream-ineligible"),
			});
			expect(response.statusCode).toBe(200);
			expect(response.payload).toContain("visible");
			expect(response.payload).toContain("[DONE]");
			expect(
				db.prepare("SELECT count(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
		} finally {
			await server.close();
			db.close();
		}
	});

	test("replays a cache hit as valid compact SSE without invoking either adapter method", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream-cache", 1_000_000, 2_000_000);
		const request: ChatRequest = {
			model: "gpt-stream-cache",
			messages: [{ role: "user", content: "say hi" }],
			stream: true,
		};
		const cached: ChatResponse = {
			id: "chatcmpl-cached-stream",
			object: "chat.completion",
			created: 5,
			model: "gpt-stream-cache-2026-07-01",
			system_fingerprint: "fp-cache-replay",
			service_tier: "priority",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "cached text" },
					finish_reason: "stop",
					logprobs: { content: [] },
				},
				{
					index: 1,
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_cached",
								type: "function",
								function: { name: "lookup", arguments: "{}" },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
		};
		db.prepare(
			`INSERT INTO cache_entries (
				hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at
			) VALUES (?, ?, ?, ?, 42, '2999-01-01 00:00:00')`,
		).run(
			cacheKeyOf(request),
			request.model,
			JSON.stringify(cached),
			JSON.stringify(cached.usage),
		);

		let completeCalls = 0;
		let streamCalls = 0;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete() {
				completeCalls += 1;
				throw new Error("cache hit must not complete upstream");
			},
			async *stream() {
				streamCalls += 1;
				yield DONE;
				throw new Error("cache hit must not stream upstream");
			},
		};
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify(request),
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/event-stream");
			expect(response.headers["x-pg-cache"]).toBe("hit");
			expect(response.headers["x-pg-cost-usd"]).toBe("0.000000");
			expect(completeCalls).toBe(0);
			expect(streamCalls).toBe(0);

			const frames = await parseClientSse(response.payload);
			expect(frames).toHaveLength(3);
			const completion = JSON.parse(frames[0] as string) as Record<
				string,
				unknown
			>;
			expect(completion).toMatchObject({
				id: "chatcmpl-cached-stream",
				object: "chat.completion.chunk",
				model: "gpt-stream-cache-2026-07-01",
				system_fingerprint: "fp-cache-replay",
				service_tier: "priority",
				usage: null,
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "cached text" },
						logprobs: { content: [] },
					},
					{
						index: 1,
						delta: { tool_calls: [{ id: "call_cached" }] },
						finish_reason: "tool_calls",
					},
				],
			});
			expect(JSON.parse(frames[1] as string)).toMatchObject({
				model: "gpt-stream-cache-2026-07-01",
				system_fingerprint: "fp-cache-replay",
				service_tier: "priority",
				choices: [],
				usage: cached.usage,
			});
			expect(frames[2]).toBe("[DONE]");

			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row).toMatchObject({
				cache_hit: 1,
				streamed: 1,
				input_tokens: 8,
				output_tokens: 3,
				cost_micro_usd: 0,
				cost_estimated: 0,
				cache_saved_micro_usd: 42,
				cache_saved_estimated: null,
				status: "ok",
			});
			expect(db.prepare("SELECT hit_count FROM cache_entries").get()).toEqual({
				hit_count: 1,
			});
		} finally {
			await server.close();
			db.close();
		}
	});

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

	test("translates a configured Anthropic stream end-to-end with metering, [DONE], and no cost header", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "claude-stream", 1_000_000, 2_000_000, {
			provider: "anthropic",
		});
		const fetch = vi
			.fn()
			.mockResolvedValue(sseResponse(ANTHROPIC_STREAM_FIXTURE));
		const server = await serverWithRealAnthropic(fetch);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: streamBody("claude-stream"),
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/event-stream");
			expect(response.headers["x-pg-cache"]).toBe("miss");
			expect(response.headers["x-pg-request-id"]).toMatch(UUID_RE);
			// A live stream never carries the cost header (§5.1).
			expect(response.headers["x-pg-cost-usd"]).toBeUndefined();
			expect(response.payload).toContain(
				"Hello from the PromptGate contract fixture.",
			);
			expect(response.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);

			// The outbound request reused the step-2 translation plus stream:true.
			const [, init] = fetch.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(init.body as string).stream).toBe(true);

			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row.streamed).toBe(1);
			expect(row.provider).toBe("anthropic");
			expect(row.status).toBe("ok");
			expect(row.input_tokens).toBe(19);
			expect(row.output_tokens).toBe(12);
			// round(19*1e6/1e6) + round(12*2e6/1e6) = 19 + 24 = 43
			expect(row.cost_micro_usd).toBe(43);
			expect(row.cost_estimated).toBe(0);
			expect(row.first_token_ms).not.toBeNull();
			expect(row.first_token_ms as number).toBeLessThan(row.total_ms as number);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("logs and reconciles a cache replay reset, then retains debt if its fallback log fails", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 3 });
		seedPricing(db, "gpt-cache-replay-reset", 1_000_000, 2_000_000);
		const request: ChatRequest = {
			model: "gpt-cache-replay-reset",
			messages: [{ role: "user", content: "abcd" }],
			max_tokens: 1,
			stream: true,
		};
		// The test-local onSend gate below releases exactly one transport buffer,
		// so the reset precedes the remaining cached frames without relying on OS
		// socket-buffer timing.
		seedStreamingCacheEntry(db, request, {
			id: "cache-reset",
			object: "chat.completion",
			created: 1,
			model: "gpt-cache-replay-reset",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "x" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		const server = await buildTestServer({});
		type ReplayGate = {
			closed: Promise<void>;
			release: () => void;
		};
		const queuedReplayGates: ReplayGate[] = [];
		const allReplayGates: ReplayGate[] = [];
		server.addHook("onSend", async (request, reply, payload) => {
			if (request.headers["x-test-gate-cache-replay"] !== "1") {
				return payload;
			}
			if (!(payload instanceof Readable)) {
				throw new Error("expected a streaming cache replay");
			}

			let releaseReplay: (() => void) | undefined;
			const released = new Promise<void>((resolve) => {
				releaseReplay = resolve;
			});
			let didRelease = false;
			const gate: ReplayGate = {
				closed: new Promise((resolve) => {
					reply.raw.once("close", resolve);
				}),
				release: () => {
					if (!didRelease) {
						didRelease = true;
						releaseReplay?.();
					}
				},
			};
			queuedReplayGates.push(gate);
			allReplayGates.push(gate);

			return Readable.from(
				(async function* gateReplay() {
					let firstChunk = true;
					for await (const chunk of payload) {
						yield chunk;
						if (firstChunk) {
							firstChunk = false;
							await released;
						}
					}
				})(),
			);
		});
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		const body = JSON.stringify(request);

		const resetReplay = async (): Promise<{
			requestId: string;
			release: () => void;
		}> => {
			return await new Promise((resolve, reject) => {
				const client = httpRequest(
					`${address}/v1/chat/completions`,
					{
						method: "POST",
						headers: {
							...authHeaders(),
							"content-length": Buffer.byteLength(body),
							"x-test-gate-cache-replay": "1",
						},
					},
					(response) => {
						const requestId = response.headers["x-pg-request-id"];
						if (typeof requestId !== "string") {
							reject(new Error("missing request id"));
							return;
						}
						response.once("data", () => {
							const gate = queuedReplayGates.shift();
							if (!gate) {
								reject(new Error("cache replay gate was not installed"));
								return;
							}
							client.destroy();
							void gate.closed.then(
								() => resolve({ requestId, release: gate.release }),
								reject,
							);
						});
					},
				);
				client.on("error", (error: Error) => {
					if (error.message !== "socket hang up") {
						reject(error);
					}
				});
				client.end(body);
			});
		};

		try {
			const { requestId: firstRequestId, release: releaseFirstReplay } =
				await resetReplay();
			releaseFirstReplay();
			const first = await readRow(db, firstRequestId);
			expect(first).toMatchObject({
				cache_hit: 1,
				streamed: 1,
				status: "client_aborted",
				error_code: null,
				input_tokens: 1,
				output_tokens: 1,
				cost_micro_usd: 0,
				cost_estimated: 0,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM requests").get(),
			).toEqual({
				count: 1,
			});

			// The equal reservation is released by the fallback durable log, so the
			// next cache hit is admitted despite the key's three-micro-USD budget.
			const admitted = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(admitted.statusCode).toBe(200);
			expect(admitted.headers["x-pg-cache"]).toBe("hit");

			db.exec(
				"CREATE TRIGGER fail_cache_replay_log BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'cache replay log failure'); END",
			);
			const { release: releaseSecondReplay } = await resetReplay();
			releaseSecondReplay();
			// The failed fallback insert writes no third row, but it turns the active
			// reservation into debt and keeps the budget fail-closed.
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM requests").get(),
			).toEqual({
				count: 2,
			});
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/chat/completions",
						headers: authHeaders(),
						body,
					})
				).statusCode,
			).toBe(429);
		} finally {
			for (const gate of allReplayGates) {
				gate.release();
			}
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — streaming error paths", () => {
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
			expect(
				db.prepare("SELECT count(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
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

	test("aborts the upstream and estimates every visible choice when a real client destroys its streaming socket", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		let observedAbort: Promise<void> | undefined;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			async *stream(
				_req: ChatRequest,
				signal: AbortSignal,
			): AsyncIterable<SseChunk> {
				yield roleFrame();
				yield multiChoiceContentFrame(["A", "BCDEFGH"]);
				observedAbort = new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				await observedAbort;
				throw signal.reason;
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });

		try {
			const outcome = await new Promise<{ requestId: string }>(
				(resolve, reject) => {
					const client = httpRequest(
						`${address}/v1/chat/completions`,
						{
							method: "POST",
							headers: {
								...authHeaders(),
								"content-length": Buffer.byteLength(streamBody("gpt-stream")),
							},
						},
						(response) => {
							const requestId = response.headers["x-pg-request-id"];
							if (typeof requestId !== "string") {
								reject(new Error("missing request id"));
								return;
							}
							response.on("data", () => {
								client.destroy();
								resolve({ requestId });
							});
						},
					);
					client.on("error", (error: Error) => {
						if (error.message !== "socket hang up") {
							reject(error);
						}
					});
					client.end(streamBody("gpt-stream"));
				},
			);

			await observedAbort;
			const row = await readRow(db, outcome.requestId);
			expect(row.status).toBe("client_aborted");
			expect(row.error_code).toBeNull();
			expect(row.cost_estimated).toBe(1);
			// "say hi" -> 2 input tokens; both emitted choices total eight chars.
			// Counting only the first choice would incorrectly report one output token.
			expect(row.input_tokens).toBe(2);
			expect(row.output_tokens).toBe(2);
			expect(row.cost_micro_usd).toBe(6);
			expect(row.first_token_ms).not.toBeNull();
			expect(
				db.prepare("SELECT count(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
		} finally {
			await server.close();
			db.close();
		}
	});

	test("does not count a frame settled after a client reset and closes the upstream iterator once", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		let returnCalls = 0;
		let observedAbort: Promise<void> | undefined;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			stream(_req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk> {
				return {
					[Symbol.asyncIterator](): AsyncIterator<SseChunk> {
						let nextCalls = 0;
						return {
							async next(): Promise<IteratorResult<SseChunk>> {
								nextCalls += 1;
								if (nextCalls === 1) {
									return { value: roleFrame(), done: false };
								}
								observedAbort = new Promise((resolve) => {
									signal.addEventListener("abort", () => resolve(), {
										once: true,
									});
								});
								await observedAbort;
								return { value: contentFrame("NEVER"), done: false };
							},
							async return(): Promise<IteratorResult<SseChunk>> {
								returnCalls += 1;
								return { value: undefined, done: true };
							},
						};
					},
				};
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });

		try {
			const outcome = await new Promise<{ requestId: string }>(
				(resolve, reject) => {
					const client = httpRequest(
						`${address}/v1/chat/completions`,
						{
							method: "POST",
							headers: {
								...authHeaders(),
								"content-length": Buffer.byteLength(streamBody("gpt-stream")),
							},
						},
						(response) => {
							const requestId = response.headers["x-pg-request-id"];
							if (typeof requestId !== "string") {
								reject(new Error("missing request id"));
								return;
							}
							response.once("data", () => {
								client.destroy();
								resolve({ requestId });
							});
						},
					);
					client.on("error", (error: Error) => {
						if (error.message !== "socket hang up") {
							reject(error);
						}
					});
					client.end(streamBody("gpt-stream"));
				},
			);

			await observedAbort;
			const row = await readRow(db, outcome.requestId);
			expect(row.status).toBe("client_aborted");
			expect(row.output_tokens).toBe(0);
			expect(row.cost_estimated).toBe(1);
			expect(returnCalls).toBe(1);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("keeps terminal usage exact when the client disconnects after it arrives", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-stream", 1_000_000, 2_000_000);
		let observedAbort: Promise<void> | undefined;
		const adapter: ProviderAdapter = {
			name: "openai",
			async complete(): Promise<ChatResponse> {
				throw new Error("unused");
			},
			async *stream(
				_req: ChatRequest,
				signal: AbortSignal,
			): AsyncIterable<SseChunk> {
				yield roleFrame();
				yield contentFrame("Hello");
				yield usageFrame({
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				});
				observedAbort = new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				await observedAbort;
				throw signal.reason;
			},
		};
		const server = await buildTestServer({ openai: adapter });
		const address = await server.listen({ port: 0, host: "127.0.0.1" });

		try {
			const outcome = await new Promise<{ requestId: string }>(
				(resolve, reject) => {
					const client = httpRequest(
						`${address}/v1/chat/completions`,
						{
							method: "POST",
							headers: {
								...authHeaders(),
								"content-length": Buffer.byteLength(streamBody("gpt-stream")),
							},
						},
						(response) => {
							const requestId = response.headers["x-pg-request-id"];
							if (typeof requestId !== "string") {
								reject(new Error("missing request id"));
								return;
							}
							response.once("data", () => {
								client.destroy();
								resolve({ requestId });
							});
						},
					);
					client.on("error", (error: Error) => {
						if (error.message !== "socket hang up") {
							reject(error);
						}
					});
					client.end(streamBody("gpt-stream"));
				},
			);

			await observedAbort;
			const row = await readRow(db, outcome.requestId);
			expect(row.status).toBe("client_aborted");
			expect(row.cost_estimated).toBe(0);
			expect(row.input_tokens).toBe(10);
			expect(row.output_tokens).toBe(5);
			expect(row.cost_micro_usd).toBe(20);
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
	test("estimates visible output for a missing-usage contract failure and never caches it", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 4 });
		seedPricing(db, "gpt-order-missing-usage", 1_000_000, 2_000_000);
		const transcript = sseText([ROLE_OBJ, contentObj("late")]);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const server = await serverWithRealOpenAi(fetch);
		const body = JSON.stringify({
			model: "gpt-order-missing-usage",
			messages: [{ role: "user", content: "say hi" }],
			max_tokens: 1,
			stream: true,
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(response.statusCode).toBe(200);
			expect(response.payload).toContain("late");
			expect(response.payload).not.toContain("[DONE]");
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row).toMatchObject({
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: 2,
				output_tokens: 1,
				cost_micro_usd: 4,
				cost_estimated: 1,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
			// The estimated durable cost consumes the whole $0.000004 budget, so
			// reconciliation cannot have treated the failed stream as zero cost.
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/chat/completions",
						headers: authHeaders(),
						body,
					})
				).statusCode,
			).toBe(429);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("content after the terminal usage chunk fails the exchange, no [DONE] to the client", async () => {
		const db = openTestDb();
		seedApiKey(db, { budgetMicroUsdMonth: 4 });
		seedPricing(db, "gpt-order-a", 1_000_000, 2_000_000);
		const transcript = sseText([
			ROLE_OBJ,
			usageObj({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
			contentObj("late"),
		]);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const server = await serverWithRealOpenAi(fetch);
		const body = JSON.stringify({
			model: "gpt-order-a",
			messages: [{ role: "user", content: "say hi" }],
			max_tokens: 1,
			stream: true,
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body,
			});
			expect(response.statusCode).toBe(200); // headers committed on the role chunk
			expect(response.payload).not.toContain("[DONE]");
			const row = await readRow(
				db,
				response.headers["x-pg-request-id"] as string,
			);
			expect(row).toMatchObject({
				status: "provider_error",
				error_code: "provider_error",
				input_tokens: 2,
				output_tokens: 1,
				cost_micro_usd: 4,
				cost_estimated: 0,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM cache_entries").get(),
			).toEqual({ count: 0 });
			// A later contract error must preserve the already-captured exact usage
			// when reconciliation releases its reservation.
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/chat/completions",
						headers: authHeaders(),
						body,
					})
				).statusCode,
			).toBe(429);
			expect(fetch).toHaveBeenCalledTimes(1);
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
