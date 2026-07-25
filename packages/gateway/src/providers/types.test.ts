import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import { expect, test } from "vitest";

import type { ProviderAdapter, ProviderName, SseChunk } from "./types.js";

const FAKE_REQUEST: ChatRequest = {
	model: "gpt-5.6-luna",
	messages: [{ role: "user", content: "hi" }],
};

const FAKE_RESPONSE: ChatResponse = {
	id: "chatcmpl-test",
	object: "chat.completion",
	created: 0,
	model: "gpt-5.6-luna",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hello" },
			finish_reason: "stop",
		},
	],
};

/**
 * Compile-time contract check: a conforming adapter must satisfy the exact
 * shape from BUILD_PLAYBOOK.md phase 1 step 5 — `name`, `complete`, and
 * `stream` — using the shared wire types, not locally redefined ones. If
 * this object stops type-checking, the seam has drifted from the playbook
 * contract.
 */
function makeFakeAdapter(name: ProviderName): ProviderAdapter {
	return {
		name,
		async complete(
			_req: ChatRequest,
			_signal: AbortSignal,
		): Promise<ChatResponse> {
			return FAKE_RESPONSE;
		},
		async *stream(
			_req: ChatRequest,
			_signal: AbortSignal,
		): AsyncIterable<SseChunk> {
			yield { data: '{"choices":[{"delta":{"content":"hi"}}]}', done: false };
			yield { data: "[DONE]", done: true };
		},
	};
}

test("a fake adapter satisfies the ProviderAdapter contract for both provider names", () => {
	const openaiAdapter = makeFakeAdapter("openai");
	const anthropicAdapter = makeFakeAdapter("anthropic");

	expect(openaiAdapter.name).toBe("openai");
	expect(anthropicAdapter.name).toBe("anthropic");
});

test("ProviderName includes the human-approved four-provider scope (step 9 foundation only — no gemini/deepseek adapters yet)", () => {
	const names: ProviderName[] = ["openai", "anthropic", "gemini", "deepseek"];

	expect(names).toEqual(["openai", "anthropic", "gemini", "deepseek"]);
});

test("complete() resolves a ChatResponse", async () => {
	const adapter = makeFakeAdapter("openai");
	const controller = new AbortController();

	const response = await adapter.complete(FAKE_REQUEST, controller.signal);

	expect(response).toEqual(FAKE_RESPONSE);
});

test("stream() yields SseChunks and terminates with done: true", async () => {
	const adapter = makeFakeAdapter("anthropic");
	const controller = new AbortController();

	const chunks: SseChunk[] = [];
	for await (const chunk of adapter.stream(FAKE_REQUEST, controller.signal)) {
		chunks.push(chunk);
	}

	expect(chunks).toHaveLength(2);
	expect(chunks[0]?.done).toBe(false);
	expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
});
