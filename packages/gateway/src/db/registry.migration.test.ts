import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "./index.js";
import { migrate } from "./migrate.js";

let tempDbDir: string;
let db: Database.Database;

beforeEach(() => {
	tempDbDir = mkdtempSync(
		join(tmpdir(), "promptgate-registry-migration-test-"),
	);
	db = openDatabase(join(tempDbDir, "promptgate.db"));
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

function insertPrompt(slug: string): number {
	return (
		db
			.prepare("INSERT INTO prompts (slug) VALUES (?) RETURNING id")
			.get(slug) as { id: number }
	).id;
}

function insertVersion(promptId: number, version: number): void {
	db.prepare(
		`INSERT INTO prompt_versions (
			prompt_id, version, messages_json, variables_json
		) VALUES (?, ?, '[]', '[]')`,
	).run(promptId, version);
}

test("applies the registry schema with composite label integrity and immutable versions", () => {
	migrate(db);

	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('prompts', 'prompt_versions', 'prompt_labels', 'label_history') ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	expect(tables.map((row) => row.name)).toEqual([
		"label_history",
		"prompt_labels",
		"prompt_versions",
		"prompts",
	]);

	const labelForeignKeys = db
		.prepare("PRAGMA foreign_key_list(prompt_labels)")
		.all() as Array<{ table: string; from: string; to: string }>;
	expect(labelForeignKeys).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				table: "prompt_versions",
				from: "prompt_id",
				to: "prompt_id",
			}),
			expect.objectContaining({
				table: "prompt_versions",
				from: "version",
				to: "version",
			}),
		]),
	);

	const promptId = insertPrompt("safety_screen");
	insertVersion(promptId, 1);
	insertVersion(promptId, 2);
	const otherPromptId = insertPrompt("other_prompt");
	insertVersion(otherPromptId, 4);
	db.prepare(
		"INSERT INTO prompt_labels (prompt_id, label, version) VALUES (?, 'prod', 1)",
	).run(promptId);

	expect(() =>
		db
			.prepare(
				"INSERT INTO prompt_labels (prompt_id, label, version) VALUES (?, 'candidate', 3)",
			)
			.run(promptId),
	).toThrow(/FOREIGN KEY constraint failed/);
	expect(() =>
		db
			.prepare(
				"INSERT INTO prompt_labels (prompt_id, label, version) VALUES (?, 'other-version', 4)",
			)
			.run(promptId),
	).toThrow(/FOREIGN KEY constraint failed/);
	expect(() => insertPrompt("safety_screen")).toThrow(
		/UNIQUE constraint failed/,
	);
	expect(() => insertVersion(promptId, 1)).toThrow(/UNIQUE constraint failed/);

	expect(() =>
		db
			.prepare(
				"UPDATE prompt_versions SET notes = 'changed' WHERE prompt_id = ?",
			)
			.run(promptId),
	).toThrow("prompt_versions is immutable");
	expect(() =>
		db.prepare("DELETE FROM prompt_versions WHERE prompt_id = ?").run(promptId),
	).toThrow("prompt_versions is immutable");

	db.prepare(
		"UPDATE prompt_labels SET version = 2, updated_at = datetime('now', '+1 second') WHERE prompt_id = ? AND label = 'prod'",
	).run(promptId);
	expect(
		db
			.prepare(
				"SELECT version FROM prompt_labels WHERE prompt_id = ? AND label = 'prod'",
			)
			.get(promptId),
	).toEqual({ version: 2 });
});

test("upgrades a database through migration 005 while preserving existing rows", () => {
	for (const migration of [
		"001_core.sql",
		"002_request_identity.sql",
		"003_provider_pricing.sql",
	]) {
		db.exec(
			readFileSync(
				new URL(`./migrations/${migration}`, import.meta.url),
				"utf8",
			),
		);
	}
	db.exec(`CREATE TABLE _migrations (
		name TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	db.prepare("INSERT INTO _migrations (name) VALUES (?), (?), (?)").run(
		"001_core.sql",
		"002_request_identity.sql",
		"003_provider_pricing.sql",
	);
	db.prepare(
		`INSERT INTO api_keys (name, key_hash) VALUES ('legacy-key', 'legacy-hash')`,
	).run();

	migrate(db);

	expect(db.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({
		count: 1,
	});
	expect(
		db.prepare("SELECT name FROM _migrations ORDER BY name").all(),
	).toEqual([
		{ name: "001_core.sql" },
		{ name: "002_request_identity.sql" },
		{ name: "003_provider_pricing.sql" },
		{ name: "004_registry.sql" },
		{ name: "005_evals.sql" },
	]);
	expect(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
			)
			.all(),
	).toEqual([
		{ name: "prompt_versions_immutable" },
		{ name: "prompt_versions_no_delete" },
	]);
});

test("migration runner is idempotent after applying migrations through 005", () => {
	migrate(db);
	const before = db
		.prepare("SELECT name, applied_at FROM _migrations ORDER BY name")
		.all();

	migrate(db);

	expect(
		db.prepare("SELECT name, applied_at FROM _migrations ORDER BY name").all(),
	).toEqual(before);
	expect(
		db
			.prepare(
				"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'prompts'",
			)
			.get(),
	).toEqual({ count: 1 });
});

test("applies the eval schema with foreign-key and value constraints", () => {
	migrate(db);

	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('eval_datasets', 'eval_runs', 'eval_results') ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	expect(tables.map((row) => row.name)).toEqual([
		"eval_datasets",
		"eval_results",
		"eval_runs",
	]);
	expect(db.prepare("PRAGMA index_list(eval_runs)").all()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "idx_eval_runs_history" }),
		]),
	);

	const datasetId = (
		db
			.prepare(
				"INSERT INTO eval_datasets (slug, file_path) VALUES ('suite', 'suite.yaml') RETURNING id",
			)
			.get() as { id: number }
	).id;
	const insertRun = db.prepare(
		`INSERT INTO eval_runs (
			dataset_id, dataset_hash, model, trigger, cases_total, cases_passed,
			score_avg, cost_micro_usd, duration_ms
		) VALUES (
			@dataset_id, @dataset_hash, 'model', @trigger, @cases_total,
			@cases_passed, @score_avg, @cost_micro_usd, @duration_ms
		) RETURNING id`,
	);
	const validRun = {
		dataset_id: datasetId,
		dataset_hash: "a".repeat(64),
		trigger: "ci",
		cases_total: 1,
		cases_passed: 1,
		score_avg: 1,
		cost_micro_usd: 2,
		duration_ms: 3,
	};

	expect(() =>
		insertRun.get({ ...validRun, dataset_id: datasetId + 999 }),
	).toThrow(/FOREIGN KEY constraint failed/);
	expect(() => insertRun.get({ ...validRun, cases_total: 0 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertRun.get({ ...validRun, cases_passed: 2 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertRun.get({ ...validRun, score_avg: 1.1 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertRun.get({ ...validRun, trigger: "nightly" })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertRun.get({ ...validRun, cost_micro_usd: -1 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertRun.get({ ...validRun, duration_ms: -1 })).toThrow(
		/CHECK constraint failed/,
	);

	const runId = (insertRun.get(validRun) as { id: number }).id;
	const insertResult = db.prepare(
		`INSERT INTO eval_results (
			run_id, case_id, passed, score, detail_json, latency_ms, cost_micro_usd
		) VALUES (
			@run_id, 'case', @passed, @score, '{}', @latency_ms, @cost_micro_usd
		)`,
	);
	const validResult = {
		run_id: runId,
		passed: 1,
		score: 1,
		latency_ms: 1,
		cost_micro_usd: 2,
	};
	expect(() =>
		insertResult.run({ ...validResult, run_id: runId + 999 }),
	).toThrow(/FOREIGN KEY constraint failed/);
	expect(() => insertResult.run({ ...validResult, passed: 2 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertResult.run({ ...validResult, score: -0.1 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() => insertResult.run({ ...validResult, latency_ms: -1 })).toThrow(
		/CHECK constraint failed/,
	);
	expect(() =>
		insertResult.run({ ...validResult, cost_micro_usd: -1 }),
	).toThrow(/CHECK constraint failed/);
});
