import { types as utilTypes } from "node:util";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { sendError } from "../errors.js";
import {
	createEvalRun,
	findEvalRunWithResults,
	type JsonValue,
	listEvalRuns,
	upsertEvalDataset,
} from "../evals/dao.js";

const nonEmpty = z.string().trim().min(1);
const safeNonNegativeInteger = z.number().int().nonnegative().safe();
const safePositiveInteger = z.number().int().positive().safe();
const scoreSchema = z.number().finite().min(0).max(1);

/**
 * Copies a value into JSON-only data without invoking accessors or allowing
 * prototypes to reinterpret keys such as "__proto__". This is intentionally
 * stricter than JSON.stringify, which silently drops several non-JSON values.
 */
export function normalizeJsonValue(
	value: unknown,
	active = new WeakSet<object>(),
): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
		return value;
	}
	if (typeof value !== "object" || utilTypes.isProxy(value)) {
		throw new Error("Value is not data-only JSON");
	}
	if (active.has(value)) throw new Error("JSON values cannot contain cycles");

	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw new Error("JSON arrays must use the standard array prototype");
			}
			const keys = Reflect.ownKeys(value);
			if (
				keys.some(
					(key) =>
						typeof key !== "string" ||
						(key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
				)
			) {
				throw new Error("JSON arrays cannot have extra properties");
			}
			const normalized: JsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(
					value,
					String(index),
				);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new Error("JSON arrays cannot be sparse or contain accessors");
				}
				normalized.push(normalizeJsonValue(descriptor.value, active));
			}
			return normalized;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("JSON objects cannot have exotic prototypes");
		}
		const normalized = Object.create(null) as { [key: string]: JsonValue };
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") {
				throw new Error("JSON objects cannot have symbol keys");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error("JSON objects cannot contain accessors");
			}
			Object.defineProperty(normalized, key, {
				value: normalizeJsonValue(descriptor.value, active),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return normalized;
	} finally {
		active.delete(value);
	}
}

const jsonValueSchema = z.unknown().transform((value, ctx): JsonValue => {
	try {
		return normalizeJsonValue(value);
	} catch {
		ctx.addIssue({
			code: "custom",
			message: "detail_json must contain only data-only JSON values.",
		});
		return z.NEVER;
	}
});

const datasetBodySchema = z
	.object({
		slug: nonEmpty,
		file_path: nonEmpty,
		description: z.string().nullable().optional(),
	})
	.strict();

const resultSchema = z
	.object({
		case_id: nonEmpty,
		passed: z.boolean(),
		score: scoreSchema.nullable().optional(),
		detail_json: jsonValueSchema,
		latency_ms: safeNonNegativeInteger.nullable().optional(),
		cost_micro_usd: safeNonNegativeInteger.nullable().optional(),
	})
	.strict();

const runBodySchema = z
	.object({
		dataset_id: safePositiveInteger,
		dataset_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
		prompt_id: z.number().int().positive().safe().nullable().optional(),
		prompt_version: z.number().int().positive().safe().nullable().optional(),
		prompt_ref: nonEmpty.nullable().optional(),
		model: nonEmpty,
		git_sha: z
			.string()
			.regex(/^[a-fA-F0-9]{7,64}$/)
			.nullable()
			.optional(),
		trigger: z.enum(["ci", "manual"]),
		cases_total: safePositiveInteger,
		cases_passed: safeNonNegativeInteger,
		score_avg: scoreSchema.nullable(),
		cost_micro_usd: safeNonNegativeInteger,
		duration_ms: safeNonNegativeInteger,
		results: z.array(resultSchema).min(1),
	})
	.strict()
	.superRefine((run, ctx) => {
		const hasPromptId = run.prompt_id !== null && run.prompt_id !== undefined;
		const hasPromptVersion =
			run.prompt_version !== null && run.prompt_version !== undefined;
		const hasPromptRef =
			run.prompt_ref !== null && run.prompt_ref !== undefined;
		if (hasPromptId !== hasPromptVersion || hasPromptId !== hasPromptRef) {
			ctx.addIssue({
				code: "custom",
				message:
					"prompt_id, prompt_version, and prompt_ref must be supplied together.",
			});
		}
		if (run.cases_total !== run.results.length) {
			ctx.addIssue({
				code: "custom",
				message: "cases_total must equal the number of results.",
			});
		}
		const caseIds = new Set<string>();
		for (const [index, result] of run.results.entries()) {
			if (caseIds.has(result.case_id)) {
				ctx.addIssue({
					code: "custom",
					message: "Each result case_id must be unique.",
					path: ["results", index, "case_id"],
				});
			}
			caseIds.add(result.case_id);
		}
		const passed = run.results.filter((result) => result.passed).length;
		if (run.cases_passed !== passed) {
			ctx.addIssue({
				code: "custom",
				message: "cases_passed must equal the number of passed results.",
			});
		}
		const scores = run.results.flatMap((result) =>
			result.score === null || result.score === undefined ? [] : [result.score],
		);
		if ((scores.length === 0) !== (run.score_avg === null)) {
			ctx.addIssue({
				code: "custom",
				message: "score_avg must be null exactly when no result has a score.",
			});
		} else if (scores.length > 0) {
			const average =
				scores.reduce((sum, score) => sum + score, 0) / scores.length;
			if (
				Math.abs((run.score_avg ?? 0) - average) >
				Number.EPSILON * Math.max(1, Math.abs(average))
			) {
				ctx.addIssue({
					code: "custom",
					message: "score_avg must equal the arithmetic mean of result scores.",
				});
			}
		}
		const totalCost = run.results.reduce(
			(sum, result) => sum + (result.cost_micro_usd ?? 0),
			0,
		);
		if (run.cost_micro_usd !== totalCost) {
			ctx.addIssue({
				code: "custom",
				message: "cost_micro_usd must equal the sum of result costs.",
			});
		}
	});

const listQuerySchema = z
	.object({
		dataset: nonEmpty.optional(),
		prompt_ref: nonEmpty.optional(),
		model: nonEmpty.optional(),
		limit: z.coerce.number().int().positive().safe().max(500).optional(),
	})
	.strict();
const idParamsSchema = z
	.object({ id: z.coerce.number().int().positive().safe() })
	.strict();

function parseOrReply<T>(
	schema: z.ZodType<T>,
	value: unknown,
	reply: FastifyReply,
): T | undefined {
	const result = schema.safeParse(value);
	if (!result.success) {
		sendError(reply, 400, "Invalid request payload.", "invalid_request_error");
		return undefined;
	}
	return result.data;
}

/** Registers eval persistence routes inside the existing authenticated admin scope. */
export function registerEvalAdminRoutes(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.register(
		(evalServer, _options, done) => {
			// The default parser rejects these keys before the detail_json
			// normalizer can preserve them as inert data. Scope the permissive
			// parser to eval routes; every accepted body still passes strict Zod
			// validation and normalizeJsonValue before reaching persistence.
			evalServer.removeContentTypeParser("application/json");
			evalServer.addContentTypeParser(
				"application/json",
				{ parseAs: "string" },
				evalServer.getDefaultJsonParser("ignore", "ignore"),
			);
			registerEvalRoutes(evalServer, db);
			done();
		},
		{ prefix: "/api/evals" },
	);
}

function registerEvalRoutes(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.post("/datasets", (request, reply) => {
		const body = parseOrReply(datasetBodySchema, request.body, reply);
		if (!body) return reply;
		return reply.code(201).send(
			upsertEvalDataset(db, {
				slug: body.slug,
				filePath: body.file_path,
				description: body.description ?? null,
			}),
		);
	});

	server.post("/runs", (request, reply) => {
		const body = parseOrReply(runBodySchema, request.body, reply);
		if (!body) return reply;
		try {
			const persisted = createEvalRun(db, {
				datasetId: body.dataset_id,
				datasetHash: body.dataset_hash,
				promptId: body.prompt_id ?? null,
				promptVersion: body.prompt_version ?? null,
				promptRef: body.prompt_ref ?? null,
				model: body.model,
				gitSha: body.git_sha ?? null,
				trigger: body.trigger,
				casesTotal: body.cases_total,
				casesPassed: body.cases_passed,
				scoreAvg: body.score_avg,
				costMicroUsd: body.cost_micro_usd,
				durationMs: body.duration_ms,
				results: body.results.map((result) => ({
					caseId: result.case_id,
					passed: result.passed,
					score: result.score ?? null,
					detail: result.detail_json,
					latencyMs: result.latency_ms ?? null,
					costMicroUsd: result.cost_micro_usd ?? null,
				})),
			});
			return reply.code(201).send(persisted);
		} catch (error) {
			if (isForeignKeyError(error)) {
				return sendError(
					reply,
					404,
					"Eval dataset not found.",
					"eval_dataset_not_found",
				);
			}
			throw error;
		}
	});

	server.get("/runs", (request, reply) => {
		const query = parseOrReply(listQuerySchema, request.query, reply);
		if (!query) return reply;
		return reply.send(
			listEvalRuns(db, {
				dataset: query.dataset,
				promptRef: query.prompt_ref,
				model: query.model,
				limit: query.limit,
			}),
		);
	});

	server.get("/runs/:id", (request, reply) => {
		const params = parseOrReply(idParamsSchema, request.params, reply);
		if (!params) return reply;
		const persisted = findEvalRunWithResults(db, params.id);
		if (!persisted)
			return sendError(reply, 404, "Eval run not found.", "eval_run_not_found");
		return reply.send(persisted);
	});
}

function isForeignKeyError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
	);
}
