import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";
import type { EvalAssertion, EvalTest, JsonValue } from "./dataset.js";

export interface CaseCtx {
	caseId: string;
	description: string;
	vars: Readonly<Record<string, JsonValue>>;
	/**
	 * The runner supplies this callback. Assertion code never creates a client or
	 * makes its own provider request, which keeps judge traffic in the gateway.
	 */
	rubric?: RubricEvaluator;
}

export interface RubricInput {
	output: string;
	rubric: string;
	context: Readonly<Pick<CaseCtx, "caseId" | "description" | "vars">>;
}

export interface AssertionOutcome {
	pass: boolean;
	score?: number;
	detail: string;
}

export interface RubricOutcome extends AssertionOutcome {
	score: number;
}

export type RubricEvaluator = (input: RubricInput) => Promise<RubricOutcome>;

export type AssertFn = (
	output: string,
	arg: unknown,
	ctx: CaseCtx,
) => Promise<AssertionOutcome>;

export class AssertionInfrastructureError extends Error {
	readonly assertionIndex?: number;
	readonly assertionType?: string;

	constructor(
		message: string,
		options: {
			cause?: unknown;
			assertionIndex?: number;
			assertionType?: string;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "AssertionInfrastructureError";
		this.assertionIndex = options.assertionIndex;
		this.assertionType = options.assertionType;
	}
}

function result(pass: boolean, detail: string): AssertionOutcome {
	return { pass, detail };
}

function requireString(value: unknown, assertionType: string): string {
	if (typeof value !== "string") {
		throw new AssertionInfrastructureError(
			`${assertionType} assertion requires a string value.`,
		);
	}
	return value;
}

function display(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function deepJsonEqual(left: JsonValue, right: JsonValue): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (typeof left !== "object" || left === null) {
		return false;
	}
	if (typeof right !== "object" || right === null) {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) =>
				deepJsonEqual(value, right[index] as JsonValue),
			)
		);
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				deepJsonEqual(left[key] as JsonValue, right[key] as JsonValue),
		)
	);
}

async function equals(output: string, arg: unknown): Promise<AssertionOutcome> {
	if (typeof arg === "string") {
		return result(output === arg, `Expected exact output ${display(arg)}.`);
	}

	let parsed: JsonValue;
	try {
		parsed = JSON.parse(output) as JsonValue;
	} catch {
		return result(
			false,
			"Output is not valid JSON for a semantic equals assertion.",
		);
	}
	return result(
		deepJsonEqual(parsed, arg as JsonValue),
		"Compared output as JSON.",
	);
}

async function contains(
	output: string,
	arg: unknown,
): Promise<AssertionOutcome> {
	const expected = requireString(arg, "contains");
	return result(
		output.includes(expected),
		`Expected output to contain ${display(expected)}.`,
	);
}

async function icontains(
	output: string,
	arg: unknown,
): Promise<AssertionOutcome> {
	const expected = requireString(arg, "icontains");
	return result(
		output.toLowerCase().includes(expected.toLowerCase()),
		`Expected output to contain ${display(expected)} case-insensitively.`,
	);
}

async function regex(output: string, arg: unknown): Promise<AssertionOutcome> {
	const source = requireString(arg, "regex");
	let pattern: RegExp;
	try {
		pattern = new RegExp(source);
	} catch (error) {
		throw new AssertionInfrastructureError(
			`Invalid regular expression assertion: ${source}.`,
			{ cause: error },
		);
	}
	return result(pattern.test(output), `Expected output to match /${source}/.`);
}

async function isJson(output: string): Promise<AssertionOutcome> {
	try {
		JSON.parse(output);
		return result(true, "Output is valid JSON.");
	} catch {
		return result(false, "Output is not valid JSON.");
	}
}

async function jsonSchema(
	output: string,
	arg: unknown,
): Promise<AssertionOutcome> {
	if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
		throw new AssertionInfrastructureError(
			"json-schema assertion requires an object schema.",
		);
	}

	const ajv = new Ajv({ allErrors: true, strict: true });
	let validate: ReturnType<Ajv["compile"]>;
	try {
		validate = ajv.compile(arg);
	} catch (error) {
		throw new AssertionInfrastructureError("Invalid JSON schema assertion.", {
			cause: error,
		});
	}
	if ("$async" in validate && validate.$async === true) {
		throw new AssertionInfrastructureError(
			"Async JSON schema assertions are not supported.",
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return result(
			false,
			"Output is not valid JSON for the JSON schema assertion.",
		);
	}
	const validation = validate(parsed);
	if (typeof validation !== "boolean") {
		throw new AssertionInfrastructureError(
			"JSON schema assertion returned an asynchronous result.",
		);
	}
	const pass = validation;
	return result(
		pass,
		pass
			? "Output satisfies the JSON schema."
			: `Output does not satisfy the JSON schema: ${ajv.errorsText(validate.errors)}.`,
	);
}

interface JavascriptAssertionResult {
	pass: boolean;
	score?: number;
	detail?: string;
}

function isJavascriptAssertionResult(
	value: unknown,
): value is JavascriptAssertionResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const prototype = Object.getPrototypeOf(record);
	const allowed = new Set(["pass", "score", "detail"]);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Object.keys(record).some((key) => !allowed.has(key)) ||
		!Object.hasOwn(record, "pass") ||
		typeof record.pass !== "boolean"
	) {
		return false;
	}
	return (
		(!Object.hasOwn(record, "score") ||
			(typeof record.score === "number" && Number.isFinite(record.score))) &&
		(!Object.hasOwn(record, "detail") || typeof record.detail === "string")
	);
}

function freezeJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(freezeJson)) as JsonValue;
	}
	if (typeof value === "object" && value !== null) {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, freezeJson(item)]),
			),
		) as JsonValue;
	}
	return value;
}

function frozenVars(
	vars: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(vars).map(([key, value]) => [key, freezeJson(value)]),
		),
	);
}

function javascriptContext(ctx: CaseCtx): Readonly<Record<string, unknown>> {
	return Object.freeze({
		caseId: ctx.caseId,
		description: ctx.description,
		vars: frozenVars(ctx.vars),
	});
}

async function javascript(
	output: string,
	arg: unknown,
	ctx: CaseCtx,
): Promise<AssertionOutcome> {
	const filePath = requireString(arg, "javascript");
	let module: { default?: unknown };
	try {
		module = (await import(
			/* @vite-ignore */ pathToFileURL(filePath).href
		)) as { default?: unknown };
	} catch (error) {
		throw new AssertionInfrastructureError(
			`Unable to import javascript assertion: ${filePath}.`,
			{ cause: error },
		);
	}
	if (typeof module.default !== "function") {
		throw new AssertionInfrastructureError(
			`Javascript assertion ${filePath} must have a default function export.`,
		);
	}

	let returned: unknown;
	try {
		returned = await module.default(output, javascriptContext(ctx));
	} catch (error) {
		throw new AssertionInfrastructureError(
			`Javascript assertion ${filePath} threw an error.`,
			{ cause: error },
		);
	}
	if (typeof returned === "boolean") {
		return result(returned, `Javascript assertion returned ${returned}.`);
	}
	if (!isJavascriptAssertionResult(returned)) {
		throw new AssertionInfrastructureError(
			`Javascript assertion ${filePath} must return a boolean or strict {pass, score?, detail?} object.`,
		);
	}
	return {
		pass: returned.pass,
		score: returned.score,
		detail:
			returned.detail ?? `Javascript assertion returned ${returned.pass}.`,
	};
}

async function llmRubric(
	output: string,
	arg: unknown,
	ctx: CaseCtx,
): Promise<AssertionOutcome> {
	if (ctx.rubric === undefined) {
		throw new AssertionInfrastructureError(
			"No rubric evaluator was supplied by the eval runner.",
		);
	}
	const rubric = requireString(arg, "llm-rubric");
	let rubricResult: RubricOutcome;
	try {
		rubricResult = await ctx.rubric({
			output,
			rubric,
			context: Object.freeze({
				caseId: ctx.caseId,
				description: ctx.description,
				vars: frozenVars(ctx.vars),
			}),
		});
	} catch (error) {
		throw new AssertionInfrastructureError("Rubric evaluator failed.", {
			cause: error,
		});
	}
	const record = rubricResult as unknown;
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		throw new AssertionInfrastructureError(
			"Rubric evaluator returned an invalid result.",
		);
	}
	const resultRecord = record as Record<string, unknown>;
	const prototype = Object.getPrototypeOf(resultRecord);
	const allowed = new Set(["pass", "score", "detail"]);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Object.keys(resultRecord).some((key) => !allowed.has(key)) ||
		typeof resultRecord.pass !== "boolean" ||
		typeof resultRecord.score !== "number" ||
		!Number.isFinite(resultRecord.score) ||
		resultRecord.score < 0 ||
		resultRecord.score > 1 ||
		typeof resultRecord.detail !== "string" ||
		resultRecord.detail.trim().length === 0
	) {
		throw new AssertionInfrastructureError(
			"Rubric evaluator returned an invalid result.",
		);
	}
	return {
		pass: resultRecord.pass,
		score: resultRecord.score,
		detail: resultRecord.detail,
	};
}

export const ASSERTIONS: Record<EvalAssertion["type"], AssertFn> = {
	equals,
	contains,
	icontains,
	regex,
	"is-json": isJson,
	"json-schema": jsonSchema,
	javascript,
	"llm-rubric": llmRubric,
};

export interface EvaluatedAssertion {
	index: number;
	type: EvalAssertion["type"];
	executed: boolean;
	skipped: boolean;
	pass?: boolean;
	score?: number;
	detail?: string;
}

export interface CaseAssertionResult {
	pass: boolean;
	/** Undefined when no rubric assertions execute. */
	score?: number;
	assertions: readonly EvaluatedAssertion[];
	firstFailedAssertion?: EvaluatedAssertion;
}

function executionArg(assertion: EvalAssertion): unknown {
	if (assertion.type === "javascript") {
		if (assertion.javascriptPath === undefined) {
			throw new AssertionInfrastructureError(
				"Javascript assertion has not been resolved by the dataset loader.",
			);
		}
		return assertion.javascriptPath;
	}
	return "value" in assertion ? assertion.value : undefined;
}

function skippedAssertion(
	assertion: EvalAssertion,
	index: number,
): EvaluatedAssertion {
	return { index, type: assertion.type, executed: false, skipped: true };
}

async function executeAssertion(
	assertion: EvalAssertion,
	index: number,
	output: string,
	ctx: CaseCtx,
): Promise<EvaluatedAssertion> {
	try {
		const outcome = await ASSERTIONS[assertion.type](
			output,
			executionArg(assertion),
			ctx,
		);
		return {
			index,
			type: assertion.type,
			executed: true,
			skipped: false,
			pass: outcome.pass,
			detail: outcome.detail,
			...(assertion.type === "llm-rubric" && outcome.score !== undefined
				? { score: outcome.score }
				: {}),
		};
	} catch (error) {
		if (error instanceof AssertionInfrastructureError) {
			throw new AssertionInfrastructureError(error.message, {
				cause: error.cause,
				assertionIndex: index,
				assertionType: assertion.type,
			});
		}
		throw new AssertionInfrastructureError("Assertion execution failed.", {
			cause: error,
			assertionIndex: index,
			assertionType: assertion.type,
		});
	}
}

/**
 * Executes declared deterministic checks in stable input order, stops after
 * the first quality failure, and executes rubric checks in their declared
 * order only after the deterministic gate passes.
 */
export async function evaluateCaseAssertions(
	output: string,
	test: Pick<EvalTest, "id" | "description" | "vars" | "assert">,
	options: { rubric?: RubricEvaluator } = {},
): Promise<CaseAssertionResult> {
	const ctx: CaseCtx = {
		caseId: test.id,
		description: test.description,
		vars: test.vars,
		rubric: options.rubric,
	};
	const results = test.assert.map(skippedAssertion);
	const deterministic = test.assert
		.map((assertion, index) => ({ assertion, index }))
		.filter(({ assertion }) => assertion.type !== "llm-rubric");

	for (const { assertion, index } of deterministic) {
		const evaluated = await executeAssertion(assertion, index, output, ctx);
		results[index] = evaluated;
		if (!evaluated.pass) {
			return {
				pass: false,
				assertions: results,
				firstFailedAssertion: evaluated,
			};
		}
	}

	const rubrics = test.assert
		.map((assertion, index) => ({ assertion, index }))
		.filter(({ assertion }) => assertion.type === "llm-rubric");
	const rubricScores: number[] = [];
	let firstFailedAssertion: EvaluatedAssertion | undefined;
	for (const { assertion, index } of rubrics) {
		const evaluated = await executeAssertion(assertion, index, output, ctx);
		results[index] = evaluated;
		if (evaluated.score !== undefined) {
			rubricScores.push(evaluated.score);
		}
		if (!evaluated.pass && firstFailedAssertion === undefined) {
			firstFailedAssertion = evaluated;
			break;
		}
	}
	return {
		pass: firstFailedAssertion === undefined,
		...(rubricScores.length > 0
			? {
					score:
						rubricScores.reduce((total, score) => total + score, 0) /
						rubricScores.length,
				}
			: {}),
		assertions: results,
		...(firstFailedAssertion === undefined ? {} : { firstFailedAssertion }),
	};
}
