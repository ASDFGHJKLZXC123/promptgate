import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const ASSERTION_TYPES = [
	"equals",
	"contains",
	"icontains",
	"regex",
	"is-json",
	"json-schema",
	"javascript",
	"llm-rubric",
] as const;

export const AssertionTypeSchema = z.enum(ASSERTION_TYPES);

/** A registry ref is exactly one non-empty slug@label or slug@positive-version. */
export const PromptRefSchema = z.string().superRefine((value, context) => {
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) {
		context.addIssue({
			code: "custom",
			message: "Prompt references must be slug@label or slug@positive-version.",
		});
		return;
	}

	const target = value.slice(at + 1);
	if (/^[1-9]\d*$/.test(target) && !Number.isSafeInteger(Number(target))) {
		context.addIssue({
			code: "custom",
			message: "Prompt version references must be safe positive integers.",
		});
	}
});

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

function isJsonValue(
	value: unknown,
	ancestors: WeakSet<object> = new WeakSet(),
): value is JsonValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (
		typeof value !== "object" ||
		Object.getOwnPropertySymbols(value).length > 0
	) {
		return false;
	}
	if (ancestors.has(value)) {
		return false;
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const keys = Object.keys(value);
			return (
				keys.length === value.length &&
				keys.every((key, index) => key === String(index)) &&
				value.every((item) => isJsonValue(item, ancestors))
			);
		}

		const prototype = Object.getPrototypeOf(value);
		return (
			(prototype === Object.prototype || prototype === null) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors))
		);
	} finally {
		ancestors.delete(value);
	}
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) && isJsonValue(value)
	);
}

/** Validates JSON recursively while preserving the caller's own object keys. */
export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, {
	message: "Expected a JSON-safe value.",
});
const JsonRecordSchema = z.custom<{ [key: string]: JsonValue }>(isJsonRecord, {
	message: "Expected a JSON-safe object.",
});

const variablesSchema = JsonRecordSchema;
const stringAssertionValueSchema = z.string().min(1);
const rubricAssertionValueSchema = z
	.string()
	.refine((value) => value.trim().length > 0, "Rubric text must not be blank.");
const fileAssertionValueSchema = z
	.string()
	.regex(
		/^file:\/\/.+/,
		"javascript assertions require a non-empty file:// value.",
	);
const jsonSchemaValueSchema = JsonRecordSchema;

const assertionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("equals"), value: JsonValueSchema }).strict(),
	z
		.object({
			type: z.literal("contains"),
			value: stringAssertionValueSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("icontains"),
			value: stringAssertionValueSchema,
		})
		.strict(),
	z
		.object({ type: z.literal("regex"), value: stringAssertionValueSchema })
		.strict(),
	z.object({ type: z.literal("is-json") }).strict(),
	z
		.object({ type: z.literal("json-schema"), value: jsonSchemaValueSchema })
		.strict(),
	z
		.object({
			type: z.literal("javascript"),
			value: fileAssertionValueSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("llm-rubric"),
			value: rubricAssertionValueSchema,
		})
		.strict(),
]);

const testSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(120)
			.regex(
				/^[A-Za-z0-9][A-Za-z0-9._-]*$/,
				"Test IDs must be persistence-safe.",
			)
			.optional(),
		description: z.string().trim().min(1),
		vars: variablesSchema,
		assert: z.array(assertionSchema).min(1),
	})
	.strict();

/** Strict promptfoo-compatible subset documented in IMPLEMENTATION_GUIDE.md §7.1. */
export const DatasetSchema = z
	.object({
		description: z.string().trim().min(1),
		prompts: z.array(PromptRefSchema).min(1),
		providers: z.array(z.string().trim().min(1)).min(1),
		defaultTest: z
			.object({ threshold: z.number().min(0).max(1).finite() })
			.strict(),
		tests: z.array(testSchema).min(1),
	})
	.strict();

type ParsedDataset = z.infer<typeof DatasetSchema>;
export type EvalAssertion = z.infer<typeof assertionSchema> & {
	/** Absolute path for a first-party javascript assertion file. */
	javascriptPath?: string;
};

export interface EvalTest {
	id: string;
	description: string;
	vars: Readonly<Record<string, JsonValue>>;
	assert: readonly EvalAssertion[];
}

export interface LoadedDataset {
	path: string;
	datasetHash: string;
	description: string;
	prompts: readonly string[];
	providers: readonly string[];
	defaultTest: { threshold: number };
	tests: readonly EvalTest[];
	warnings: readonly string[];
}

export class DatasetLoadError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DatasetLoadError";
	}
}

function slugifyDescription(description: string): string {
	const slug = description
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, 120).replace(/-+$/g, "") || "case";
}

function assignTestIds(tests: readonly ParsedDataset["tests"][number][]): {
	tests: EvalTest[];
	warnings: string[];
} {
	const explicitIds = new Set<string>();
	for (const test of tests) {
		if (test.id === undefined) {
			continue;
		}
		if (explicitIds.has(test.id)) {
			throw new DatasetLoadError(
				`Duplicate explicit test ID "${test.id}" is not allowed.`,
			);
		}
		explicitIds.add(test.id);
	}

	const assigned = new Set(explicitIds);
	const warnings: string[] = [];
	const normalized = tests.map((test) => {
		if (test.id !== undefined) {
			return {
				id: test.id,
				description: test.description,
				vars: test.vars,
				assert: test.assert.map((assertion) => ({ ...assertion })),
			};
		}

		const base = slugifyDescription(test.description);
		let id = base;
		let suffix = 2;
		while (assigned.has(id)) {
			const suffixText = `-${suffix}`;
			id = `${base.slice(0, 120 - suffixText.length)}${suffixText}`;
			suffix += 1;
		}
		if (id !== base) {
			warnings.push(
				`Test ID collision for "${base}"; assigned deterministic ID "${id}".`,
			);
		}
		assigned.add(id);
		return {
			id,
			description: test.description,
			vars: test.vars,
			assert: test.assert.map((assertion) => ({ ...assertion })),
		};
	});
	return { tests: normalized, warnings };
}

async function resolveJavascriptAssertions(
	datasetPath: string,
	tests: EvalTest[],
): Promise<void> {
	for (const test of tests) {
		for (const assertion of test.assert) {
			if (assertion.type !== "javascript") {
				continue;
			}
			const rawPath = (assertion.value as string).slice("file://".length);
			if (isAbsolute(rawPath)) {
				throw new DatasetLoadError(
					`Javascript assertion in test "${test.id}" must use a dataset-relative file:// path.`,
				);
			}
			const javascriptPath = resolve(dirname(datasetPath), rawPath);
			try {
				const file = await stat(javascriptPath);
				if (!file.isFile()) {
					throw new Error("Path is not a regular file.");
				}
			} catch (error) {
				throw new DatasetLoadError(
					`Javascript assertion file not found for test "${test.id}": ${javascriptPath}`,
					{ cause: error },
				);
			}
			assertion.javascriptPath = javascriptPath;
		}
	}
}

/**
 * Reads a checked-in evaluation YAML file, hashes its exact bytes, then
 * validates and normalizes it for later runner steps. No provider or gateway
 * work occurs here.
 */
export async function loadDataset(filePath: string): Promise<LoadedDataset> {
	const path = resolve(filePath);
	let source: Buffer;
	try {
		source = await readFile(path);
	} catch (error) {
		throw new DatasetLoadError(`Unable to read dataset: ${path}`, {
			cause: error,
		});
	}

	let parsedYaml: unknown;
	try {
		parsedYaml = parse(source.toString("utf8"));
	} catch (error) {
		throw new DatasetLoadError(`Invalid YAML in dataset: ${path}`, {
			cause: error,
		});
	}

	const parsed = DatasetSchema.safeParse(parsedYaml);
	if (!parsed.success) {
		throw new DatasetLoadError(
			`Invalid evaluation dataset: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
				.join("; ")}`,
		);
	}

	const { tests, warnings } = assignTestIds(parsed.data.tests);
	await resolveJavascriptAssertions(path, tests);
	return {
		path,
		datasetHash: createHash("sha256").update(source).digest("hex"),
		description: parsed.data.description,
		prompts: parsed.data.prompts,
		providers: parsed.data.providers,
		defaultTest: parsed.data.defaultTest,
		tests,
		warnings,
	};
}

export { slugifyDescription };
