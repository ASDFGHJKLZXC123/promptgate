import { describe, expect, test } from "vitest";
import { ChatResponseSchema } from "./chat-response.js";

describe("ChatResponseSchema", () => {
	test("parses a full non-streaming response with usage", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi there" },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			},
		});
		expect(result.success).toBe(true);
	});

	test("allows usage to be missing (provider hiccup — metering falls back to an estimate)", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi there" },
					finish_reason: "stop",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("allows a null finish_reason (in-progress / provider-specific)", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: null },
					finish_reason: null,
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("passes through provider-specific extras like system_fingerprint", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			system_fingerprint: "fp_abc123",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.system_fingerprint).toBe("fp_abc123");
		}
	});

	test("rejects a response with no choices array", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
		});
		expect(result.success).toBe(false);
	});

	test("rejects an invalid finish_reason value", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi" },
					finish_reason: "made_up_reason",
				},
			],
		});
		expect(result.success).toBe(false);
	});
});
