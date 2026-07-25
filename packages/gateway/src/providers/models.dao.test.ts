import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { listCurrentModels } from "./models.dao.js";
import type { ProviderName } from "./types.js";

let tempDbDir: string;
let db: Database.Database;

interface SeedPricingRow {
	provider: ProviderName;
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

function unixSecondsOf(dateOnly: string): number {
	return Math.floor(new Date(`${dateOnly}T00:00:00Z`).getTime() / 1000);
}

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-models-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

describe("listCurrentModels (IMPLEMENTATION_GUIDE.md §5.1, §3.5)", () => {
	test("returns a currently effective single-row model with its provider and created date", () => {
		seedPricing({
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});

		const rows = listCurrentModels(db);

		expect(rows).toEqual([
			{
				model: "gpt-5.6-luna",
				provider: "openai",
				created: unixSecondsOf("2020-01-01"),
			},
		]);
	});

	test("collapses multiple price rows for one model into a single distinct entry", () => {
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-06-30",
			input_micro_usd_per_mtok: 2_000_000,
			output_micro_usd_per_mtok: 10_000_000,
		});
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
			input_micro_usd_per_mtok: 1_000_000,
			output_micro_usd_per_mtok: 5_000_000,
		});

		const rows = listCurrentModels(db);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			model: "claude-sonnet-5",
			provider: "anthropic",
			created: unixSecondsOf("2020-01-01"),
		});
	});

	test("uses the latest currently-effective row for provider ownership when it differs from the earliest row", () => {
		seedPricing({
			provider: "openai",
			model: "migrated-model",
			effective_from: "2020-01-01",
		});
		seedPricing({
			provider: "anthropic",
			model: "migrated-model",
			effective_from: "2020-06-01",
		});

		const rows = listCurrentModels(db);

		expect(rows).toEqual([
			{
				model: "migrated-model",
				provider: "anthropic",
				created: unixSecondsOf("2020-01-01"),
			},
		]);
	});

	test("excludes a model whose only pricing row is future-dated", () => {
		seedPricing({
			provider: "anthropic",
			model: "claude-future",
			effective_from: "2999-01-01",
		});

		const rows = listCurrentModels(db);

		expect(rows).toEqual([]);
	});

	test("includes a model with a currently effective row even when a later future row also exists", () => {
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-06-30",
		});
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2999-09-01",
		});

		const rows = listCurrentModels(db);

		expect(rows).toEqual([
			{
				model: "claude-sonnet-5",
				provider: "anthropic",
				created: unixSecondsOf("2020-06-30"),
			},
		]);
	});

	test("orders distinct models deterministically by id ascending", () => {
		seedPricing({
			provider: "openai",
			model: "gpt-5.6-terra",
			effective_from: "2020-01-01",
		});
		seedPricing({
			provider: "anthropic",
			model: "claude-sonnet-5",
			effective_from: "2020-01-01",
		});
		seedPricing({
			provider: "openai",
			model: "gpt-5.6-luna",
			effective_from: "2020-01-01",
		});

		const rows = listCurrentModels(db);

		expect(rows.map((row) => row.model)).toEqual([
			"claude-sonnet-5",
			"gpt-5.6-luna",
			"gpt-5.6-terra",
		]);
	});

	test("returns an empty list when model_pricing has no rows", () => {
		const rows = listCurrentModels(db);

		expect(rows).toEqual([]);
	});
});
