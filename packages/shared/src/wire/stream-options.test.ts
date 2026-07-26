import { describe, expect, test } from "vitest";
import { StreamOptionsSchema } from "./stream-options.js";

describe("StreamOptionsSchema", () => {
	test("accepts an omitted/empty options object", () => {
		expect(StreamOptionsSchema.safeParse({}).success).toBe(true);
	});

	test("accepts include_usage and preserves unknown caller fields", () => {
		const result = StreamOptionsSchema.safeParse({
			include_usage: false,
			continuous_usage_stats: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.include_usage).toBe(false);
			expect(result.data.continuous_usage_stats).toBe(true);
		}
	});

	test("rejects a non-boolean include_usage", () => {
		expect(
			StreamOptionsSchema.safeParse({ include_usage: "yes" }).success,
		).toBe(false);
	});

	test("rejects a non-object value", () => {
		expect(StreamOptionsSchema.safeParse(5).success).toBe(false);
	});
});
