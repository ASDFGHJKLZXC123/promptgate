import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import {
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

test("migration 002 upgrades an already-applied 001 database without losing legacy rows", () => {
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
