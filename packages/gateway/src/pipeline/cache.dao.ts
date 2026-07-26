import {
	type ChatResponse,
	ChatResponseSchema,
	type ChatUsage,
	ChatUsageSchema,
} from "@promptgate/shared";
import type Database from "better-sqlite3";

import { stableStringify } from "./cache-key.js";

/** A validated cache replay payload. Raw SQLite values never leave this DAO. */
export interface CacheHit {
	response: ChatResponse;
	/** Null is an intentionally cached non-streaming response with no provider usage. */
	usage: ChatUsage | null;
}

interface CacheEntryRow {
	model: string;
	response_json: string;
	usage_json: string;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false };
	}
}

/**
 * Finds and claims an exact, still-live cache entry. The read, trust-boundary
 * validation, and hit counter update happen in one SQLite transaction: a
 * corrupt, expired, or model-mismatched row is indistinguishable from a miss
 * and never gains a hit count (IMPLEMENTATION_GUIDE.md §§3.4, 11).
 */
export function findAndRecordCacheHit(
	db: Database.Database,
	input: { hash: string; model: string; requireUsage?: boolean },
): CacheHit | null {
	return db.transaction(() => {
		const row = db
			.prepare(
				`SELECT model, response_json, usage_json
				 FROM cache_entries
				 WHERE hash = ? AND expires_at > datetime('now')`,
			)
			.get(input.hash) as CacheEntryRow | undefined;

		if (!row || row.model !== input.model) {
			return null;
		}

		const responseValue = parseJson(row.response_json);
		const usageValue = parseJson(row.usage_json);
		if (!responseValue.ok || !usageValue.ok) {
			return null;
		}

		const response = ChatResponseSchema.safeParse(responseValue.value);
		const usage = ChatUsageSchema.nullable().safeParse(usageValue.value);
		if (!response.success || !usage.success) {
			return null;
		}
		if (input.requireUsage && usage.data === null) {
			// A synthetic stream must never invent terminal provider usage. Leave the
			// entry untouched so the non-streaming form can still reuse it.
			return null;
		}
		// A provider may return a canonical/snapshot identifier rather than the
		// routed alias, so `cache_entries.model` is the request-model guard. When
		// response_json already carries usage, however, two divergent usage
		// payloads would make the replay ambiguous and must fail closed.
		if (
			response.data.usage !== undefined &&
			(usage.data === null ||
				stableStringify(response.data.usage) !== stableStringify(usage.data))
		) {
			return null;
		}

		const update = db
			.prepare(
				`UPDATE cache_entries
				 SET hit_count = hit_count + 1, last_hit_at = datetime('now')
				 WHERE hash = ? AND expires_at > datetime('now')`,
			)
			.run(input.hash);
		if (update.changes !== 1) {
			return null;
		}

		return {
			// The non-stream read contract returns the stored JSON unchanged.
			// `usage_json` stays separate for cache-hit accounting and synthetic
			// streaming replay when the stored response omitted its optional usage.
			response: response.data,
			usage: usage.data,
		};
	})();
}

/**
 * Replaces an exact cache entry after a successful, metered completion. The
 * response may lack provider usage only for non-streaming responses; that
 * absence is deliberately represented by the JSON literal `null`, never by a
 * fabricated token count.
 */
export function upsertCacheEntry(
	db: Database.Database,
	input: {
		hash: string;
		model: string;
		response: ChatResponse;
		usage: ChatUsage | null;
		pricedCostMicroUsd: number;
		ttlHours: number;
	},
): void {
	const response = ChatResponseSchema.parse(input.response);
	const usage = ChatUsageSchema.nullable().parse(input.usage);
	if (
		response.usage !== undefined &&
		(usage === null ||
			stableStringify(response.usage) !== stableStringify(usage))
	) {
		throw new TypeError("Cached response usage must match usage_json.");
	}
	if (!Number.isFinite(input.ttlHours) || input.ttlHours <= 0) {
		throw new TypeError("Cache TTL hours must be a positive finite number.");
	}
	if (
		!Number.isSafeInteger(input.pricedCostMicroUsd) ||
		input.pricedCostMicroUsd < 0
	) {
		throw new TypeError(
			"Cached priced cost must be a nonnegative integer micro-USD value.",
		);
	}

	db.prepare(
		`INSERT INTO cache_entries (
			hash, model, response_json, usage_json, priced_cost_micro_usd,
			expires_at, hit_count, last_hit_at
		) VALUES (
			@hash, @model, @response_json, @usage_json, @priced_cost_micro_usd,
			datetime('now', @ttl_modifier), 0, NULL
		)
		ON CONFLICT(hash) DO UPDATE SET
			model = excluded.model,
			response_json = excluded.response_json,
			usage_json = excluded.usage_json,
			priced_cost_micro_usd = excluded.priced_cost_micro_usd,
			created_at = datetime('now'),
			expires_at = excluded.expires_at,
			hit_count = 0,
			last_hit_at = NULL`,
	).run({
		hash: input.hash,
		model: input.model,
		response_json: JSON.stringify(response),
		usage_json: JSON.stringify(usage),
		priced_cost_micro_usd: input.pricedCostMicroUsd,
		ttl_modifier: `+${input.ttlHours} hours`,
	});
}

/** Deletes expired cache rows. Reads exclude them immediately; this reclaims disk. */
export function deleteExpiredCacheEntries(db: Database.Database): number {
	return db
		.prepare("DELETE FROM cache_entries WHERE expires_at <= datetime('now')")
		.run().changes;
}
