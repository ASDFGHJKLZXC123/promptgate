/**
 * Retry helper for provider fetches (IMPLEMENTATION_GUIDE.md §3.6): upstream
 * 429/5xx responses are retried twice with jittered backoff (250ms, then
 * 1000ms base), then the last response is returned as-is for the caller to
 * turn into a typed provider error. Ordinary 4xx responses return
 * immediately — never retried. Network-level rejections (including an
 * aborted signal) propagate directly and are never retried either. Fetch,
 * sleep, and the jitter source are all injectable so retry timing is
 * deterministic in tests — no real waiting, no network.
 *
 * `extraRetryStatuses` (BUILD_PLAYBOOK.md phase 1 step 11) lets a caller opt
 * a handful of additional statuses into the same retry schedule — e.g.
 * Gemini's adapter adds 408 per Google's official retry guidance. It
 * defaults to empty, so OpenAI's and DeepSeek's retry behavior is unchanged.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryFetchDeps {
	fetch: FetchLike;
	sleep: (ms: number, signal: AbortSignal | null | undefined) => Promise<void>;
	random: () => number;
}

/** One entry per retry attempt — two entries means two retries (three total attempts). */
export const RETRY_BASE_DELAYS_MS: readonly number[] = [250, 1000];

function defaultSleep(
	ms: number,
	signal: AbortSignal | null | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const defaultRetryDeps: RetryFetchDeps = {
	fetch: (input, init) => globalThis.fetch(input, init),
	sleep: defaultSleep,
	random: () => Math.random(),
};

function isRetryableStatus(
	status: number,
	extraRetryStatuses: readonly number[],
): boolean {
	return (
		status === 429 ||
		(status >= 500 && status < 600) ||
		extraRetryStatuses.includes(status)
	);
}

/** Equal-jitter backoff: half the base delay is fixed, half is randomized. */
function jitteredDelayMs(baseMs: number, random: () => number): number {
	return baseMs / 2 + random() * (baseMs / 2);
}

async function releaseBody(response: Response): Promise<void> {
	if (!response.body) {
		return;
	}
	try {
		await response.body.cancel();
	} catch {
		// Already consumed/closed — nothing left to release.
	}
}

/**
 * Fetches with up to `RETRY_BASE_DELAYS_MS.length` retries on 429/5xx plus
 * any caller-supplied `extraRetryStatuses`. Returns the final response —
 * successful, non-retryable, or the last retryable failure after exhaustion
 * — for the caller to interpret.
 */
export async function fetchWithRetry(
	input: string,
	init: RequestInit,
	deps: RetryFetchDeps = defaultRetryDeps,
	extraRetryStatuses: readonly number[] = [],
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const response = await deps.fetch(input, init);

		const isLastAttempt = attempt >= RETRY_BASE_DELAYS_MS.length;
		if (
			!isRetryableStatus(response.status, extraRetryStatuses) ||
			isLastAttempt
		) {
			return response;
		}

		await releaseBody(response);
		const baseDelayMs = RETRY_BASE_DELAYS_MS[attempt] as number;
		await deps.sleep(jitteredDelayMs(baseDelayMs, deps.random), init.signal);
	}
}
