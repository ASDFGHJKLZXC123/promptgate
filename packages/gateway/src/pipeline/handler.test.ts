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
import type { ProviderAdapter, ProviderName } from "../providers/types.js";
import { cacheKeyOf } from "./cache-key.js";

interface OpenAIErrorResponse {
	error: { message: string; type: string; code: string };
}

interface RequestsRow {
	request_id: string | null;
	api_key_id: number;
	provider: string;
	model: string;
	feature: string | null;
	cache_hit: number;
	streamed: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: number;
	total_ms: number | null;
	status: string;
	error_code: string | null;
}

const ADMIN_TOKEN = "test-admin-token-000000";
const PLAINTEXT_KEY = "pg-test-handler-key";
const KEY_HASH = createHash("sha256").update(PLAINTEXT_KEY).digest("hex");
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;
let previousOpenAiKey: string | undefined;
let previousUpstreamTimeout: string | undefined;
let previousBodyLimit: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	previousOpenAiKey = process.env.OPENAI_API_KEY;
	previousUpstreamTimeout = process.env.UPSTREAM_TIMEOUT_MS;
	previousBodyLimit = process.env.BODY_LIMIT_BYTES;
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	delete process.env.OPENAI_API_KEY;
	delete process.env.BODY_LIMIT_BYTES;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-handler-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();

	// Guardrail: no test in this file may reach the network. Any real fetch
	// call is a bug — fake adapters must be the only thing invoked.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("network should not be used in handler tests");
		}),
	);
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
	if (previousOpenAiKey === undefined) {
		delete process.env.OPENAI_API_KEY;
	} else {
		process.env.OPENAI_API_KEY = previousOpenAiKey;
	}
	if (previousUpstreamTimeout === undefined) {
		delete process.env.UPSTREAM_TIMEOUT_MS;
	} else {
		process.env.UPSTREAM_TIMEOUT_MS = previousUpstreamTimeout;
	}
	if (previousBodyLimit === undefined) {
		delete process.env.BODY_LIMIT_BYTES;
	} else {
		process.env.BODY_LIMIT_BYTES = previousBodyLimit;
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

function seedApiKey(db: Database.Database): number {
	const row = db
		.prepare(
			`INSERT INTO api_keys (name, key_hash, disabled) VALUES (@name, @key_hash, 0)
			 RETURNING id`,
		)
		.get({ name: "handler-test-key", key_hash: KEY_HASH }) as { id: number };
	return row.id;
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

function fakeChatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
	return {
		id: "chatcmpl-fake",
		object: "chat.completion",
		created: 0,
		model: "gpt-test-exact",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "hello world" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		...overrides,
	};
}

function seedCacheEntry(
	db: Database.Database,
	request: ChatRequest,
	response: ChatResponse,
	overrides: Partial<{
		model: string;
		responseJson: string;
		usageJson: string;
		expiresAt: string;
	}> = {},
): void {
	if (!response.usage) {
		throw new Error("Cache fixture requires usage.");
	}
	db.prepare(
		`INSERT INTO cache_entries (
			hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at
		) VALUES (?, ?, ?, ?, 77, ?)`,
	).run(
		cacheKeyOf(request),
		overrides.model ?? request.model,
		overrides.responseJson ?? JSON.stringify(response),
		overrides.usageJson ?? JSON.stringify(response.usage),
		overrides.expiresAt ?? "2999-01-01 00:00:00",
	);
}

interface FakeAdapterHandle {
	adapter: ProviderAdapter;
	calls: ChatRequest[];
}

function fakeAdapter(
	complete: (req: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>,
	name: ProviderName = "openai",
): FakeAdapterHandle {
	const calls: ChatRequest[] = [];
	return {
		calls,
		adapter: {
			name,
			async complete(req, signal) {
				calls.push(req);
				return complete(req, signal);
			},
			stream() {
				throw new Error("stream() should not be called in phase 1 tests");
			},
		},
	};
}

async function buildTestServer(
	adapters: Partial<Record<ProviderName, ProviderAdapter>>,
): Promise<FastifyInstance> {
	const { buildServer } = await import("../server.js");
	return buildServer({ adapters });
}

function authHeaders(): Record<string, string> {
	return {
		authorization: `Bearer ${PLAINTEXT_KEY}`,
		"content-type": "application/json",
	};
}

describe("POST /v1/chat/completions — success path", () => {
	test("meters exact usage, sets headers, and persists a row keyed by the same UUID", async () => {
		const db = openTestDb();
		seedApiKey(db);
		// $1.50/Mtok in, $2.50/Mtok out — chosen to force Math.round to round
		// .5 up on both components (1 * 1_500_000 / 1e6 = 1.5 -> 2;
		// 1 * 2_500_000 / 1e6 = 2.5 -> 3; total 5 micro-USD).
		seedPricing(db, "gpt-test-exact", 1_500_000, 2_500_000);

		const { adapter, calls } = fakeAdapter(async () =>
			fakeChatResponse({
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-exact",
					messages: [{ role: "user", content: "say hi" }],
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(calls).toHaveLength(1);

			const requestId = response.headers["x-pg-request-id"];
			expect(typeof requestId).toBe("string");
			expect(requestId as string).toMatch(UUID_RE);
			expect(response.headers["x-pg-cache"]).toBe("miss");
			expect(response.headers["x-pg-cost-usd"]).toBe("0.000005");
			expect(response.json()).toEqual(fakeChatResponse());

			await new Promise((resolve) => setTimeout(resolve, 20));

			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(requestId) as RequestsRow;

			expect(row).toBeDefined();
			expect(row.request_id).toBe(requestId);
			expect(row.provider).toBe("openai");
			expect(row.model).toBe("gpt-test-exact");
			expect(row.input_tokens).toBe(1);
			expect(row.output_tokens).toBe(1);
			expect(row.cost_micro_usd).toBe(5);
			expect(row.cost_estimated).toBe(0);
			expect(row.status).toBe("ok");
			expect(row.error_code).toBeNull();
			expect(row.streamed).toBe(0);
			expect(row.cache_hit).toBe(0);
			expect(row.total_ms).not.toBeNull();
			expect(
				db
					.prepare(
						"SELECT response_json, usage_json, priced_cost_micro_usd FROM cache_entries",
					)
					.get(),
			).toEqual({
				response_json: JSON.stringify(fakeChatResponse()),
				usage_json: JSON.stringify({
					prompt_tokens: 1,
					completion_tokens: 1,
					total_tokens: 2,
				}),
				priced_cost_micro_usd: 5,
			});

			const replay = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-exact",
					messages: [{ role: "user", content: "say hi" }],
				}),
			});
			expect(replay.headers["x-pg-cache"]).toBe("hit");
			expect(replay.headers["x-pg-cost-usd"]).toBe("0.000000");
			expect(calls).toHaveLength(1);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("estimates tokens via chars/4 and flags cost_estimated when usage is missing", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { adapter } = fakeAdapter(async () => {
			const { usage: _usage, ...rest } = fakeChatResponse({
				model: "gpt-test-estimate",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "hello world" }, // 11 chars -> ceil(11/4) = 3
						finish_reason: "stop",
					},
				],
			});
			return rest as ChatResponse;
		});
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "say hi" }], // 6 chars -> ceil(6/4) = 2
				}),
			});

			expect(response.statusCode).toBe(200);
			// No live usage: cost header still reflects the estimate, not "missing".
			expect(response.headers["x-pg-cost-usd"]).toBeDefined();

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(requestId) as RequestsRow;

			expect(row.input_tokens).toBe(2);
			expect(row.output_tokens).toBe(3);
			// round(2*1_000_000/1e6) + round(3*2_000_000/1e6) = 2 + 6 = 8
			expect(row.cost_micro_usd).toBe(8);
			expect(row.cost_estimated).toBe(1);
			expect(row.status).toBe("ok");
			expect(db.prepare("SELECT usage_json FROM cache_entries").get()).toEqual({
				usage_json: "null",
			});
			const replay = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "say hi" }],
				}),
			});
			expect(replay.headers["x-pg-cache"]).toBe("hit");
			expect(replay.headers["x-pg-cost-usd"]).toBe("0.000000");
			await new Promise((resolve) => setTimeout(resolve, 20));
			const replayRow = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(replay.headers["x-pg-request-id"]) as RequestsRow;
			expect(replayRow).toMatchObject({
				cache_hit: 1,
				cost_micro_usd: 0,
				cost_estimated: 1,
				input_tokens: 2,
				output_tokens: 3,
			});
		} finally {
			await server.close();
			db.close();
		}
	});

	test("forwards the parsed body (pg_* fields intact) to the resolved adapter and preserves pg_feature in the log", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "say hi" }],
					pg_feature: "inbox_summary",
					pg_no_cache: true,
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(calls[0]).toMatchObject({
				model: "gpt-test-estimate",
				pg_feature: "inbox_summary",
				pg_no_cache: true,
			});

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT feature FROM requests WHERE request_id = ?")
				.get(requestId) as { feature: string | null };
			expect(row.feature).toBe("inbox_summary");
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — cache read path", () => {
	test("returns a cache hit without calling the adapter and logs exact zero-cost cache accounting", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-cache", 1_000_000, 2_000_000);
		const body: ChatRequest = {
			model: "gpt-cache",
			messages: [{ role: "user", content: "cache this" }],
		};
		const cached = fakeChatResponse({
			model: "gpt-cache",
			usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
		});
		seedCacheEntry(db, body, cached);
		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["x-pg-cache"]).toBe("hit");
			expect(response.headers["x-pg-cost-usd"]).toBe("0.000000");
			expect(response.json()).toEqual(cached);
			expect(calls).toHaveLength(0);

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(requestId) as RequestsRow;
			expect(row).toMatchObject({
				request_id: requestId,
				provider: "openai",
				model: "gpt-cache",
				cache_hit: 1,
				streamed: 0,
				input_tokens: 7,
				output_tokens: 4,
				cost_micro_usd: 0,
				cost_estimated: 0,
				status: "ok",
			});
			expect(
				db.prepare("SELECT hit_count, last_hit_at FROM cache_entries").get(),
			).toEqual({ hit_count: 1, last_hit_at: expect.any(String) });
		} finally {
			await server.close();
			db.close();
		}
	});

	test("treats corrupt, expired, and model-mismatched entries as misses without incrementing them", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-cache", 1_000_000, 2_000_000);
		const body: ChatRequest = {
			model: "gpt-cache",
			messages: [{ role: "user", content: "miss safely" }],
		};
		const { adapter, calls } = fakeAdapter(async () =>
			fakeChatResponse({ model: "gpt-cache" }),
		);
		const server = await buildTestServer({ openai: adapter });

		try {
			for (const invalid of [
				{ responseJson: "not-json" },
				{ expiresAt: "2000-01-01 00:00:00" },
				{ model: "other-model" },
			]) {
				seedCacheEntry(
					db,
					body,
					fakeChatResponse({ model: "gpt-cache" }),
					invalid,
				);
				const response = await server.inject({
					method: "POST",
					url: "/v1/chat/completions",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				expect(response.statusCode).toBe(200);
				expect(response.headers["x-pg-cache"]).toBe("miss");
				db.prepare("DELETE FROM cache_entries").run();
			}
			expect(calls).toHaveLength(3);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("pg_no_cache bypasses an otherwise usable cache entry", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-cache", 1_000_000, 2_000_000);
		const cachedRequest: ChatRequest = {
			model: "gpt-cache",
			messages: [{ role: "user", content: "bypass" }],
		};
		seedCacheEntry(db, cachedRequest, fakeChatResponse({ model: "gpt-cache" }));
		const sentinel = db
			.prepare(
				`SELECT hash, model, response_json, usage_json, priced_cost_micro_usd,
				 expires_at, hit_count, last_hit_at
				 FROM cache_entries`,
			)
			.get();
		const { adapter, calls } = fakeAdapter(async () =>
			fakeChatResponse({ model: "gpt-cache" }),
		);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({ ...cachedRequest, pg_no_cache: true }),
			});
			expect(response.headers["x-pg-cache"]).toBe("miss");
			expect(calls).toHaveLength(1);
			expect(db.prepare("SELECT hit_count FROM cache_entries").get()).toEqual({
				hit_count: 0,
			});
			expect(
				db
					.prepare(
						`SELECT hash, model, response_json, usage_json, priced_cost_micro_usd,
						 expires_at, hit_count, last_hit_at
						 FROM cache_entries`,
					)
					.get(),
			).toEqual(sentinel);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("logs Gemini cache hits with normalized hidden-thinking output tokens while keeping cost zero", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gemini-cache-normalized", 300_000, 2_500_000, {
			provider: "gemini",
			cachedInputRate: 30_000,
		});
		const body: ChatRequest = {
			model: "gemini-cache-normalized",
			messages: [{ role: "user", content: "remember this" }],
		};
		const cached = fakeChatResponse({
			model: "gemini-cache-normalized-2026-07-01",
			usage: {
				prompt_tokens: 100,
				completion_tokens: 5,
				total_tokens: 114,
				prompt_tokens_details: { cached_tokens: 40 },
			},
		});
		seedCacheEntry(db, body, cached);
		const { adapter, calls } = fakeAdapter(
			async () => fakeChatResponse({ model: "gemini-cache-normalized" }),
			"gemini",
		);
		const server = await buildTestServer({ gemini: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(cached);
			expect(calls).toHaveLength(0);

			await new Promise((resolve) => setTimeout(resolve, 20));
			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(response.headers["x-pg-request-id"]) as RequestsRow;
			expect(row).toMatchObject({
				cache_hit: 1,
				input_tokens: 100,
				// Gemini bills total - prompt, including hidden thinking: 114 - 100.
				output_tokens: 14,
				cost_micro_usd: 0,
				cost_estimated: 0,
			});
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — auth, validation, unknown model, streaming", () => {
	test("rejects an unauthenticated request before the adapter is ever invoked", async () => {
		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-test", messages: [] }),
			});

			expect(response.statusCode).toBe(401);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"invalid_pg_key",
			);
			expect(calls).toHaveLength(0);
		} finally {
			await server.close();
		}
	});

	test("rejects an invalid body with invalid_request_error", async () => {
		const db = openTestDb();
		seedApiKey(db);
		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), // missing `model`
			});

			expect(response.statusCode).toBe(400);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"invalid_request_error",
			);
			expect(calls).toHaveLength(0);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("rejects an unknown/unpriced model with unknown_model", async () => {
		const db = openTestDb();
		seedApiKey(db);
		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "totally-unrouted-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				error: {
					message: 'Unknown model: "totally-unrouted-model".',
					type: "invalid_request_error",
					code: "unknown_model",
				},
			});
			expect(calls).toHaveLength(0);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("routes stream:true to the adapter's streaming path (phase 2 step 3), not the non-streaming complete()", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);
		const { calls } = fakeAdapter(async () => fakeChatResponse());
		// A streaming-capable fake: complete() must NOT be called for stream:true.
		const streamingAdapter: ProviderAdapter = {
			name: "openai",
			async complete(req) {
				calls.push(req);
				return fakeChatResponse();
			},
			async *stream() {
				yield {
					data: '{"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-test-estimate","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
					done: false,
				};
				yield { data: "[DONE]", done: true };
			},
		};
		const server = await buildTestServer({ openai: streamingAdapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/event-stream");
			expect(response.headers["x-pg-cost-usd"]).toBeUndefined();
			expect(response.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
			// The non-streaming complete() path was never taken.
			expect(calls).toHaveLength(0);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("returns provider_error for a priced-but-unimplemented provider (anthropic)", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "claude-test-model", 1_000_000, 2_000_000);
		db.prepare(
			"UPDATE model_pricing SET provider = 'anthropic' WHERE model = 'claude-test-model'",
		).run();
		const server = await buildTestServer({}); // no anthropic adapter registered

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "claude-test-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(501);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("enforces the configured route body limit with a safe OpenAI envelope", async () => {
		process.env.BODY_LIMIT_BYTES = "128";
		await vi.resetModules();

		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);
		const { adapter, calls } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "x".repeat(512) }],
				}),
			});

			expect(response.statusCode).toBe(413);
			expect(response.headers["x-pg-request-id"]).toMatch(UUID_RE);
			expect(response.headers["x-pg-cache"]).toBe("miss");
			expect(response.json()).toEqual({
				error: {
					message: "Request body is too large.",
					type: "invalid_request_error",
					code: "invalid_request_error",
				},
			});
			expect(calls).toHaveLength(0);
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — provider error mapping", () => {
	test("maps a thrown ProviderError to an OpenAI envelope, preserving status but never echoing the upstream body", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { ProviderError } = await import("../providers/provider-error.js");
		const { adapter } = fakeAdapter(async () => {
			throw new ProviderError(
				"openai",
				401,
				{
					error: {
						message: "Invalid API key: provider-secret-marker-do-not-leak",
					},
				},
				"OpenAI request failed with status 401.",
			);
		});
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(401);
			const body = response.json() as OpenAIErrorResponse;
			expect(body.error.code).toBe("provider_error");
			expect(response.payload).not.toContain(
				"provider-secret-marker-do-not-leak",
			);

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT status, error_code FROM requests WHERE request_id = ?")
				.get(requestId) as { status: string; error_code: string | null };
			expect(row.status).toBe("provider_error");
			expect(row.error_code).toBe("provider_error");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("maps a missing provider API key (ProviderConfigError) to 503 without leaking the config detail", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { ProviderConfigError } = await import(
			"../providers/provider-error.js"
		);
		const { adapter } = fakeAdapter(async () => {
			throw new ProviderConfigError(
				"openai",
				"OPENAI_API_KEY is not configured.",
			);
		});
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(503);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("maps an unexpected adapter rejection to a generic 502 provider_error", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { adapter } = fakeAdapter(async () => {
			throw new Error("unexpected failure with internal details");
		});
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(502);
			const body = response.json() as OpenAIErrorResponse;
			expect(body.error.code).toBe("provider_error");
			expect(response.payload).not.toContain(
				"unexpected failure with internal details",
			);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("aborts and returns 504 when the upstream call exceeds UPSTREAM_TIMEOUT_MS", async () => {
		process.env.UPSTREAM_TIMEOUT_MS = "20";
		await vi.resetModules();

		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);

		const { adapter } = fakeAdapter(
			(_req, signal) =>
				new Promise<ChatResponse>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(504);
			expect((response.json() as OpenAIErrorResponse).error.code).toBe(
				"provider_error",
			);
		} finally {
			await server.close();
			db.close();
		}
	});
});

describe("POST /v1/chat/completions — logging lifecycle", () => {
	test("does not insert the requests row until after Fastify onSend", async () => {
		const db = openTestDb();
		seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);
		const { adapter } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });
		let rowsObservedDuringOnSend: number | undefined;

		server.addHook("onSend", async (request, _reply, payload) => {
			if (request.url === "/v1/chat/completions") {
				const row = db
					.prepare("SELECT COUNT(*) AS count FROM requests")
					.get() as { count: number };
				rowsObservedDuringOnSend = row.count;
			}
			return payload;
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(rowsObservedDuringOnSend).toBe(0);
			const persisted = db
				.prepare("SELECT COUNT(*) AS count FROM requests")
				.get() as { count: number };
			expect(persisted.count).toBe(1);
		} finally {
			await server.close();
			db.close();
		}
	});

	test("a logging failure (duplicate request_id) does not alter the already-sent response", async () => {
		const fixedUuid = "11111111-1111-4111-8111-111111111111";
		vi.doMock("node:crypto", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:crypto")>();
			return { ...actual, randomUUID: () => fixedUuid };
		});

		const db = openTestDb();
		const apiKeyId = seedApiKey(db);
		seedPricing(db, "gpt-test-estimate", 1_000_000, 2_000_000);
		// Pre-seed a row already holding the UUID the handler will generate,
		// so the DAO's unique index rejects the handler's own insert attempt.
		db.prepare(
			`INSERT INTO requests (request_id, api_key_id, provider, model, status)
			 VALUES (?, ?, 'openai', 'gpt-test-estimate', 'ok')`,
		).run(fixedUuid, apiKeyId);

		const { adapter } = fakeAdapter(async () => fakeChatResponse());
		const server = await buildTestServer({ openai: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gpt-test-estimate",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			// The response itself must be unaffected by the downstream logging failure.
			expect(response.statusCode).toBe(200);
			expect(response.headers["x-pg-request-id"]).toBe(fixedUuid);
			expect(response.json()).toEqual(fakeChatResponse());

			await new Promise((resolve) => setTimeout(resolve, 20));
			const rows = db
				.prepare("SELECT COUNT(*) as count FROM requests WHERE request_id = ?")
				.get(fixedUuid) as { count: number };
			// Still exactly the one pre-seeded row — the handler's own insert
			// failed silently rather than throwing into the response path.
			expect(rows.count).toBe(1);
		} finally {
			await server.close();
			db.close();
			vi.doUnmock("node:crypto");
		}
	});
});

describe("POST /v1/chat/completions — Gemini and DeepSeek routing (BUILD_PLAYBOOK.md phase 1 step 12)", () => {
	test("routes Gemini 2.5 Flash to the injected adapter and meters exact cached-input cost/log", async () => {
		const db = openTestDb();
		seedApiKey(db);
		// Official standard text rates: $0.30/Mtok ordinary input,
		// $0.03/Mtok cached input, $2.50/Mtok output. With 400 cached,
		// 600 uncached, 10 visible output, and 3 hidden thinking tokens:
		// 12 + 180 + 33 = 225 micro-USD.
		seedPricing(db, "gemini-2.5-flash", 300_000, 2_500_000, {
			provider: "gemini",
			cachedInputRate: 30_000,
		});

		const { adapter, calls } = fakeAdapter(
			async () =>
				fakeChatResponse({
					model: "gemini-2.5-flash",
					usage: {
						prompt_tokens: 1_000,
						completion_tokens: 10,
						total_tokens: 1_013,
						prompt_tokens_details: { cached_tokens: 400 },
					},
				}),
			"gemini",
		);
		const server = await buildTestServer({ gemini: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gemini-2.5-flash",
					messages: [{ role: "user", content: "say hi" }],
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(calls).toHaveLength(1);
			expect(response.headers["x-pg-cost-usd"]).toBe("0.000225");

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(requestId) as RequestsRow;

			expect(row.provider).toBe("gemini");
			expect(row.model).toBe("gemini-2.5-flash");
			expect(row.input_tokens).toBe(1_000);
			expect(row.output_tokens).toBe(13);
			expect(row.cost_micro_usd).toBe(225);
			expect(row.cost_estimated).toBe(0);
			expect(row.status).toBe("ok");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("routes a deepseek- model to the injected DeepSeek fake adapter and meters exact cache-hit/cache-miss/output cost/log", async () => {
		const db = openTestDb();
		seedApiKey(db);
		// input (cache-miss) 140000, cached input (cache-hit) 2800, output
		// 280000 micro-USD/Mtok — the human-approved DeepSeek rates
		// (IMPLEMENTATION_GUIDE.md §3.5's step 9 amendment). With
		// cache_hit_tokens=1000, cache_miss_tokens=2000, output_tokens=500:
		// round(1000*2800/1e6)=3, round(2000*140000/1e6)=280,
		// round(500*280000/1e6)=140 -> total 423.
		seedPricing(db, "deepseek-test-cache", 140_000, 280_000, {
			provider: "deepseek",
			cachedInputRate: 2_800,
		});

		const { adapter, calls } = fakeAdapter(
			async () =>
				fakeChatResponse({
					model: "deepseek-test-cache",
					usage: {
						prompt_tokens: 3_000,
						completion_tokens: 500,
						total_tokens: 3_500,
						prompt_cache_hit_tokens: 1_000,
						prompt_cache_miss_tokens: 2_000,
						prompt_tokens_details: { cached_tokens: 1_000 },
					},
				}),
			"deepseek",
		);
		const server = await buildTestServer({ deepseek: adapter });

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "deepseek-test-cache",
					messages: [{ role: "user", content: "say hi" }],
				}),
			});

			expect(response.statusCode).toBe(200);
			expect(calls).toHaveLength(1);
			expect(response.headers["x-pg-cost-usd"]).toBe("0.000423");

			await new Promise((resolve) => setTimeout(resolve, 20));
			const requestId = response.headers["x-pg-request-id"] as string;
			const row = db
				.prepare("SELECT * FROM requests WHERE request_id = ?")
				.get(requestId) as RequestsRow;

			expect(row.provider).toBe("deepseek");
			expect(row.model).toBe("deepseek-test-cache");
			expect(row.input_tokens).toBe(3_000);
			expect(row.output_tokens).toBe(500);
			expect(row.cost_micro_usd).toBe(423);
			expect(row.cost_estimated).toBe(0);
			expect(row.status).toBe("ok");
		} finally {
			await server.close();
			db.close();
		}
	});

	test("rejects a model priced under a mismatched provider as unknown_model without invoking any adapter", async () => {
		const db = openTestDb();
		seedApiKey(db);
		// Priced as "openai" despite the gemini- prefix — routes.ts must
		// reject this rather than route it to either adapter.
		seedPricing(db, "gemini-mismatched-model", 1_000_000, 2_000_000, {
			provider: "openai",
		});

		const { adapter: geminiAdapter, calls: geminiCalls } = fakeAdapter(
			async () => fakeChatResponse(),
			"gemini",
		);
		const { adapter: openaiAdapter, calls: openaiCalls } = fakeAdapter(
			async () => fakeChatResponse(),
			"openai",
		);
		const server = await buildTestServer({
			gemini: geminiAdapter,
			openai: openaiAdapter,
		});

		try {
			const response = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				headers: authHeaders(),
				body: JSON.stringify({
					model: "gemini-mismatched-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				error: {
					message: 'Unknown model: "gemini-mismatched-model".',
					type: "invalid_request_error",
					code: "unknown_model",
				},
			});
			expect(geminiCalls).toHaveLength(0);
			expect(openaiCalls).toHaveLength(0);
		} finally {
			await server.close();
			db.close();
		}
	});
});
