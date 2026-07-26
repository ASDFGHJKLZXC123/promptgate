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
	usage: ChatUsage;
}

interface CacheEntryRow {
	model: string;
	response_json: string;
	usage_json: string;
}

function parseJson(text: string): unknown | null {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
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
	input: { hash: string; model: string },
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
		if (responseValue === null || usageValue === null) {
			return null;
		}

		const response = ChatResponseSchema.safeParse(responseValue);
		const usage = ChatUsageSchema.safeParse(usageValue);
		if (!response.success || !usage.success) {
			return null;
		}
		// A provider may return a canonical/snapshot identifier rather than the
		// routed alias, so `cache_entries.model` is the request-model guard. When
		// response_json already carries usage, however, two divergent usage
		// payloads would make the replay ambiguous and must fail closed.
		if (
			response.data.usage !== undefined &&
			stableStringify(response.data.usage) !== stableStringify(usage.data)
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
