import type { ChatRequest, ChatResponse } from "@promptgate/shared";

import {
	fromAnthropicResponse,
	toAnthropicRequest,
} from "./anthropic-translate.js";
import {
	ProviderConfigError,
	ProviderError,
	StreamNotImplementedError,
} from "./provider-error.js";
import {
	defaultRetryDeps,
	fetchWithRetry,
	type RetryFetchDeps,
} from "./retry.js";
import type { ProviderAdapter, SseChunk } from "./types.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Official Anthropic Messages contract, verified 2026-07-25 (ORCHESTRATOR.md). */
const ANTHROPIC_VERSION = "2023-06-01";
/** Fallback used only if the caller doesn't inject config.DEFAULT_MAX_TOKENS. */
const DEFAULT_MAX_TOKENS_FALLBACK = 1024;

export interface AnthropicAdapterOptions {
	/**
	 * The configured Anthropic key, or `undefined` when `ANTHROPIC_API_KEY`
	 * isn't set — every provider key is optional at boot
	 * (IMPLEMENTATION_GUIDE.md §3.2) and only required once this adapter is
	 * actually invoked. Left to the caller to resolve from `config.ts` so this
	 * module never touches process env directly.
	 */
	apiKey: string | undefined;
	/**
	 * `config.DEFAULT_MAX_TOKENS`, injected so translation can supply Anthropic's
	 * required `max_tokens` when the client omits it (§3.2). Defaults to the
	 * config default when omitted so the adapter stays self-contained in tests.
	 */
	defaultMaxTokens?: number;
	retryDeps?: RetryFetchDeps;
	/**
	 * Deterministic clock (epoch ms) for the synthesized OpenAI `created` field,
	 * which Anthropic responses don't carry. Defaults to `Date.now`.
	 */
	now?: () => number;
}

async function readErrorBody(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

/**
 * Anthropic non-streaming adapter (BUILD_PLAYBOOK.md phase 2 step 2). Unlike
 * the OpenAI-compatible providers, Anthropic uses a native contract, so this
 * translates the request into `POST /v1/messages` (`x-api-key`,
 * `anthropic-version`, `content-type` headers), reuses the shared bounded
 * 429/5xx retry helper, and translates the response back into the shared
 * OpenAI shape (`anthropic-translate.ts`). A missing key is a safe
 * `ProviderConfigError` before any request; an untranslatable request shape is
 * a typed `ProviderRequestError` (HTTP 400) instead of malformed upstream
 * data. Streaming stays a stub until phase 2 step 4.
 */
export function createAnthropicAdapter(
	options: AnthropicAdapterOptions,
): ProviderAdapter {
	const retryDeps = options.retryDeps ?? defaultRetryDeps;
	const defaultMaxTokens =
		options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_FALLBACK;
	const now = options.now ?? (() => Date.now());

	return {
		name: "anthropic",

		async complete(
			req: ChatRequest,
			signal: AbortSignal,
		): Promise<ChatResponse> {
			if (!options.apiKey) {
				throw new ProviderConfigError(
					"anthropic",
					"ANTHROPIC_API_KEY is not configured.",
				);
			}

			const body = toAnthropicRequest(req, defaultMaxTokens);
			const response = await fetchWithRetry(
				ANTHROPIC_MESSAGES_URL,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": options.apiKey,
						"anthropic-version": ANTHROPIC_VERSION,
					},
					body: JSON.stringify(body),
					signal,
				},
				retryDeps,
			);

			if (!response.ok) {
				throw new ProviderError(
					"anthropic",
					response.status,
					await readErrorBody(response),
					`Anthropic request failed with status ${response.status}.`,
				);
			}

			return fromAnthropicResponse(
				await response.json(),
				Math.floor(now() / 1000),
			);
		},

		stream(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<SseChunk> {
			// Anthropic SSE translation lands in phase 2 step 4; until then a
			// streaming request must fail cleanly, never crash the pipeline. The
			// typed error maps to a safe 501 (BUILD_PLAYBOOK.md phase 2 step 3).
			throw new StreamNotImplementedError(
				"anthropic",
				"Anthropic streaming is not implemented until Phase 2 step 4 (BUILD_PLAYBOOK.md).",
			);
		},
	};
}
