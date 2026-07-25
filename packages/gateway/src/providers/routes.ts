import type Database from "better-sqlite3";
import { type OpenAIErrorResponse, openAIError } from "../errors.js";
import { findCurrentPricing } from "./pricing.dao.js";
import type { ProviderName } from "./types.js";

interface ProviderRoute {
	match: RegExp;
	provider: ProviderName;
}

/** Model-prefix → provider map (IMPLEMENTATION_GUIDE.md §3.1). */
const ROUTES: readonly ProviderRoute[] = [
	{ match: /^claude-/, provider: "anthropic" },
	{ match: /^(gpt-|o[0-9])/, provider: "openai" },
	{ match: /^gemini-/, provider: "gemini" },
	{ match: /^deepseek-/, provider: "deepseek" },
];

export type ResolveProviderResult =
	| { ok: true; provider: ProviderName }
	| { ok: false; statusCode: 400; error: OpenAIErrorResponse };

function matchProvider(model: string): ProviderName | undefined {
	return ROUTES.find((route) => route.match.test(model))?.provider;
}

function unknownModelError(model: string): OpenAIErrorResponse {
	return openAIError(`Unknown model: "${model}".`, "unknown_model");
}

/**
 * Resolves a requested model to its provider, per §3.1: the model must both
 * match a routed prefix AND have an active `model_pricing` row naming that
 * same provider, otherwise metering would go unpriced or be billed under the
 * wrong provider's rate. All three failure modes (unrouted prefix, routed
 * but unpriced model, routed but priced under a different provider) collapse
 * into the same `unknown_model` OpenAI error envelope (§3.6) — the caller
 * (the pipeline route, step 7) just checks `result.ok` and forwards
 * `result.error` verbatim; it never has to build the error itself or
 * distinguish why the model was rejected.
 */
export function resolveProvider(
	db: Database.Database,
	model: string,
): ResolveProviderResult {
	const provider = matchProvider(model);
	if (!provider) {
		return {
			ok: false,
			statusCode: 400,
			error: unknownModelError(model),
		};
	}

	const pricing = findCurrentPricing(db, model);
	if (!pricing || pricing.provider !== provider) {
		return {
			ok: false,
			statusCode: 400,
			error: unknownModelError(model),
		};
	}

	return { ok: true, provider };
}
