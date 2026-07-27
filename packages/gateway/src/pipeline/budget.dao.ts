import type Database from "better-sqlite3";

/**
 * Returns one key's settled current-month request cost. Rejected rows and
 * rows without metering contribute zero through SQLite's SUM/COALESCE rules.
 * Reservations and fail-closed debt deliberately live outside SQLite in the
 * single-process BudgetGuard (IMPLEMENTATION_GUIDE.md §3.5).
 */
export function sumCurrentMonthSettledSpend(
	db: Database.Database,
	apiKeyId: number,
): number {
	const row = db
		.prepare(
			`SELECT COALESCE(SUM(cost_micro_usd), 0) AS spend_micro_usd
			 FROM requests
			 WHERE api_key_id = ?
				AND ts >= datetime('now', 'start of month')
				AND ts < datetime('now', 'start of month', '+1 month')`,
		)
		.get(apiKeyId) as { spend_micro_usd: number };
	return row.spend_micro_usd;
}
