import type { ChatRequest } from "@promptgate/shared";
import { expect, test, vi } from "vitest";

import { createDeepSeekAdapter } from "./deepseek.js";
import { ProviderConfigError, ProviderError } from "./provider-error.js";
import type { RetryFetchDeps } from "./retry.js";

const FAKE_REQUEST: ChatRequest = {
	model: "deepseek-v4-flash",
	messages: [{ role: "user", content: "say hi" }],
};

const FAKE_RESPONSE_BODY = {
	id: "chatcmpl-test",
	object: "chat.completion",
	created: 0,
	model: "deepseek-v4-flash",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hello" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
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

test("sends the exact endpoint, method, and headers", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, FAKE_RESPONSE_BODY));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	await adapter.complete(FAKE_REQUEST, new AbortController().signal);

	expect(fetch).toHaveBeenCalledTimes(1);
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
	expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
	expect(init.method).toBe("POST");
	expect(init.headers).toMatchObject({
		"content-type": "application/json",
		authorization: "Bearer sk-deepseek-test-key",
	});
});

test("strips pg_* fields from the forwarded body", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, FAKE_RESPONSE_BODY));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const req: ChatRequest = {
		...FAKE_REQUEST,
		pg_prompt: "safety_screen@prod",
		pg_vars: { note: "hi" },
		pg_feature: "inbox_summary",
		pg_no_cache: true,
	};
	await adapter.complete(req, new AbortController().signal);

	const [, init] = fetch.mock.calls[0] as [string, RequestInit];
	const sentBody = JSON.parse(init.body as string);
	expect(sentBody).toEqual({
		model: "deepseek-v4-flash",
		messages: [{ role: "user", content: "say hi" }],
	});
});

test("preserves caller-supplied thinking and other unknown fields for provider forwarding", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, FAKE_RESPONSE_BODY));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const req = {
		...FAKE_REQUEST,
		thinking: { type: "enabled", budget_tokens: 1024 },
		seed: 42,
	} as ChatRequest;
	await adapter.complete(req, new AbortController().signal);

	const [, init] = fetch.mock.calls[0] as [string, RequestInit];
	const sentBody = JSON.parse(init.body as string);
	expect(sentBody.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
	expect(sentBody.seed).toBe(42);
});

test("validates and returns a successful response with paired cache usage", async () => {
	const responseWithCacheUsage = {
		...FAKE_RESPONSE_BODY,
		usage: {
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			prompt_cache_hit_tokens: 60,
			prompt_cache_miss_tokens: 40,
		},
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, responseWithCacheUsage));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const result = await adapter.complete(
		FAKE_REQUEST,
		new AbortController().signal,
	);

	expect(result).toEqual(responseWithCacheUsage);
	expect(result.usage?.prompt_cache_hit_tokens).toBe(60);
	expect(result.usage?.prompt_cache_miss_tokens).toBe(40);
});

test("accepts DeepSeek's documented insufficient_system_resource finish reason", async () => {
	const resourceLimitedResponse = {
		...FAKE_RESPONSE_BODY,
		choices: [
			{
				...FAKE_RESPONSE_BODY.choices[0],
				finish_reason: "insufficient_system_resource",
			},
		],
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, resourceLimitedResponse));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const result = await adapter.complete(
		FAKE_REQUEST,
		new AbortController().signal,
	);

	expect(result.choices[0]?.finish_reason).toBe("insufficient_system_resource");
});

test("throws when the successful response fails ChatResponseSchema validation", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, { object: "chat.completion" }));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	await expect(
		adapter.complete(FAKE_REQUEST, new AbortController().signal),
	).rejects.toThrow();
});

test("throws when the cache usage pair is malformed (mismatched sum)", async () => {
	const responseWithBadCacheUsage = {
		...FAKE_RESPONSE_BODY,
		usage: {
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			prompt_cache_hit_tokens: 60,
			prompt_cache_miss_tokens: 10,
		},
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(200, responseWithBadCacheUsage));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	await expect(
		adapter.complete(FAKE_REQUEST, new AbortController().signal),
	).rejects.toThrow();
});

test("throws ProviderConfigError without making a request when the key is missing", async () => {
	const fetch = vi.fn();
	const adapter = createDeepSeekAdapter({
		apiKey: undefined,
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(error).toBeInstanceOf(ProviderConfigError);
	expect((error as ProviderConfigError).provider).toBe("deepseek");
	expect(fetch).not.toHaveBeenCalled();
});

test("retries on 429 and succeeds, forwarding the retry helper's result", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			textErrorResponse(429, { error: { message: "rate limited" } }),
		)
		.mockResolvedValueOnce(jsonResponse(200, FAKE_RESPONSE_BODY));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const result = await adapter.complete(
		FAKE_REQUEST,
		new AbortController().signal,
	);

	expect(fetch).toHaveBeenCalledTimes(2);
	expect(result).toEqual(FAKE_RESPONSE_BODY);
});

test("exhausts retries on repeated 5xx and throws a ProviderError with the upstream status/body", async () => {
	const upstreamError = { error: { message: "boom", type: "server_error" } };
	const fetch = vi
		.fn()
		.mockImplementation(() =>
			Promise.resolve(textErrorResponse(503, upstreamError)),
		);
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(fetch).toHaveBeenCalledTimes(3);
	expect(error).toBeInstanceOf(ProviderError);
	const providerError = error as ProviderError;
	expect(providerError.provider).toBe("deepseek");
	expect(providerError.status).toBe(503);
	expect(providerError.body).toEqual(upstreamError);
});

test("does not retry an ordinary 4xx and preserves its status/body", async () => {
	const upstreamError = {
		error: { message: "bad request", type: "invalid_request_error" },
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(textErrorResponse(400, upstreamError));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});

	const error = await adapter
		.complete(FAKE_REQUEST, new AbortController().signal)
		.catch((e: unknown) => e);

	expect(fetch).toHaveBeenCalledTimes(1);
	expect(error).toBeInstanceOf(ProviderError);
	expect((error as ProviderError).status).toBe(400);
	expect((error as ProviderError).body).toEqual(upstreamError);
});

test("propagates abort without retrying", async () => {
	const controller = new AbortController();
	const abortError = new DOMException("Aborted", "AbortError");
	const fetch = vi.fn().mockImplementation(() => Promise.reject(abortError));
	const adapter = createDeepSeekAdapter({
		apiKey: "sk-deepseek-test-key",
		retryDeps: noRetryDeps(fetch),
	});
	controller.abort();

	const error = await adapter
		.complete(FAKE_REQUEST, controller.signal)
		.catch((e: unknown) => e);

	expect(error).toBe(abortError);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("stream() throws synchronously as not-yet-supported until Phase 2", () => {
	const adapter = createDeepSeekAdapter({ apiKey: "sk-deepseek-test-key" });

	expect(() =>
		adapter.stream(FAKE_REQUEST, new AbortController().signal),
	).toThrow(/Phase 2/);
});
