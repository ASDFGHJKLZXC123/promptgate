import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatRequest } from "@promptgate/shared";
import { expect, test, vi } from "vitest";

import { createAnthropicAdapter } from "./anthropic.js";
import {
	ProviderConfigError,
	ProviderError,
	ProviderRequestError,
} from "./provider-error.js";
import type { RetryFetchDeps } from "./retry.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../test/fixtures");

/** Committed offline contract fixture — no test ever reaches the network (§11). */
const ANTHROPIC_FIXTURE = JSON.parse(
	readFileSync(path.join(FIXTURES_DIR, "anthropic-non-streaming.json"), "utf8"),
) as Record<string, unknown>;

const FAKE_REQUEST: ChatRequest = {
	model: "claude-sonnet-5",
	messages: [
		{ role: "system", content: "Be helpful." },
		{ role: "user", content: "say hi" },
	],
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textErrorResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

function noRetryDeps(fetch: RetryFetchDeps["fetch"]): RetryFetchDeps {
	return {
		fetch,
		sleep: vi.fn().mockResolvedValue(undefined),
		random: () => 0,
	};
}

test("sends the official endpoint, method, and Anthropic headers", async () => {
	const fetch = vi.fn().mockResolvedValue(jsonResponse(200, ANTHROPIC_FIXTURE));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	await adapter.complete(FAKE_REQUEST, new AbortController().signal);

	expect(fetch).toHaveBeenCalledTimes(1);
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
	expect(url).toBe("https://api.anthropic.com/v1/messages");
	expect(init.method).toBe("POST");
	expect(init.headers).toMatchObject({
		"content-type": "application/json",
		"x-api-key": "sk-ant-test-key",
		"anthropic-version": "2023-06-01",
	});
});

test("forwards the translated Anthropic body (system extracted, default max_tokens applied)", async () => {
	const fetch = vi.fn().mockResolvedValue(jsonResponse(200, ANTHROPIC_FIXTURE));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		defaultMaxTokens: 512,
		retryDeps: noRetryDeps(fetch),
	});

	await adapter.complete(FAKE_REQUEST, new AbortController().signal);

	const [, init] = fetch.mock.calls[0] as [string, RequestInit];
	expect(JSON.parse(init.body as string)).toEqual({
		model: "claude-sonnet-5",
		system: "Be helpful.",
		messages: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
		max_tokens: 512,
		thinking: { type: "disabled" },
	});
});

test("does not leak pg_* fields into the upstream body", async () => {
	const fetch = vi.fn().mockResolvedValue(jsonResponse(200, ANTHROPIC_FIXTURE));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		defaultMaxTokens: 512,
		retryDeps: noRetryDeps(fetch),
	});

	await adapter.complete(
		{
			...FAKE_REQUEST,
			pg_feature: "inbox_summary",
			pg_no_cache: true,
		},
		new AbortController().signal,
	);

	const [, init] = fetch.mock.calls[0] as [string, RequestInit];
	const sent = JSON.parse(init.body as string) as Record<string, unknown>;
	expect(Object.keys(sent).some((key) => key.startsWith("pg_"))).toBe(false);
});

test("translates the fixture response into the shared OpenAI shape with a deterministic clock", async () => {
	const fetch = vi.fn().mockResolvedValue(jsonResponse(200, ANTHROPIC_FIXTURE));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
		now: () => 100_000, // 100 seconds
	});

	const result = await adapter.complete(
		FAKE_REQUEST,
		new AbortController().signal,
	);

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

test("surfaces a malformed upstream 200 as a ProviderError without leaking the body", async () => {
	const fetch = vi.fn().mockResolvedValue(
		jsonResponse(200, {
			id: "msg_leak",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-5",
			// The adapter explicitly disabled thinking, so this block violates the
			// request contract and its text must never surface to the client.
			content: [{ type: "thinking", thinking: "UPSTREAM-LEAK-MARKER" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
	);
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(error).toBeInstanceOf(ProviderError);
	expect((error as ProviderError).status).toBe(502);
	expect(JSON.stringify(error)).not.toContain("UPSTREAM-LEAK-MARKER");
});

test("throws ProviderConfigError without making a request when the key is missing", async () => {
	const fetch = vi.fn();
	const adapter = createAnthropicAdapter({
		apiKey: undefined,
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(error).toBeInstanceOf(ProviderConfigError);
	expect((error as ProviderConfigError).provider).toBe("anthropic");
	expect(fetch).not.toHaveBeenCalled();
});

test("rejects an untranslatable request with a ProviderRequestError before fetching", async () => {
	const fetch = vi.fn();
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(
			{
				...FAKE_REQUEST,
				tools: [{ type: "custom", name: "x" }],
			} as ChatRequest,
			new AbortController().signal,
		)
		.catch((e: unknown) => e);

	expect(error).toBeInstanceOf(ProviderRequestError);
	expect((error as ProviderRequestError).provider).toBe("anthropic");
	expect(fetch).not.toHaveBeenCalled();
});

test("retries on 429 then succeeds (shared bounded retry semantics)", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(textErrorResponse(429, { error: "slow down" }))
		.mockResolvedValueOnce(jsonResponse(200, ANTHROPIC_FIXTURE));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
		now: () => 0,
	});

	await adapter.complete(FAKE_REQUEST, new AbortController().signal);

	expect(fetch).toHaveBeenCalledTimes(2);
});

test("exhausts retries on repeated 5xx and throws a ProviderError with the upstream status/body", async () => {
	const upstreamError = { type: "error", error: { type: "overloaded_error" } };
	const fetch = vi
		.fn()
		.mockImplementation(() =>
			Promise.resolve(textErrorResponse(529, upstreamError)),
		);
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(fetch).toHaveBeenCalledTimes(3);
	expect(error).toBeInstanceOf(ProviderError);
	const providerError = error as ProviderError;
	expect(providerError.provider).toBe("anthropic");
	expect(providerError.status).toBe(529);
	expect(providerError.body).toEqual(upstreamError);
});

test("does not retry an ordinary 4xx and preserves its status/body", async () => {
	const upstreamError = {
		type: "error",
		error: { type: "invalid_request_error" },
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(textErrorResponse(400, upstreamError));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(fetch).toHaveBeenCalledTimes(1);
	expect(error).toBeInstanceOf(ProviderError);
	expect((error as ProviderError).status).toBe(400);
});

test("propagates abort without retrying", async () => {
	const controller = new AbortController();
	const abortError = new DOMException("Aborted", "AbortError");
	const fetch = vi.fn().mockImplementation(() => Promise.reject(abortError));
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});
	controller.abort();

	const error = await adapter
		.complete(FAKE_REQUEST, controller.signal)
		.catch((e: unknown) => e);

	expect(error).toBe(abortError);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("stream() delegates to the Anthropic SSE translator and ends with [DONE]", async () => {
	// Delegation smoke test only; the full streaming contract lives in
	// anthropic-stream.test.ts. Proves the adapter wires stream() to the
	// translator instead of throwing the old not-implemented stub.
	const fixture = readFileSync(
		path.join(FIXTURES_DIR, "anthropic-streaming.txt"),
		"utf8",
	);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(fixture));
			controller.close();
		},
	});
	const fetch = vi.fn().mockResolvedValue(
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
	const adapter = createAnthropicAdapter({
		apiKey: "sk-ant-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const chunks: { data: string; done: boolean }[] = [];
	for await (const chunk of adapter.stream(
		FAKE_REQUEST,
		new AbortController().signal,
	)) {
		chunks.push(chunk);
	}

	expect(chunks.at(-1)).toEqual({ data: "[DONE]", done: true });
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
	expect(url).toBe("https://api.anthropic.com/v1/messages");
	expect(init.headers).toMatchObject({ accept: "text/event-stream" });
	expect(JSON.parse(init.body as string).stream).toBe(true);
});
