import type Database from "better-sqlite3";

export interface ApiKeyAuthRow {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: number;
}

/** Looks up an API key by its SHA-256 hash. Never selects key_hash. */
export function findApiKeyByHash(
	db: Database.Database,
	keyHash: string,
): ApiKeyAuthRow | null {
	const statement = db.prepare(`
		SELECT id, name, budget_micro_usd_month, rate_limit_rpm, disabled
		FROM api_keys
		WHERE key_hash = ?
	`);
	const row = statement.get(keyHash) as ApiKeyAuthRow | undefined;
	return row ?? null;
}
