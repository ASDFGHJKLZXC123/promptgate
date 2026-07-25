import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { findCurrentPricing } from "./pricing.dao.js";

let tempDbDir: string;
let db: Database.Database;

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-pricing-dao-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

test("returns null cached_input_micro_usd_per_mtok when the seeded row omits it (migration 003 default)", () => {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES ('openai', 'gpt-test', 1000000, 2000000, '2020-01-01')`,
	).run();

	const pricing = findCurrentPricing(db, "gpt-test");

	expect(pricing).toMatchObject({
		provider: "openai",
		cached_input_micro_usd_per_mtok: null,
	});
});

test("returns the cached input rate for a provider that prices cache-hit input separately", () => {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES ('deepseek', 'deepseek-v4-flash', 140000, 2800, 280000, '2020-01-01')`,
	).run();

	const pricing = findCurrentPricing(db, "deepseek-v4-flash");

	expect(pricing).toMatchObject({
		provider: "deepseek",
		input_micro_usd_per_mtok: 140000,
		cached_input_micro_usd_per_mtok: 2800,
		output_micro_usd_per_mtok: 280000,
	});
});

test("returns the cached rate from the latest currently effective pricing row", () => {
	db.prepare(
		`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
		 VALUES
		 ('deepseek', 'deepseek-v4-flash', 200000, 4000, 300000, '2020-01-01'),
		 ('deepseek', 'deepseek-v4-flash', 140000, 2800, 280000, '2021-01-01'),
		 ('deepseek', 'deepseek-v4-flash', 100000, 1000, 200000, '2999-01-01')`,
	).run();

	expect(findCurrentPricing(db, "deepseek-v4-flash")).toMatchObject({
		input_micro_usd_per_mtok: 140000,
		cached_input_micro_usd_per_mtok: 2800,
		output_micro_usd_per_mtok: 280000,
		effective_from: "2021-01-01",
	});
});

test("returns null for a model with no effective pricing row", () => {
	expect(findCurrentPricing(db, "unpriced-model")).toBeNull();
});
