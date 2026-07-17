import type Database from "better-sqlite3";
import { z } from "zod";
import type { ProviderName } from "../providers/types.js";

/**
 * Every gateway-created `requests` row must carry the same UUID handed back
 * on `x-pg-request-id` (BUILD_PLAYBOOK.md phase 1 step 7). `request_id` is
 * nullable at the schema level only for legacy rows predating migration 002
 * (see `002_request_identity.sql`) — this DAO enforces the application
 * invariant by rejecting an absent/non-UUID id before any SQL runs.
 */
const RequestIdSchema = z.uuid();

export type RequestLogProvider = ProviderName | "unknown";
export type RequestLogStatus =
	| "ok"
	| "client_aborted"
	| "provider_error"
	| `rejected_${string}`;

export interface InsertRequestLogInput {
	requestId: string;
	apiKeyId: number;
	provider: RequestLogProvider;
	model: string;
	feature?: string | null;
	cacheHit: boolean;
	streamed: boolean;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costMicroUsd?: number | null;
	costEstimated: boolean;
	firstTokenMs?: number | null;
	totalMs: number;
	status: RequestLogStatus;
	errorCode?: string | null;
}

/** Inserts a `requests` row (IMPLEMENTATION_GUIDE.md §4). Never called from a route handler directly. */
export function insertRequestLog(
	db: Database.Database,
	input: InsertRequestLogInput,
): void {
	const requestId = RequestIdSchema.parse(input.requestId);

	db.prepare(`
		INSERT INTO requests (
			request_id, api_key_id, provider, model, feature,
			cache_hit, streamed, input_tokens, output_tokens,
			cost_micro_usd, cost_estimated, first_token_ms, total_ms,
			status, error_code
		) VALUES (
			@request_id, @api_key_id, @provider, @model, @feature,
			@cache_hit, @streamed, @input_tokens, @output_tokens,
			@cost_micro_usd, @cost_estimated, @first_token_ms, @total_ms,
			@status, @error_code
		)
	`).run({
		request_id: requestId,
		api_key_id: input.apiKeyId,
		provider: input.provider,
		model: input.model,
		feature: input.feature ?? null,
		cache_hit: input.cacheHit ? 1 : 0,
		streamed: input.streamed ? 1 : 0,
		input_tokens: input.inputTokens ?? null,
		output_tokens: input.outputTokens ?? null,
		cost_micro_usd: input.costMicroUsd ?? null,
		cost_estimated: input.costEstimated ? 1 : 0,
		first_token_ms: input.firstTokenMs ?? null,
		total_ms: input.totalMs,
		status: input.status,
		error_code: input.errorCode ?? null,
	});
}
