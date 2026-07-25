import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { RetryFetchDeps } from "./retry.js";
import type { ProviderAdapter } from "./types.js";

const GEMINI_CHAT_COMPLETIONS_URL =
	"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/**
 * Google's official retry guidance for this endpoint includes 408 (Request
 * Timeout) alongside the usual 429/5xx (BUILD_PLAYBOOK.md phase 1 step 11) —
 * unlike OpenAI/DeepSeek, which only retry 429/5xx via the shared default.
 */
const GEMINI_EXTRA_RETRY_STATUSES: readonly number[] = [408];

export interface GeminiAdapterOptions {
	/**
	 * The configured Gemini key, or `undefined` when `GEMINI_API_KEY` isn't
	 * set — providers are optional at boot (IMPLEMENTATION_GUIDE.md §3.2) and
	 * only required once this adapter is actually invoked. Left to the caller
	 * to resolve from `config.ts` so this module never touches process env
	 * directly.
	 */
	apiKey: string | undefined;
	retryDeps?: RetryFetchDeps;
}

/**
 * Gemini adapter (BUILD_PLAYBOOK.md phase 1 step 11): Google's official
 * OpenAI-compatible passthrough to `POST /v1beta/openai/chat/completions` —
 * swap auth, strip `pg_*` fields (§5.1), and forward every other
 * caller-supplied field verbatim. Streaming is out of scope until Phase 2.
 * Thin wrapper around the shared OpenAI-compatible core
 * (`openai-compatible.ts`) supplying Gemini's endpoint, credential, and
 * extra 408 retry status — kept as its own module (rather than folded into
 * `openai.ts`/`deepseek.ts`) so provider-specific translation has a home if
 * the compatible contract ever diverges (§3.2).
 */
export function createGeminiAdapter(
	options: GeminiAdapterOptions,
): ProviderAdapter {
	return createOpenAiCompatibleAdapter({
		name: "gemini",
		label: "Gemini",
		url: GEMINI_CHAT_COMPLETIONS_URL,
		apiKey: options.apiKey,
		missingKeyMessage: "GEMINI_API_KEY is not configured.",
		retryDeps: options.retryDeps,
		extraRetryStatuses: GEMINI_EXTRA_RETRY_STATUSES,
	});
}
