import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	DatasetLoadError,
	loadDataset,
	slugifyDescription,
} from "./dataset.js";

const temporaryDirectories: string[] = [];

function createDataset(
	contents: string,
	extraFiles: Record<string, string> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "promptgate-evals-"));
	temporaryDirectories.push(directory);
	const datasetPath = join(directory, "dataset.yaml");
	writeFileSync(datasetPath, contents);
	for (const [relativePath, source] of Object.entries(extraFiles)) {
		const target = join(directory, relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, source);
	}
	return { directory, datasetPath };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

const validDataset = `description: Safety checks
prompts:
  - safety_screen@candidate
providers:
  - gemini-2.5-flash
defaultTest:
  threshold: 0.8
tests:
  - description: Escalates urgent risk
    vars:
      note: hello
    assert:
      - type: is-json
      - type: javascript
        value: file://asserts/escalates.js
`;

describe("evaluation dataset loader", () => {
	test("loads valid YAML, hashes exact bytes, and resolves javascript files", async () => {
		const { directory, datasetPath } = createDataset(validDataset, {
			"asserts/escalates.js": "export default () => true;\n",
		});
		const dataset = await loadDataset(datasetPath);

		expect(dataset.datasetHash).toBe(
			createHash("sha256").update(validDataset).digest("hex"),
		);
		expect(dataset.defaultTest.threshold).toBe(0.8);
		expect(dataset.tests[0]).toMatchObject({ id: "escalates-urgent-risk" });
		expect(dataset.tests[0]?.assert[1]?.javascriptPath).toBe(
			resolve(directory, "asserts/escalates.js"),
		);
	});

	test("preserves explicit IDs and deterministically suffixes generated collisions", async () => {
		const { datasetPath } = createDataset(`description: IDs
prompts: [safety_screen@candidate]
providers: [gemini-2.5-flash]
defaultTest: { threshold: 0.8 }
tests:
  - description: Explicit case
    vars: {}
    assert: [{ type: contains, value: ok }]
  - id: explicit-case
    description: Reserved explicit ID
    vars: {}
    assert: [{ type: contains, value: ok }]
  - description: Explicit case
    vars: {}
    assert: [{ type: contains, value: ok }]
`);
		const dataset = await loadDataset(datasetPath);

		expect(dataset.tests.map((test) => test.id)).toEqual([
			"explicit-case-2",
			"explicit-case",
			"explicit-case-3",
		]);
		expect(dataset.warnings).toEqual([
			'Test ID collision for "explicit-case"; assigned deterministic ID "explicit-case-2".',
			'Test ID collision for "explicit-case"; assigned deterministic ID "explicit-case-3".',
		]);
	});

	test("rejects duplicate explicit IDs rather than silently rewriting them", async () => {
		const { datasetPath } = createDataset(`description: IDs
prompts: [safety_screen@candidate]
providers: [gemini-2.5-flash]
defaultTest: { threshold: 0.8 }
tests:
  - id: stable-case
    description: First
    vars: {}
    assert: [{ type: contains, value: ok }]
  - id: stable-case
    description: Second
    vars: {}
    assert: [{ type: contains, value: ok }]
`);

		await expect(loadDataset(datasetPath)).rejects.toThrow(
			'Duplicate explicit test ID "stable-case"',
		);
	});

	test("accepts every supported assertion type", async () => {
		const { datasetPath } = createDataset(
			`description: All assertions
prompts: [safety_screen@1]
providers: [deepseek-v4-flash]
defaultTest: { threshold: 0 }
tests:
  - description: all
    vars: {}
    assert:
      - { type: equals, value: value }
      - { type: contains, value: value }
      - { type: icontains, value: value }
      - { type: regex, value: value }
      - { type: is-json }
      - { type: json-schema, value: {} }
      - { type: javascript, value: file://assert.js }
      - { type: llm-rubric, value: rubric }
`,
			{ "assert.js": "export default () => true;" },
		);

		const dataset = await loadDataset(datasetPath);
		expect(dataset.tests[0]?.assert.map((assertion) => assertion.type)).toEqual(
			[
				"equals",
				"contains",
				"icontains",
				"regex",
				"is-json",
				"json-schema",
				"javascript",
				"llm-rubric",
			],
		);
	});

	test("rejects unknown fields, malformed registry refs, and misplaced thresholds", async () => {
		const cases = [
			validDataset.replace(
				"description: Safety checks",
				"description: Safety checks\nextra: nope",
			),
			validDataset.replace("safety_screen@candidate", "safety_screen"),
			validDataset.replace(
				"defaultTest:\n  threshold: 0.8",
				"defaultTest:\n  options:\n    threshold: 0.8",
			),
			validDataset.replace("threshold: 0.8", "threshold: 1.1"),
		];
		for (const contents of cases) {
			const { datasetPath } = createDataset(contents, {
				"asserts/escalates.js": "export default () => true;",
			});
			await expect(loadDataset(datasetPath)).rejects.toBeInstanceOf(
				DatasetLoadError,
			);
		}
	});

	test("validates JSON-safe variables and assertion-specific values", async () => {
		const invalidAssertions = [
			"{ type: equals }",
			"{ type: contains, value: 42 }",
			"{ type: icontains, value: false }",
			"{ type: regex, value: {} }",
			"{ type: is-json, value: extra }",
			"{ type: json-schema, value: schema }",
			"{ type: llm-rubric, value: '' }",
			"{ type: llm-rubric, value: '   ' }",
		];
		for (const assertion of invalidAssertions) {
			const { datasetPath } = createDataset(`description: Invalid assertion
prompts: [safety_screen@candidate]
providers: [gemini-2.5-flash]
defaultTest: { threshold: 0.8 }
tests:
  - description: invalid
    vars: {}
    assert: [${assertion}]
`);
			await expect(loadDataset(datasetPath)).rejects.toBeInstanceOf(
				DatasetLoadError,
			);
		}

		const { datasetPath } = createDataset(`description: Invalid variables
prompts: [safety_screen@candidate]
providers: [gemini-2.5-flash]
defaultTest: { threshold: 0.8 }
tests:
  - description: invalid
    vars:
      invalid_number: .nan
    assert: [{ type: is-json }]
`);
		await expect(loadDataset(datasetPath)).rejects.toBeInstanceOf(
			DatasetLoadError,
		);
	});

	test("preserves prototype-like variable keys without polluting prototypes", async () => {
		const { datasetPath } = createDataset(`description: Prototype-like keys
prompts: [safety_screen@candidate]
providers: [gemini-2.5-flash]
defaultTest: { threshold: 0.8 }
tests:
  - description: preserved
    vars:
      __proto__:
        polluted: true
      constructor: ok
    assert: [{ type: equals, value: { __proto__: safe } }]
`);
		const dataset = await loadDataset(datasetPath);
		const testCase = dataset.tests[0];

		expect(testCase).toBeDefined();
		expect(Object.hasOwn(testCase?.vars ?? {}, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(testCase?.vars ?? {}, "__proto__")?.value,
		).toEqual({ polluted: true });
		expect(testCase?.vars.constructor).toBe("ok");
		const assertion = testCase?.assert[0];
		expect(assertion?.type).toBe("equals");
		if (assertion?.type !== "equals") {
			throw new Error("Expected equals assertion.");
		}
		if (
			typeof assertion.value !== "object" ||
			assertion.value === null ||
			Array.isArray(assertion.value)
		) {
			throw new Error("Expected object equality value.");
		}
		expect(Object.hasOwn(assertion.value, "__proto__")).toBe(true);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	test("rejects javascript paths that do not name a relative regular file", async () => {
		for (const value of [
			"file://asserts/missing.js",
			"file:///tmp/assert.js",
			"file://asserts",
		]) {
			const { datasetPath } = createDataset(
				validDataset.replace("file://asserts/escalates.js", value),
				value === "file://asserts" ? { "asserts/nested.txt": "" } : {},
			);
			await expect(loadDataset(datasetPath)).rejects.toBeInstanceOf(
				DatasetLoadError,
			);
		}
	});

	test("slugifies descriptions into stable IDs with a safe fallback", () => {
		expect(slugifyDescription("  Café / Safety! ")).toBe("cafe-safety");
		expect(slugifyDescription("---")).toBe("case");
		expect(slugifyDescription("x".repeat(140))).toHaveLength(120);
	});
});
