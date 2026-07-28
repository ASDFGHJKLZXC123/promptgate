import { describe, expect, test, vi } from "vitest";
import { PerModelRequestPacer } from "./pacing.js";

describe("PerModelRequestPacer", () => {
	test("leaves the default zero interval inert", async () => {
		const sleep = vi.fn();
		const pacer = new PerModelRequestPacer(0, { now: () => 0, sleep });
		await pacer.wait("gemini-2.5-flash");
		expect(sleep).not.toHaveBeenCalled();
	});

	test("spaces same-model calls while independent models can start together", async () => {
		let now = 0;
		const sleep = vi.fn(async (milliseconds: number) => {
			now += milliseconds;
		});
		const pacer = new PerModelRequestPacer(6_500, {
			now: () => now,
			sleep,
		});
		await pacer.wait("gemini-2.5-flash");
		await pacer.wait("deepseek-v4-flash");
		await pacer.wait("gemini-2.5-flash");

		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(6_500);
	});

	test("queues concurrent callers of the same model before reserving a later slot", async () => {
		let now = 0;
		const sleepers: Array<{ milliseconds: number; resolve: () => void }> = [];
		const pacer = new PerModelRequestPacer(10, {
			now: () => now,
			sleep: async (milliseconds) =>
				new Promise<void>((resolve) => {
					sleepers.push({ milliseconds, resolve });
				}),
		});
		await pacer.wait("gemini-2.5-flash");
		const second = pacer.wait("gemini-2.5-flash");
		const third = pacer.wait("gemini-2.5-flash");
		await vi.waitFor(() => expect(sleepers).toHaveLength(1));
		expect(sleepers[0]?.milliseconds).toBe(10);

		now = 10;
		sleepers[0]?.resolve();
		await second;
		await vi.waitFor(() => expect(sleepers).toHaveLength(2));
		expect(sleepers[1]?.milliseconds).toBe(10);

		now = 20;
		sleepers[1]?.resolve();
		await third;
	});
});
