import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	ASSERTIONS,
	AssertionInfrastructureError,
	evaluateCaseAssertions,
	type RubricEvaluator,
} from "./assertions.js";
import type { EvalTest, JsonValue } from "./dataset.js";

const temporaryDirectories: string[] = [];

function testCase(
	assert: EvalTest["assert"],
): Pick<EvalTest, "id" | "description" | "vars" | "assert"> {
	return {
		id: "case-1",
		description: "A test case",
		vars: { note: "safe" },
		assert,
	};
}

async function assertionFile(
	source: string,
	filename = "assertion.mjs",
): Promise<string> {
	const directory = join(
		tmpdir(),
		`promptgate-assert-${Date.now()}-${Math.random()}`,
	);
	temporaryDirectories.push(directory);
	await mkdir(directory, {
		recursive: true,
	});
	const path = join(directory, filename);
	await writeFile(path, source, "utf8");
	return path;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, {
				force: true,
				recursive: true,
			}),
		),
	);
});

const none: JsonValue = null;

describe("ASSERTIONS", () => {
	test("exposes exactly the documented eight assertion types", () => {
		expect(Object.keys(ASSERTIONS)).toEqual([
			"equals",
			"contains",
			"icontains",
			"regex",
			"is-json",
			"json-schema",
			"javascript",
			"llm-rubric",
		]);
	});

	test("uses raw exact equality for string targets and semantic JSON equality otherwise", async () => {
		expect(
			await ASSERTIONS.equals(" hello ", "hello", {} as never),
		).toMatchObject({ pass: false });
		expect(
			await ASSERTIONS.equals('{"a":[1,true]}', { a: [1, true] }, {} as never),
		).toMatchObject({ pass: true });
		expect(
			await ASSERTIONS.equals("not json", { a: 1 }, {} as never),
		).toMatchObject({ pass: false });
	});

	test("checks raw substrings, regexes, and every valid JSON value", async () => {
		expect(
			await ASSERTIONS.contains("AlphaBeta", "haB", {} as never),
		).toMatchObject({ pass: true });
		expect(
			await ASSERTIONS.icontains("AlphaBeta", "PHAB", {} as never),
		).toMatchObject({ pass: true });
		expect(
			await ASSERTIONS.regex("abc-42", "^abc-\\d+$", {} as never),
		).toMatchObject({ pass: true });
		await expect(
			ASSERTIONS.regex("anything", "[", {} as never),
		).rejects.toBeInstanceOf(AssertionInfrastructureError);
		for (const value of ["null", "true", "0", '"text"', "[]", "{}"] as const) {
			expect(
				await ASSERTIONS["is-json"](value, none, {} as never),
			).toMatchObject({ pass: true });
		}
	});

	test("treats output parsing/schema mismatch as quality failures and invalid schemas as infrastructure failures", async () => {
		const schema = {
			type: "object",
			required: ["risk"],
			properties: { risk: { const: "urgent" } },
		};
		expect(
			await ASSERTIONS["json-schema"]('{"risk":"low"}', schema, {} as never),
		).toMatchObject({ pass: false });
		expect(
			await ASSERTIONS["json-schema"]("not json", schema, {} as never),
		).toMatchObject({ pass: false });
		await expect(
			ASSERTIONS["json-schema"]("{}", { type: 4 }, {} as never),
		).rejects.toBeInstanceOf(AssertionInfrastructureError);
	});

	test("imports resolved ESM javascript defaults and validates strict return shapes", async () => {
		const passing = await assertionFile(
			"export default async (output, context) => ({ pass: output === 'ok' && context.vars.note === 'safe', score: 0.9, detail: 'checked' });",
		);
		const outcome = await ASSERTIONS.javascript("ok", passing, {
			caseId: "case-1",
			description: "A test case",
			vars: { note: "safe" },
		});
		expect(outcome).toEqual({ pass: true, score: 0.9, detail: "checked" });

		const invalid = await assertionFile(
			"export default () => ({ pass: true, extra: 'nope' });",
		);
		await expect(
			ASSERTIONS.javascript("ok", invalid, {
				caseId: "case-1",
				description: "A test case",
				vars: {},
			}),
		).rejects.toBeInstanceOf(AssertionInfrastructureError);
	});

	test("loads special-character assertion paths in the native Node runtime", async () => {
		const specialPath = await assertionFile(
			"export default (output) => output === 'ok';",
			"assertion#edge?.mjs",
		);
		const moduleUrl = pathToFileURL(
			resolve(process.cwd(), "packages/evals/dist/assertions.js"),
		).href;
		const runtime = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`const { ASSERTIONS } = await import(process.argv[1]);
const result = await ASSERTIONS.javascript("ok", process.argv[2], {
	caseId: "case-1",
	description: "A test case",
	vars: {},
});
process.stdout.write(JSON.stringify(result));`,
				moduleUrl,
				specialPath,
			],
			{ encoding: "utf8" },
		);
		expect(runtime.status, runtime.stderr).toBe(0);
		expect(JSON.parse(runtime.stdout)).toMatchObject({ pass: true });
	});

	test("classifies broken javascript modules as infrastructure failures", async () => {
		const context = {
			caseId: "case-1",
			description: "A test case",
			vars: {},
		};
		const noDefault = await assertionFile("export const value = true;");
		const throwing = await assertionFile(
			"export default () => { throw new Error('boom'); };",
		);
		for (const path of [
			join(tmpdir(), "promptgate-assert-does-not-exist.mjs"),
			noDefault,
			throwing,
		]) {
			await expect(
				ASSERTIONS.javascript("output", path, context),
			).rejects.toBeInstanceOf(AssertionInfrastructureError);
		}

		const qualityFailure = await assertionFile("export default () => false;");
		await expect(
			ASSERTIONS.javascript("output", qualityFailure, context),
		).resolves.toMatchObject({ pass: false });
	});

	test("rejects async JSON schemas instead of treating promises as passes", async () => {
		await expect(
			ASSERTIONS["json-schema"](
				"{}",
				{
					$async: true,
					type: "object",
					properties: { risk: { type: "string" } },
					required: ["risk"],
				},
				{} as never,
			),
		).rejects.toThrow("Async JSON schema assertions are not supported");
	});

	test("requires normalized, complete, strict rubric results", async () => {
		for (const invalidResult of [
			{ pass: true, detail: "missing score" },
			{ pass: true, score: 200, detail: "out of range" },
			{ pass: true, score: 0.5, detail: "   " },
			{ pass: true, score: 0.5, detail: "valid", extra: true },
		]) {
			const rubric = vi
				.fn()
				.mockResolvedValue(invalidResult) as unknown as RubricEvaluator;
			await expect(
				ASSERTIONS["llm-rubric"]("output", "rubric", {
					caseId: "case-1",
					description: "A test case",
					vars: {},
					rubric,
				}),
			).rejects.toBeInstanceOf(AssertionInfrastructureError);
		}
	});

	test("fails as infrastructure when no rubric evaluator is injected", async () => {
		await expect(
			ASSERTIONS["llm-rubric"]("output", "rubric", {
				caseId: "case-1",
				description: "A test case",
				vars: {},
			}),
		).rejects.toThrow("No rubric evaluator was supplied");
	});
});

describe("evaluateCaseAssertions", () => {
	test("executes deterministic assertions first in stable order and skips all later checks after the first failure", async () => {
		const rubric = vi.fn<RubricEvaluator>();
		const evaluation = await evaluateCaseAssertions(
			"plain output",
			testCase([
				{ type: "llm-rubric", value: "judge" },
				{ type: "contains", value: "missing" },
				{ type: "regex", value: "[" },
			]),
			{ rubric },
		);
		expect(evaluation.pass).toBe(false);
		expect(evaluation.score).toBeUndefined();
		expect(evaluation.assertions).toEqual([
			{ index: 0, type: "llm-rubric", executed: false, skipped: true },
			expect.objectContaining({
				index: 1,
				type: "contains",
				executed: true,
				skipped: false,
				pass: false,
			}),
			{ index: 2, type: "regex", executed: false, skipped: true },
		]);
		expect(rubric).not.toHaveBeenCalled();
	});

	test("runs rubric checks last, averages executed scores, and stops after failure", async () => {
		const rubric = vi
			.fn<RubricEvaluator>()
			.mockResolvedValueOnce({ pass: true, score: 0.8, detail: "first" })
			.mockResolvedValueOnce({ pass: false, score: 0.4, detail: "second" })
			.mockResolvedValueOnce({ pass: true, score: 1, detail: "must skip" });
		const evaluation = await evaluateCaseAssertions(
			'{"ok":true}',
			testCase([
				{ type: "llm-rubric", value: "first rubric" },
				{ type: "is-json" },
				{ type: "llm-rubric", value: "second rubric" },
				{ type: "llm-rubric", value: "third rubric" },
			]),
			{ rubric },
		);
		expect(rubric).toHaveBeenCalledTimes(2);
		expect(evaluation.pass).toBe(false);
		expect(evaluation.score).toBeCloseTo(0.6);
		expect(evaluation.assertions.map((assertion) => assertion.index)).toEqual([
			0, 1, 2, 3,
		]);
		expect(evaluation.assertions[1]).toMatchObject({
			executed: true,
			pass: true,
		});
		expect(evaluation.assertions[0]).toMatchObject({
			executed: true,
			score: 0.8,
		});
		expect(evaluation.assertions[3]).toEqual({
			index: 3,
			type: "llm-rubric",
			executed: false,
			skipped: true,
		});
	});

	test("does not expose deterministic javascript scores as case scores", async () => {
		const path = await assertionFile(
			"export default () => ({ pass: true, score: 0.1, detail: 'local' });",
		);
		const evaluation = await evaluateCaseAssertions(
			"output",
			testCase([
				{ type: "javascript", value: "file://assert.js", javascriptPath: path },
			]),
		);
		expect(evaluation.pass).toBe(true);
		expect(evaluation.score).toBeUndefined();
		expect(evaluation.assertions[0]).toMatchObject({ pass: true });
		expect(evaluation.assertions[0]?.score).toBeUndefined();
	});

	test("annotates typed infrastructure errors with the declared assertion index and type", async () => {
		await expect(
			evaluateCaseAssertions(
				"output",
				testCase([{ type: "regex", value: "[" }]),
			),
		).rejects.toMatchObject({
			name: "AssertionInfrastructureError",
			assertionIndex: 0,
			assertionType: "regex",
		});
	});
});
