import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatRequest } from "@promptgate/shared";
import { expect, test } from "vitest";

import {
	fromAnthropicResponse,
	toAnthropicRequest,
} from "./anthropic-translate.js";
import { ProviderError, ProviderRequestError } from "./provider-error.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../test/fixtures");

/** The committed offline contract fixture — tests never touch the network (§11). */
function readAnthropicNonStreamingFixture(): unknown {
	return JSON.parse(
		readFileSync(
			path.join(FIXTURES_DIR, "anthropic-non-streaming.json"),
			"utf8",
		),
	) as unknown;
}

function request(overrides: Partial<ChatRequest>): ChatRequest {
	return {
		model: "claude-sonnet-5",
		messages: [{ role: "user", content: "hi" }],
		...overrides,
	} as ChatRequest;
}

/** Builds a request with arbitrary loose fields (tools, tool_choice, ...) attached. */
function looseRequest(extra: Record<string, unknown>): ChatRequest {
	return { ...request({}), ...extra } as ChatRequest;
}

// --- System / conversation shape ---

test("concatenates system/developer messages into one system param and keeps user turns", () => {
	const body = toAnthropicRequest(
		request({
			messages: [
				{ role: "system", content: "Be terse." },
				{ role: "developer", content: "Prefer JSON." },
				{ role: "user", content: "hello" },
			],
		}),
		1024,
	);

	expect(body.system).toBe("Be terse.\n\nPrefer JSON.");
	expect(body.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "hello" }] },
	]);
});

test("rejects a request whose conversation is empty after hoisting system messages", () => {
	expect(() =>
		toAnthropicRequest(
			request({ messages: [{ role: "system", content: "Be terse." }] }),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects a request with no messages at all", () => {
	expect(() => toAnthropicRequest(request({ messages: [] }), 1024)).toThrow(
		ProviderRequestError,
	);
});

test("applies the injected defaultMaxTokens only when max_tokens is absent", () => {
	expect(toAnthropicRequest(request({}), 777).max_tokens).toBe(777);
	expect(toAnthropicRequest(request({ max_tokens: 42 }), 777).max_tokens).toBe(
		42,
	);
});

test("omits optional keys when their source is absent", () => {
	const body = toAnthropicRequest(request({}), 1024);
	expect(body.thinking).toEqual({ type: "disabled" });
	expect(body.system).toBeUndefined();
	expect(body.stop_sequences).toBeUndefined();
	expect(body.tools).toBeUndefined();
	expect(body.tool_choice).toBeUndefined();
	expect(body.output_config).toBeUndefined();
});

test("translates array text content into text blocks", () => {
	const body = toAnthropicRequest(
		request({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "part one" },
						{ type: "text", text: "part two" },
					],
				},
			],
		}),
		1024,
	);
	expect(body.messages[0]).toEqual({
		role: "user",
		content: [
			{ type: "text", text: "part one" },
			{ type: "text", text: "part two" },
		],
	});
});

test("concatenates text-only content parts without injecting separators", () => {
	const body = toAnthropicRequest(
		looseRequest({
			messages: [
				{
					role: "system",
					content: [
						{ type: "text", text: "system-" },
						{ type: "text", text: "parts" },
					],
				},
				{ role: "user", content: "use a tool" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "assistant-" },
						{ type: "text", text: "parts" },
					],
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "run", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_1",
					content: [
						{ type: "text", text: "tool-" },
						{ type: "text", text: "parts" },
					],
				},
			],
		}),
		1024,
	);

	expect(body.system).toBe("system-parts");
	expect(body.messages[1]?.content[0]).toEqual({
		type: "text",
		text: "assistant-parts",
	});
	expect(body.messages[2]?.content[0]).toEqual({
		type: "tool_result",
		tool_use_id: "call_1",
		content: "tool-parts",
	});
});

test("rejects a final assistant prefill unsupported by Claude Sonnet 5", () => {
	expect(() =>
		toAnthropicRequest(
			request({
				messages: [
					{ role: "user", content: "complete this" },
					{ role: "assistant", content: "The answer is (" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

// --- Sampling / stop / effort ---

test("maps stop string to a single stop_sequences entry", () => {
	expect(
		toAnthropicRequest(request({ stop: "STOP" }), 1024).stop_sequences,
	).toEqual(["STOP"]);
});

test("maps stop array to stop_sequences verbatim", () => {
	expect(
		toAnthropicRequest(request({ stop: ["A", "B"] }), 1024).stop_sequences,
	).toEqual(["A", "B"]);
});

test("omits stop_sequences for null, absent, or empty stop", () => {
	expect(
		toAnthropicRequest(request({ stop: null }), 1024).stop_sequences,
	).toBeUndefined();
	expect(toAnthropicRequest(request({}), 1024).stop_sequences).toBeUndefined();
	expect(
		toAnthropicRequest(request({ stop: [] }), 1024).stop_sequences,
	).toBeUndefined();
});

test.each([
	["a blank string", ""],
	["a blank array entry", ["A", ""]],
	["more than four entries", ["A", "B", "C", "D", "E"]],
] as const)("rejects stop with %s", (_label, stop) => {
	expect(() =>
		toAnthropicRequest(request({ stop: stop as ChatRequest["stop"] }), 1024),
	).toThrow(ProviderRequestError);
});

test("omits temperature when it is exactly the default (1)", () => {
	const body = toAnthropicRequest(request({ temperature: 1 }), 1024);
	expect("temperature" in body).toBe(false);
});

test("rejects a temperature that is not exactly 1", () => {
	expect(() => toAnthropicRequest(request({ temperature: 0.5 }), 1024)).toThrow(
		ProviderRequestError,
	);
	expect(() => toAnthropicRequest(request({ temperature: 0 }), 1024)).toThrow(
		ProviderRequestError,
	);
});

test("omits top_p when it is at least 0.99", () => {
	const body = toAnthropicRequest(request({ top_p: 0.99 }), 1024);
	expect("top_p" in body).toBe(false);
});

test("rejects a top_p below 0.99", () => {
	expect(() => toAnthropicRequest(request({ top_p: 0.9 }), 1024)).toThrow(
		ProviderRequestError,
	);
});

test.each(["low", "medium", "high", "xhigh", "max"] as const)(
	"maps reasoning_effort %s to output_config.effort",
	(effort) => {
		const body = toAnthropicRequest(
			request({ reasoning_effort: effort }),
			1024,
		);
		expect(body.output_config).toEqual({ effort });
	},
);

test.each(["none", "minimal"] as const)(
	"rejects reasoning_effort %s (no Anthropic equivalent)",
	(effort) => {
		expect(() =>
			toAnthropicRequest(request({ reasoning_effort: effort }), 1024),
		).toThrow(ProviderRequestError);
	},
);

// --- response_format / output_config ---

test("translates response_format json_schema via output_config.format", () => {
	const schema = { type: "object", properties: { a: { type: "string" } } };
	const body = toAnthropicRequest(
		request({
			response_format: {
				type: "json_schema",
				json_schema: { name: "answer", schema },
			},
		}),
		1024,
	);
	expect(body.output_config).toEqual({
		format: { type: "json_schema", schema },
	});
});

test("rejects json_schema response_format without an actual object schema", () => {
	expect(() =>
		toAnthropicRequest(
			request({
				response_format: {
					type: "json_schema",
					json_schema: { name: "answer" },
				},
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("maps response_format json_object to an open object schema", () => {
	const body = toAnthropicRequest(
		request({ response_format: { type: "json_object" } }),
		1024,
	);
	expect(body.output_config).toEqual({
		format: { type: "json_schema", schema: { type: "object" } },
	});
});

test("does not translate response_format text (OpenAI default)", () => {
	const body = toAnthropicRequest(
		request({ response_format: { type: "text" } }),
		1024,
	);
	expect(body.output_config).toBeUndefined();
});

test("merges output_config format and effort coherently", () => {
	const body = toAnthropicRequest(
		request({
			response_format: { type: "json_object" },
			reasoning_effort: "high",
		}),
		1024,
	);
	expect(body.output_config).toEqual({
		format: { type: "json_schema", schema: { type: "object" } },
		effort: "high",
	});
});

// --- Tools & tool_choice ---

test("translates OpenAI function tools, preserving strict and defaulting input_schema", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [
				{
					type: "function",
					function: {
						name: "lookup",
						description: "Look something up",
						parameters: {
							type: "object",
							properties: {},
							additionalProperties: false,
						},
						strict: true,
					},
				},
				{ type: "function", function: { name: "noargs" } },
			],
		}),
		1024,
	);
	expect(body.tools).toEqual([
		{
			name: "lookup",
			description: "Look something up",
			input_schema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			strict: true,
		},
		// missing description omitted; missing parameters default to an object schema
		{ name: "noargs", input_schema: { type: "object" } },
	]);
});

test("closes the default no-argument schema for a strict tool", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "noargs", strict: true } }],
		}),
		1024,
	);
	expect(body.tools).toEqual([
		{
			name: "noargs",
			input_schema: { type: "object", additionalProperties: false },
			strict: true,
		},
	]);
});

test("rejects a strict tool schema with an open object node", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				tools: [
					{
						type: "function",
						function: {
							name: "lookup",
							strict: true,
							parameters: {
								type: "object",
								properties: {
									nested: {
										type: "object",
										properties: {},
									},
								},
								additionalProperties: false,
							},
						},
					},
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects a tool whose parameters are not an object schema", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				tools: [
					{
						type: "function",
						function: { name: "x", parameters: { type: "array" } },
					},
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test.each([
	["auto", { type: "auto" }],
	["required", { type: "any" }],
	["none", { type: "none" }],
] as const)("maps tool_choice %s", (choice, expected) => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "lookup" } }],
			tool_choice: choice,
		}),
		1024,
	);
	expect(body.tool_choice).toEqual(expected);
});

test("maps a forced-function tool_choice to Anthropic type tool + name", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "lookup" } }],
			tool_choice: { type: "function", function: { name: "lookup" } },
		}),
		1024,
	);
	expect(body.tool_choice).toEqual({ type: "tool", name: "lookup" });
});

test("rejects a forced tool_choice that names an undefined tool", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				tools: [{ type: "function", function: { name: "lookup" } }],
				tool_choice: { type: "function", function: { name: "missing" } },
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects tool_choice when tools are absent", () => {
	expect(() =>
		toAnthropicRequest(looseRequest({ tool_choice: "auto" }), 1024),
	).toThrow(ProviderRequestError);
});

test("rejects tool_choice when tools is an empty array", () => {
	expect(() =>
		toAnthropicRequest(looseRequest({ tools: [], tool_choice: "auto" }), 1024),
	).toThrow(ProviderRequestError);
});

test("maps parallel_tool_calls:false to disable_parallel_tool_use, synthesizing auto", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "lookup" } }],
			parallel_tool_calls: false,
		}),
		1024,
	);
	expect(body.tool_choice).toEqual({
		type: "auto",
		disable_parallel_tool_use: true,
	});
});

test("attaches disable_parallel_tool_use to an explicit tool_choice", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "lookup" } }],
			tool_choice: "required",
			parallel_tool_calls: false,
		}),
		1024,
	);
	expect(body.tool_choice).toEqual({
		type: "any",
		disable_parallel_tool_use: true,
	});
});

test("does not attach disable_parallel_tool_use to tool_choice none", () => {
	const body = toAnthropicRequest(
		looseRequest({
			tools: [{ type: "function", function: { name: "lookup" } }],
			tool_choice: "none",
			parallel_tool_calls: false,
		}),
		1024,
	);
	expect(body.tool_choice).toEqual({ type: "none" });
});

test("rejects duplicate tool names", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				tools: [
					{ type: "function", function: { name: "lookup" } },
					{ type: "function", function: { name: "lookup" } },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects non-function tools with a client error", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({ tools: [{ type: "custom", name: "x" }] }),
			1024,
		),
	).toThrow(ProviderRequestError);
});

// --- Assistant tool_calls and tool history ---

test("translates assistant tool_calls to tool_use blocks answered by a grouped tool_result", () => {
	const body = toAnthropicRequest(
		looseRequest({
			messages: [
				{ role: "user", content: "weather?" },
				{
					role: "assistant",
					content: "Let me check.",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "get_weather", arguments: '{"city":"Paris"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sunny" },
			],
		}),
		1024,
	);
	expect(body.messages[1]).toEqual({
		role: "assistant",
		content: [
			{ type: "text", text: "Let me check." },
			{
				type: "tool_use",
				id: "call_1",
				name: "get_weather",
				input: { city: "Paris" },
			},
		],
	});
	expect(body.messages[2]).toEqual({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
	});
});

test("groups consecutive tool results into one Anthropic user message", () => {
	const body = toAnthropicRequest(
		looseRequest({
			messages: [
				{ role: "user", content: "weather?" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "a", arguments: "{}" },
						},
						{
							id: "call_2",
							type: "function",
							function: { name: "b", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sunny" },
				{ role: "tool", tool_call_id: "call_2", content: "warm" },
			],
		}),
		1024,
	);
	expect(body.messages[2]).toEqual({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "call_1", content: "sunny" },
			{ type: "tool_result", tool_use_id: "call_2", content: "warm" },
		],
	});
});

test.each([
	['""', ""],
	["a bare array", "[1,2]"],
	["a scalar", "42"],
	["a JSON null", "null"],
	["invalid JSON", "not json"],
] as const)(
	"rejects assistant tool_call arguments that are %s",
	(_label, args) => {
		expect(() =>
			toAnthropicRequest(
				looseRequest({
					messages: [
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "a", arguments: args },
								},
							],
						},
						{ role: "tool", tool_call_id: "call_1", content: "ok" },
					],
				}),
				1024,
			),
		).toThrow(ProviderRequestError);
	},
);

test("rejects an orphan tool message with no preceding assistant tool call", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{ role: "user", content: "hi" },
					{ role: "tool", tool_call_id: "call_1", content: "result" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects a tool message without a tool_call_id", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "a", arguments: "{}" },
							},
						],
					},
					{ role: "tool", content: "result" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects a tool result referencing an unknown tool_call_id", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "a", arguments: "{}" },
							},
						],
					},
					{ role: "tool", tool_call_id: "call_9", content: "result" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects a duplicate tool result for the same tool_call_id", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "a", arguments: "{}" },
							},
							{
								id: "call_2",
								type: "function",
								function: { name: "b", arguments: "{}" },
							},
						],
					},
					{ role: "tool", tool_call_id: "call_1", content: "one" },
					{ role: "tool", tool_call_id: "call_1", content: "again" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("matches parallel tool results by id without imposing execution order", () => {
	const body = toAnthropicRequest(
		looseRequest({
			messages: [
				{ role: "user", content: "run both" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "a", arguments: "{}" },
						},
						{
							id: "call_2",
							type: "function",
							function: { name: "b", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_2", content: "two" },
				{ role: "tool", tool_call_id: "call_1", content: "one" },
			],
		}),
		1024,
	);
	expect(body.messages[2]).toEqual({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "call_2", content: "two" },
			{ type: "tool_result", tool_use_id: "call_1", content: "one" },
		],
	});
});

test("rejects duplicate assistant tool_call ids", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "a", arguments: "{}" },
							},
							{
								id: "call_1",
								type: "function",
								function: { name: "b", arguments: "{}" },
							},
						],
					},
					{ role: "tool", tool_call_id: "call_1", content: "one" },
					{ role: "tool", tool_call_id: "call_1", content: "again" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects an assistant tool call with no matching tool result", () => {
	expect(() =>
		toAnthropicRequest(
			looseRequest({
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "a", arguments: "{}" },
							},
						],
					},
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

// --- Images ---

test("translates a remote https image_url into an Anthropic url source", () => {
	const body = toAnthropicRequest(
		request({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/cat.png" },
						},
					],
				},
			],
		}),
		1024,
	);
	expect(body.messages[0]).toEqual({
		role: "user",
		content: [
			{
				type: "image",
				source: { type: "url", url: "https://example.com/cat.png" },
			},
		],
	});
});

test("accepts the default image detail but rejects unsupported low/high detail", () => {
	const body = toAnthropicRequest(
		request({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: {
								url: "https://example.com/cat.png",
								detail: "auto",
							},
						},
					],
				},
			],
		}),
		1024,
	);
	expect(body.messages[0]?.content[0]).toEqual({
		type: "image",
		source: { type: "url", url: "https://example.com/cat.png" },
	});

	for (const detail of ["low", "high"] as const) {
		expect(() =>
			toAnthropicRequest(
				request({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image_url",
									image_url: {
										url: "https://example.com/cat.png",
										detail,
									},
								},
							],
						},
					],
				}),
				1024,
			),
		).toThrow(ProviderRequestError);
	}
});

test("translates a supported data URL into a base64 source", () => {
	const body = toAnthropicRequest(
		request({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,QUJD" },
						},
						{ type: "text", text: "what is this?" },
					],
				},
			],
		}),
		1024,
	);
	expect(body.messages[0]).toEqual({
		role: "user",
		content: [
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "QUJD" },
			},
			{ type: "text", text: "what is this?" },
		],
	});
});

test.each([
	["a malformed data URL", "data:image/png,QUJD"],
	["empty base64 data", "data:image/png;base64,"],
	["non-canonical base64 length", "data:image/png;base64,QQ"],
	["non-canonical base64 padding bits", "data:image/png;base64,AB=="],
	["an unsupported media type", "data:image/svg+xml;base64,QUJD"],
	["an incomplete remote URL", "https://"],
	["a non-URL string", "not-a-url"],
] as const)("rejects an image with %s", (_label, url) => {
	expect(() =>
		toAnthropicRequest(
			request({
				messages: [
					{
						role: "user",
						content: [{ type: "image_url", image_url: { url } }],
					},
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects an image content part in a non-user (system) role", () => {
	expect(() =>
		toAnthropicRequest(
			request({
				messages: [
					{
						role: "system",
						content: [
							{
								type: "image_url",
								image_url: { url: "https://example.com/x.png" },
							},
						],
					},
					{ role: "user", content: "hi" },
				],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

test("rejects an unknown content part type", () => {
	expect(() =>
		toAnthropicRequest(
			request({
				messages: [{ role: "user", content: [{ type: "audio", audio: {} }] }],
			}),
			1024,
		),
	).toThrow(ProviderRequestError);
});

// --- Response translation ---

test("translates the committed non-streaming fixture into an OpenAI response", () => {
	const result = fromAnthropicResponse(readAnthropicNonStreamingFixture(), 100);
	expect(result).toEqual({
		id: "msg_pgfixture_anthropic_nonstream",
		object: "chat.completion",
		created: 100,
		model: "claude-sonnet-5",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: "Hello from the PromptGate contract fixture.",
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 19, completion_tokens: 12, total_tokens: 31 },
	});
});

function toolUseResponse(overrides: Record<string, unknown> = {}): unknown {
	return {
		id: "msg_tool",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5",
		content: [
			{
				type: "tool_use",
				id: "toolu_1",
				name: "get_weather",
				input: { city: "Paris" },
			},
		],
		stop_reason: "tool_use",
		usage: { input_tokens: 5, output_tokens: 7 },
		...overrides,
	};
}

test("translates tool_use response blocks into message.tool_calls with JSON-string arguments", () => {
	const result = fromAnthropicResponse(toolUseResponse(), 100);
	const choice = result.choices[0];
	expect(choice?.finish_reason).toBe("tool_calls");
	expect(choice?.message.content).toBeNull();
	const message = choice?.message as Record<string, unknown>;
	expect(message.tool_calls).toEqual([
		{
			id: "toolu_1",
			type: "function",
			function: { name: "get_weather", arguments: '{"city":"Paris"}' },
		},
	]);
});

test("preserves text alongside tool_use and normalizes usage totals", () => {
	const result = fromAnthropicResponse(
		{
			id: "msg_mix",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			content: [
				{ type: "text", text: "Working on it. " },
				{ type: "text", text: "Calling a tool." },
				{ type: "tool_use", id: "toolu_2", name: "run", input: {} },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		100,
	);
	const choice = result.choices[0];
	expect(choice?.message.content).toBe("Working on it. Calling a tool.");
	expect(result.usage).toEqual({
		prompt_tokens: 10,
		completion_tokens: 20,
		total_tokens: 30,
	});
});

test.each([
	["end_turn", "stop"],
	["stop_sequence", "stop"],
	["max_tokens", "length"],
	["model_context_window_exceeded", "length"],
] as const)(
	"maps stop_reason %s to finish_reason %s",
	(stopReason, expected) => {
		const result = fromAnthropicResponse(
			{
				id: "msg_stop",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "done" }],
				stop_reason: stopReason,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		);
		expect(result.choices[0]?.finish_reason).toBe(expected);
	},
);

test("maps a refusal with empty content to null content and content_filter", () => {
	const result = fromAnthropicResponse(
		{
			id: "msg_refusal",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			content: [],
			stop_reason: "refusal",
			usage: { input_tokens: 3, output_tokens: 0 },
		},
		100,
	);
	expect(result.choices[0]?.finish_reason).toBe("content_filter");
	expect(result.choices[0]?.message.content).toBeNull();
});

test("discards incomplete text returned with a refusal", () => {
	const result = fromAnthropicResponse(
		{
			id: "msg_refusal",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			content: [{ type: "text", text: "partial incomplete output" }],
			stop_reason: "refusal",
			usage: { input_tokens: 3, output_tokens: 2 },
		},
		100,
	);
	expect(result.choices[0]?.finish_reason).toBe("content_filter");
	expect(result.choices[0]?.message.content).toBeNull();
});

test.each(["pause_turn", "compaction", "surprise"] as const)(
	"fails closed on the unmapped stop_reason %s",
	(stopReason) => {
		expect(() =>
			fromAnthropicResponse(
				{
					id: "msg_x",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [{ type: "text", text: "hi" }],
					stop_reason: stopReason,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				100,
			),
		).toThrow(ProviderError);
	},
);

test("fails closed on a null / absent stop_reason", () => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "hi" }],
				stop_reason: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("fails closed when tool_use blocks appear without a tool_use stop_reason", () => {
	expect(() =>
		fromAnthropicResponse(toolUseResponse({ stop_reason: "end_turn" }), 100),
	).toThrow(ProviderError);
});

test("fails closed when stop_reason is tool_use but no tool_use blocks were translated", () => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "no tools here" }],
				stop_reason: "tool_use",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("fails closed on thinking blocks instead of silently ignoring them", () => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_thinking",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [
					{ type: "thinking", thinking: "" },
					{ type: "text", text: "final" },
				],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("fails closed on an unknown block type", () => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "server_tool_use", id: "x", name: "y", input: {} }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test.each([
	["type is not message", { type: "not_message" }],
	["role is not assistant", { role: "user" }],
] as const)("fails closed when the response %s", (_label, override) => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "hi" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
				...override,
			},
			100,
		),
	).toThrow(ProviderError);
});

test.each([
	["a blank tool id", { id: "", name: "y", input: {} }],
	["a blank tool name", { id: "x", name: "", input: {} }],
	["a non-object tool input", { id: "x", name: "y", input: [1, 2] }],
] as const)("fails closed on a tool_use block with %s", (_label, block) => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "tool_use", ...block }],
				stop_reason: "tool_use",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("fails closed on duplicate upstream tool_use ids", () => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_x",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [
					{ type: "tool_use", id: "toolu_1", name: "a", input: {} },
					{ type: "tool_use", id: "toolu_1", name: "b", input: {} },
				],
				stop_reason: "tool_use",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("accepts cache token counts that are absent or exactly zero", () => {
	const result = fromAnthropicResponse(
		{
			id: "msg_cache",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: {
				input_tokens: 4,
				output_tokens: 2,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
		100,
	);
	expect(result.usage).toEqual({
		prompt_tokens: 4,
		completion_tokens: 2,
		total_tokens: 6,
	});
});

test.each([
	["cache_creation_input_tokens", { cache_creation_input_tokens: 5 }],
	["cache_read_input_tokens", { cache_read_input_tokens: 7 }],
] as const)("fails closed on a nonzero %s", (_label, cache) => {
	expect(() =>
		fromAnthropicResponse(
			{
				id: "msg_cache",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "ok" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 4, output_tokens: 2, ...cache },
			},
			100,
		),
	).toThrow(ProviderError);
});

test("uses the injected created timestamp (deterministic)", () => {
	const result = fromAnthropicResponse(
		readAnthropicNonStreamingFixture(),
		12345,
	);
	expect(result.created).toBe(12345);
});
