import { z } from "zod";

/** Monotonic milliseconds, injectable so bucket behavior is deterministic in tests. */
export type RateLimitClock = () => number;

const RateLimitRpmSchema = z.number().int().positive();
const ApiKeyIdSchema = z.number().int().positive();
const ClockReadingSchema = z.number().finite();

export type RateLimitResult =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

/**
 * A token bucket for one authenticated key. It starts full, refills at
 * `rpm / 60` tokens per second, and never exceeds its configured capacity.
 */
export class TokenBucket {
	private tokens: number;
	private lastRefillAtMs: number;
	private rpm: number;

	public constructor(
		rpm: number,
		private readonly now: RateLimitClock,
	) {
		this.rpm = RateLimitRpmSchema.parse(rpm);
		this.tokens = this.rpm;
		this.lastRefillAtMs = this.readNow();
	}

	/**
	 * Applies a changed persisted RPM without minting new tokens. A lower
	 * capacity immediately clamps accumulated burst credit; a higher capacity
	 * preserves existing credit and refills at the new rate going forward.
	 */
	public reconfigure(rpm: number): void {
		const nextRpm = RateLimitRpmSchema.parse(rpm);
		this.refill();
		this.rpm = nextRpm;
		this.tokens = Math.min(this.tokens, this.rpm);
	}

	public take(): RateLimitResult {
		this.refill();
		const deficit = 1 - this.tokens;
		// A calculation landing at a whole-token boundary should be admitted;
		// tolerate only floating-point representation noise, not partial tokens.
		if (deficit <= 1e-12) {
			this.tokens = Math.max(0, this.tokens - 1);
			return { allowed: true };
		}

		return {
			allowed: false,
			// Retry-After is an integer number of seconds. Rounding up is the exact
			// earliest whole second at which one complete token is available.
			retryAfterSeconds: Math.max(1, Math.ceil((deficit * 60) / this.rpm)),
		};
	}

	private refill(): void {
		const currentMs = Math.max(this.lastRefillAtMs, this.readNow());
		const elapsedMs = currentMs - this.lastRefillAtMs;
		this.tokens = Math.min(
			this.rpm,
			this.tokens + (elapsedMs * this.rpm) / 60_000,
		);
		this.lastRefillAtMs = currentMs;
	}

	private readNow(): number {
		return ClockReadingSchema.parse(this.now());
	}
}

/** Single-process, per-key token bucket registry (IMPLEMENTATION_GUIDE.md §3.5). */
export class RateLimiter {
	private readonly buckets = new Map<number, TokenBucket>();

	public constructor(
		private readonly now: RateLimitClock = () => performance.now(),
	) {}

	public take(apiKeyId: number, rpm: number): RateLimitResult {
		const keyId = ApiKeyIdSchema.parse(apiKeyId);
		const validatedRpm = RateLimitRpmSchema.parse(rpm);
		const existing = this.buckets.get(keyId);
		if (existing) {
			existing.reconfigure(validatedRpm);
			return existing.take();
		}

		const bucket = new TokenBucket(validatedRpm, this.now);
		this.buckets.set(keyId, bucket);
		return bucket.take();
	}
}
