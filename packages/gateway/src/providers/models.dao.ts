import type Database from "better-sqlite3";
import type { ProviderName } from "./types.js";

export interface CurrentModelRow {
	model: string;
	provider: ProviderName;
	/** Unix seconds derived from the model's earliest-ever `effective_from` date. */
	created: number;
}

/**
 * Lists every model with at least one currently effective (§3.5:
 * `effective_from <= date('now')`) `model_pricing` row — one row per distinct
 * model, ordered by id ascending. `UNIQUE(model, effective_from)` guarantees
 * at most one row can equal the per-model latest-effective date, so each
 * model surfaces exactly once with that row's provider. A model whose only
 * rows are future-dated has no row `<= now`, so the equality never matches
 * and it is excluded entirely (BUILD_PLAYBOOK.md phase 1 step 8). `created`
 * comes from the model's earliest `effective_from` across all of its pricing
 * history (not just the currently-effective row), so it never shifts as
 * later price changes are added.
 */
export function listCurrentModels(db: Database.Database): CurrentModelRow[] {
	const statement = db.prepare(`
		SELECT
			mp.model AS model,
			mp.provider AS provider,
			CAST(strftime('%s', (
				SELECT MIN(e.effective_from) FROM model_pricing e WHERE e.model = mp.model
			)) AS INTEGER) AS created
		FROM model_pricing mp
		WHERE mp.effective_from = (
			SELECT MAX(c.effective_from) FROM model_pricing c
			WHERE c.model = mp.model AND c.effective_from <= date('now')
		)
		ORDER BY mp.model ASC
	`);
	return statement.all() as CurrentModelRow[];
}
