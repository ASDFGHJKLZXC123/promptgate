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

/**
 * Thrown when a streaming provider's SSE transcript violates the
 * OpenAI-compatible contract (BUILD_PLAYBOOK.md phase 2 step 3): malformed
 * JSON, a wrong `chat.completion.chunk` identity, invalid or
 * duplicate/missing terminal usage, a frame after `[DONE]`, a missing
 * `[DONE]`, or a truncated stream. If it surfaces before any bytes reach the
 * client the pipeline maps it to a safe `provider_error` JSON envelope; once
 * streaming has started the pipeline closes the stream and marks the request
 * `provider_error`. The `message` is always client-safe and never echoes the
 * offending upstream payload.
 */
export class StreamContractError extends Error {
	readonly provider: ProviderName;

	constructor(provider: ProviderName, message: string) {
		super(message);
		this.name = "StreamContractError";
		this.provider = provider;
	}
}

/**
 * Thrown by an adapter whose streaming path is not implemented yet — currently
 * only Anthropic, whose SSE translation lands in phase 2 step 4. The pipeline
 * maps this to a safe 501 `provider_error` so a configured Anthropic streaming
 * request fails cleanly instead of crashing (BUILD_PLAYBOOK.md phase 2 step 3).
 */
export class StreamNotImplementedError extends Error {
	readonly provider: ProviderName;

	constructor(provider: ProviderName, message: string) {
		super(message);
		this.name = "StreamNotImplementedError";
		this.provider = provider;
	}
}
