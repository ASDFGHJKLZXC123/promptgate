import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatRequest } from "@promptgate/shared";
import { describe, expect, test, vi } from "vitest";

import { createDeepSeekAdapter } from "./deepseek.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import {
	buildStreamRequestBody,
	readStreamChunk,
} from "./openai-compatible-stream.js";
import {
	ProviderConfigError,
	ProviderError,
	ProviderRequestError,
	StreamContractError,
} from "./provider-error.js";
import type { RetryFetchDeps } from "./retry.js";
import type { ProviderAdapter, ProviderName, SseChunk } from "./types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../test/fixtures");
const CHUNK_BASE = {
	id: "chatcmpl-x",
	object: "chat.completion.chunk",
	created: 1,
	model: "m",
};
const ROLE_CHUNK = {
	...CHUNK_BASE,
	choices: [
		{
			index: 0,
			delta: { role: "assistant", content: "" },
			finish_reason: null,
		},
	],
	usage: null,
};
const CONTENT_CHUNK = {
	...CHUNK_BASE,
	choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
	usage: null,
};
const USAGE_CHUNK = {
	...CHUNK_BASE,
	choices: [],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const GEMINI_COMBINED_TERMINAL_CHUNK = {
	...CHUNK_BASE,
	model: "gemini-2.5-flash",
	choices: [
		{
			index: 0,
			delta: { role: "assistant", content: "OK" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 30 },
};
const DEEPSEEK_COMBINED_TERMINAL_CHUNK = {
	...CHUNK_BASE,
	model: "deepseek-v4-flash",
	choices: [
		{
			index: 0,
			delta: { content: "" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 7, completion_tokens: 39, total_tokens: 46 },
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

/** Joins objects into an SSE transcript, appending `data: [DONE]\n` by default. */
function transcript(objs: unknown[], opts: { done?: boolean } = {}): string {
	const lines = objs.map((o) => `data: ${JSON.stringify(o)}`);
	if (opts.done !== false) {
		lines.push("data: [DONE]");
	}
	return `${lines.join("\n\n")}\n`;
}

const OK_TRANSCRIPT = transcript([ROLE_CHUNK, CONTENT_CHUNK, USAGE_CHUNK]);

function noRetryDeps(fetch: RetryFetchDeps["fetch"]): RetryFetchDeps {
	return {
		fetch,
		sleep: vi.fn().mockResolvedValue(undefined),
		random: () => 0,
	};
}

function compatibleAdapter(
	fetch: RetryFetchDeps["fetch"],
	overrides: { apiKey?: string | undefined; name?: ProviderName } = {},
): ProviderAdapter {
	return createOpenAiCompatibleAdapter({
		name: overrides.name ?? "openai",
		label: "OpenAI",
		url: "https://provider.test/v1/chat/completions",
		apiKey: "apiKey" in overrides ? overrides.apiKey : "sk-test-key",
		missingKeyMessage: "OPENAI_API_KEY is not configured.",
		retryDeps: noRetryDeps(fetch),
	});
}

async function collectStream(
	adapter: ProviderAdapter,
	req: ChatRequest,
): Promise<SseChunk[]> {
	const chunks: SseChunk[] = [];
	for await (const chunk of adapter.stream(req, new AbortController().signal)) {
		chunks.push(chunk);
	}
	return chunks;
}

const REQUEST: ChatRequest = {
	model: "gpt-5.6-luna",
	messages: [{ role: "user", content: "say hi" }],
	stream: true,
};

describe("buildStreamRequestBody", () => {
	test("forces stream:true, injects include_usage, strips pg_*, preserves the rest", () => {
		const body = buildStreamRequestBody(
			{
				...REQUEST,
				stream: false,
				temperature: 0.4,
				extra_body: { google: { thinking_config: { thinking_budget: 0 } } },
				thinking: { type: "enabled" },
				pg_feature: "inbox",
				pg_no_cache: true,
			} as ChatRequest,
			"gemini",
		);

		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.temperature).toBe(0.4);
		expect(body.extra_body).toEqual({
			google: { thinking_config: { thinking_budget: 0 } },
		});
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.pg_feature).toBeUndefined();
		expect(body.pg_no_cache).toBeUndefined();
	});

	test("merges caller stream_options and always overrides include_usage to true", () => {
		const body = buildStreamRequestBody(
			{
				...REQUEST,
				stream_options: { include_usage: false, continuous_usage_stats: true },
			} as ChatRequest,
			"openai",
		);
		expect(body.stream_options).toEqual({
			continuous_usage_stats: true,
			include_usage: true,
		});
	});

	test("rejects malformed caller stream_options with a client-safe ProviderRequestError", () => {
		expect(() =>
			buildStreamRequestBody(
				{ ...REQUEST, stream_options: { include_usage: "yes" } } as ChatRequest,
				"openai",
			),
		).toThrow(ProviderRequestError);
	});
});

describe("streamOpenAiCompatible — outbound request", () => {
	test("sends the exact URL, auth, and forced streaming body", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(OK_TRANSCRIPT));
		const adapter = compatibleAdapter(fetch);

		await collectStream(adapter, {
			...REQUEST,
			pg_no_cache: true,
			extra_body: { google: { thinking_config: { thinking_budget: 2 } } },
		} as ChatRequest);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://provider.test/v1/chat/completions");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"content-type": "application/json",
			accept: "text/event-stream",
			authorization: "Bearer sk-test-key",
		});
		const sent = JSON.parse(init.body as string);
		expect(sent.stream).toBe(true);
		expect(sent.stream_options).toEqual({ include_usage: true });
		expect(sent.pg_no_cache).toBeUndefined();
		expect(sent.extra_body).toEqual({
			google: { thinking_config: { thinking_budget: 2 } },
		});
	});

	test("throws ProviderConfigError without making a request when the key is missing", async () => {
		const fetch = vi.fn();
		const adapter = compatibleAdapter(fetch, { apiKey: undefined });

		await expect(collectStream(adapter, REQUEST)).rejects.toBeInstanceOf(
			ProviderConfigError,
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("rejects malformed stream_options before any fetch", async () => {
		const fetch = vi.fn();
		const adapter = compatibleAdapter(fetch);

		await expect(
			collectStream(adapter, {
				...REQUEST,
				stream_options: 5,
			} as unknown as ChatRequest),
		).rejects.toBeInstanceOf(ProviderRequestError);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("retries 429 before streaming the body, then forwards the successful transcript", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(sseResponse(OK_TRANSCRIPT));
		const adapter = compatibleAdapter(fetch);

		const chunks = await collectStream(adapter, REQUEST);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
	});

	test("maps a non-ok upstream response to a ProviderError before streaming", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "leak-me" } }), {
				status: 401,
			}),
		);
		const adapter = compatibleAdapter(fetch);

		const error = await collectStream(adapter, REQUEST).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ProviderError);
		expect((error as ProviderError).status).toBe(401);
	});
});

describe("streamOpenAiCompatible — forwarding and fixture parity", () => {
	test.each([
		["openai", "openai-streaming.txt", createOpenAiAdapterForTest],
		["gemini", "gemini-streaming.txt", createGeminiAdapterForTest],
		["deepseek", "deepseek-streaming.txt", createDeepSeekAdapterForTest],
	] as const)(
		"forwards the committed %s fixture verbatim with one terminal [DONE]",
		async (_provider, file, factory) => {
			const text = readFileSync(path.join(FIXTURES_DIR, file), "utf8");
			const fetch = vi.fn().mockResolvedValue(sseResponse(text));
			const adapter = factory(fetch);

			const chunks = await collectStream(adapter, REQUEST);

			const expectedPayloads = text
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice("data: ".length));
			expect(chunks.map((c) => c.data)).toEqual(expectedPayloads);
			expect(chunks.filter((c) => c.done)).toHaveLength(1);
			expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
		},
	);

	test("accepts OpenAI's separate empty-choice terminal usage frame", async () => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(OK_TRANSCRIPT));
		const chunks = await collectStream(compatibleAdapter(fetch), REQUEST);

		expect(chunks.map((chunk) => chunk.data)).toEqual([
			JSON.stringify(ROLE_CHUNK),
			JSON.stringify(CONTENT_CHUNK),
			JSON.stringify(USAGE_CHUNK),
			"[DONE]",
		]);
	});

	test("accepts Gemini's collapsed content, finish, and usage frame and tee-reads both", async () => {
		const payload = JSON.stringify(GEMINI_COMBINED_TERMINAL_CHUNK);
		const fetch = vi
			.fn()
			.mockResolvedValue(sseResponse(`data: ${payload}\n\ndata: [DONE]\n`));

		const chunks = await collectStream(
			createGeminiAdapterForTest(fetch),
			REQUEST,
		);

		expect(chunks).toEqual([
			{ data: payload, done: false },
			{ data: "[DONE]", done: true },
		]);
		expect(readStreamChunk(payload)).toEqual({
			contentDelta: "OK",
			visibleContentChars: 2,
			usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 30 },
		});
	});

	test("accepts DeepSeek's combined finish and usage frame", async () => {
		const text = transcript([ROLE_CHUNK, DEEPSEEK_COMBINED_TERMINAL_CHUNK]);
		const fetch = vi.fn().mockResolvedValue(sseResponse(text));

		const chunks = await collectStream(
			createDeepSeekAdapterForTest(fetch),
			REQUEST,
		);

		expect(chunks.map((chunk) => chunk.data)).toEqual([
			JSON.stringify(ROLE_CHUNK),
			JSON.stringify(DEEPSEEK_COMBINED_TERMINAL_CHUNK),
			"[DONE]",
		]);
	});

	test("is invariant to arbitrary byte boundaries in the upstream stream", async () => {
		const text = readFileSync(
			path.join(FIXTURES_DIR, "deepseek-streaming.txt"),
			"utf8",
		);
		const fetch = vi.fn().mockResolvedValue(sseResponseByteAtATime(text));
		const adapter = createDeepSeekAdapterForTest(fetch);

		const chunks = await collectStream(adapter, REQUEST);

		const expectedPayloads = text
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));
		expect(chunks.map((c) => c.data)).toEqual(expectedPayloads);
	});
});

function createOpenAiAdapterForTest(
	fetch: RetryFetchDeps["fetch"],
): ProviderAdapter {
	return compatibleAdapter(fetch, { name: "openai" });
}
function createGeminiAdapterForTest(
	fetch: RetryFetchDeps["fetch"],
): ProviderAdapter {
	return createGeminiAdapter({
		apiKey: "gm-test-key",
		retryDeps: noRetryDeps(fetch),
	});
}
function createDeepSeekAdapterForTest(
	fetch: RetryFetchDeps["fetch"],
): ProviderAdapter {
	return createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});
}

describe("streamOpenAiCompatible — fail-closed contract violations", () => {
	test.each([
		[
			"malformed JSON chunk",
			`data: ${JSON.stringify(ROLE_CHUNK)}\n\ndata: {not json\n\ndata: [DONE]\n`,
		],
		[
			"wrong chunk identity",
			transcript([{ ...ROLE_CHUNK, object: "chat.completion" }, USAGE_CHUNK]),
		],
		[
			"duplicate terminal usage",
			transcript([ROLE_CHUNK, USAGE_CHUNK, USAGE_CHUNK]),
		],
		[
			"content after the terminal usage chunk",
			transcript([ROLE_CHUNK, USAGE_CHUNK, CONTENT_CHUNK]),
		],
		[
			"missing terminal usage before [DONE]",
			transcript([ROLE_CHUNK, CONTENT_CHUNK]),
		],
		[
			"usage-bearing choice with a null finish_reason",
			transcript([
				ROLE_CHUNK,
				{ ...USAGE_CHUNK, choices: CONTENT_CHUNK.choices },
			]),
		],
		[
			"usage-bearing choice with a missing finish_reason",
			transcript([
				ROLE_CHUNK,
				{
					...USAGE_CHUNK,
					choices: [{ index: 0, delta: { content: "late" } }],
				},
			]),
		],
		[
			"mixed usage-bearing choices where one lacks a finish_reason",
			transcript([
				ROLE_CHUNK,
				{
					...USAGE_CHUNK,
					choices: [
						{
							index: 0,
							delta: { content: "complete" },
							finish_reason: "stop",
						},
						{
							index: 1,
							delta: { content: "incomplete" },
							finish_reason: null,
						},
					],
				},
			]),
		],
		[
			// [DONE] and the trailing frame are both blank-line terminated so the
			// parser dispatches them — the adapter must reject the post-DONE frame.
			"a dispatched data frame after [DONE]",
			`data: ${JSON.stringify(ROLE_CHUNK)}\n\ndata: ${JSON.stringify(USAGE_CHUNK)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(CONTENT_CHUNK)}\n\n`,
		],
		[
			"missing [DONE] after a dispatched usage chunk",
			`data: ${JSON.stringify(ROLE_CHUNK)}\n\ndata: ${JSON.stringify(USAGE_CHUNK)}\n\n`,
		],
	])("fails closed on %s", async (_label, text) => {
		const fetch = vi.fn().mockResolvedValue(sseResponse(text));
		const adapter = compatibleAdapter(fetch);

		await expect(collectStream(adapter, REQUEST)).rejects.toBeInstanceOf(
			StreamContractError,
		);
	});

	test("fails closed on a truncated stream (ends mid-chunk)", async () => {
		const text = `data: ${JSON.stringify(ROLE_CHUNK)}\n\ndata: {"id":"x","object":"cha`;
		const fetch = vi.fn().mockResolvedValue(sseResponse(text));
		const adapter = compatibleAdapter(fetch);

		await expect(collectStream(adapter, REQUEST)).rejects.toBeInstanceOf(
			StreamContractError,
		);
	});

	test("streams valid chunks before a mid-stream violation surfaces", async () => {
		// A valid role + content chunk flow to the client, THEN a bad frame — the
		// adapter must have yielded the good chunks before it throws (proves it
		// forwards promptly rather than buffering the whole response).
		const text = `${transcript([ROLE_CHUNK, CONTENT_CHUNK], { done: false })}\ndata: {broken\n\n`;
		const fetch = vi.fn().mockResolvedValue(sseResponse(text));
		const adapter = compatibleAdapter(fetch);

		const seen: SseChunk[] = [];
		const error = await (async () => {
			try {
				for await (const chunk of adapter.stream(
					REQUEST,
					new AbortController().signal,
				)) {
					seen.push(chunk);
				}
			} catch (e) {
				return e;
			}
		})();

		expect(error).toBeInstanceOf(StreamContractError);
		expect(seen.map((c) => JSON.parse(c.data).choices[0].delta)).toEqual([
			{ role: "assistant", content: "" },
			{ content: "Hello" },
		]);
	});
});

describe("streamOpenAiCompatible — content-type and terminal safety", () => {
	test("fails closed without leaking on a 200 whose content-type is not event-stream", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(
					JSON.stringify({ error: { message: "leak-me-mime" } }),
					"application/json",
				),
			);
		const adapter = compatibleAdapter(fetch);

		const error = await collectStream(adapter, REQUEST).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(StreamContractError);
		expect((error as Error).message).not.toContain("leak-me-mime");
	});

	test("accepts text/event-stream case-insensitively and with parameters", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				sseResponse(OK_TRANSCRIPT, "Text/Event-Stream; charset=utf-8"),
			);
		const adapter = compatibleAdapter(fetch);

		const chunks = await collectStream(adapter, REQUEST);
		expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
	});

	test("never yields [DONE] when a data frame follows it (buffered until clean EOF)", async () => {
		const text = `data: ${JSON.stringify(ROLE_CHUNK)}\n\ndata: ${JSON.stringify(USAGE_CHUNK)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(CONTENT_CHUNK)}\n\n`;
		const fetch = vi.fn().mockResolvedValue(sseResponse(text));
		const adapter = compatibleAdapter(fetch);

		const seen: SseChunk[] = [];
		const error = await (async () => {
			try {
				for await (const chunk of adapter.stream(
					REQUEST,
					new AbortController().signal,
				)) {
					seen.push(chunk);
				}
			} catch (e) {
				return e;
			}
		})();

		expect(error).toBeInstanceOf(StreamContractError);
		// The client received role + usage but NEVER the terminal sentinel.
		expect(seen.some((c) => c.done)).toBe(false);
		expect(seen.map((c) => c.data)).not.toContain("[DONE]");
	});
});

describe("readStreamChunk — first-token and usage tee", () => {
	test("a nonempty content delta is the first token", () => {
		expect(readStreamChunk(JSON.stringify(CONTENT_CHUNK))).toEqual({
			contentDelta: "Hello",
			visibleContentChars: 5,
			usage: null,
		});
	});

	test("a role chunk (empty content) is not the first token", () => {
		expect(readStreamChunk(JSON.stringify(ROLE_CHUNK)).contentDelta).toBeNull();
	});

	test("DeepSeek reasoning_content is not the first token", () => {
		const reasoning = {
			...CHUNK_BASE,
			choices: [
				{
					index: 0,
					delta: { reasoning_content: "thinking" },
					finish_reason: null,
				},
			],
			usage: null,
		};
		expect(readStreamChunk(JSON.stringify(reasoning)).contentDelta).toBeNull();
	});

	test("finds visible content in a later choice (n>1), not only choices[0]", () => {
		const multiChoice = {
			...CHUNK_BASE,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "" },
					finish_reason: null,
				},
				{ index: 1, delta: { content: "later" }, finish_reason: null },
				{ index: 2, delta: { content: "also" }, finish_reason: null },
			],
			usage: null,
		};
		const reading = readStreamChunk(JSON.stringify(multiChoice));
		expect(reading.contentDelta).toBe("later");
		expect(reading.visibleContentChars).toBe(9);
	});

	test("captures the terminal usage", () => {
		const reading = readStreamChunk(JSON.stringify(USAGE_CHUNK));
		expect(reading.contentDelta).toBeNull();
		expect(reading.usage).toMatchObject({ prompt_tokens: 1, total_tokens: 2 });
	});

	test("[DONE] and malformed payloads read as no content and no usage", () => {
		expect(readStreamChunk("[DONE]")).toEqual({
			contentDelta: null,
			visibleContentChars: 0,
			usage: null,
		});
		expect(readStreamChunk("{broken")).toEqual({
			contentDelta: null,
			visibleContentChars: 0,
			usage: null,
		});
	});
});
