import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"migrations",
);
const MIGRATION_FILE = /^\d+_.+\.sql$/;

interface MigrationRow {
	name: string;
}

/** Applies each numbered SQL migration exactly once, in filename order. */
export function migrate(db: Database.Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

	const appliedRows = db
		.prepare("SELECT name FROM _migrations")
		.all() as MigrationRow[];
	const applied = new Set(appliedRows.map((row) => row.name));
	const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && MIGRATION_FILE.test(entry.name))
		.map((entry) => entry.name)
		.sort();

	for (const name of migrations) {
		if (applied.has(name)) {
			continue;
		}

		db.transaction(() => {
			db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
			db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
		})();
	}
}
