import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { meterUsage } from "./meter.js";

let tempDbDir: string;
let db: Database.Database;

function seedPricing(
	model: string,
	inputRate: number,
	outputRate: number,
): void {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES ('openai', ?, ?, ?, '2020-01-01')`,
	).run(model, inputRate, outputRate);
}

function seedPricingWithCachedInput(
	model: string,
	inputRate: number,
	cachedInputRate: number,
	outputRate: number,
	provider: "deepseek" | "gemini" = "deepseek",
): void {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES (?, ?, ?, ?, ?, '2020-01-01')`,
	).run(provider, model, inputRate, cachedInputRate, outputRate);
}

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-meter-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

const REQUEST: ChatRequest = {
	model: "gpt-test",
	messages: [{ role: "user", content: "say hi" }], // 6 chars
};

function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
	return {
		id: "chatcmpl-test",
		object: "chat.completion",
		created: 0,
		model: "gpt-test",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "hello world" }, // 11 chars
				finish_reason: "stop",
			},
		],
		...overrides,
	};
}

test("uses exact provider usage and rounds each component independently before summing", () => {
	seedPricing("gpt-test", 1_500_000, 2_500_000);

	const result = meterUsage(
		db,
		"gpt-test",
		REQUEST,
		response({
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
	);

	// round(1 * 1_500_000 / 1e6) = round(1.5) = 2
	// round(1 * 2_500_000 / 1e6) = round(2.5) = 3
	expect(result).toEqual({
		inputTokens: 1,
		outputTokens: 1,
		costMicroUsd: 5,
		costEstimated: false,
	});
});

test("falls back to a chars/4 estimate and flags costEstimated when usage is missing", () => {
	seedPricing("gpt-test", 1_000_000, 2_000_000);

	const result = meterUsage(
		db,
		"gpt-test",
		REQUEST,
		response({ usage: undefined }),
	);

	expect(result).toEqual({
		inputTokens: Math.ceil(6 / 4), // 2
		outputTokens: Math.ceil(11 / 4), // 3
		costMicroUsd: 2 + 6,
		costEstimated: true,
	});
});

test("throws if no effective pricing row exists for the model", () => {
	expect(() => meterUsage(db, "unpriced-model", REQUEST, response())).toThrow(
		/No effective model_pricing row/,
	);
});

test("prices cache-hit and cache-miss input tokens separately when both usage fields and a cached rate exist", () => {
	seedPricingWithCachedInput("deepseek-v4-flash", 140_000, 2_800, 280_000);

	const result = meterUsage(
		db,
		"deepseek-v4-flash",
		REQUEST,
		response({
			usage: {
				prompt_tokens: 1_000,
				completion_tokens: 10,
				total_tokens: 1_010,
				prompt_cache_hit_tokens: 400,
				prompt_cache_miss_tokens: 600,
			},
		}),
	);

	// round(400 * 2_800 / 1e6) = round(1.12) = 1
	// round(600 * 140_000 / 1e6) = round(84) = 84
	// round(10 * 280_000 / 1e6) = round(2.8) = 3
	expect(result).toEqual({
		inputTokens: 1_000,
		outputTokens: 10,
		costMicroUsd: 1 + 84 + 3,
		costEstimated: false,
	});
});

test("rounds cache-hit, cache-miss, and output charges as separate billing components", () => {
	seedPricingWithCachedInput("deepseek-v4-flash", 140_000, 2_800, 280_000);

	const result = meterUsage(
		db,
		"deepseek-v4-flash",
		REQUEST,
		response({
			usage: {
				prompt_tokens: 103,
				completion_tokens: 1,
				total_tokens: 104,
				prompt_cache_hit_tokens: 100,
				prompt_cache_miss_tokens: 3,
			},
		}),
	);

	// Cache hit: round(0.28) = 0; cache miss: round(0.42) = 0;
	// output: round(0.28) = 0. Combining input classes first would yield 1,
	// so this locks the approved per-component rounding rule.
	expect(result.costMicroUsd).toBe(0);
});

test("derives Gemini cache misses from prompt_tokens_details and meters the three components exactly", () => {
	seedPricingWithCachedInput(
		"gemini-2.5-flash",
		300_000,
		30_000,
		2_500_000,
		"gemini",
	);

	const result = meterUsage(
		db,
		"gemini-2.5-flash",
		REQUEST,
		response({
			model: "gemini-2.5-flash",
			usage: {
				prompt_tokens: 1_000,
				completion_tokens: 10,
				total_tokens: 1_010,
				prompt_tokens_details: { cached_tokens: 400 },
			},
		}),
	);

	// round(400 * 30_000 / 1e6) = 12
	// round(600 * 300_000 / 1e6) = 180
	// round(10 * 2_500_000 / 1e6) = 25
	expect(result).toEqual({
		inputTokens: 1_000,
		outputTokens: 10,
		costMicroUsd: 12 + 180 + 25,
		costEstimated: false,
	});
});

test("falls back to ordinary input pricing when the model has no cached rate, even if usage reports a cache split", () => {
	seedPricing("gpt-test", 1_000_000, 2_000_000);

	const result = meterUsage(
		db,
		"gpt-test",
		REQUEST,
		response({
			usage: {
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: 110,
				prompt_cache_hit_tokens: 40,
				prompt_cache_miss_tokens: 60,
			},
		}),
	);

	expect(result.costMicroUsd).toBe(
		Math.round((100 * 1_000_000) / 1_000_000) +
			Math.round((10 * 2_000_000) / 1_000_000),
	);
});

test("falls back to ordinary input pricing when usage omits the cache split, even with a cached rate configured", () => {
	seedPricingWithCachedInput("deepseek-v4-flash", 140_000, 2_800, 280_000);

	const result = meterUsage(
		db,
		"deepseek-v4-flash",
		REQUEST,
		response({
			usage: {
				prompt_tokens: 1_000,
				completion_tokens: 10,
				total_tokens: 1_010,
			},
		}),
	);

	expect(result.costMicroUsd).toBe(
		Math.round((1_000 * 140_000) / 1_000_000) +
			Math.round((10 * 280_000) / 1_000_000),
	);
});

test("estimate accounts for every message, not just the first", () => {
	seedPricing("gpt-test", 1_000_000, 2_000_000);
	const multiMessageRequest: ChatRequest = {
		model: "gpt-test",
		messages: [
			{ role: "system", content: "abcd" }, // 4 chars
			{ role: "user", content: "abcd" }, // 4 chars
		],
	};

	const result = meterUsage(
		db,
		"gpt-test",
		multiMessageRequest,
		response({ usage: undefined }),
	);

	expect(result.inputTokens).toBe(Math.ceil(8 / 4)); // 2
});
