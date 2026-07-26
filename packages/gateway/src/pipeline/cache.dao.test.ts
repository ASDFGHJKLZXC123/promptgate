import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse, ChatUsage } from "@promptgate/shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import {
	deleteExpiredCacheEntries,
	findAndRecordCacheHit,
	upsertCacheEntry,
} from "./cache.dao.js";

let tempDbDir: string;
let db: Database.Database;

const response: ChatResponse = {
	id: "chatcmpl-cache",
	object: "chat.completion",
	created: 1,
	model: "gpt-cache",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "cached" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const usage: ChatUsage = {
	prompt_tokens: 3,
	completion_tokens: 2,
	total_tokens: 5,
};

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-cache-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

function seedEntry(
	overrides: Partial<{
		hash: string;
		model: string;
		responseJson: string;
		usageJson: string;
		expiresAt: string;
	}> = {},
): void {
	db.prepare(
		`INSERT INTO cache_entries (
			hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at
		) VALUES (@hash, @model, @response_json, @usage_json, 9, @expires_at)`,
	).run({
		hash: overrides.hash ?? "cache-hash",
		model: overrides.model ?? "gpt-cache",
		response_json: overrides.responseJson ?? JSON.stringify(response),
		usage_json: overrides.usageJson ?? JSON.stringify(usage),
		expires_at: overrides.expiresAt ?? "2999-01-01 00:00:00",
	});
}

function hitCount(): { hit_count: number; last_hit_at: string | null } {
	return db
		.prepare("SELECT hit_count, last_hit_at FROM cache_entries WHERE hash = ?")
		.get("cache-hash") as { hit_count: number; last_hit_at: string | null };
}

test("returns stored response JSON unchanged with separate authoritative usage", () => {
	const { usage: _responseUsage, ...responseWithoutUsage } = response;
	seedEntry({
		responseJson: JSON.stringify(responseWithoutUsage),
	});

	const hit = findAndRecordCacheHit(db, {
		hash: "cache-hash",
		model: "gpt-cache",
	});

	expect(hit).toEqual({
		response: responseWithoutUsage,
		usage,
	});
	expect(hitCount()).toEqual({ hit_count: 1, last_hit_at: expect.any(String) });
});

test("treats expired entries as misses without incrementing them", () => {
	seedEntry({ expiresAt: "2000-01-01 00:00:00" });

	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 0, last_hit_at: null });
});

test("treats corrupt response or usage JSON as a miss without incrementing", () => {
	seedEntry({ responseJson: "not json" });
	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 0, last_hit_at: null });

	db.prepare(
		"UPDATE cache_entries SET response_json = ?, usage_json = ? WHERE hash = ?",
	).run(
		JSON.stringify(response),
		JSON.stringify({ prompt_tokens: 1 }),
		"cache-hash",
	);
	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 0, last_hit_at: null });
});

test("treats a cache-entry model mismatch as a miss but preserves a canonical response model", () => {
	seedEntry({ model: "other-model" });
	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 0, last_hit_at: null });

	db.prepare(
		"UPDATE cache_entries SET model = ?, response_json = ? WHERE hash = ?",
	).run(
		"gpt-cache",
		JSON.stringify({ ...response, model: "gpt-cache-2026-07-01" }),
		"cache-hash",
	);
	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toMatchObject({ response: { model: "gpt-cache-2026-07-01" } });
	expect(hitCount()).toEqual({ hit_count: 1, last_hit_at: expect.any(String) });
});

test("treats conflicting response and usage payloads as a miss without incrementing", () => {
	seedEntry({
		responseJson: JSON.stringify({
			...response,
			usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
		}),
	});

	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 0, last_hit_at: null });
});

test("stores a missing provider usage as JSON null and excludes it only from streaming replay", () => {
	const { usage: _usage, ...responseWithoutUsage } = response;
	upsertCacheEntry(db, {
		hash: "cache-hash",
		model: "gpt-cache",
		response: responseWithoutUsage,
		usage: null,
		pricedCostMicroUsd: 12,
		ttlHours: 1,
	});

	expect(
		findAndRecordCacheHit(db, { hash: "cache-hash", model: "gpt-cache" }),
	).toEqual({ response: responseWithoutUsage, usage: null });
	expect(
		findAndRecordCacheHit(db, {
			hash: "cache-hash",
			model: "gpt-cache",
			requireUsage: true,
		}),
	).toBeNull();
	expect(hitCount()).toEqual({ hit_count: 1, last_hit_at: expect.any(String) });
});

test("upsert refreshes the exact entry and hourly sweep only removes expired rows", () => {
	upsertCacheEntry(db, {
		hash: "cache-hash",
		model: "gpt-cache",
		response,
		usage,
		pricedCostMicroUsd: 9,
		ttlHours: 1,
	});
	seedEntry({ hash: "expired-hash", expiresAt: "2000-01-01 00:00:00" });

	expect(deleteExpiredCacheEntries(db)).toBe(1);
	expect(
		db.prepare("SELECT count(*) AS count FROM cache_entries").get(),
	).toEqual({ count: 1 });
	upsertCacheEntry(db, {
		hash: "cache-hash",
		model: "gpt-cache",
		response,
		usage,
		pricedCostMicroUsd: 11,
		ttlHours: 2,
	});
	expect(
		db
			.prepare(
				"SELECT priced_cost_micro_usd, hit_count, last_hit_at FROM cache_entries WHERE hash = ?",
			)
			.get("cache-hash"),
	).toEqual({ priced_cost_micro_usd: 11, hit_count: 0, last_hit_at: null });
});

test("rejects a non-integer or negative priced cache cost", () => {
	for (const pricedCostMicroUsd of [-1, 1.5]) {
		expect(() =>
			upsertCacheEntry(db, {
				hash: `cache-hash-${pricedCostMicroUsd}`,
				model: "gpt-cache",
				response,
				usage,
				pricedCostMicroUsd,
				ttlHours: 1,
			}),
		).toThrow("nonnegative integer");
	}
});
