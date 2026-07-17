import type Database from "better-sqlite3";

export interface ModelPricingRow {
	id: number;
	provider: "openai" | "anthropic";
	model: string;
	input_micro_usd_per_mtok: number;
	output_micro_usd_per_mtok: number;
	effective_from: string;
}

/**
 * Looks up the currently effective `model_pricing` row for a model — the
 * newest `effective_from` that is not in the future (IMPLEMENTATION_GUIDE.md
 * §3.5's date-effective pricing, restated in §3.1's routing check). Returns
 * `null` when the model has no priced row yet (or only future-dated rows),
 * which `routes.ts` treats as an unpriced/unknown model.
 */
export function findCurrentPricing(
	db: Database.Database,
	model: string,
): ModelPricingRow | null {
	const statement = db.prepare(`
		SELECT id, provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from
		FROM model_pricing
		WHERE model = ? AND effective_from <= date('now')
		ORDER BY effective_from DESC
		LIMIT 1
	`);
	const row = statement.get(model) as ModelPricingRow | undefined;
	return row ?? null;
}
