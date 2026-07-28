export interface RequestPacingClock {
	now(): number;
	sleep(milliseconds: number): Promise<void>;
}

const systemClock: RequestPacingClock = {
	now: () => performance.now(),
	sleep: (milliseconds) =>
		new Promise((resolve) => {
			setTimeout(resolve, milliseconds);
		}),
};

/**
 * Serializes request starts for each model without coupling different models.
 * A slot is consumed before its wait starts, so concurrent callers cannot race
 * through a quota boundary. Failed waits deliberately retain their slot.
 */
export class PerModelRequestPacer {
	private readonly nextEligibleAt = new Map<string, number>();
	private readonly tails = new Map<string, Promise<void>>();
	private readonly intervalMs: number;
	private readonly clock: RequestPacingClock;

	constructor(intervalMs: number, clock: RequestPacingClock = systemClock) {
		this.intervalMs = intervalMs;
		this.clock = clock;
	}

	async wait(model: string): Promise<void> {
		if (this.intervalMs === 0) return;
		const prior = this.tails.get(model) ?? Promise.resolve();
		const turn = prior
			.catch(() => undefined)
			.then(async () => {
				const now = this.clock.now();
				const scheduled = Math.max(now, this.nextEligibleAt.get(model) ?? now);
				this.nextEligibleAt.set(model, scheduled + this.intervalMs);
				for (;;) {
					const remaining = scheduled - this.clock.now();
					if (remaining <= 0) return;
					await this.clock.sleep(remaining);
				}
			});
		this.tails.set(model, turn);
		try {
			await turn;
		} finally {
			if (this.tails.get(model) === turn) this.tails.delete(model);
		}
	}
}
