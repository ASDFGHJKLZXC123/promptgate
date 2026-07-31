import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { openDatabase } from "./index.js";
import { migrate } from "./migrate.js";

let tempDbDir: string | undefined;

afterEach(() => {
	if (tempDbDir) rmSync(tempDbDir, { recursive: true, force: true });
	tempDbDir = undefined;
});

test("migration 006 backfills only legacy non-hit cache-savings provenance", () => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-provenance-migration-"));
	const db = openDatabase(join(tempDbDir, "promptgate.db"));
	try {
		for (const migration of [
			"001_core.sql",
			"002_request_identity.sql",
			"003_provider_pricing.sql",
			"004_registry.sql",
			"005_evals.sql",
		]) {
			db.exec(
				readFileSync(
					new URL(`./migrations/${migration}`, import.meta.url),
					"utf8",
				),
			);
		}
		db.exec(`CREATE TABLE _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.prepare(
			"INSERT INTO _migrations (name) VALUES (?), (?), (?), (?), (?)",
		).run(
			"001_core.sql",
			"002_request_identity.sql",
			"003_provider_pricing.sql",
			"004_registry.sql",
			"005_evals.sql",
		);
		const key = db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES ('legacy', 'hash') RETURNING id",
			)
			.get() as { id: number };
		db.prepare(
			`INSERT INTO requests (api_key_id, provider, model, cache_hit, status)
			 VALUES (?, 'openai', 'model', 0, 'ok'), (?, 'openai', 'model', 1, 'ok')`,
		).run(key.id, key.id);
		db.prepare(
			`INSERT INTO cache_entries (
				hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at
			) VALUES ('legacy-cache', 'model', '{}', 'null', 99, '2999-01-01 00:00:00')`,
		).run();

		migrate(db);

		expect(
			db
				.prepare(
					"SELECT cache_hit, cache_saved_micro_usd, cache_saved_estimated FROM requests ORDER BY id",
				)
				.all(),
		).toEqual([
			{ cache_hit: 0, cache_saved_micro_usd: 0, cache_saved_estimated: 0 },
			{
				cache_hit: 1,
				cache_saved_micro_usd: null,
				cache_saved_estimated: null,
			},
		]);
		expect(
			db
				.prepare(
					"SELECT priced_cost_micro_usd, priced_cost_estimated FROM cache_entries",
				)
				.get(),
		).toEqual({ priced_cost_micro_usd: 99, priced_cost_estimated: null });
	} finally {
		db.close();
	}
});
