import type { ProviderName } from "./types.js";

/**
 * Preserves the exact upstream status and body after retries are exhausted
 * (or on a non-retryable failure) so the pipeline (step 7) can map this to
 * the OpenAI `provider_error` envelope (IMPLEMENTATION_GUIDE.md §3.6)
 * without re-deriving anything from the adapter.
 */
export class ProviderError extends Error {
	readonly provider: ProviderName;
	readonly status: number;
	readonly body: unknown;

	constructor(
		provider: ProviderName,
		status: number,
		body: unknown,
		message: string,
	) {
		super(message);
		this.name = "ProviderError";
		this.provider = provider;
		this.status = status;
		this.body = body;
	}
}

/**
 * Thrown when a provider adapter is invoked without its required API key
 * configured. Provider keys are optional at boot (IMPLEMENTATION_GUIDE.md
 * §12) — this only surfaces once a request actually needs that provider,
 * before any upstream request is made, and never carries the (absent) key
 * value.
 */
export class ProviderConfigError extends Error {
	readonly provider: ProviderName;

	constructor(provider: ProviderName, message: string) {
		super(message);
		this.name = "ProviderConfigError";
		this.provider = provider;
	}
}
