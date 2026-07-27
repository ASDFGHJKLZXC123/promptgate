import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { sumCurrentMonthSettledSpend } from "./budget.dao.js";

let tempDbDir: string;
let db: Database.Database;
let firstKeyId: number;
let secondKeyId: number;

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-budget-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
	firstKeyId = insertKey("budget-first", "budget-first-hash");
	secondKeyId = insertKey("budget-second", "budget-second-hash");
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

function insertKey(name: string, hash: string): number {
	return (
		db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES (?, ?) RETURNING id",
			)
			.get(name, hash) as { id: number }
	).id;
}

function insertRequest(
	apiKeyId: number,
	costMicroUsd: number | null,
	status: string,
	tsExpression = "datetime('now')",
): void {
	db.prepare(
		`INSERT INTO requests (
			api_key_id, provider, model, cost_micro_usd, cost_estimated,
			total_ms, status, ts
		) VALUES (?, 'openai', 'gpt-budget-dao', ?, 0, 0, ?, ${tsExpression})`,
	).run(apiKeyId, costMicroUsd, status);
}

test("sums only one key's settled current-month costs and treats null/rejected/no rows as zero", () => {
	insertRequest(firstKeyId, 7, "ok");
	insertRequest(firstKeyId, null, "rejected_budget");
	insertRequest(firstKeyId, null, "provider_error");
	insertRequest(
		firstKeyId,
		99,
		"ok",
		"datetime('now', 'start of month', '-1 second')",
	);
	insertRequest(secondKeyId, 41, "ok");

	expect(sumCurrentMonthSettledSpend(db, firstKeyId)).toBe(7);
	expect(sumCurrentMonthSettledSpend(db, secondKeyId)).toBe(41);
	expect(sumCurrentMonthSettledSpend(db, 99_999)).toBe(0);
});
