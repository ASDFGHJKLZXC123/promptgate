import { expect, test, vi } from "vitest";

import {
	defaultRetryDeps,
	fetchWithRetry,
	RETRY_BASE_DELAYS_MS,
	type RetryFetchDeps,
} from "./retry.js";

function fakeResponse(status: number, cancel?: () => Promise<void>): Response {
	return {
		status,
		body: cancel ? { cancel } : null,
	} as unknown as Response;
}

function makeDeps(overrides: Partial<RetryFetchDeps> = {}): RetryFetchDeps {
	return {
		fetch: vi.fn(),
		sleep: vi.fn().mockResolvedValue(undefined),
		random: () => 0,
		...overrides,
	};
}

test("returns immediately on a successful (2xx) response without sleeping", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(deps.sleep).not.toHaveBeenCalled();
});

test("returns immediately on an ordinary 4xx without retrying", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(400));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(400);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(deps.sleep).not.toHaveBeenCalled();
});

test("retries on 429 and succeeds on the second attempt", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(429))
		.mockResolvedValueOnce(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(deps.sleep).toHaveBeenCalledTimes(1);
});

test("retries on 5xx and succeeds on the third attempt", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(503))
		.mockResolvedValueOnce(fakeResponse(502))
		.mockResolvedValueOnce(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(deps.sleep).toHaveBeenCalledTimes(2);
});

test("exhausts retries after exactly 2 retries (3 total attempts) and returns the last failure", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(429));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(429);
	expect(fetch).toHaveBeenCalledTimes(1 + RETRY_BASE_DELAYS_MS.length);
	expect(deps.sleep).toHaveBeenCalledTimes(RETRY_BASE_DELAYS_MS.length);
});

test("only retries 429 and 5xx, never other 4xx statuses", async () => {
	for (const status of [401, 403, 404, 422]) {
		const fetch = vi.fn().mockResolvedValue(fakeResponse(status));
		const deps = makeDeps({ fetch });

		const response = await fetchWithRetry("https://example.test", {}, deps);

		expect(response.status).toBe(status);
		expect(fetch).toHaveBeenCalledTimes(1);
	}
});

test("computes jittered delays from the 250ms/1000ms base schedule", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(429));
	const sleep = vi.fn().mockResolvedValue(undefined);
	const deps = makeDeps({ fetch, sleep, random: () => 0 });

	await fetchWithRetry("https://example.test", {}, deps);

	// Equal-jitter: base/2 fixed + random() * base/2. random() === 0 gives base/2 exactly.
	expect(sleep).toHaveBeenNthCalledWith(1, 125, undefined);
	expect(sleep).toHaveBeenNthCalledWith(2, 500, undefined);
});

test("jitter scales with the random source between base/2 and base", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(429));
	const sleep = vi.fn().mockResolvedValue(undefined);
	const deps = makeDeps({ fetch, sleep, random: () => 0.5 });

	await fetchWithRetry("https://example.test", {}, deps);

	expect(sleep).toHaveBeenNthCalledWith(1, 187.5, undefined);
	expect(sleep).toHaveBeenNthCalledWith(2, 750, undefined);
});

test("cancels the body of a discarded retryable response but not the final response", async () => {
	const retriedCancel = vi.fn().mockResolvedValue(undefined);
	const finalCancel = vi.fn().mockResolvedValue(undefined);
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(503, retriedCancel))
		.mockResolvedValueOnce(fakeResponse(200, finalCancel));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(200);
	expect(retriedCancel).toHaveBeenCalledTimes(1);
	expect(finalCancel).not.toHaveBeenCalled();
});

test("tolerates a retryable response with no body to release", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(429, undefined))
		.mockResolvedValueOnce(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(200);
});

test("does not retry 408 by default (extraRetryStatuses omitted)", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(408));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps);

	expect(response.status).toBe(408);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(deps.sleep).not.toHaveBeenCalled();
});

test("retries a status named in extraRetryStatuses and succeeds on the next attempt", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(408))
		.mockResolvedValueOnce(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry(
		"https://example.test",
		{},
		deps,
		[408],
	);

	expect(response.status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(deps.sleep).toHaveBeenCalledTimes(1);
});

test("exhausts retries on a status named in extraRetryStatuses after 3 total attempts", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(408));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry(
		"https://example.test",
		{},
		deps,
		[408],
	);

	expect(response.status).toBe(408);
	expect(fetch).toHaveBeenCalledTimes(1 + RETRY_BASE_DELAYS_MS.length);
});

test("extraRetryStatuses does not widen retries to unlisted statuses", async () => {
	const fetch = vi.fn().mockResolvedValue(fakeResponse(400));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry(
		"https://example.test",
		{},
		deps,
		[408],
	);

	expect(response.status).toBe(400);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("an empty extraRetryStatuses array behaves like the default (429/5xx only)", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(429))
		.mockResolvedValueOnce(fakeResponse(200));
	const deps = makeDeps({ fetch });

	const response = await fetchWithRetry("https://example.test", {}, deps, []);

	expect(response.status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(2);
});

test("propagates a fetch rejection (e.g. AbortError) without retrying", async () => {
	const abortError = new DOMException("Aborted", "AbortError");
	const fetch = vi.fn().mockRejectedValue(abortError);
	const deps = makeDeps({ fetch });

	await expect(fetchWithRetry("https://example.test", {}, deps)).rejects.toBe(
		abortError,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("propagates a sleep rejection (abort mid-wait) without a further fetch attempt", async () => {
	const abortError = new DOMException("Aborted", "AbortError");
	const fetch = vi.fn().mockResolvedValue(fakeResponse(503));
	const sleep = vi.fn().mockRejectedValue(abortError);
	const deps = makeDeps({ fetch, sleep });

	await expect(fetchWithRetry("https://example.test", {}, deps)).rejects.toBe(
		abortError,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("passes the request's AbortSignal through to sleep between retries", async () => {
	const controller = new AbortController();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(fakeResponse(429))
		.mockResolvedValueOnce(fakeResponse(200));
	const sleep = vi.fn().mockResolvedValue(undefined);
	const deps = makeDeps({ fetch, sleep });

	await fetchWithRetry(
		"https://example.test",
		{ signal: controller.signal },
		deps,
	);

	expect(sleep).toHaveBeenCalledWith(expect.any(Number), controller.signal);
});

test("defaultRetryDeps.sleep rejects immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();

	await expect(
		defaultRetryDeps.sleep(1000, controller.signal),
	).rejects.toBeInstanceOf(DOMException);
});

test("defaultRetryDeps.sleep removes its abort listener after the delay resolves", async () => {
	const controller = new AbortController();
	const removeEventListener = vi.spyOn(
		controller.signal,
		"removeEventListener",
	);

	await defaultRetryDeps.sleep(0, controller.signal);

	expect(removeEventListener).toHaveBeenCalledWith(
		"abort",
		expect.any(Function),
	);
});
