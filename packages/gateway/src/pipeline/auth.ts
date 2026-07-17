import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "../errors.js";
import { findApiKeyByHash } from "./auth.dao.js";

/** The subset of an api_keys row that is safe to attach to a request — never key_hash. */
export interface RequestApiKeyContext {
	id: number;
	name: string;
	budgetMicroUsdMonth: number;
	rateLimitRpm: number;
}

export interface PipelineRequestContext {
	apiKey: RequestApiKeyContext;
}

declare module "fastify" {
	interface FastifyRequest {
		/** Set by the /v1 client-auth hook before any /v1 route handler runs. */
		ctx: PipelineRequestContext;
	}
}

const BEARER_TOKEN = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i;
const INVALID_KEY_MESSAGE = "Invalid API key.";

function extractBearerToken(authorizationHeader: unknown): string | undefined {
	if (typeof authorizationHeader !== "string") {
		return undefined;
	}
	return BEARER_TOKEN.exec(authorizationHeader)?.[1];
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function rejectInvalidKey(reply: FastifyReply): void {
	sendError(
		reply,
		401,
		INVALID_KEY_MESSAGE,
		"invalid_pg_key",
		"authentication_error",
	);
}

/**
 * Builds the /v1 client-auth `onRequest` hook: extracts the Bearer token,
 * hashes it, looks up `api_keys`, and rejects missing/malformed/wrong/disabled
 * keys with a 401 `invalid_pg_key` in the OpenAI error envelope. On success,
 * attaches the safe key row to `request.ctx` for downstream pipeline steps.
 */
export function createClientAuthHook(db: Database.Database) {
	return async function clientAuthHook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		const token = extractBearerToken(request.headers.authorization);
		if (!token) {
			rejectInvalidKey(reply);
			return;
		}

		const row = findApiKeyByHash(db, hashToken(token));
		if (!row || row.disabled === 1) {
			rejectInvalidKey(reply);
			return;
		}

		request.ctx = {
			apiKey: {
				id: row.id,
				name: row.name,
				budgetMicroUsdMonth: row.budget_micro_usd_month,
				rateLimitRpm: row.rate_limit_rpm,
			},
		};
	};
}

/** Installs the request context shape and auth hook on an encapsulated /v1 plugin. */
export function registerClientAuth(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.decorateRequest("ctx");
	server.addHook("onRequest", createClientAuthHook(db));
}
