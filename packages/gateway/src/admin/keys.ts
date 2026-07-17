import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import { sendError } from "../errors.js";
import {
	type ApiKeyPatchInput,
	type ApiKeyWithSpend,
	type CreateApiKeyInput,
	createApiKey,
	listApiKeys,
	patchApiKey,
	type StoredApiKey,
} from "./keys.dao.js";

const adminTokenDigest = createHash("sha256")
	.update(config.ADMIN_TOKEN)
	.digest();

const postBodySchema = z
	.object({
		name: z.string().trim().min(1),
		budget_micro_usd_month: z.number().int().nonnegative().default(10_000_000),
		rate_limit_rpm: z.number().int().positive().default(60),
	})
	.strict();

const patchBodySchema = z
	.object({
		budget_micro_usd_month: z.number().int().nonnegative().optional(),
		rate_limit_rpm: z.number().int().positive().optional(),
		disabled: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one patch field must be provided.",
	});

const idParamsSchema = z.object({
	id: z.coerce.number().int().positive(),
});

interface ListApiKeyResponse {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	created_at: string;
	month_to_date_spend_micro_usd: number;
}

interface CreateApiKeyResponse {
	plaintext_key: string;
}

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

function isValidAdminToken(candidate: string): boolean {
	const candidateHash = createHash("sha256").update(candidate).digest();
	return timingSafeEqual(adminTokenDigest, candidateHash);
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "SQLITE_CONSTRAINT_UNIQUE"
	);
}

export function registerAdminRoutes(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.setErrorHandler((error, request, reply) => {
		const candidateStatus =
			typeof error === "object" &&
			error !== null &&
			"statusCode" in error &&
			typeof error.statusCode === "number"
				? error.statusCode
				: undefined;
		const statusCode =
			candidateStatus !== undefined &&
			candidateStatus >= 400 &&
			candidateStatus < 500
				? candidateStatus
				: 500;

		if (statusCode === 500) {
			request.log.error({ error }, "Admin API request failed");
			return sendError(
				reply,
				statusCode,
				"Internal server error.",
				"internal_error",
				"server_error",
			);
		}

		return sendError(
			reply,
			statusCode,
			"Invalid request payload.",
			"invalid_request_error",
		);
	});

	server.addHook("onRequest", async (request, reply) => {
		const token = request.headers["x-admin-token"];
		const candidate = typeof token === "string" ? token : "";
		if (!isValidAdminToken(candidate)) {
			return sendError(
				reply,
				401,
				"Invalid admin token.",
				"invalid_admin_token",
				"authentication_error",
			);
		}
	});

	server.post("/api/keys", async (request, reply) => {
		const body = parseOrReply(postBodySchema, request.body, reply);
		if (!body) {
			return reply;
		}
		const plaintext = `pg-${randomBytes(24).toString("hex")}`;
		const keyHash = createHash("sha256").update(plaintext).digest("hex");
		try {
			createApiKey(db, {
				name: body.name,
				budgetMicroUsdMonth: body.budget_micro_usd_month,
				rateLimitRpm: body.rate_limit_rpm,
				keyHash,
			} satisfies CreateApiKeyInput);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return sendError(
					reply,
					409,
					"An API key with that name already exists.",
					"key_name_conflict",
				);
			}
			throw error;
		}
		const response: CreateApiKeyResponse = {
			plaintext_key: plaintext,
		};
		return reply.send(response);
	});

	server.get("/api/keys", (_request, reply) => {
		const rows: ApiKeyWithSpend[] = listApiKeys(db);
		const response: ListApiKeyResponse[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			budget_micro_usd_month: row.budget_micro_usd_month,
			rate_limit_rpm: row.rate_limit_rpm,
			disabled: row.disabled,
			created_at: row.created_at,
			month_to_date_spend_micro_usd: row.month_to_date_spend_micro_usd,
		}));
		reply.send(response);
	});

	server.patch("/api/keys/:id", async (request, reply) => {
		const params = parseOrReply(idParamsSchema, request.params, reply);
		if (!params) {
			return reply;
		}
		const body = parseOrReply(patchBodySchema, request.body, reply);
		if (!body) {
			return reply;
		}

		const updates: ApiKeyPatchInput = {
			budget_micro_usd_month: body.budget_micro_usd_month,
			rate_limit_rpm: body.rate_limit_rpm,
			disabled: body.disabled,
		};
		const row = patchApiKey(db, params.id, updates);
		if (!row) {
			sendError(reply, 404, "API key not found.", "not_found");
			return reply;
		}

		const response: StoredApiKey = {
			id: row.id,
			name: row.name,
			budget_micro_usd_month: row.budget_micro_usd_month,
			rate_limit_rpm: row.rate_limit_rpm,
			disabled: row.disabled,
			created_at: row.created_at,
		};
		return reply.send(response);
	});
}
