import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { sendError } from "../errors.js";
import { findRequestUsageForKey } from "./requests.dao.js";

/**
 * Trust boundary for the `:request_id` path segment. The value is client-
 * controlled, so it is validated as a UUID before it reaches SQL. Validation
 * failure is deliberately NOT surfaced as a distinct 400 — it maps to the same
 * 404 as a genuine miss so a malformed id is indistinguishable from a
 * nonexistent or cross-key one (BUILD_PLAYBOOK.md phase 2 step 6).
 */
const RequestIdParamsSchema = z.object({ request_id: z.uuid() });

/**
 * The single 404 emitted for every non-owning outcome: unknown id, malformed
 * (non-UUID) id, a legacy NULL `request_id` row, and a valid UUID owned by a
 * different key. One constant envelope means key ownership can never leak
 * through a distinguishable error (IMPLEMENTATION_GUIDE.md §5.1).
 */
function sendUsageNotFound(reply: FastifyReply): FastifyReply {
	return sendError(
		reply,
		404,
		"No usage record was found for the given request_id.",
		"request_not_found",
	);
}

/**
 * Registers `GET /v1/requests/:request_id/usage` (BUILD_PLAYBOOK.md phase 2
 * step 6, §5.1) inside the protected `/v1` plugin — the enclosing client-auth
 * hook (`auth.ts`) already authenticated the pg key and attached
 * `request.ctx.apiKey`. A key may read only a row matching BOTH the requested
 * `request_id` and its own key id; the composite ownership check lives in the
 * DAO's SQL, never here. The endpoint exists to serve the final cost a live
 * stream's headers cannot carry (§5.1); it never calls a provider.
 */
export function registerRequestUsageRoute(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.get("/requests/:request_id/usage", async (request, reply) => {
		// Every outcome reached after the enclosing /v1 authentication hook is
		// key-scoped account information, including a 404. Set this before
		// validation/lookup so an authenticated miss cannot be cached by a
		// browser or intermediary. The outer auth hook still owns 401 responses.
		reply.header("cache-control", "private, no-store");

		const params = RequestIdParamsSchema.safeParse(request.params);
		if (!params.success) {
			return sendUsageNotFound(reply);
		}

		const usage = findRequestUsageForKey(db, {
			// UUID comparisons in SQLite are text comparisons. Canonicalize after
			// Zod validation so a syntactically valid uppercase UUID addresses the
			// same opaque request id as its persisted lowercase form.
			requestId: params.data.request_id.toLowerCase(),
			apiKeyId: request.ctx.apiKey.id,
		});
		if (!usage) {
			return sendUsageNotFound(reply);
		}

		return reply.send(usage);
	});
}
