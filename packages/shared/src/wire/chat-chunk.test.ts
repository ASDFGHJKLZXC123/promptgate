import { describe, expect, test } from "vitest";
import { ChatCompletionChunkSchema } from "./chat-chunk.js";

describe("ChatCompletionChunkSchema", () => {
	test("parses a nonterminal content chunk with usage: null and preserves unknown fields", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1_785_283_260,
			model: "gpt-5.6-luna",
			system_fingerprint: "fp_x",
			choices: [
				{
					index: 0,
					delta: { content: "Hello", refusal: null },
					logprobs: null,
					finish_reason: null,
				},
			],
			usage: null,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			// Unknown fields survive for verbatim provider forwarding.
			expect(result.data.system_fingerprint).toBe("fp_x");
			expect(result.data.choices[0]?.logprobs).toBeNull();
		}
	});

	test("parses the terminal usage chunk (empty choices + validated usage)", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "deepseek-v4-flash",
			choices: [],
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 320,
				total_tokens: 1320,
				prompt_cache_hit_tokens: 768,
				prompt_cache_miss_tokens: 232,
			},
		});
		expect(result.success).toBe(true);
	});

	test("parses a combined terminal content, finish, and usage chunk", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "gemini-2.5-flash",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "OK" },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 4,
				completion_tokens: 1,
				total_tokens: 30,
			},
		});
		expect(result.success).toBe(true);
	});

	test("preserves DeepSeek reasoning_content on the delta without treating it as content", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "deepseek-v4-flash",
			choices: [
				{
					index: 0,
					delta: { reasoning_content: "thinking" },
					finish_reason: null,
				},
			],
			usage: null,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.choices[0]?.delta.reasoning_content).toBe("thinking");
			expect(result.data.choices[0]?.delta.content ?? null).toBeNull();
		}
	});

	test("rejects a wrong object identity", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1,
			model: "gpt-5.6-luna",
			choices: [],
			usage: null,
		});
		expect(result.success).toBe(false);
	});

	test("rejects a usage object that violates ChatUsageSchema (total < prompt + completion)", () => {
		const result = ChatCompletionChunkSchema.safeParse({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "gpt-5.6-luna",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 12 },
		});
		expect(result.success).toBe(false);
	});
});
