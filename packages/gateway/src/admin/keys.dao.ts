import type Database from "better-sqlite3";

export interface CreateApiKeyInput {
	name: string;
	budgetMicroUsdMonth: number;
	rateLimitRpm: number;
	keyHash: string;
}

export interface StoredApiKey {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	created_at: string;
}

export interface ApiKeyWithSpend {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	created_at: string;
	month_to_date_spend_micro_usd: number;
}

interface ApiKeyListRow {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: number;
	created_at: string;
	month_to_date_spend_micro_usd: number;
}

export interface ApiKeyPatchInput {
	budget_micro_usd_month?: number;
	rate_limit_rpm?: number;
	disabled?: boolean;
}

interface ApiKeyRow {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: number;
	created_at: string;
}

function mapDisabled(disabledValue: number): boolean {
	return disabledValue === 1;
}

function mapStoredApiKey(row: ApiKeyRow): StoredApiKey {
	return {
		id: row.id,
		name: row.name,
		budget_micro_usd_month: row.budget_micro_usd_month,
		rate_limit_rpm: row.rate_limit_rpm,
		disabled: mapDisabled(row.disabled),
		created_at: row.created_at,
	};
}

export function createApiKey(
	db: Database.Database,
	input: CreateApiKeyInput,
): StoredApiKey {
	const statement = db.prepare(`
		INSERT INTO api_keys (
			name,
			budget_micro_usd_month,
			rate_limit_rpm,
			key_hash,
			disabled
		) VALUES (
			@name,
			@budget_micro_usd_month,
			@rate_limit_rpm,
			@key_hash,
			0
		)
		RETURNING id, name, budget_micro_usd_month, rate_limit_rpm, disabled, created_at
	`);
	const row = statement.get({
		name: input.name,
		budget_micro_usd_month: input.budgetMicroUsdMonth,
		rate_limit_rpm: input.rateLimitRpm,
		key_hash: input.keyHash,
	}) as ApiKeyRow | undefined;
	if (!row) {
		throw new Error("Failed to persist API key");
	}
	return mapStoredApiKey(row);
}

export function listApiKeys(db: Database.Database): ApiKeyWithSpend[] {
	const statement = db.prepare(`
		SELECT
			k.id,
			k.name,
			k.budget_micro_usd_month,
			k.rate_limit_rpm,
			k.disabled,
			k.created_at,
			COALESCE(SUM(r.cost_micro_usd), 0) AS month_to_date_spend_micro_usd
		FROM api_keys k
		LEFT JOIN requests r
			ON r.api_key_id = k.id
			AND r.ts >= datetime('now', 'start of month')
			AND r.ts < datetime('now', 'start of month', '+1 month')
		GROUP BY
			k.id,
			k.name,
			k.budget_micro_usd_month,
			k.rate_limit_rpm,
			k.disabled,
			k.created_at
		ORDER BY k.created_at ASC, k.id ASC
	`);
	const rows = statement.all() as ApiKeyListRow[];
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		budget_micro_usd_month: row.budget_micro_usd_month,
		rate_limit_rpm: row.rate_limit_rpm,
		disabled: mapDisabled(row.disabled),
		created_at: row.created_at,
		month_to_date_spend_micro_usd: row.month_to_date_spend_micro_usd,
	}));
}

export function patchApiKey(
	db: Database.Database,
	id: number,
	updates: ApiKeyPatchInput,
): StoredApiKey | null {
	const statement = db.prepare(`
		UPDATE api_keys
		SET
			budget_micro_usd_month = COALESCE(@budget_micro_usd_month, budget_micro_usd_month),
			rate_limit_rpm = COALESCE(@rate_limit_rpm, rate_limit_rpm),
			disabled = COALESCE(@disabled, disabled)
		WHERE id = @id
		RETURNING id, name, budget_micro_usd_month, rate_limit_rpm, disabled, created_at
	`);
	const row = statement.get({
		id,
		budget_micro_usd_month: updates.budget_micro_usd_month ?? null,
		rate_limit_rpm: updates.rate_limit_rpm ?? null,
		disabled: updates.disabled === undefined ? null : updates.disabled ? 1 : 0,
	}) as ApiKeyRow | undefined;
	if (!row) {
		return null;
	}
	return mapStoredApiKey(row);
}
