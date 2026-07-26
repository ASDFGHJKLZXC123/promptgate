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

	test("accepts Gemini usage whose total includes hidden thinking output", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gemini-2.5-flash",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 3,
				completion_tokens: 2,
				total_tokens: 28,
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects usage whose total is smaller than prompt plus completion", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-5.6-terra",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 14,
			},
		});
		expect(result.success).toBe(false);
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

	test("accepts DeepSeek's documented insufficient_system_resource finish reason", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "try again" },
					finish_reason: "insufficient_system_resource",
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

	test("accepts paired cache usage fields that sum to prompt_tokens", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
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
				prompt_cache_hit_tokens: 4,
				prompt_cache_miss_tokens: 6,
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects a cache hit/miss pair that does not sum to prompt_tokens", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
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
				prompt_cache_hit_tokens: 4,
				prompt_cache_miss_tokens: 5,
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects a lone cache usage field without its pair", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
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
				prompt_cache_hit_tokens: 4,
			},
		});
		expect(result.success).toBe(false);
	});

	test("accepts Gemini cached-token details within prompt_tokens", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gemini-2.5-flash",
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
				prompt_tokens_details: { cached_tokens: 4 },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects Gemini cached-token details that exceed prompt_tokens", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gemini-2.5-flash",
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
				prompt_tokens_details: { cached_tokens: 11 },
			},
		});
		expect(result.success).toBe(false);
	});

	test("accepts matching DeepSeek cache fields in both compatible representations", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
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
				prompt_cache_hit_tokens: 4,
				prompt_cache_miss_tokens: 6,
				prompt_tokens_details: { cached_tokens: 4 },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects conflicting cache-hit counts across compatible representations", () => {
		const result = ChatResponseSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "deepseek-v4-flash",
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
				prompt_cache_hit_tokens: 4,
				prompt_cache_miss_tokens: 6,
				prompt_tokens_details: { cached_tokens: 3 },
			},
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
