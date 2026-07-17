import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { z } from "zod";

const ModelPricingRowSchema = z
	.object({
		provider: z.enum(["openai", "anthropic"]),
		model: z.string().min(1),
		input_micro_usd_per_mtok: z.number().int().nonnegative(),
		output_micro_usd_per_mtok: z.number().int().nonnegative(),
		effective_from: z.iso.date(),
	})
	.strict();

export const PricingRowsSchema = z.array(ModelPricingRowSchema).min(1);
export type ModelPricingRow = z.infer<typeof ModelPricingRowSchema>;

export interface SeedPricingOptions {
	dbPath: string;
	pricingPath: string;
}

interface OpenDatabaseLike {
	openDatabase(filename: string): BetterSqliteDatabase;
}

interface MigrateLike {
	migrate(db: BetterSqliteDatabase): void;
}

interface DbHelpers extends OpenDatabaseLike, MigrateLike {}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPricingPath = join(scriptDir, "..", "pricing.json");
const DEFAULT_DB_PATH = process.env.DB_PATH ?? "./data/promptgate.db";

function isNodeModuleNotFound(error: unknown): boolean {
	if (error === null || typeof error !== "object") {
		return false;
	}

	const maybeError = error as { code?: string };
	return maybeError.code === "ERR_MODULE_NOT_FOUND";
}

async function importFirst<T>(paths: readonly string[]): Promise<T> {
	for (const candidate of paths) {
		try {
			return (await import(pathToFileURL(candidate).href)) as T;
		} catch (error) {
			if (isNodeModuleNotFound(error)) {
				continue;
			}

			throw error;
		}
	}

	throw new Error(`Unable to load module from candidates: ${paths.join(", ")}`);
}

async function loadDbHelpers(): Promise<DbHelpers> {
	const sourceOpenDatabase = join(scriptDir, "..", "src", "db", "index.js");
	const sourceMigrate = join(scriptDir, "..", "src", "db", "migrate.js");
	const distOpenDatabase = join(scriptDir, "..", "db", "index.js");
	const distMigrate = join(scriptDir, "..", "db", "migrate.js");

	const openDbModule = await importFirst<OpenDatabaseLike>([
		sourceOpenDatabase,
		distOpenDatabase,
	]);
	const migrateModule = await importFirst<MigrateLike>([
		sourceMigrate,
		distMigrate,
	]);

	return {
		openDatabase: openDbModule.openDatabase,
		migrate: migrateModule.migrate,
	};
}

export function parsePricingRows(raw: string): ModelPricingRow[] {
	const parsed: unknown = JSON.parse(raw);
	return PricingRowsSchema.parse(parsed);
}

export async function seedPricing({
	dbPath,
	pricingPath,
}: SeedPricingOptions): Promise<void> {
	const pricingRows = parsePricingRows(readFileSync(pricingPath, "utf8"));

	const { migrate, openDatabase } = await loadDbHelpers();
	const db = openDatabase(dbPath);
	try {
		migrate(db);

		const upsert = db.prepare(`
			INSERT INTO model_pricing (
				provider,
				model,
				input_micro_usd_per_mtok,
				output_micro_usd_per_mtok,
				effective_from
			) VALUES (
				@provider,
				@model,
				@input_micro_usd_per_mtok,
				@output_micro_usd_per_mtok,
				@effective_from
			)
			ON CONFLICT(model, effective_from) DO UPDATE SET
				provider = excluded.provider,
				input_micro_usd_per_mtok = excluded.input_micro_usd_per_mtok,
				output_micro_usd_per_mtok = excluded.output_micro_usd_per_mtok;
		`);

		const insertTransaction = db.transaction(
			(rows: readonly ModelPricingRow[]) => {
				for (const row of rows) {
					upsert.run(row);
				}
			},
		);

		insertTransaction(pricingRows);
	} finally {
		db.close();
	}
}

export function parseSeedArgs(argv: string[]): SeedPricingOptions {
	const options: SeedPricingOptions = {
		dbPath: DEFAULT_DB_PATH,
		pricingPath: defaultPricingPath,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--db-path" && i + 1 < argv.length) {
			options.dbPath = argv[i + 1];
			i += 1;
			continue;
		}

		if (arg === "--pricing" && i + 1 < argv.length) {
			options.pricingPath = argv[i + 1];
			i += 1;
		}
	}

	return options;
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
	const options = parseSeedArgs(process.argv.slice(2));
	await seedPricing(options);
}
