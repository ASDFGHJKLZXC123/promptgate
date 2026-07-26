import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatRequest } from "@promptgate/shared";
import { describe, expect, test, vi } from "vitest";

import { createAnthropicAdapter } from "./anthropic.js";
import {
	ProviderConfigError,
	ProviderError,
	StreamContractError,
} from "./provider-error.js";
import type { RetryFetchDeps } from "./retry.js";
import type { ProviderAdapter, SseChunk } from "./types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../test/fixtures");
/** Committed offline contract fixture — no test ever reaches the network (§11). */
const STREAM_FIXTURE = readFileSync(
	path.join(FIXTURES_DIR, "anthropic-streaming.txt"),
	"utf8",
);

/** Injected clock: epoch ms → the deterministic `created` = floor(ms/1000). */
const NOW_MS = 1_720_000_000_000;
const CREATED = 1_720_000_000;

const REQUEST: ChatRequest = {
	model: "claude-sonnet-5",
	messages: [{ role: "user", content: "say hi" }],
	stream: true,
};

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

function sseResponse(
	text: string,
	contentType = "text/event-stream",
): Response {
	return new Response(streamFromChunks([encode(text)]), {
		status: 200,
		headers: { "content-type": contentType },
	});
}

function sseResponseByteAtATime(text: string): Response {
	return new Response(
		streamFromChunks(Array.from(encode(text), (b) => Uint8Array.of(b))),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function noRetryDeps(fetch: RetryFetchDeps["fetch"]): RetryFetchDeps {
	return {
		fetch,
		sleep: vi.fn().mockResolvedValue(undefined),
		random: () => 0,
	};
}

function makeAdapter(
	fetch: RetryFetchDeps["fetch"],
	overrides: { apiKey?: string | undefined } = {},
): ProviderAdapter {
	return createAnthropicAdapter({
		apiKey: "apiKey" in overrides ? overrides.apiKey : "sk-ant-test-key",
		defaultMaxTokens: 512,
		retryDeps: noRetryDeps(fetch),
		now: () => NOW_MS,
	});
}

async function collectStream(
	adapter: ProviderAdapter,
	req: ChatRequest = REQUEST,
): Promise<SseChunk[]> {
	const chunks: SseChunk[] = [];
	for await (const chunk of adapter.stream(req, new AbortController().signal)) {
		chunks.push(chunk);
	}
	return chunks;
}

async function streamError(
	adapter: ProviderAdapter,
	req: ChatRequest = REQUEST,
): Promise<unknown> {
	try {
		for await (const _ of adapter.stream(req, new AbortController().signal)) {
			// drain
		}
		return undefined;
	} catch (error) {
		return error;
	}
}

// --- Crafted Anthropic transcript builders ------------------------------------

function evt(name: string, obj: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** The official transcript ends message_stop with a single newline, no blank line. */
function terminalStop(): string {
	return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`;
}

const MESSAGE_START = {
	type: "message_start",
	message: {
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 19, output_tokens: 0 },
	},
} as const;

function messageStart(usage?: Record<string, number>): string {
	if (!usage) {
		return evt("message_start", MESSAGE_START);
	}
	return evt("message_start", {
		...MESSAGE_START,
		message: { ...MESSAGE_START.message, usage },
	});
}

function textBlockStart(index = 0): string {
	return evt("content_block_start", {
		type: "content_block_start",
		index,
		content_block: { type: "text", text: "" },
	});
}

function textDelta(text: string, index = 0): string {
	return evt("content_block_delta", {
		type: "content_block_delta",
		index,
		delta: { type: "text_delta", text },
	});
}

function toolBlockStart(index: number, id: string, name: string): string {
	return evt("content_block_start", {
		type: "content_block_start",
		index,
		content_block: { type: "tool_use", id, name, input: {} },
	});
}

function inputJsonDelta(index: number, partialJson: string): string {
	return evt("content_block_delta", {
		type: "content_block_delta",
		index,
		delta: { type: "input_json_delta", partial_json: partialJson },
	});
}

function blockStop(index = 0): string {
	return evt("content_block_stop", { type: "content_block_stop", index });
}

function messageDelta(stopReason: string | null, outputTokens = 12): string {
	return evt("message_delta", {
		type: "message_delta",
		delta: {
			stop_reason: stopReason,
			// stop_sequence is coherent only as a nonempty string for the
			// stop_sequence reason, and null otherwise.
			stop_sequence: stopReason === "stop_sequence" ? "STOP" : null,
		},
		usage: { output_tokens: outputTokens },
	});
}

/** A minimal well-formed single-text-block transcript. */
function textTranscript(
	opts: { stopReason?: string; outputTokens?: number; text?: string } = {},
): string {
	return (
		messageStart() +
		textBlockStart() +
		textDelta(opts.text ?? "Hi") +
		blockStop() +
		messageDelta(opts.stopReason ?? "end_turn", opts.outputTokens ?? 5) +
		terminalStop()
	);
}

/** Parses the JSON `data` of every non-terminal frame. */
function payloads(chunks: SseChunk[]): Record<string, unknown>[] {
	return chunks
		.filter((c) => !c.done)
		.map((c) => JSON.parse(c.data) as Record<string, unknown>);
}

function firstChoiceDelta(
	chunk: Record<string, unknown>,
): Record<string, unknown> {
	const choices = chunk.choices as { delta: Record<string, unknown> }[];
	return choices[0].delta;
}

/** The first non-null finish_reason across all translated frames, or undefined. */
function finishReasonOf(chunks: SseChunk[]): unknown {
	for (const chunk of payloads(chunks)) {
		const choices = chunk.choices as { finish_reason?: unknown }[];
		const reason = choices[0]?.finish_reason;
		if (reason != null) {
			return reason;
		}
	}
	return undefined;
}

function chunkBase(extra: Record<string, unknown>): Record<string, unknown> {
	return {
		id: "msg_test",
		object: "chat.completion.chunk",
		created: CREATED,
		model: "claude-sonnet-5",
		...extra,
	};
}

// --- Fixture-verbatim exact translation ---------------------------------------

describe("streamAnthropic — committed fixture translation", () => {
	test("translates the committed fixture into the exact role/content/finish/usage/[DONE] sequence", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(STREAM_FIXTURE));
		const chunks = await collectStream(makeAdapter(fetch));

		expect(chunks.map((c) => c.done)).toEqual([
			false,
			false,
			false,
			false,
			true,
		]);
		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });

		const base = {
			id: "msg_pgfixture_anthropic_stream",
			object: "chat.completion.chunk",
			created: CREATED,
			model: "claude-sonnet-5",
		};
		expect(payloads(chunks)).toEqual([
			{
				...base,
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "" },
						finish_reason: null,
					},
				],
				usage: null,
			},
			{
				...base,
				choices: [
					{
						index: 0,
						delta: { content: "Hello from the PromptGate contract fixture." },
						finish_reason: null,
					},
				],
				usage: null,
			},
			{
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: null,
			},
			{
				...base,
				choices: [],
				usage: { prompt_tokens: 19, completion_tokens: 12, total_tokens: 31 },
			},
		]);
	});

	test("is invariant to arbitrary upstream byte boundaries (one byte at a time)", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(sseResponseByteAtATime(STREAM_FIXTURE));
		const chunks = await collectStream(makeAdapter(fetch));

		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
		const deltas = payloads(chunks)
			.filter((c) => (c.choices as unknown[]).length > 0)
			.map((c) => firstChoiceDelta(c));
		expect(deltas).toEqual([
			{ role: "assistant", content: "" },
			{ content: "Hello from the PromptGate contract fixture." },
			{},
		]);
	});

	test("yields incremental content frames before the terminal is reached", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(STREAM_FIXTURE));
		const seen: SseChunk[] = [];
		for await (const chunk of makeAdapter(fetch).stream(
			REQUEST,
			new AbortController().signal,
		)) {
			seen.push(chunk);
			// The content delta must surface before the finish/usage/[DONE] triple.
			if (chunk.done) {
				continue;
			}
			const delta = (
				JSON.parse(chunk.data) as { choices: { delta: { content?: string } }[] }
			).choices[0]?.delta;
			if (delta?.content) {
				expect(seen.some((c) => c.done)).toBe(false);
			}
		}
		expect(seen.at(-1)?.done).toBe(true);
	});
});

// --- Outbound request / transport ---------------------------------------------

describe("streamAnthropic — outbound request", () => {
	test("sends the exact endpoint, auth headers, streaming accept, and translated body", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(textTranscript()));
		await collectStream(makeAdapter(fetch));

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"content-type": "application/json",
			"x-api-key": "sk-ant-test-key",
			"anthropic-version": "2023-06-01",
			accept: "text/event-stream",
		});
		// Identical to the step-2 non-streaming subset plus stream:true.
		expect(JSON.parse(init.body as string)).toEqual({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
			max_tokens: 512,
			thinking: { type: "disabled" },
			stream: true,
		});
	});

	test("throws ProviderConfigError without any fetch when the key is missing", async () => {
		const fetch = vi.fn();
		const error = await streamError(makeAdapter(fetch, { apiKey: undefined }));
		expect(error).toBeInstanceOf(ProviderConfigError);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("does not leak pg_* fields into the upstream body", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(textTranscript()));
		await collectStream(makeAdapter(fetch), {
			...REQUEST,
			pg_feature: "inbox_summary",
			pg_no_cache: true,
		} as ChatRequest);
		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		const sent = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(Object.keys(sent).some((key) => key.startsWith("pg_"))).toBe(false);
	});

	test("retries 429 before streaming the body, then translates the transcript", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(sseResponse(textTranscript()));
		const chunks = await collectStream(makeAdapter(fetch));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
	});

	test("maps a non-ok upstream response to a ProviderError before streaming", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "leak-me" } }), {
				status: 401,
			}),
		);
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(ProviderError);
		expect((error as ProviderError).status).toBe(401);
	});

	test("fails closed without leaking on a 200 whose content-type is not event-stream", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					JSON.stringify({ error: { message: "leak-me-mime" } }),
					"application/json",
				),
			);
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(StreamContractError);
		expect((error as Error).message).not.toContain("leak-me-mime");
	});

	test("accepts text/event-stream case-insensitively and with parameters", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(textTranscript(), "Text/Event-Stream; charset=utf-8"),
			);
		const chunks = await collectStream(makeAdapter(fetch));
		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
	});
});

// --- Stop-reason mapping (success variants) -----------------------------------

describe("streamAnthropic — stop-reason mapping", () => {
	test.each([
		["end_turn", "stop"],
		["stop_sequence", "stop"],
		["max_tokens", "length"],
		["model_context_window_exceeded", "length"],
		["refusal", "content_filter"],
	])("maps %s → finish_reason %s", async (stopReason, expected) => {
		const fetch = vi
			.fn()
			.mockResolvedValue(sseResponse(textTranscript({ stopReason })));
		const chunks = await collectStream(makeAdapter(fetch));
		expect(finishReasonOf(chunks)).toBe(expected);
	});

	test("captures split input/output usage into one terminal usage object", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					messageStart({ input_tokens: 100, output_tokens: 0 }) +
						textBlockStart() +
						textDelta("hi") +
						blockStop() +
						messageDelta("end_turn", 42) +
						terminalStop(),
				),
			);
		const chunks = await collectStream(makeAdapter(fetch));
		const usageChunk = payloads(chunks).find((c) => c.usage != null);
		expect(usageChunk?.usage).toEqual({
			prompt_tokens: 100,
			completion_tokens: 42,
			total_tokens: 142,
		});
	});
});

// --- Tool-call streaming translation ------------------------------------------

describe("streamAnthropic — tool_use streaming", () => {
	test("translates a single tool_use block into OpenAI tool_calls deltas with concatenable JSON", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					messageStart() +
						toolBlockStart(0, "toolu_1", "get_weather") +
						inputJsonDelta(0, '{"location":') +
						inputJsonDelta(0, '"NYC"}') +
						blockStop(0) +
						messageDelta("tool_use", 7) +
						terminalStop(),
				),
			);
		const chunks = await collectStream(makeAdapter(fetch));

		expect(payloads(chunks)).toEqual([
			chunkBase({
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "" },
						finish_reason: null,
					},
				],
				usage: null,
			}),
			chunkBase({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "toolu_1",
									type: "function",
									function: { name: "get_weather", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
				usage: null,
			}),
			chunkBase({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"location":' } },
							],
						},
						finish_reason: null,
					},
				],
				usage: null,
			}),
			chunkBase({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }],
						},
						finish_reason: null,
					},
				],
				usage: null,
			}),
			chunkBase({
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: null,
			}),
			chunkBase({
				choices: [],
				usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 },
			}),
		]);

		// The concatenated arguments across deltas form the exact tool input JSON.
		const args = payloads(chunks)
			.flatMap((c) => c.choices as { delta: Record<string, unknown> }[])
			.flatMap((choice) => {
				const calls = choice.delta.tool_calls as
					| { function?: { arguments?: string } }[]
					| undefined;
				return calls?.map((call) => call.function?.arguments ?? "") ?? [];
			})
			.join("");
		expect(args).toBe('{"location":"NYC"}');
	});

	test("assigns sequential OpenAI indices to parallel tool_use blocks after a text block", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					messageStart() +
						textBlockStart(0) +
						textDelta("Calling tools", 0) +
						blockStop(0) +
						toolBlockStart(1, "toolu_a", "alpha") +
						inputJsonDelta(1, "{}") +
						blockStop(1) +
						toolBlockStart(2, "toolu_b", "beta") +
						inputJsonDelta(2, "{}") +
						blockStop(2) +
						messageDelta("tool_use", 9) +
						terminalStop(),
				),
			);
		const chunks = await collectStream(makeAdapter(fetch));

		const toolStarts = payloads(chunks)
			.flatMap((c) => c.choices as { delta: Record<string, unknown> }[])
			.map((choice) => choice.delta.tool_calls)
			.filter(
				(calls): calls is { index: number; id?: string }[] =>
					Array.isArray(calls) && calls[0]?.id !== undefined,
			)
			.map((calls) => ({ index: calls[0].index, id: calls[0].id }));
		expect(toolStarts).toEqual([
			{ index: 0, id: "toolu_a" },
			{ index: 1, id: "toolu_b" },
		]);
		expect(finishReasonOf(chunks)).toBe("tool_calls");
	});
});

// --- Tool-input placeholder + accumulation validation -------------------------

function toolStartWithInput(
	index: number,
	id: string,
	name: string,
	input: Record<string, unknown>,
): string {
	return evt("content_block_start", {
		type: "content_block_start",
		index,
		content_block: { type: "tool_use", id, name, input },
	});
}

/** One tool block whose input streams as the given fragments (then a clean end). */
function toolTranscript(fragments: string[]): string {
	return (
		messageStart() +
		toolBlockStart(0, "toolu_1", "get_weather") +
		fragments.map((fragment) => inputJsonDelta(0, fragment)).join("") +
		blockStop(0) +
		messageDelta("tool_use", 7) +
		terminalStop()
	);
}

/** Concatenates every emitted tool_calls.arguments fragment across all frames. */
function concatenatedToolArgs(chunks: SseChunk[]): string {
	return payloads(chunks)
		.flatMap((c) => c.choices as { delta: Record<string, unknown> }[])
		.flatMap((choice) => {
			const calls = choice.delta.tool_calls as
				| { function?: { arguments?: string } }[]
				| undefined;
			return calls?.map((call) => call.function?.arguments ?? "") ?? [];
		})
		.join("");
}

describe("streamAnthropic — tool_use input validation", () => {
	test("accepts a valid empty-object tool input, including an empty leading fragment", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(sseResponse(toolTranscript(["", "{}"])));
		const chunks = await collectStream(makeAdapter(fetch));

		expect(finishReasonOf(chunks)).toBe("tool_calls");
		// Empty individual fragments are valid; the accumulation is the object "{}".
		expect(concatenatedToolArgs(chunks)).toBe("{}");
	});

	test.each([
		[
			"a non-empty start-block input placeholder",
			messageStart() + toolStartWithInput(0, "toolu_1", "t", { seeded: true }),
		],
		["no input_json fragments at all", toolTranscript([])],
		["only empty fragments (empty accumulation)", toolTranscript([""])],
		["malformed final tool JSON", toolTranscript(['{"a":'])],
		["scalar final tool JSON", toolTranscript(["123"])],
		["array final tool JSON", toolTranscript(["[1,2]"])],
		[
			"duplicate tool_use ids across the response",
			messageStart() +
				toolBlockStart(0, "toolu_dup", "a") +
				inputJsonDelta(0, "{}") +
				blockStop(0) +
				toolBlockStart(1, "toolu_dup", "b") +
				inputJsonDelta(1, "{}") +
				blockStop(1) +
				messageDelta("tool_use", 5) +
				terminalStop(),
		],
	])("fails closed on %s", async (_label, transcript) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(StreamContractError);
	});
});

// --- Cumulative message_delta state machine -----------------------------------

describe("streamAnthropic — cumulative message_delta", () => {
	test("accepts multiple message_deltas and bills the latest cumulative output_tokens", async () => {
		const transcript =
			messageStart({ input_tokens: 10, output_tokens: 1 }) +
			textBlockStart(0) +
			textDelta("hi") +
			blockStop(0) +
			messageDelta(null, 3) +
			messageDelta("end_turn", 7) +
			terminalStop();
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const chunks = await collectStream(makeAdapter(fetch));
		expect(finishReasonOf(chunks)).toBe("stop");
		const usageChunk = payloads(chunks).find((c) => c.usage != null);
		expect(usageChunk?.usage).toEqual({
			prompt_tokens: 10,
			completion_tokens: 7,
			total_tokens: 17,
		});
	});

	test.each([
		[
			"decreasing cumulative output_tokens",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta(null, 8) +
				messageDelta("end_turn", 4) +
				terminalStop(),
		],
		[
			"message_stop with no terminal stop_reason",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta(null, 3) +
				messageDelta(null, 5) +
				terminalStop(),
		],
		[
			"a message_delta after the terminal stop_reason",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta("end_turn", 5) +
				messageDelta(null, 6) +
				terminalStop(),
		],
	])("fails closed on %s", async (_label, transcript) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(StreamContractError);
	});
});

// --- Native side-channel field trust boundary (P1) ----------------------------

/** A raw message_start carrying a fully custom message object. */
function messageStartWith(message: Record<string, unknown>): string {
	return evt("message_start", { type: "message_start", message });
}

const START_MESSAGE_BASE = {
	id: "msg_test",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-5",
	content: [],
	stop_reason: null,
	stop_sequence: null,
	usage: { input_tokens: 19, output_tokens: 0 },
};

/** A text-block transcript whose single terminal message_delta carries custom fields. */
function deltaTranscript(
	delta: Record<string, unknown>,
	usage: Record<string, unknown>,
): string {
	return (
		messageStart() +
		textBlockStart(0) +
		textDelta("hi") +
		blockStop(0) +
		evt("message_delta", { type: "message_delta", delta, usage }) +
		terminalStop()
	);
}

describe("streamAnthropic — native field trust boundary", () => {
	test.each([
		[
			"message_start missing stop_sequence",
			messageStartWith({
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 19, output_tokens: 0 },
			}),
		],
		[
			"message_start with a non-null stop_sequence",
			messageStartWith({ ...START_MESSAGE_BASE, stop_sequence: "X" }),
		],
		[
			"message_start missing usage.output_tokens",
			messageStartWith({ ...START_MESSAGE_BASE, usage: { input_tokens: 19 } }),
		],
		[
			"message_start with a non-integer usage.output_tokens",
			messageStartWith({
				...START_MESSAGE_BASE,
				usage: { input_tokens: 19, output_tokens: 1.5 },
			}),
		],
	])("fails closed on %s", async (_label, transcript) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		expect(await streamError(makeAdapter(fetch))).toBeInstanceOf(
			StreamContractError,
		);
	});

	test("accepts safe absent/null/zero native message_delta fields", async () => {
		const transcript = deltaTranscript(
			{
				stop_reason: "end_turn",
				stop_sequence: null,
				container: null,
				stop_details: null,
			},
			{
				output_tokens: 5,
				input_tokens: 0,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: 0,
				server_tool_use: null,
				output_tokens_details: { thinking_tokens: 0 },
			},
		);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const chunks = await collectStream(makeAdapter(fetch));

		expect(finishReasonOf(chunks)).toBe("stop");
		const usageChunk = payloads(chunks).find((c) => c.usage != null);
		expect(usageChunk?.usage).toEqual({
			prompt_tokens: 19,
			completion_tokens: 5,
			total_tokens: 24,
		});
	});

	test("accepts a refusal with a current-shaped non-null refusal stop_details object", async () => {
		const transcript = deltaTranscript(
			{
				stop_reason: "refusal",
				stop_sequence: null,
				stop_details: {
					type: "refusal",
					category: "policy",
					explanation: "I can't help with that.",
				},
			},
			{ output_tokens: 3 },
		);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const chunks = await collectStream(makeAdapter(fetch));
		expect(finishReasonOf(chunks)).toBe("content_filter");
	});

	test("accepts a refusal whose stop_details category and explanation are null", async () => {
		const transcript = deltaTranscript(
			{
				stop_reason: "refusal",
				stop_sequence: null,
				stop_details: { type: "refusal", category: null, explanation: null },
			},
			{ output_tokens: 3, output_tokens_details: null },
		);
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const chunks = await collectStream(makeAdapter(fetch));
		expect(finishReasonOf(chunks)).toBe("content_filter");
	});

	test.each([
		[
			"positive usage.input_tokens",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, input_tokens: 7 },
			),
		],
		[
			"positive cache_creation_input_tokens",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, cache_creation_input_tokens: 3 },
			),
		],
		[
			"positive cache_read_input_tokens",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, cache_read_input_tokens: 3 },
			),
		],
		[
			"positive thinking_tokens in output_tokens_details",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, output_tokens_details: { thinking_tokens: 4 } },
			),
		],
		[
			"a non-null server_tool_use",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
			),
		],
		[
			"a non-null container",
			deltaTranscript(
				{
					stop_reason: "end_turn",
					stop_sequence: null,
					container: { id: "c" },
				},
				{ output_tokens: 5 },
			),
		],
		[
			"a stop_sequence string on a non-stop_sequence reason",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: "STOP" },
				{ output_tokens: 5 },
			),
		],
		[
			"a null stop_sequence on the stop_sequence reason",
			deltaTranscript(
				{ stop_reason: "stop_sequence", stop_sequence: null },
				{ output_tokens: 5 },
			),
		],
		[
			"a valid refusal stop_details on a non-refusal reason",
			deltaTranscript(
				{
					stop_reason: "end_turn",
					stop_sequence: null,
					stop_details: {
						type: "refusal",
						category: "policy",
						explanation: "no",
					},
				},
				{ output_tokens: 5 },
			),
		],
		[
			"a malformed (scalar) stop_details",
			deltaTranscript(
				{ stop_reason: "refusal", stop_sequence: null, stop_details: 5 },
				{ output_tokens: 5 },
			),
		],
		[
			"an empty refusal stop_details object",
			deltaTranscript(
				{ stop_reason: "refusal", stop_sequence: null, stop_details: {} },
				{ output_tokens: 5 },
			),
		],
		[
			"a refusal stop_details with the wrong type",
			deltaTranscript(
				{
					stop_reason: "refusal",
					stop_sequence: null,
					stop_details: { type: "other", category: "policy", explanation: "x" },
				},
				{ output_tokens: 5 },
			),
		],
		[
			"a refusal stop_details with a non-string category",
			deltaTranscript(
				{
					stop_reason: "refusal",
					stop_sequence: null,
					stop_details: { type: "refusal", category: 5, explanation: "x" },
				},
				{ output_tokens: 5 },
			),
		],
		[
			"a refusal stop_details with a non-string explanation",
			deltaTranscript(
				{
					stop_reason: "refusal",
					stop_sequence: null,
					stop_details: { type: "refusal", category: "policy", explanation: 5 },
				},
				{ output_tokens: 5 },
			),
		],
		[
			"empty output_tokens_details (missing thinking_tokens)",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, output_tokens_details: {} },
			),
		],
		[
			"null thinking_tokens in output_tokens_details",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, output_tokens_details: { thinking_tokens: null } },
			),
		],
		[
			"non-integer thinking_tokens in output_tokens_details",
			deltaTranscript(
				{ stop_reason: "end_turn", stop_sequence: null },
				{ output_tokens: 5, output_tokens_details: { thinking_tokens: 1.5 } },
			),
		],
	])("fails closed on %s", async (_label, transcript) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		expect(await streamError(makeAdapter(fetch))).toBeInstanceOf(
			StreamContractError,
		);
	});
});

// --- Fail-closed contract violations ------------------------------------------

describe("streamAnthropic — fail-closed contract violations", () => {
	test.each([
		[
			"event name / data.type mismatch",
			evt("message_start", { ...MESSAGE_START, type: "ping" }),
		],
		["malformed JSON payload", "event: message_start\ndata: {not json\n\n"],
		["missing event name", 'data: {"type":"message_start"}\n\n'],
		[
			"duplicate message_start",
			messageStart() + messageStart() + terminalStop(),
		],
		[
			"content_block_delta with no open block",
			messageStart() + textDelta("hi") + terminalStop(),
		],
		[
			"misindexed content_block_start (index 1 first)",
			messageStart() + textBlockStart(1),
		],
		[
			"content_block_start before the previous block closed",
			messageStart() + textBlockStart(0) + textBlockStart(1),
		],
		[
			"content_block_stop with the wrong index",
			messageStart() + textBlockStart(0) + textDelta("hi") + blockStop(1),
		],
		[
			"text block receiving an input_json_delta",
			messageStart() + textBlockStart(0) + inputJsonDelta(0, "{}"),
		],
		[
			"tool block receiving a text_delta",
			messageStart() + toolBlockStart(0, "toolu_1", "t") + textDelta("hi", 0),
		],
		[
			"a streamed thinking block despite thinking disabled",
			messageStart() +
				evt("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				}),
		],
		[
			"a signature/thinking delta on a text block",
			messageStart() +
				textBlockStart(0) +
				evt("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "sig" },
				}),
		],
		[
			"an unsupported content block type",
			messageStart() +
				evt("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "x",
						name: "y",
						input: {},
					},
				}),
		],
		[
			"message_delta before message_start",
			messageDelta("end_turn") + terminalStop(),
		],
		[
			"message_delta while a block is still open",
			messageStart() + textBlockStart(0) + messageDelta("end_turn"),
		],
		[
			"duplicate message_delta",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta("end_turn") +
				messageDelta("end_turn"),
		],
		["an unsupported stop_reason", textTranscriptWith("pause_turn")],
		["a null stop_reason", textTranscriptWith(null)],
		[
			"tool stop_reason with no tool blocks (incoherent)",
			textTranscriptWith("tool_use"),
		],
		[
			"end_turn stop_reason with tool blocks (incoherent)",
			messageStart() +
				toolBlockStart(0, "toolu_1", "t") +
				inputJsonDelta(0, "{}") +
				blockStop(0) +
				messageDelta("end_turn", 5) +
				terminalStop(),
		],
		[
			"message_stop before message_delta",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				terminalStop(),
		],
		[
			"a data event after message_stop",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta("end_turn") +
				evt("message_stop", { type: "message_stop" }) +
				evt("ping", { type: "ping" }),
		],
		[
			"an unknown event type",
			messageStart() + evt("surprise", { type: "surprise" }),
		],
		[
			"nonzero cache_creation_input_tokens in message_start usage",
			messageStart({
				input_tokens: 19,
				output_tokens: 0,
				cache_creation_input_tokens: 4,
			}) + terminalStop(),
		],
		[
			"nonzero cache_read_input_tokens in message_start usage",
			messageStart({
				input_tokens: 19,
				output_tokens: 0,
				cache_read_input_tokens: 4,
			}) + terminalStop(),
		],
		[
			"a stream that ends without message_stop",
			messageStart() +
				textBlockStart(0) +
				textDelta("hi") +
				blockStop(0) +
				messageDelta("end_turn"),
		],
		[
			"a truncated final line",
			`${messageStart()}${textBlockStart(0)}event: content_block_delta\ndata: {"type":"content_bl`,
		],
	])("fails closed on %s", async (_label, transcript) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(transcript));
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(StreamContractError);
	});

	test("an error event fails closed without echoing its message", async () => {
		const fetch = vi.fn().mockResolvedValue(
			sseResponse(
				messageStart() +
					evt("error", {
						type: "error",
						error: { type: "overloaded_error", message: "leak-me-error" },
					}),
			),
		);
		const error = await streamError(makeAdapter(fetch));
		expect(error).toBeInstanceOf(StreamContractError);
		expect((error as Error).message).not.toContain("leak-me-error");
	});

	test("yields good content frames before a mid-stream violation surfaces", async () => {
		const fetch = vi.fn().mockResolvedValue(
			sseResponse(
				messageStart() +
					textBlockStart(0) +
					textDelta("partial") +
					// a text_delta on the still-open block is fine; the bad frame is a
					// stray tool delta with no matching index
					inputJsonDelta(5, "{}"),
			),
		);
		const seen: SseChunk[] = [];
		let caught: unknown;
		try {
			for await (const chunk of makeAdapter(fetch).stream(
				REQUEST,
				new AbortController().signal,
			)) {
				seen.push(chunk);
			}
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StreamContractError);
		expect(seen.some((c) => c.done)).toBe(false);
		expect(seen.map((c) => firstChoiceDelta(JSON.parse(c.data)))).toEqual([
			{ role: "assistant", content: "" },
			{ content: "partial" },
		]);
	});
});

/** A single-text-block transcript ending in a specific (bad) stop_reason. */
function textTranscriptWith(stopReason: string | null): string {
	return (
		messageStart() +
		textBlockStart(0) +
		textDelta("hi") +
		blockStop(0) +
		messageDelta(stopReason) +
		terminalStop()
	);
}
