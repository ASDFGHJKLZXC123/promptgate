import Database from "better-sqlite3";

/** Opens a SQLite connection with the invariants required by PromptGate. */
export function openDatabase(filename: string): Database.Database {
	const db = new Database(filename);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	return db;
}
