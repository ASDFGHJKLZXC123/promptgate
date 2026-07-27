import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatRequest, PgVarsSchema } from "@promptgate/shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { resolvePromptRequest } from "./prompt-resolve.js";

let db: Database.Database;
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "promptgate-prompt-resolve-"));
	db = openDatabase(join(directory, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
	return {
		model: "gpt-test",
		messages: [{ role: "user", content: "Client context" }],
		...overrides,
	};
}

function seedPrompt(
	messages: unknown,
	variables: unknown,
	label = "prod",
): { promptId: number; version: number } {
	const prompt = db
		.prepare("INSERT INTO prompts (slug) VALUES ('welcome') RETURNING id")
		.get() as { id: number };
	db.prepare(
		`INSERT INTO prompt_versions (prompt_id, version, messages_json, variables_json)
		 VALUES (?, 1, ?, ?)`,
	).run(prompt.id, JSON.stringify(messages), JSON.stringify(variables));
	db.prepare(
		"INSERT INTO prompt_labels (prompt_id, label, version) VALUES (?, ?, 1)",
	).run(prompt.id, label);
	return { promptId: prompt.id, version: 1 };
}

describe("resolvePromptRequest", () => {
	test("prepends rendered text messages and preserves escape/nonrecursive behavior", () => {
		const seeded = seedPrompt(
			[
				{
					role: "system",
					content: "Use \\{{literal}} for {{name}}; {{value}}",
				},
				{ role: "developer", content: [{ type: "text", text: "unchanged" }] },
			],
			[
				{ name: "name", required: true },
				{ name: "value", required: true },
			],
		);
		const result = resolvePromptRequest(
			db,
			request({
				pg_prompt: "welcome@prod",
				pg_vars: { name: "Ada", value: "{{name}}" },
			}),
		);

		expect(result).toMatchObject({
			ok: true,
			promptRef: { promptId: seeded.promptId, promptVersion: seeded.version },
		});
		if (result.ok) {
			expect(result.body.messages).toEqual([
				{ role: "system", content: "Use {{literal}} for Ada; {{name}}" },
				{ role: "developer", content: [{ type: "text", text: "unchanged" }] },
				{ role: "user", content: "Client context" },
			]);
		}
	});

	test("reports only required declarations in declaration order when absent or non-string", () => {
		seedPrompt(
			[{ role: "system", content: "{{optional}} {{undeclared}}" }],
			[
				{ name: "zeta", required: true },
				{ name: "alpha", required: true },
				{ name: "optional", required: false },
			],
		);
		const result = resolvePromptRequest(
			db,
			request({ pg_prompt: "welcome@1", pg_vars: { zeta: 4, optional: 3 } }),
		);

		expect(result).toMatchObject({
			ok: false,
			code: "prompt_var_missing",
			message: "Missing prompt variables: zeta, alpha.",
		});
	});

	test("keeps optional and undeclared unresolved placeholders literal", () => {
		seedPrompt(
			[{ role: "system", content: "{{optional}} {{undeclared}}" }],
			[{ name: "optional", required: false }],
		);
		const result = resolvePromptRequest(
			db,
			request({ pg_prompt: "welcome@1", pg_vars: { optional: 7 } }),
		);

		expect(result).toMatchObject({ ok: true });
		if (result.ok) {
			expect(result.body.messages[0]).toMatchObject({
				content: "{{optional}} {{undeclared}}",
			});
		}
	});

	test("renders an own __proto__ variable without prototype mutation", () => {
		seedPrompt(
			[{ role: "system", content: "Hello {{__proto__}}" }],
			[{ name: "__proto__", required: true }],
		);
		const jsonVars: unknown = JSON.parse('{"__proto__":"Ada"}');
		const vars = PgVarsSchema.parse(jsonVars);
		const result = resolvePromptRequest(
			db,
			request({ pg_prompt: "welcome@1", pg_vars: vars }),
		);

		expect(result).toMatchObject({ ok: true });
		if (result.ok) {
			expect(result.body.messages[0]).toMatchObject({ content: "Hello Ada" });
		}
	});

	test("returns a safe provider error with attribution for corrupt stored JSON", () => {
		const seeded = seedPrompt(
			[{ role: "system", content: "ok" }],
			[{ name: "name", required: true }],
		);
		// Simulate an out-of-band damaged database; normal registry writes remain
		// protected by the migration trigger.
		db.exec("DROP TRIGGER prompt_versions_immutable");
		db.prepare(
			"UPDATE prompt_versions SET messages_json = 'not-json' WHERE prompt_id = ?",
		).run(seeded.promptId);
		const result = resolvePromptRequest(
			db,
			request({ pg_prompt: "welcome@1", pg_vars: { name: "Ada" } }),
		);

		expect(result).toMatchObject({
			ok: false,
			code: "provider_error",
			promptRef: { promptId: seeded.promptId, promptVersion: seeded.version },
		});
	});
});
