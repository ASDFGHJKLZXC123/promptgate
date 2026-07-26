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
 * Thrown when a caller's request cannot be safely translated into a provider's
 * native contract — e.g. an Anthropic-routed message carries content the
 * translation table (§3.2) doesn't support (BUILD_PLAYBOOK.md phase 2 step 2).
 * The pipeline maps this to an OpenAI `invalid_request_error` at HTTP 400
 * rather than sending malformed data upstream. `message` is always
 * client-safe: it is composed by the adapter, never echoes upstream bodies or
 * secrets, and describes the offending shape without reproducing its content.
 */
export class ProviderRequestError extends Error {
	readonly provider: ProviderName;

	constructor(provider: ProviderName, message: string) {
		super(message);
		this.name = "ProviderRequestError";
		this.provider = provider;
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
