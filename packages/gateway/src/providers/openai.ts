import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { RetryFetchDeps } from "./retry.js";
import type { ProviderAdapter } from "./types.js";

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

/**
 * OpenAI adapter (BUILD_PLAYBOOK.md phase 1 step 6): pure passthrough to
 * `POST /v1/chat/completions` — swap auth, strip `pg_*` fields (§5.1), and
 * forward every other field verbatim (§3.2's "OpenAI-routed models: pure
 * passthrough"). Streaming is out of scope until phase 2. Thin wrapper
 * around the shared OpenAI-compatible core (`openai-compatible.ts`, step 10)
 * supplying OpenAI's endpoint and credential.
 */
export function createOpenAiAdapter(
	options: OpenAiAdapterOptions,
): ProviderAdapter {
	return createOpenAiCompatibleAdapter({
		name: "openai",
		label: "OpenAI",
		url: OPENAI_CHAT_COMPLETIONS_URL,
		apiKey: options.apiKey,
		missingKeyMessage: "OPENAI_API_KEY is not configured.",
		retryDeps: options.retryDeps,
	});
}
