import { describe, expect, test } from "vitest";
import { ChatRequestSchema } from "./chat-request.js";

describe("ChatRequestSchema", () => {
	test("parses a minimal valid request", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(result.success).toBe(true);
	});

	test("allows an empty messages array (fully template-defined pg_prompt call)", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [],
			pg_prompt: "safety_screen@prod",
		});
		expect(result.success).toBe(true);
	});

	test("passes through unrecognized OpenAI fields for provider forwarding", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
			seed: 42,
			tools: [{ type: "function", function: { name: "lookup" } }],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.seed).toBe(42);
			expect(result.data.tools).toEqual([
				{ type: "function", function: { name: "lookup" } },
			]);
		}
	});

	test("accepts all touched fields together", () => {
		const result = ChatRequestSchema.safeParse({
			model: "claude-opus-4-8",
			messages: [{ role: "system", content: "be terse" }],
			temperature: 0.7,
			top_p: 0.9,
			max_tokens: 256,
			stream: true,
			stop: ["\n"],
			response_format: { type: "json_object" },
			reasoning_effort: "high",
			pg_prompt: "safety_screen@prod",
			pg_vars: { note: "test" },
			pg_feature: "inbox_summary",
			pg_no_cache: true,
		});
		expect(result.success).toBe(true);
	});

	test.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"])(
		"accepts the current OpenAI reasoning effort value %s",
		(reasoning_effort) => {
			const result = ChatRequestSchema.safeParse({
				model: "gpt-5.6-terra",
				messages: [{ role: "user", content: "hi" }],
				reasoning_effort,
			});

			expect(result.success).toBe(true);
		},
	);

	test("rejects temperature above the documented 0-2 range", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
			temperature: 2.5,
		});
		expect(result.success).toBe(false);
	});

	test("rejects an empty pg_prompt", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
			pg_prompt: "",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a missing model", () => {
		const result = ChatRequestSchema.safeParse({
			messages: [{ role: "user", content: "hi" }],
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown role", () => {
		const result = ChatRequestSchema.safeParse({
			model: "gpt-5.6-terra",
			messages: [{ role: "narrator", content: "hi" }],
		});
		expect(result.success).toBe(false);
	});
});
