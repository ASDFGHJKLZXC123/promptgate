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
