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

test("upgrades a database through migration 004 while preserving existing rows", () => {
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

test("migration runner is idempotent after applying registry migration", () => {
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
