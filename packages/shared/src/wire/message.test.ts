import { describe, expect, test } from "vitest";
import { ChatMessageSchema } from "./message.js";

describe("ChatMessageSchema", () => {
	test("accepts plain string content", () => {
		expect(
			ChatMessageSchema.safeParse({ role: "user", content: "hi" }).success,
		).toBe(true);
	});

	test("accepts current OpenAI developer messages", () => {
		expect(
			ChatMessageSchema.safeParse({
				role: "developer",
				content: "Follow the application policy.",
			}).success,
		).toBe(true);
	});

	test("accepts null content (e.g. an assistant tool-call turn)", () => {
		expect(
			ChatMessageSchema.safeParse({ role: "assistant", content: null }).success,
		).toBe(true);
	});

	test("accepts multimodal content parts", () => {
		const result = ChatMessageSchema.safeParse({
			role: "user",
			content: [
				{ type: "text", text: "describe this" },
				{ type: "image_url", image_url: { url: "https://example.com/x.png" } },
			],
		});
		expect(result.success).toBe(true);
	});

	test("passes through tool_calls without validating their shape", () => {
		const result = ChatMessageSchema.safeParse({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function" }],
		});
		expect(result.success).toBe(true);
	});

	test("rejects an unrecognized role", () => {
		expect(
			ChatMessageSchema.safeParse({ role: "narrator", content: "hi" }).success,
		).toBe(false);
	});
});
