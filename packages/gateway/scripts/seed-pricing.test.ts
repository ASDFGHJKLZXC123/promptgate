import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";

import {
	parsePricingRows,
	parseSeedArgs,
	seedPricing,
} from "./seed-pricing.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checkedInPricingPath = join(scriptDir, "..", "pricing.json");

type SeededPricingRow = {
	provider: string;
	model: string;
	input_micro_usd_per_mtok: number;
	cached_input_micro_usd_per_mtok: number | null;
	output_micro_usd_per_mtok: number;
	effective_from: string;
};

interface TestContext {
	tempDir: string;
	dbPath: string;
	pricingPath: string;
}

const HUMAN_APPROVED_ROWS = [
	{
		provider: "openai",
		model: "gpt-5.6-luna",
		input_micro_usd_per_mtok: 1000000,
		cached_input_micro_usd_per_mtok: null,
		output_micro_usd_per_mtok: 6000000,
		effective_from: "2026-07-16",
	},
	{
		provider: "openai",
		model: "gpt-5.6-terra",
		input_micro_usd_per_mtok: 2500000,
		cached_input_micro_usd_per_mtok: null,
		output_micro_usd_per_mtok: 15000000,
		effective_from: "2026-07-16",
	},
	{
		provider: "anthropic",
		model: "claude-sonnet-5",
		input_micro_usd_per_mtok: 2000000,
		cached_input_micro_usd_per_mtok: null,
		output_micro_usd_per_mtok: 10000000,
		effective_from: "2026-06-30",
	},
	{
		provider: "anthropic",
		model: "claude-sonnet-5",
		input_micro_usd_per_mtok: 3000000,
		cached_input_micro_usd_per_mtok: null,
		output_micro_usd_per_mtok: 15000000,
		effective_from: "2026-09-01",
	},
	{
		provider: "gemini",
		model: "gemini-2.5-flash-lite",
		input_micro_usd_per_mtok: 100000,
		cached_input_micro_usd_per_mtok: null,
		output_micro_usd_per_mtok: 400000,
		effective_from: "2026-07-25",
	},
	{
		provider: "deepseek",
		model: "deepseek-v4-flash",
		input_micro_usd_per_mtok: 140000,
		cached_input_micro_usd_per_mtok: 2800,
		output_micro_usd_per_mtok: 280000,
		effective_from: "2026-07-25",
	},
] as const;

let context: TestContext;

beforeEach(() => {
	context = {
		tempDir: mkdtempSync(join(tmpdir(), "promptgate-pricing-seed-")),
		dbPath: "",
		pricingPath: "",
	};
	context.dbPath = join(context.tempDir, "promptgate.db");
	context.pricingPath = join(context.tempDir, "pricing.json");
});

afterEach(() => {
	if (context?.tempDir) {
		rmSync(context.tempDir, { recursive: true, force: true });
	}
});

function readSeededRows(dbPath: string) {
	const db = new Database(dbPath);
	try {
		return db
			.prepare(
				"SELECT provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from FROM model_pricing ORDER BY model, effective_from",
			)
			.all() as Array<SeededPricingRow>;
	} finally {
		db.close();
	}
}

function rowsAsSet(rows: readonly SeededPricingRow[]) {
	return new Set(
		rows.map(
			(row) =>
				`${row.provider}|${row.model}|${row.effective_from}|${row.input_micro_usd_per_mtok}|${row.cached_input_micro_usd_per_mtok}|${row.output_micro_usd_per_mtok}`,
		),
	);
}

test("imports checked-in pricing rows exactly as human-approved values", () => {
	const raw = readFileSync(checkedInPricingPath, "utf8");
	const rows = parsePricingRows(raw);

	expect(rows).toEqual(HUMAN_APPROVED_ROWS);
});

test("enforces Zod validation on malformed pricing rows", () => {
	expect(() =>
		parsePricingRows(
			JSON.stringify([
				{
					provider: "openai",
					model: "broken-model",
					input_micro_usd_per_mtok: 10,
					cached_input_micro_usd_per_mtok: null,
					output_micro_usd_per_mtok: 100,
					effective_from: "2026-99-99",
				},
			]),
		),
	).toThrow(ZodError);
});

test("accepts gemini and deepseek as valid providers", () => {
	const rows = parsePricingRows(
		JSON.stringify([
			{
				provider: "deepseek",
				model: "deepseek-v4-flash",
				input_micro_usd_per_mtok: 140000,
				cached_input_micro_usd_per_mtok: 2800,
				output_micro_usd_per_mtok: 280000,
				effective_from: "2026-07-25",
			},
		]),
	);
	expect(rows[0]?.provider).toBe("deepseek");
});

test("normalizes an omitted cached-input rate to null for pre-step-9 pricing files", () => {
	const rows = parsePricingRows(
		JSON.stringify([
			{
				provider: "openai",
				model: "gpt-legacy",
				input_micro_usd_per_mtok: 1_000_000,
				output_micro_usd_per_mtok: 2_000_000,
				effective_from: "2026-07-16",
			},
		]),
	);

	expect(rows[0]?.cached_input_micro_usd_per_mtok).toBeNull();
});

test("parses CLI arguments for DB and pricing paths", () => {
	const options = parseSeedArgs([
		"--db-path",
		"sqlite.db",
		"--pricing",
		"prices.json",
	]);

	expect(options).toEqual({
		dbPath: "sqlite.db",
		pricingPath: "prices.json",
	});
});

describe("seed-pricing", () => {
	test("seeds a pre-step-9 pricing file with no cached-input field", async () => {
		writeFileSync(
			context.pricingPath,
			`${JSON.stringify(
				[
					{
						provider: "openai",
						model: "gpt-legacy",
						input_micro_usd_per_mtok: 1_000_000,
						output_micro_usd_per_mtok: 2_000_000,
						effective_from: "2026-07-16",
					},
				],
				null,
				2,
			)}\n`,
			"utf8",
		);

		await seedPricing({
			dbPath: context.dbPath,
			pricingPath: context.pricingPath,
		});

		expect(readSeededRows(context.dbPath)).toEqual([
			{
				provider: "openai",
				model: "gpt-legacy",
				input_micro_usd_per_mtok: 1_000_000,
				cached_input_micro_usd_per_mtok: null,
				output_micro_usd_per_mtok: 2_000_000,
				effective_from: "2026-07-16",
			},
		]);
	});

	test("seeds exact approved rows and is idempotent", async () => {
		await seedPricing({
			dbPath: context.dbPath,
			pricingPath: checkedInPricingPath,
		});
		const firstRows = readSeededRows(context.dbPath);
		const firstSet = rowsAsSet(firstRows);

		await seedPricing({
			dbPath: context.dbPath,
			pricingPath: checkedInPricingPath,
		});
		const secondRows = readSeededRows(context.dbPath);
		const secondSet = rowsAsSet(secondRows);

		expect(firstRows).toHaveLength(6);
		expect(secondRows).toHaveLength(6);
		expect(secondSet).toEqual(firstSet);
	});

	test("updates existing rows when approved pricing changes", async () => {
		const base = [
			{
				provider: "openai",
				model: "gpt-5.6-luna",
				input_micro_usd_per_mtok: 1000000,
				cached_input_micro_usd_per_mtok: null,
				output_micro_usd_per_mtok: 6000000,
				effective_from: "2026-07-16",
			},
		];
		const updated = [
			{
				provider: "openai",
				model: "gpt-5.6-luna",
				input_micro_usd_per_mtok: 1100000,
				cached_input_micro_usd_per_mtok: null,
				output_micro_usd_per_mtok: 6100000,
				effective_from: "2026-07-16",
			},
		];
		writeFileSync(
			context.pricingPath,
			`${JSON.stringify(base, null, 2)}\n`,
			"utf8",
		);

		await seedPricing({
			dbPath: context.dbPath,
			pricingPath: context.pricingPath,
		});

		writeFileSync(
			context.pricingPath,
			`${JSON.stringify(updated, null, 2)}\n`,
			"utf8",
		);

		await seedPricing({
			dbPath: context.dbPath,
			pricingPath: context.pricingPath,
		});

		const updatedRows = readSeededRows(context.dbPath).filter(
			(row) =>
				row.model === "gpt-5.6-luna" && row.effective_from === "2026-07-16",
		);

		expect(updatedRows).toHaveLength(1);
		expect(updatedRows[0]).toMatchObject({
			input_micro_usd_per_mtok: 1100000,
			output_micro_usd_per_mtok: 6100000,
		});
	});
});
