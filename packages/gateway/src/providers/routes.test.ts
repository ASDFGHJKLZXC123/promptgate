import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { resolveProvider } from "./routes.js";

let tempDbDir: string;
let db: Database.Database;

interface SeedPricingRow {
	provider: "openai" | "anthropic";
	model: string;
	effective_from: string;
	input_micro_usd_per_mtok?: number;
	output_micro_usd_per_mtok?: number;
}

function seedPricing(row: SeedPricingRow): void {
	db.prepare(
		`INSERT INTO model_pricing (
			provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from
		) VALUES (@provider, @model, @input_micro_usd_per_mtok, @output_micro_usd_per_mtok, @effective_from)`,
	).run({
		provider: row.provider,
		model: row.model,
		input_micro_usd_per_mtok: row.input_micro_usd_per_mtok ?? 1_000_000,
		output_micro_usd_per_mtok: row.output_micro_usd_per_mtok ?? 2_000_000,
		effective_from: row.effective_from,
	});
}

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-routes-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

describe("resolveProvider — prefix routing (IMPLEMENTATION_GUIDE.md §3.1)", () => {
	test("routes a priced claude- model to anthropic", () => {
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2026-01-01",
		});

		const result = resolveProvider(db, "claude-sonnet-5");

		expect(result).toEqual({ ok: true, provider: "anthropic" });
	});

	test("routes a priced gpt- model to openai", () => {
		seedPricing({
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2026-01-01",
		});

		const result = resolveProvider(db, "gpt-5.6-luna");

		expect(result).toEqual({ ok: true, provider: "openai" });
	});

	test("routes a priced oN model (e.g. o1) to openai", () => {
		seedPricing({
			provider: "openai",
			model: "o1-mini",
			effective_from: "2026-01-01",
		});

		const result = resolveProvider(db, "o1-mini");

		expect(result).toEqual({ ok: true, provider: "openai" });
	});
});

describe("resolveProvider — rejection semantics (IMPLEMENTATION_GUIDE.md §3.1, §3.6)", () => {
	test("rejects a model with an unsupported prefix as unknown_model", () => {
		const result = resolveProvider(db, "mistral-large");

		expect(result).toEqual({
			ok: false,
			statusCode: 400,
			error: {
				error: {
					message: 'Unknown model: "mistral-large".',
					type: "invalid_request_error",
					code: "unknown_model",
				},
			},
		});
	});

	test("rejects a routed-prefix model with no model_pricing row as unknown_model", () => {
		const result = resolveProvider(db, "gpt-5.6-terra");

		expect(result).toEqual({
			ok: false,
			statusCode: 400,
			error: {
				error: {
					message: 'Unknown model: "gpt-5.6-terra".',
					type: "invalid_request_error",
					code: "unknown_model",
				},
			},
		});
	});

	test("rejects a model whose only pricing row is not yet effective as unknown_model", () => {
		seedPricing({
			provider: "anthropic",
			model: "claude-future",
			effective_from: "2999-01-01",
		});

		const result = resolveProvider(db, "claude-future");

		expect(result).toEqual({
			ok: false,
			statusCode: 400,
			error: {
				error: {
					message: 'Unknown model: "claude-future".',
					type: "invalid_request_error",
					code: "unknown_model",
				},
			},
		});
	});

	test("exact unknown_model OpenAI error envelope shape", () => {
		const result = resolveProvider(db, "unsupported-model");

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected resolveProvider to reject");
		}
		expect(Object.keys(result.error)).toEqual(["error"]);
		expect(Object.keys(result.error.error).sort()).toEqual([
			"code",
			"message",
			"type",
		]);
		expect(result.error.error.code).toBe("unknown_model");
		expect(result.error.error.type).toBe("invalid_request_error");
		expect(result.statusCode).toBe(400);
	});
});
