import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import type { ProviderAdapter, ProviderName } from "../providers/types.js";

const OWNER_KEY = "pg-test-usage-owner";
const OTHER_KEY = "pg-test-usage-other";
const OWNER_HASH = createHash("sha256").update(OWNER_KEY).digest("hex");
const OTHER_HASH = createHash("sha256").update(OTHER_KEY).digest("hex");
const OWNED_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_REQUEST_ID = "33333333-3333-4333-8333-333333333333";

let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	process.env.ADMIN_TOKEN = "test-admin-token-000000";
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-usage-route-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("usage lookup must not make a provider call");
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (previousDbPath === undefined) delete process.env.DB_PATH;
	else process.env.DB_PATH = previousDbPath;
	if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
	else process.env.ADMIN_TOKEN = previousAdminToken;
	if (tempDbDir) {
		rmSync(tempDbDir, { recursive: true, force: true });
		tempDbDir = undefined;
	}
});

function openTestDb(): Database.Database {
	const dbPath = process.env.DB_PATH;
	if (!dbPath) throw new Error("DB_PATH is not configured");
	const db = openDatabase(dbPath);
	migrate(db);
	return db;
}

function seedKey(db: Database.Database, name: string, hash: string): number {
	return (
		db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES (?, ?) RETURNING id",
			)
			.get(name, hash) as { id: number }
	).id;
}

function seedRequest(
	db: Database.Database,
	input: {
		requestId: string;
		apiKeyId: number;
		streamed: number;
		inputTokens: number | null;
		outputTokens: number | null;
		costMicroUsd: number | null;
		costEstimated: number;
		status: string;
	},
): void {
	db.prepare(
		`INSERT INTO requests (
			request_id, api_key_id, provider, model, streamed, input_tokens,
			output_tokens, cost_micro_usd, cost_estimated, status
		) VALUES (?, ?, 'openai', 'gpt-test', ?, ?, ?, ?, ?, ?)`,
	).run(
		input.requestId,
		input.apiKeyId,
		input.streamed,
		input.inputTokens,
		input.outputTokens,
		input.costMicroUsd,
		input.costEstimated,
		input.status,
	);
}

function unreachableAdapter(name: ProviderName): ProviderAdapter {
	return {
		name,
		async complete() {
			throw new Error(`${name} adapter must not be called by usage lookup`);
		},
		stream() {
			throw new Error(`${name} adapter must not be called by usage lookup`);
		},
	};
}

async function buildTestServer(): Promise<FastifyInstance> {
	const { buildServer } = await import("../server.js");
	return buildServer({
		adapters: {
			openai: unreachableAdapter("openai"),
			anthropic: unreachableAdapter("anthropic"),
			gemini: unreachableAdapter("gemini"),
			deepseek: unreachableAdapter("deepseek"),
		},
	});
}

function auth(key: string): { authorization: string } {
	return { authorization: `Bearer ${key}` };
}

describe("GET /v1/requests/:request_id/usage", () => {
	test("returns the exact safe projection for the owning key without a provider call", async () => {
		const db = openTestDb();
		const ownerId = seedKey(db, "owner", OWNER_HASH);
		seedRequest(db, {
			requestId: OWNED_REQUEST_ID,
			apiKeyId: ownerId,
			streamed: 1,
			inputTokens: 12,
			outputTokens: 7,
			costMicroUsd: 34,
			costEstimated: 0,
			status: "ok",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: `/v1/requests/${OWNED_REQUEST_ID}/usage`,
			headers: auth(OWNER_KEY),
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("private, no-store");
		expect(response.json()).toEqual({
			request_id: OWNED_REQUEST_ID,
			model: "gpt-test",
			streamed: true,
			input_tokens: 12,
			output_tokens: 7,
			cost_micro_usd: 34,
			cost_estimated: false,
			status: "ok",
		});
		expect(fetch).not.toHaveBeenCalled();
		await server.close();
	});

	test("preserves estimated nullable metering fields", async () => {
		const db = openTestDb();
		const ownerId = seedKey(db, "owner", OWNER_HASH);
		seedRequest(db, {
			requestId: OWNED_REQUEST_ID,
			apiKeyId: ownerId,
			streamed: 1,
			inputTokens: null,
			outputTokens: null,
			costMicroUsd: null,
			costEstimated: 1,
			status: "client_aborted",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: `/v1/requests/${OWNED_REQUEST_ID}/usage`,
			headers: auth(OWNER_KEY),
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			request_id: OWNED_REQUEST_ID,
			model: "gpt-test",
			streamed: true,
			input_tokens: null,
			output_tokens: null,
			cost_micro_usd: null,
			cost_estimated: true,
			status: "client_aborted",
		});
		await server.close();
	});

	test("returns one indistinguishable 404 for unknown, malformed, and cross-key ids", async () => {
		const db = openTestDb();
		const ownerId = seedKey(db, "owner", OWNER_HASH);
		seedKey(db, "other", OTHER_HASH);
		seedRequest(db, {
			requestId: OTHER_REQUEST_ID,
			apiKeyId: ownerId,
			streamed: 0,
			inputTokens: 1,
			outputTokens: 1,
			costMicroUsd: 2,
			costEstimated: 0,
			status: "ok",
		});
		// A pre-002 legacy row has no addressable request_id. It must not make a
		// lookup response distinguishable from an ordinary unknown id.
		db.prepare(
			"INSERT INTO requests (api_key_id, provider, model, status) VALUES (?, 'openai', 'legacy', 'ok')",
		).run(ownerId);
		db.close();
		const server = await buildTestServer();

		const responses = await Promise.all([
			server.inject({
				method: "GET",
				url: `/v1/requests/${UNKNOWN_REQUEST_ID}/usage`,
				headers: auth(OWNER_KEY),
			}),
			server.inject({
				method: "GET",
				url: "/v1/requests/not-a-uuid/usage",
				headers: auth(OWNER_KEY),
			}),
			server.inject({
				method: "GET",
				url: "/v1/requests/not-a-uuid%27%20OR%201%3D1--/usage",
				headers: auth(OWNER_KEY),
			}),
			server.inject({
				method: "GET",
				url: "/v1/requests/not%2Fa-uuid/usage",
				headers: auth(OWNER_KEY),
			}),
			server.inject({
				method: "GET",
				url: `/v1/requests/${OTHER_REQUEST_ID}/usage`,
				headers: auth(OTHER_KEY),
			}),
		]);

		for (const response of responses) {
			expect(response.statusCode).toBe(404);
			expect(response.headers["cache-control"]).toBe("private, no-store");
		}
		expect(responses.map((response) => response.body)).toEqual([
			responses[0]?.body,
			responses[0]?.body,
			responses[0]?.body,
			responses[0]?.body,
			responses[0]?.body,
		]);
		await server.close();
	});

	test("accepts canonical-equivalent uppercase UUID input", async () => {
		const db = openTestDb();
		const ownerId = seedKey(db, "owner", OWNER_HASH);
		seedRequest(db, {
			requestId: OWNED_REQUEST_ID,
			apiKeyId: ownerId,
			streamed: 0,
			inputTokens: 1,
			outputTokens: 2,
			costMicroUsd: 3,
			costEstimated: 0,
			status: "ok",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: `/v1/requests/${OWNED_REQUEST_ID.toUpperCase()}/usage`,
			headers: auth(OWNER_KEY),
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ request_id: OWNED_REQUEST_ID });
		await server.close();
	});

	test("inherits /v1 authentication before usage lookup", async () => {
		const db = openTestDb();
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: `/v1/requests/${OWNED_REQUEST_ID}/usage`,
		});

		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({
			error: {
				message: "Invalid API key.",
				type: "authentication_error",
				code: "invalid_pg_key",
			},
		});
		await server.close();
	});
});
