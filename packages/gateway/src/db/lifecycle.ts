export interface WalLifecycleDatabase {
	pragma(statement: string): unknown;
	close(): void;
}

interface WalCheckpointRow {
	busy: number;
	log: number;
	checkpointed: number;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWalCheckpointRow(value: unknown): value is WalCheckpointRow {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		isSafeNonNegativeInteger(row.busy) &&
		isSafeNonNegativeInteger(row.log) &&
		isSafeNonNegativeInteger(row.checkpointed)
	);
}

function checkpointWal(db: WalLifecycleDatabase): void {
	const result = db.pragma("wal_checkpoint(TRUNCATE)");
	if (
		!Array.isArray(result) ||
		result.length !== 1 ||
		!isWalCheckpointRow(result[0])
	) {
		throw new Error("SQLite WAL checkpoint returned an invalid result");
	}
	const [checkpoint] = result;
	if (
		checkpoint.busy !== 0 ||
		checkpoint.log !== 0 ||
		checkpoint.checkpointed !== 0
	) {
		throw new Error("SQLite WAL checkpoint did not fully truncate the log");
	}
}

/**
 * Checkpoints the WAL before closing its sole gateway-owned connection. A
 * checkpoint failure remains the primary error even if closing also fails.
 */
export function closeDatabaseAfterWalCheckpoint(
	db: WalLifecycleDatabase,
): void {
	let checkpointError: unknown;
	let closeError: unknown;
	try {
		checkpointWal(db);
	} catch (error) {
		checkpointError = error;
	} finally {
		try {
			db.close();
		} catch (error) {
			closeError = error;
		}
	}
	if (checkpointError !== undefined) throw checkpointError;
	if (closeError !== undefined) throw closeError;
}
