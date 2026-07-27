import { describe, expect, test } from "vitest";

import { BudgetGuard, estimateBudgetReservation } from "./budget.js";

describe("BudgetGuard", () => {
	test("admits equality, blocks one micro-USD over, and isolates API keys", () => {
		const guard = new BudgetGuard({ settledSpend: () => 3, now: () => 0 });

		const equality = guard.reserve(1, 10, 7);
		expect(equality).not.toBe("over_budget");
		expect(guard.reserve(2, 10, 7)).not.toBe("over_budget");
		expect(guard.reserve(1, 10, 1)).toBe("over_budget");
	});

	test("counts active reservations synchronously and finalizes each token once", () => {
		const guard = new BudgetGuard({ settledSpend: () => 0, now: () => 0 });
		const first = guard.reserve(1, 4, 2);
		const second = guard.reserve(1, 4, 2);
		expect(first).not.toBe("over_budget");
		expect(second).not.toBe("over_budget");
		expect(guard.reserve(1, 4, 3)).toBe("over_budget");

		if (first === "over_budget" || second === "over_budget") {
			throw new Error("Expected both reservations to be admitted.");
		}
		guard.reconcileAfterDurableLog(first, 0);
		guard.reconcileAfterDurableLog(first, 0);
		// The second reservation remains active; the duplicate first finalization
		// cannot subtract it a second time.
		expect(guard.reserve(1, 4, 3)).toBe("over_budget");
	});

	test("memoizes settled spend briefly, invalidates after durable logging, and retains fail-closed debt once", () => {
		let now = 0;
		let settled = 1;
		let reads = 0;
		const guard = new BudgetGuard({
			settledSpend: () => {
				reads += 1;
				return settled;
			},
			now: () => now,
			memoTtlMs: 10,
		});

		const first = guard.reserve(1, 10, 2);
		expect(reads).toBe(1);
		expect(guard.reserve(2, 10, 2)).not.toBe("over_budget");
		expect(reads).toBe(2);
		expect(guard.reserve(1, 10, 2)).not.toBe("over_budget");
		expect(reads).toBe(2);
		if (first === "over_budget") {
			throw new Error("Expected first reservation to be admitted.");
		}

		settled = 3;
		guard.reconcileAfterDurableLog(first, 2);
		expect(guard.reserve(1, 10, 2)).not.toBe("over_budget");
		expect(reads).toBe(3);

		const failed = guard.reserve(3, 5, 2);
		if (failed === "over_budget") {
			throw new Error("Expected failed-log reservation to be admitted.");
		}
		guard.retainDebt(failed, 4);
		guard.retainDebt(failed, 4);
		expect(guard.reserve(3, 5, 1)).toBe("over_budget");

		now = 11;
		expect(guard.reserve(4, 10, 1)).not.toBe("over_budget");
		expect(reads).toBe(6);
	});

	test("keeps a reservation active when known actual is invalid and retains larger actual debt exactly once", () => {
		const guard = new BudgetGuard({ settledSpend: () => 0, now: () => 0 });
		const invalidActual = guard.reserve(1, 2, 2);
		if (invalidActual === "over_budget") {
			throw new Error("Expected the reservation to be admitted.");
		}
		expect(() => guard.retainDebt(invalidActual, -1)).toThrow();
		expect(guard.reserve(1, 2, 1)).toBe("over_budget");

		const largerActual = guard.reserve(2, 4, 2);
		if (largerActual === "over_budget") {
			throw new Error("Expected the reservation to be admitted.");
		}
		guard.retainDebt(largerActual, 4);
		guard.retainDebt(largerActual, 4);
		// Equality proves the debt is max(reserved, actual) = 4, not double-counted.
		expect(guard.reserve(2, 4, 0)).not.toBe("over_budget");
	});

	test("reserves independently meter-rounded micro-USD with default/max output bounds", () => {
		const pricing = {
			input_micro_usd_per_mtok: 1_500_000,
			output_micro_usd_per_mtok: 2_500_000,
		};
		expect(
			estimateBudgetReservation(
				{ model: "gpt-budget", messages: [{ role: "user", content: "a" }] },
				pricing,
				3,
			),
		).toBe(10);
		expect(
			estimateBudgetReservation(
				{
					model: "gpt-budget",
					messages: [{ role: "user", content: "abcd" }],
					max_tokens: 1,
				},
				pricing,
				9,
			),
		).toBe(5);
		expect(
			estimateBudgetReservation(
				{ model: "gpt-budget", messages: [{ role: "user", content: "a" }] },
				{
					input_micro_usd_per_mtok: 1,
					output_micro_usd_per_mtok: 1,
				},
				1,
			),
		).toBe(0);
	});
});
