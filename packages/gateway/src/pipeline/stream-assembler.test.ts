import { describe, expect, test } from "vitest";

import { StreamingResponseAssembler } from "./stream-assembler.js";

const base = {
	id: "chatcmpl-stream",
	object: "chat.completion.chunk",
	created: 123,
	model: "gpt-cache",
	system_fingerprint: "fp_1",
};

function observe(assembler: StreamingResponseAssembler, value: unknown): void {
	assembler.observePayload(JSON.stringify(value));
}

describe("StreamingResponseAssembler", () => {
	test("assembles interleaved choices, reasoning, tool calls, extras, finish reasons, and usage", () => {
		const assembler = new StreamingResponseAssembler();
		observe(assembler, {
			...base,
			choices: [
				{
					index: 1,
					delta: { role: "assistant", content: "B" },
					finish_reason: null,
					logprobs: null,
				},
				{
					index: 0,
					delta: {
						role: "assistant",
						reasoning_content: "think",
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "weather", arguments: '{"city":' },
							},
						],
					},
					finish_reason: null,
				},
			],
			usage: null,
		});
		observe(assembler, {
			...base,
			choices: [
				{
					index: 0,
					delta: {
						content: "A",
						reasoning_content: " more",
						tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }],
					},
					finish_reason: "tool_calls",
				},
				{
					index: 1,
					delta: { content: "2" },
					finish_reason: "stop",
					logprobs: null,
				},
			],
			usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
		});
		assembler.observeDone("[DONE]");

		expect(assembler.finish()).toEqual({
			id: "chatcmpl-stream",
			object: "chat.completion",
			created: 123,
			model: "gpt-cache",
			system_fingerprint: "fp_1",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: "A",
						reasoning_content: "think more",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "weather", arguments: '{"city":"SF"}' },
							},
						],
					},
					finish_reason: "tool_calls",
				},
				{
					index: 1,
					logprobs: null,
					message: { role: "assistant", content: "B2" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
		});
	});

	test("bypasses an incoherent transcript without throwing", () => {
		const assembler = new StreamingResponseAssembler();
		observe(assembler, {
			...base,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "first" },
					finish_reason: "stop",
				},
			],
			usage: null,
		});
		// A later delta after finish is valid enough to forward, but cannot be
		// cached as the completed response would not reproduce it faithfully.
		observe(assembler, {
			...base,
			choices: [{ index: 0, delta: { content: "later" }, finish_reason: null }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		assembler.observeDone("[DONE]");
		expect(assembler.finish()).toBeNull();
	});

	test("bypasses unknown delta semantics and identity changes", () => {
		const assembler = new StreamingResponseAssembler();
		observe(assembler, {
			...base,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", refusal: "no" },
					finish_reason: null,
				},
			],
			usage: null,
		});
		observe(assembler, {
			...base,
			id: "different",
			choices: [],
			usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
		});
		assembler.observeDone("[DONE]");
		expect(assembler.finish()).toBeNull();
	});

	test("bypasses invalid tool JSON and payloads after the terminal usage", () => {
		const assembler = new StreamingResponseAssembler();
		observe(assembler, {
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_bad",
								type: "function",
								function: { name: "lookup", arguments: "not json" },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		// Terminal usage means subsequent data must never reach a cache entry.
		observe(assembler, { ...base, choices: [], usage: null });
		assembler.observeDone("[DONE]");
		expect(assembler.finish()).toBeNull();
	});

	test("bypasses tool-call metadata that cannot be preserved losslessly", () => {
		for (const toolCall of [
			{
				index: 0,
				id: "call_extra",
				type: "function",
				function: { name: "lookup", arguments: "{}", provider_meta: "x" },
			},
			{
				index: 0,
				id: "call_extra",
				type: "function",
				function: { name: "lookup", arguments: "{}" },
				provider_tool_meta: "y",
			},
		]) {
			const assembler = new StreamingResponseAssembler();
			observe(assembler, {
				...base,
				choices: [
					{
						index: 0,
						delta: { role: "assistant", tool_calls: [toolCall] },
						finish_reason: "tool_calls",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
			assembler.observeDone("[DONE]");
			expect(assembler.finish()).toBeNull();
		}
	});
});
