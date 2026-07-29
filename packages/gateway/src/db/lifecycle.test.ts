import { describe, expect, test, vi } from "vitest";
import { closeDatabaseAfterWalCheckpoint } from "./lifecycle.js";

function database(result: unknown) {
	return {
		pragma: vi.fn(() => result),
		close: vi.fn(),
	};
}

describe("WAL close lifecycle", () => {
	test("accepts the exact successful TRUNCATE row and closes once", () => {
		const db = database([{ busy: 0, log: 0, checkpointed: 0 }]);

		closeDatabaseAfterWalCheckpoint(db);

		expect(db.pragma).toHaveBeenCalledExactlyOnceWith(
			"wal_checkpoint(TRUNCATE)",
		);
		expect(db.close).toHaveBeenCalledExactlyOnceWith();
	});

	test.each([
		null,
		[],
		[{}],
		[{ busy: -1, log: 0, checkpointed: 0 }],
		[{ busy: 0.5, log: 0, checkpointed: 0 }],
		[{ busy: Number.MAX_SAFE_INTEGER + 1, log: 0, checkpointed: 0 }],
		[{ busy: 1, log: 0, checkpointed: 0 }],
		[{ busy: 0, log: 1, checkpointed: 1 }],
		[{ busy: 0, log: -1, checkpointed: 0 }],
		[{ busy: 0, log: 0, checkpointed: 0.5 }],
		[{ busy: 0, log: Number.NaN, checkpointed: 0 }],
	])("rejects invalid checkpoint result %#", (result) => {
		const db = database(result);

		expect(() => closeDatabaseAfterWalCheckpoint(db)).toThrow();
		expect(db.close).toHaveBeenCalledExactlyOnceWith();
	});

	test("rethrows the checkpoint error after closing once", () => {
		const checkpointError = new Error("checkpoint failed");
		const db = database([{ busy: 0, log: 0, checkpointed: 0 }]);
		db.pragma.mockImplementation(() => {
			throw checkpointError;
		});

		expect(() => closeDatabaseAfterWalCheckpoint(db)).toThrow(checkpointError);
		expect(db.close).toHaveBeenCalledExactlyOnceWith();
	});

	test("rethrows a close failure after a successful checkpoint", () => {
		const closeError = new Error("close failed");
		const db = database([{ busy: 0, log: 0, checkpointed: 0 }]);
		db.close.mockImplementation(() => {
			throw closeError;
		});

		expect(() => closeDatabaseAfterWalCheckpoint(db)).toThrow(closeError);
		expect(db.close).toHaveBeenCalledExactlyOnceWith();
	});

	test("preserves checkpoint error identity when checkpoint and close both fail", () => {
		const checkpointError = new Error("checkpoint failed");
		const closeError = new Error("close failed");
		const db = database([{ busy: 0, log: 0, checkpointed: 0 }]);
		db.pragma.mockImplementation(() => {
			throw checkpointError;
		});
		db.close.mockImplementation(() => {
			throw closeError;
		});

		let thrown: unknown;
		try {
			closeDatabaseAfterWalCheckpoint(db);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(checkpointError);
		expect(db.close).toHaveBeenCalledExactlyOnceWith();
	});
});
