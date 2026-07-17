import {
	type ChatRequest,
	type ChatResponse,
	ChatResponseSchema,
	stripPgFields,
} from "@promptgate/shared";

import { ProviderConfigError, ProviderError } from "./provider-error.js";
import {
	defaultRetryDeps,
	fetchWithRetry,
	type RetryFetchDeps,
} from "./retry.js";
import type { ProviderAdapter, SseChunk } from "./types.js";

const OPENAI_CHAT_COMPLETIONS_URL =
	"https://api.openai.com/v1/chat/completions";

export interface OpenAiAdapterOptions {
	/**
	 * The configured OpenAI key, or `undefined` when `OPENAI_API_KEY` isn't
	 * set — providers are optional at boot (IMPLEMENTATION_GUIDE.md §12).
	 * Left to the caller to resolve from `config.ts` so this module never
	 * touches process env directly.
	 */
	apiKey: string | undefined;
	retryDeps?: RetryFetchDeps;
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
 * OpenAI adapter (BUILD_PLAYBOOK.md phase 1 step 6): pure passthrough to
 * `POST /v1/chat/completions` — swap auth, strip `pg_*` fields (§5.1), and
 * forward every other field verbatim (§3.2's "OpenAI-routed models: pure
 * passthrough"). Streaming is out of scope until phase 2.
 */
export function createOpenAiAdapter(
	options: OpenAiAdapterOptions,
): ProviderAdapter {
	const retryDeps = options.retryDeps ?? defaultRetryDeps;

	return {
		name: "openai",

		async complete(
			req: ChatRequest,
			signal: AbortSignal,
		): Promise<ChatResponse> {
			if (!options.apiKey) {
				throw new ProviderConfigError(
					"openai",
					"OPENAI_API_KEY is not configured.",
				);
			}

			const body = stripPgFields(req);
			const response = await fetchWithRetry(
				OPENAI_CHAT_COMPLETIONS_URL,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${options.apiKey}`,
					},
					body: JSON.stringify(body),
					signal,
				},
				retryDeps,
			);

			if (!response.ok) {
				throw new ProviderError(
					"openai",
					response.status,
					await readErrorBody(response),
					`OpenAI request failed with status ${response.status}.`,
				);
			}

			return ChatResponseSchema.parse(await response.json());
		},

		stream(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<SseChunk> {
			throw new Error(
				"OpenAI streaming is not implemented until Phase 2 (BUILD_PLAYBOOK.md).",
			);
		},
	};
}
