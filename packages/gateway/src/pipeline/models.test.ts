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

interface OpenAIErrorResponse {
	error: { message: string; type: string; code: string };
}

interface ModelsListResponse {
	object: "list";
	data: Array<{
		id: string;
		object: "model";
		created: number;
		owned_by: string;
	}>;
}

const ADMIN_TOKEN = "test-admin-token-000000";
const PLAINTEXT_KEY = "pg-test-models-key";
const KEY_HASH = createHash("sha256").update(PLAINTEXT_KEY).digest("hex");

const DISABLED_PLAINTEXT_KEY = "pg-test-models-disabled-key";
const DISABLED_KEY_HASH = createHash("sha256")
	.update(DISABLED_PLAINTEXT_KEY)
	.digest("hex");

let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;
let previousOpenAiKey: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	previousOpenAiKey = process.env.OPENAI_API_KEY;
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	delete process.env.OPENAI_API_KEY;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-models-route-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();

	// Guardrail: GET /v1/models must be answered entirely from model_pricing —
	// any real fetch call (a provider call) is a bug in this test file.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("network should not be used for GET /v1/models");
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

function seedApiKey(db: Database.Database, hash: string, disabled = 0): void {
	db.prepare(
		`INSERT INTO api_keys (name, key_hash, disabled) VALUES (@name, @key_hash, @disabled)`,
	).run({
		name: `models-test-key-${hash.slice(0, 8)}`,
		key_hash: hash,
		disabled,
	});
}

interface SeedPricingRow {
	provider: ProviderName;
	model: string;
	effective_from: string;
}

function seedPricing(db: Database.Database, row: SeedPricingRow): void {
	db.prepare(
		`INSERT INTO model_pricing (
			provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from
		) VALUES (@provider, @model, 1000000, 2000000, @effective_from)`,
	).run(row);
}

/** No test in this file invokes a provider adapter — a throwing stub proves no provider is ever called. */
function unreachableAdapter(name: ProviderName): ProviderAdapter {
	return {
		name,
		async complete() {
			throw new Error(`${name} adapter should not be called by GET /v1/models`);
		},
		stream() {
			throw new Error(`${name} adapter should not be called by GET /v1/models`);
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

function unixSecondsOf(dateOnly: string): number {
	return Math.floor(new Date(`${dateOnly}T00:00:00Z`).getTime() / 1000);
}

describe("GET /v1/models — inherited /v1 authentication", () => {
	test("rejects a missing Authorization header with invalid_pg_key, same as chat completions", async () => {
		const db = openTestDb();
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({ method: "GET", url: "/v1/models" });

		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({
			error: {
				message: "Invalid API key.",
				type: "authentication_error",
				code: "invalid_pg_key",
			},
		} satisfies OpenAIErrorResponse);

		await server.close();
	});

	test("rejects a disabled key", async () => {
		const db = openTestDb();
		seedApiKey(db, DISABLED_KEY_HASH, 1);
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${DISABLED_PLAINTEXT_KEY}` },
		});

		expect(response.statusCode).toBe(401);

		await server.close();
	});

	test("accepts a valid pg key with no additional route-specific auth", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});

		expect(response.statusCode).toBe(200);

		await server.close();
	});
});

describe("GET /v1/models — OpenAI list envelope (IMPLEMENTATION_GUIDE.md §5.1)", () => {
	test("returns the exact top-level list envelope and per-model object shape", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});
		const body = response.json() as ModelsListResponse;

		expect(response.statusCode).toBe(200);
		expect(body).toEqual({
			object: "list",
			data: [
				{
					id: "gpt-5.6-luna",
					object: "model",
					created: unixSecondsOf("2020-01-01"),
					owned_by: "openai",
				},
			],
		} satisfies ModelsListResponse);

		await server.close();
	});

	test("returns an empty data array, still under object: list, when no model is currently priced", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ object: "list", data: [] });

		await server.close();
	});
});

describe("GET /v1/models — distinctness, exclusion, and ordering", () => {
	test("collapses multiple price rows for the same model into one entry, in deterministic id order", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-06-30",
		});
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});
		const body = response.json() as ModelsListResponse;

		expect(body.data.map((model) => model.id)).toEqual([
			"claude-sonnet-5",
			"gpt-5.6-luna",
		]);
		expect(body.data.find((model) => model.id === "claude-sonnet-5")).toEqual({
			id: "claude-sonnet-5",
			object: "model",
			created: unixSecondsOf("2020-01-01"),
			owned_by: "anthropic",
		});

		await server.close();
	});

	test("excludes a model whose only pricing row is future-dated", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-future",
			effective_from: "2999-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});
		const body = response.json() as ModelsListResponse;

		expect(body.data.map((model) => model.id)).toEqual(["gpt-5.6-luna"]);

		await server.close();
	});

	test("is stable across repeated calls regardless of insertion order", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-terra",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const first = (
			(
				await server.inject({
					method: "GET",
					url: "/v1/models",
					headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
				})
			).json() as ModelsListResponse
		).data.map((model) => model.id);
		const second = (
			(
				await server.inject({
					method: "GET",
					url: "/v1/models",
					headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
				})
			).json() as ModelsListResponse
		).data.map((model) => model.id);

		const expectedOrder = ["claude-sonnet-5", "gpt-5.6-luna", "gpt-5.6-terra"];
		expect(first).toEqual(expectedOrder);
		expect(second).toEqual(expectedOrder);

		await server.close();
	});

	test("includes Gemini and DeepSeek alongside other current priced rows, in deterministic model-id order (BUILD_PLAYBOOK.md phase 1 step 12)", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "gemini",
			model: "gemini-2.5-flash-lite",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "gemini",
			model: "gemini-2.5-flash",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});
		const body = response.json() as ModelsListResponse;

		expect(response.statusCode).toBe(200);
		expect(body.data.map((model) => model.id)).toEqual([
			"claude-sonnet-5",
			"deepseek-v4-flash",
			"gemini-2.5-flash",
			"gemini-2.5-flash-lite",
			"gpt-5.6-luna",
		]);
		expect(body.data.find((model) => model.id === "gemini-2.5-flash")).toEqual({
			id: "gemini-2.5-flash",
			object: "model",
			created: unixSecondsOf("2020-01-01"),
			owned_by: "gemini",
		});
		expect(
			body.data.find((model) => model.id === "gemini-2.5-flash-lite"),
		).toEqual({
			id: "gemini-2.5-flash-lite",
			object: "model",
			created: unixSecondsOf("2020-01-01"),
			owned_by: "gemini",
		});
		expect(body.data.find((model) => model.id === "deepseek-v4-flash")).toEqual(
			{
				id: "deepseek-v4-flash",
				object: "model",
				created: unixSecondsOf("2020-01-01"),
				owned_by: "deepseek",
			},
		);
		expect(fetch).not.toHaveBeenCalled();

		await server.close();
	});
});

describe("GET /v1/models — no provider/network call", () => {
	test("never invokes an adapter or fetch even when providers are configured", async () => {
		const db = openTestDb();
		seedApiKey(db, KEY_HASH);
		seedPricing(db, {
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});
		seedPricing(db, {
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
		});
		db.close();
		const server = await buildTestServer();

		const response = await server.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
		});

		expect(response.statusCode).toBe(200);
		expect(fetch).not.toHaveBeenCalled();

		await server.close();
	});
});
