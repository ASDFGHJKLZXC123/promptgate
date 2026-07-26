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

/**
 * The safe usage projection returned by `GET /v1/requests/:request_id/usage`
 * (IMPLEMENTATION_GUIDE.md §5.1, BUILD_PLAYBOOK.md phase 2 step 6). Deliberately
 * excludes `api_key_id`, the numeric row `id`, key hashes, and any upstream
 * provider payload — a caller learns only the metering facts for a request it
 * already owns. SQLite `streamed`/`cost_estimated` integers are normalized to
 * JSON booleans; nullable token/cost fields are preserved as `null` so an
 * absent-usage row (e.g. an aborted stream) is never overclaimed as complete.
 */
export interface RequestUsage {
	request_id: string;
	model: string;
	streamed: boolean;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: boolean;
	status: string;
}

/** Raw row shape as stored, before boolean normalization. */
interface RequestUsageDbRow {
	request_id: string;
	model: string;
	streamed: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: number;
	status: string;
}

/**
 * Looks up a request's usage by the composite ownership predicate
 * (`request_id` AND `api_key_id`) in a single query — never fetch-then-check,
 * so a key can only ever read its own rows (BUILD_PLAYBOOK.md phase 2 step 6).
 * Returns `null` when no row matches either half of the predicate: an unknown
 * id, a legacy NULL `request_id` (SQL `= ?` never matches NULL), or a valid id
 * owned by a different key all collapse to the same indistinguishable miss, so
 * the route can map every one of them to an identical 404. Callers validate the
 * id at the trust boundary; a non-UUID here simply matches nothing.
 */
export function findRequestUsageForKey(
	db: Database.Database,
	ownership: { requestId: string; apiKeyId: number },
): RequestUsage | null {
	const row = db
		.prepare(`
			SELECT request_id, model, streamed, input_tokens, output_tokens,
				cost_micro_usd, cost_estimated, status
			FROM requests
			WHERE request_id = ? AND api_key_id = ?
		`)
		.get(ownership.requestId, ownership.apiKeyId) as
		| RequestUsageDbRow
		| undefined;

	if (!row) {
		return null;
	}

	return {
		request_id: row.request_id,
		model: row.model,
		streamed: row.streamed === 1,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		cost_micro_usd: row.cost_micro_usd,
		cost_estimated: row.cost_estimated === 1,
		status: row.status,
	};
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
