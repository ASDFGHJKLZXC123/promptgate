import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import {
	findRequestUsageForKey,
	type InsertRequestLogInput,
	insertRequestLog,
} from "./requests.dao.js";

let tempDbDir: string;
let db: Database.Database;
let apiKeyId: number;

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-requests-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
	const row = db
		.prepare(
			"INSERT INTO api_keys (name, key_hash) VALUES ('dao-test-key', 'hash') RETURNING id",
		)
		.get() as { id: number };
	apiKeyId = row.id;
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

function baseInput(
	overrides: Partial<InsertRequestLogInput> = {},
): InsertRequestLogInput {
	return {
		requestId: "11111111-1111-4111-8111-111111111111",
		apiKeyId,
		provider: "openai",
		model: "gpt-test",
		cacheHit: false,
		streamed: false,
		costEstimated: false,
		totalMs: 12,
		status: "ok",
		...overrides,
	};
}

function countRows(): number {
	const row = db.prepare("SELECT COUNT(*) as count FROM requests").get() as {
		count: number;
	};
	return row.count;
}

test("inserts a row and persists the exact request_id", () => {
	insertRequestLog(db, baseInput());

	const row = db
		.prepare("SELECT request_id FROM requests WHERE request_id = ?")
		.get("11111111-1111-4111-8111-111111111111") as { request_id: string };
	expect(row.request_id).toBe("11111111-1111-4111-8111-111111111111");
});

test("persists a complete prompt attribution pair", () => {
	insertRequestLog(db, baseInput({ promptId: 7, promptVersion: 3 }));

	expect(
		db.prepare("SELECT prompt_id, prompt_version FROM requests").get(),
	).toEqual({ prompt_id: 7, prompt_version: 3 });
});

test("rejects a partial or invalid prompt attribution before touching SQL", () => {
	expect(() => insertRequestLog(db, baseInput({ promptId: 7 }))).toThrow();
	expect(() =>
		insertRequestLog(db, baseInput({ promptId: 0, promptVersion: 1 })),
	).toThrow();
	expect(countRows()).toBe(0);
});

test("rejects a missing request_id before touching SQL", () => {
	expect(() =>
		insertRequestLog(db, {
			...baseInput(),
			requestId: undefined as unknown as string,
		}),
	).toThrow();
	expect(countRows()).toBe(0);
});

test("rejects a non-UUID request_id before touching SQL", () => {
	expect(() =>
		insertRequestLog(db, { ...baseInput(), requestId: "not-a-uuid" }),
	).toThrow();
	expect(countRows()).toBe(0);
});

test("rejects an empty-string request_id before touching SQL", () => {
	expect(() =>
		insertRequestLog(db, { ...baseInput(), requestId: "" }),
	).toThrow();
	expect(countRows()).toBe(0);
});

test("enforces uniqueness of request_id via the migration 002 partial unique index", () => {
	insertRequestLog(db, baseInput());

	expect(() => insertRequestLog(db, baseInput())).toThrow();
	expect(countRows()).toBe(1);
});

test("allows multiple legacy NULL request_id rows to coexist (pre-migration-002 compatibility)", () => {
	db.prepare(
		"INSERT INTO requests (api_key_id, provider, model, status) VALUES (?, 'openai', 'gpt-test', 'ok')",
	).run(apiKeyId);
	db.prepare(
		"INSERT INTO requests (api_key_id, provider, model, status) VALUES (?, 'openai', 'gpt-test', 'ok')",
	).run(apiKeyId);

	expect(countRows()).toBe(2);
});

test("migrations 002 and 003 upgrade an already-applied 001 database without losing legacy rows", () => {
	const legacyDb = openDatabase(join(tempDbDir, "legacy-001.db"));
	try {
		legacyDb.exec(
			readFileSync(
				new URL("../db/migrations/001_core.sql", import.meta.url),
				"utf8",
			),
		);
		legacyDb.exec(`CREATE TABLE _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		legacyDb
			.prepare("INSERT INTO _migrations (name) VALUES ('001_core.sql')")
			.run();
		const legacyKey = legacyDb
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES ('legacy-key', 'legacy-hash') RETURNING id",
			)
			.get() as { id: number };
		legacyDb
			.prepare(
				"INSERT INTO requests (api_key_id, provider, model, status) VALUES (?, 'openai', 'gpt-test', 'ok')",
			)
			.run(legacyKey.id);

		migrate(legacyDb);

		const legacyRow = legacyDb
			.prepare("SELECT request_id, model FROM requests")
			.get() as { request_id: string | null; model: string };
		expect(legacyRow).toEqual({ request_id: null, model: "gpt-test" });
		const applied = legacyDb
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all() as Array<{ name: string }>;
		expect(applied.map((row) => row.name)).toEqual([
			"001_core.sql",
			"002_request_identity.sql",
			"003_provider_pricing.sql",
			"004_registry.sql",
			"005_evals.sql",
		]);
	} finally {
		legacyDb.close();
	}
});

test("migration 003 preserves pricing rows from an already-applied 002 database", () => {
	const legacyDb = openDatabase(join(tempDbDir, "legacy-002.db"));
	try {
		for (const migration of ["001_core.sql", "002_request_identity.sql"]) {
			legacyDb.exec(
				readFileSync(
					new URL(`../db/migrations/${migration}`, import.meta.url),
					"utf8",
				),
			);
		}
		legacyDb.exec(`CREATE TABLE _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		legacyDb
			.prepare("INSERT INTO _migrations (name) VALUES (?), (?)")
			.run("001_core.sql", "002_request_identity.sql");
		legacyDb
			.prepare(
				`INSERT INTO model_pricing (
					provider, model, input_micro_usd_per_mtok,
					output_micro_usd_per_mtok, effective_from
				) VALUES ('openai', 'gpt-legacy', 1000000, 2000000, '2020-01-01')`,
			)
			.run();

		migrate(legacyDb);

		const pricing = legacyDb
			.prepare(
				`SELECT model, input_micro_usd_per_mtok,
					cached_input_micro_usd_per_mtok,
					output_micro_usd_per_mtok
				 FROM model_pricing WHERE model = 'gpt-legacy'`,
			)
			.get();
		expect(pricing).toEqual({
			model: "gpt-legacy",
			input_micro_usd_per_mtok: 1_000_000,
			cached_input_micro_usd_per_mtok: null,
			output_micro_usd_per_mtok: 2_000_000,
		});
		const applied = legacyDb
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all() as Array<{ name: string }>;
		expect(applied.map((row) => row.name)).toEqual([
			"001_core.sql",
			"002_request_identity.sql",
			"003_provider_pricing.sql",
			"004_registry.sql",
			"005_evals.sql",
		]);
	} finally {
		legacyDb.close();
	}
});

test("stores optional fields as NULL when omitted and preserves feature/status/error_code", () => {
	insertRequestLog(
		db,
		baseInput({
			requestId: "22222222-2222-4222-8222-222222222222",
			status: "rejected_unknown_model",
			errorCode: "unknown_model",
			feature: "inbox_summary",
		}),
	);

	const row = db
		.prepare("SELECT * FROM requests WHERE request_id = ?")
		.get("22222222-2222-4222-8222-222222222222") as Record<string, unknown>;

	expect(row.status).toBe("rejected_unknown_model");
	expect(row.error_code).toBe("unknown_model");
	expect(row.feature).toBe("inbox_summary");
	expect(row.input_tokens).toBeNull();
	expect(row.output_tokens).toBeNull();
	expect(row.cost_micro_usd).toBeNull();
});

describe("findRequestUsageForKey", () => {
	test("returns only the safe usage projection for the owning key", () => {
		insertRequestLog(
			db,
			baseInput({
				streamed: true,
				inputTokens: 12,
				outputTokens: 7,
				costMicroUsd: 34,
				costEstimated: false,
			}),
		);

		expect(
			findRequestUsageForKey(db, {
				requestId: "11111111-1111-4111-8111-111111111111",
				apiKeyId,
			}),
		).toEqual({
			request_id: "11111111-1111-4111-8111-111111111111",
			model: "gpt-test",
			streamed: true,
			input_tokens: 12,
			output_tokens: 7,
			cost_micro_usd: 34,
			cost_estimated: false,
			status: "ok",
		});
	});

	test("preserves nullable metering fields and normalizes SQLite booleans", () => {
		insertRequestLog(
			db,
			baseInput({
				requestId: "22222222-2222-4222-8222-222222222222",
				streamed: false,
				costEstimated: true,
				status: "client_aborted",
			}),
		);

		expect(
			findRequestUsageForKey(db, {
				requestId: "22222222-2222-4222-8222-222222222222",
				apiKeyId,
			}),
		).toMatchObject({
			streamed: false,
			input_tokens: null,
			output_tokens: null,
			cost_micro_usd: null,
			cost_estimated: true,
			status: "client_aborted",
		});
	});

	test("uses the request_id and api_key_id ownership predicate", () => {
		insertRequestLog(db, baseInput());
		const otherKey = db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES ('other-key', 'other-hash') RETURNING id",
			)
			.get() as { id: number };

		expect(
			findRequestUsageForKey(db, {
				requestId: "11111111-1111-4111-8111-111111111111",
				apiKeyId: otherKey.id,
			}),
		).toBeNull();
	});
});
