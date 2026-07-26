import {
	type ChatRequest,
	type ChatResponse,
	ChatResponseSchema,
	stripPgFields,
} from "@promptgate/shared";

import { streamOpenAiCompatible } from "./openai-compatible-stream.js";
import { ProviderConfigError, ProviderError } from "./provider-error.js";
import {
	defaultRetryDeps,
	fetchWithRetry,
	type RetryFetchDeps,
} from "./retry.js";
import type { ProviderAdapter, ProviderName, SseChunk } from "./types.js";

export interface OpenAiCompatibleAdapterConfig {
	name: ProviderName;
	/** Display label used in error/stream-stub messages (e.g. "OpenAI"). */
	label: string;
	url: string;
	/**
	 * The configured provider key, or `undefined` when its env var isn't set
	 * — every provider key is optional at boot (IMPLEMENTATION_GUIDE.md §3.2)
	 * and only required once its adapter is actually invoked.
	 */
	apiKey: string | undefined;
	missingKeyMessage: string;
	retryDeps?: RetryFetchDeps;
	/**
	 * Additional HTTP statuses to retry beyond the shared 429/5xx default
	 * (BUILD_PLAYBOOK.md phase 1 step 11) — e.g. Gemini adds 408 per Google's
	 * official retry guidance. Omitted by OpenAI/DeepSeek, so their retry
	 * behavior is unchanged.
	 */
	extraRetryStatuses?: readonly number[];
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
 * Shared request core for providers that implement the official OpenAI
 * chat/completions contract (IMPLEMENTATION_GUIDE.md §3.2): swap auth, strip
 * `pg_*` fields (§5.1), forward every other caller-supplied field verbatim
 * (including fields PromptGate doesn't itself understand, e.g. DeepSeek's
 * `thinking` and Gemini's `extra_body.google`), and validate the successful
 * response against the shared `ChatResponseSchema`. `openai.ts`,
 * `deepseek.ts`, and `gemini.ts` are thin endpoint/credential wrappers
 * around this. Streaming is out of scope until Phase 2.
 */
export function createOpenAiCompatibleAdapter(
	config: OpenAiCompatibleAdapterConfig,
): ProviderAdapter {
	const retryDeps = config.retryDeps ?? defaultRetryDeps;

	return {
		name: config.name,

		async complete(
			req: ChatRequest,
			signal: AbortSignal,
		): Promise<ChatResponse> {
			if (!config.apiKey) {
				throw new ProviderConfigError(config.name, config.missingKeyMessage);
			}

			const body = stripPgFields(req);
			const response = await fetchWithRetry(
				config.url,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${config.apiKey}`,
					},
					body: JSON.stringify(body),
					signal,
				},
				retryDeps,
				config.extraRetryStatuses,
			);

			if (!response.ok) {
				throw new ProviderError(
					config.name,
					response.status,
					await readErrorBody(response),
					`${config.label} request failed with status ${response.status}.`,
				);
			}

			return ChatResponseSchema.parse(await response.json());
		},

		stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk> {
			return streamOpenAiCompatible(
				{
					name: config.name,
					label: config.label,
					url: config.url,
					apiKey: config.apiKey,
					missingKeyMessage: config.missingKeyMessage,
					retryDeps,
					extraRetryStatuses: config.extraRetryStatuses ?? [],
				},
				req,
				signal,
			);
		},
	};
}
