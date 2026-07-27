import { describe, expect, test } from "vitest";

import { RateLimiter, TokenBucket } from "./ratelimit.js";

describe("TokenBucket", () => {
	test("starts with its full configured burst capacity", () => {
		let now = 0;
		const bucket = new TokenBucket(3, () => now);

		expect(bucket.take()).toEqual({ allowed: true });
		expect(bucket.take()).toEqual({ allowed: true });
		expect(bucket.take()).toEqual({ allowed: true });
		expect(bucket.take()).toEqual({
			allowed: false,
			retryAfterSeconds: 20,
		});

		now = 20_000;
		expect(bucket.take()).toEqual({ allowed: true });
	});

	test("refills fractionally, caps accumulated credit, and reports exact retry-after", () => {
		let now = 0;
		const bucket = new TokenBucket(60, () => now);

		for (let index = 0; index < 60; index += 1) {
			expect(bucket.take()).toEqual({ allowed: true });
		}
		now = 500;
		expect(bucket.take()).toEqual({
			allowed: false,
			retryAfterSeconds: 1,
		});
		now = 1_000;
		expect(bucket.take()).toEqual({ allowed: true });
		now = 120_000;
		for (let index = 0; index < 60; index += 1) {
			expect(bucket.take()).toEqual({ allowed: true });
		}
		expect(bucket.take()).toEqual({
			allowed: false,
			retryAfterSeconds: 1,
		});
	});

	test("admits exactly at a whole-token refill boundary", () => {
		let now = 0;
		const bucket = new TokenBucket(3, () => now);

		for (let index = 0; index < 3; index += 1) {
			bucket.take();
		}
		now = 20_000;
		expect(bucket.take()).toEqual({ allowed: true });
	});

	test("clamps credit immediately when configured RPM is reduced", () => {
		const now = 0;
		const bucket = new TokenBucket(10, () => now);

		bucket.take();
		bucket.reconfigure(2);
		expect(bucket.take()).toEqual({ allowed: true });
		expect(bucket.take()).toEqual({ allowed: true });
		expect(bucket.take()).toEqual({
			allowed: false,
			retryAfterSeconds: 30,
		});
	});

	test("raises refill speed without minting an immediate burst", () => {
		let now = 0;
		const bucket = new TokenBucket(2, () => now);

		bucket.take();
		bucket.take();
		bucket.reconfigure(6);
		expect(bucket.take()).toEqual({
			allowed: false,
			retryAfterSeconds: 10,
		});
		now = 10_000;
		expect(bucket.take()).toEqual({ allowed: true });
	});
});

describe("RateLimiter", () => {
	test("isolates buckets by authenticated key id", () => {
		const limiter = new RateLimiter(() => 0);

		expect(limiter.take(1, 1)).toEqual({ allowed: true });
		expect(limiter.take(1, 1)).toEqual({
			allowed: false,
			retryAfterSeconds: 60,
		});
		expect(limiter.take(2, 1)).toEqual({ allowed: true });
	});
});
