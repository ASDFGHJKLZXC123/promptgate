import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { addVersion, createPrompt, resolveRef, setLabel } from "./dao.js";

let tempDbDir: string;
let db: Database.Database;

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-registry-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

const messages = [{ role: "system", content: "Be concise." }];
const variables = [{ name: "tone", required: true }];

function versionCount(promptId: number): number {
	return (
		db
			.prepare(
				"SELECT COUNT(*) AS count FROM prompt_versions WHERE prompt_id = ?",
			)
			.get(promptId) as { count: number }
	).count;
}

function labelHistoryCount(): number {
	return (
		db.prepare("SELECT COUNT(*) AS count FROM label_history").get() as {
			count: number;
		}
	).count;
}

describe("prompt registry DAO", () => {
	test("creates prompts and leaves a duplicate slug entirely to the database", () => {
		const prompt = createPrompt(db, "greet", "Greeting instructions");

		expect(prompt).toEqual({
			id: expect.any(Number),
			slug: "greet",
			description: "Greeting instructions",
		});
		expect(() => createPrompt(db, "greet", "Duplicate")).toThrow(
			/UNIQUE constraint failed/,
		);
		expect(
			db.prepare("SELECT slug, description FROM prompts ORDER BY id").all(),
		).toEqual([{ slug: "greet", description: "Greeting instructions" }]);
	});

	test("numbers versions monotonically and independently for each prompt", () => {
		const first = createPrompt(db, "greet");
		const second = createPrompt(db, "summarize");

		expect(addVersion(db, first.id, messages, variables, "first").version).toBe(
			1,
		);
		expect(addVersion(db, second.id, messages, variables).version).toBe(1);
		expect(
			addVersion(db, first.id, messages, variables, "second").version,
		).toBe(2);
		expect(
			db
				.prepare(
					"SELECT prompt_id, version FROM prompt_versions ORDER BY prompt_id, version",
				)
				.all(),
		).toEqual([
			{ prompt_id: first.id, version: 1 },
			{ prompt_id: first.id, version: 2 },
			{ prompt_id: second.id, version: 1 },
		]);
	});

	test("rolls back a failed version append without allocating or modifying a version", () => {
		const prompt = createPrompt(db, "greet");
		addVersion(db, prompt.id, messages, variables);

		expect(() => addVersion(db, prompt.id + 999, messages, variables)).toThrow(
			/FOREIGN KEY constraint failed/,
		);
		expect(versionCount(prompt.id)).toBe(1);
		expect(addVersion(db, prompt.id, messages, variables).version).toBe(2);
	});

	test("preserves JSON exactly through a version write and reference read", () => {
		const prompt = createPrompt(db, "json-round-trip");
		const storedMessages = [
			{ content: "Use {{tone}}", role: "system", metadata: { retries: 2 } },
		];
		const storedVariables = [{ default: null, name: "tone", required: true }];
		const added = addVersion(db, prompt.id, storedMessages, storedVariables);

		expect(added.messages_json).toBe(JSON.stringify(storedMessages));
		expect(added.variables_json).toBe(JSON.stringify(storedVariables));
		expect(resolveRef(db, "json-round-trip@1")).toEqual({
			promptId: prompt.id,
			version: 1,
			messages_json: JSON.stringify(storedMessages),
			variables_json: JSON.stringify(storedVariables),
		});
	});

	test("never provides a DAO path to mutate immutable version content", () => {
		const prompt = createPrompt(db, "immutable");
		addVersion(db, prompt.id, messages, variables, "original");

		expect(() =>
			db
				.prepare(
					"UPDATE prompt_versions SET notes = 'changed' WHERE prompt_id = ?",
				)
				.run(prompt.id),
		).toThrow("prompt_versions is immutable");
		expect(() =>
			db
				.prepare("DELETE FROM prompt_versions WHERE prompt_id = ?")
				.run(prompt.id),
		).toThrow("prompt_versions is immutable");
		expect(resolveRef(db, "immutable@1")).toMatchObject({
			messages_json: JSON.stringify(messages),
			variables_json: JSON.stringify(variables),
		});
	});

	test("deploys and moves labels while preserving an append-only history", () => {
		const prompt = createPrompt(db, "greet");
		addVersion(db, prompt.id, messages, variables);
		addVersion(
			db,
			prompt.id,
			[{ role: "system", content: "Be warm." }],
			variables,
		);

		expect(setLabel(db, prompt.id, "prod", 1)).toEqual({
			promptId: prompt.id,
			label: "prod",
			fromVersion: null,
			toVersion: 1,
		});
		db.prepare(
			"UPDATE prompt_labels SET updated_at = '2000-01-01 00:00:00' WHERE prompt_id = ? AND label = 'prod'",
		).run(prompt.id);
		expect(setLabel(db, prompt.id, "prod", 2)).toEqual({
			promptId: prompt.id,
			label: "prod",
			fromVersion: 1,
			toVersion: 2,
		});
		db.prepare(
			"UPDATE prompt_labels SET updated_at = '2000-01-01 00:00:00' WHERE prompt_id = ? AND label = 'prod'",
		).run(prompt.id);
		expect(setLabel(db, prompt.id, "prod", 2)).toEqual({
			promptId: prompt.id,
			label: "prod",
			fromVersion: 2,
			toVersion: 2,
		});

		expect(
			db
				.prepare(
					"SELECT version, updated_at FROM prompt_labels WHERE prompt_id = ? AND label = 'prod'",
				)
				.get(prompt.id),
		).toEqual({ version: 2, updated_at: expect.not.stringMatching(/^2000-/) });
		expect(
			db
				.prepare(
					"SELECT prompt_id, label, from_version, to_version FROM label_history ORDER BY id",
				)
				.all(),
		).toEqual([
			{
				prompt_id: prompt.id,
				label: "prod",
				from_version: null,
				to_version: 1,
			},
			{ prompt_id: prompt.id, label: "prod", from_version: 1, to_version: 2 },
			{ prompt_id: prompt.id, label: "prod", from_version: 2, to_version: 2 },
		]);
	});

	test("rolls a label pointer back when its history insert fails", () => {
		const prompt = createPrompt(db, "greet");
		addVersion(db, prompt.id, messages, variables);
		addVersion(db, prompt.id, messages, variables);
		setLabel(db, prompt.id, "prod", 1);
		db.exec(`
			CREATE TRIGGER reject_label_history BEFORE INSERT ON label_history
			BEGIN SELECT RAISE(ABORT, 'label history rejected'); END;
		`);

		expect(() => setLabel(db, prompt.id, "prod", 2)).toThrow(
			"label history rejected",
		);
		expect(
			db
				.prepare(
					"SELECT version FROM prompt_labels WHERE prompt_id = ? AND label = 'prod'",
				)
				.get(prompt.id),
		).toEqual({ version: 1 });
		expect(labelHistoryCount()).toBe(1);
	});

	test("rolls back a dangling or cross-prompt label move without history", () => {
		const first = createPrompt(db, "first");
		const second = createPrompt(db, "second");
		addVersion(db, first.id, messages, variables);
		addVersion(db, second.id, messages, variables);
		addVersion(db, second.id, messages, variables);
		setLabel(db, first.id, "prod", 1);

		// Version 2 exists, but only under `second`; the composite FK must reject
		// pointing `first` at it.
		expect(() => setLabel(db, first.id, "prod", 2)).toThrow(
			/FOREIGN KEY constraint failed/,
		);
		expect(() => setLabel(db, first.id, "candidate", 1_000)).toThrow(
			/FOREIGN KEY constraint failed/,
		);
		expect(
			db
				.prepare(
					"SELECT label, version FROM prompt_labels WHERE prompt_id = ? ORDER BY label",
				)
				.all(first.id),
		).toEqual([{ label: "prod", version: 1 }]);
		expect(labelHistoryCount()).toBe(1);
	});

	test("resolves numeric versions and labels, with every invalid ref a read-only miss", () => {
		const prompt = createPrompt(db, "greet");
		addVersion(
			db,
			prompt.id,
			[{ role: "system", content: "version one" }],
			variables,
		);
		addVersion(
			db,
			prompt.id,
			[{ role: "system", content: "version two" }],
			variables,
		);
		setLabel(db, prompt.id, "prod", 2);

		expect(resolveRef(db, "greet@1")).toMatchObject({
			promptId: prompt.id,
			version: 1,
		});
		expect(resolveRef(db, "greet@prod")).toMatchObject({
			promptId: prompt.id,
			version: 2,
		});

		const before = {
			labels: db.prepare("SELECT COUNT(*) AS count FROM prompt_labels").get(),
			history: labelHistoryCount(),
		};
		for (const ref of [
			"",
			"greet",
			"@prod",
			"greet@",
			"greet@prod@extra",
			"missing@prod",
			"greet@999",
			"greet@9007199254740992",
		]) {
			expect(resolveRef(db, ref)).toBeNull();
		}
		expect({
			labels: db.prepare("SELECT COUNT(*) AS count FROM prompt_labels").get(),
			history: labelHistoryCount(),
		}).toEqual(before);
	});
});
