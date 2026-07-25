import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { RetryFetchDeps } from "./retry.js";
import type { ProviderAdapter } from "./types.js";

const DEEPSEEK_CHAT_COMPLETIONS_URL =
	"https://api.deepseek.com/v1/chat/completions";

export interface DeepSeekAdapterOptions {
	/**
	 * The configured DeepSeek key, or `undefined` when `DEEPSEEK_API_KEY`
	 * isn't set — providers are optional at boot (IMPLEMENTATION_GUIDE.md
	 * §3.2) and only required once this adapter is actually invoked. Left to
	 * the caller to resolve from `config.ts` so this module never touches
	 * process env directly.
	 */
	apiKey: string | undefined;
	retryDeps?: RetryFetchDeps;
}

/**
 * DeepSeek adapter (BUILD_PLAYBOOK.md phase 1 step 10): the official
 * OpenAI-compatible passthrough to `POST /v1/chat/completions` — swap auth,
 * strip `pg_*` fields (§5.1), and forward every other caller-supplied field
 * verbatim, including `thinking` (§3.2: "do not silently enable/disable
 * reasoning"). `ChatUsageSchema` (`@promptgate/shared`) already validates
 * and preserves the optional `prompt_cache_hit_tokens`/
 * `prompt_cache_miss_tokens` pair so step 9's cache-aware metering can apply
 * DeepSeek's split pricing. Streaming is out of scope until Phase 2. Thin
 * wrapper around the shared OpenAI-compatible core (`openai-compatible.ts`)
 * supplying DeepSeek's endpoint and credential.
 */
export function createDeepSeekAdapter(
	options: DeepSeekAdapterOptions,
): ProviderAdapter {
	return createOpenAiCompatibleAdapter({
		name: "deepseek",
		label: "DeepSeek",
		url: DEEPSEEK_CHAT_COMPLETIONS_URL,
		apiKey: options.apiKey,
		missingKeyMessage: "DEEPSEEK_API_KEY is not configured.",
		retryDeps: options.retryDeps,
	});
}
