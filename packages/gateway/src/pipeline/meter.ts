import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import type Database from "better-sqlite3";

import { findCurrentPricing } from "../providers/pricing.dao.js";

export interface MeterResult {
	inputTokens: number;
	outputTokens: number;
	costMicroUsd: number;
	costEstimated: boolean;
}

/**
 * Defensible chars/4 estimator (IMPLEMENTATION_GUIDE.md §3.5) used only when
 * the provider response omits `usage` — never as the primary token source.
 */
function estimateTokensFromChars(charCount: number): number {
	return Math.ceil(charCount / 4);
}

function messageContentLength(
	content: ChatRequest["messages"][number]["content"],
): number {
	if (typeof content === "string") {
		return content.length;
	}
	if (Array.isArray(content)) {
		return JSON.stringify(content).length;
	}
	return 0;
}

function estimatePromptTokens(req: ChatRequest): number {
	const chars = req.messages.reduce(
		(total, message) => total + messageContentLength(message.content),
		0,
	);
	return estimateTokensFromChars(chars);
}

function estimateCompletionTokens(response: ChatResponse): number {
	const chars = response.choices.reduce(
		(total, choice) => total + messageContentLength(choice.message.content),
		0,
	);
	return estimateTokensFromChars(chars);
}

/**
 * Prices the input side of a request (IMPLEMENTATION_GUIDE.md §3.5, extended
 * by BUILD_PLAYBOOK.md phase 1 step 9's cache-split metering, 2026-07-25):
 * when the provider reported a validated cache split AND the model's pricing
 * row has a cached-input rate, price the cache-hit and cache-miss components
 * separately (each rounded before summing, same as the output formula below).
 * DeepSeek reports the explicit hit/miss pair; Gemini reports
 * `prompt_tokens_details.cached_tokens`, from which the miss count is derived.
 * Otherwise all `inputTokens` use the ordinary input rate.
 */
function priceInputTokens(
	usage: ChatResponse["usage"],
	inputTokens: number,
	pricing: NonNullable<ReturnType<typeof findCurrentPricing>>,
): number {
	const detailedCacheHitTokens = usage?.prompt_tokens_details?.cached_tokens;
	const cacheHitTokens =
		usage?.prompt_cache_hit_tokens ?? detailedCacheHitTokens;
	const cacheMissTokens =
		usage?.prompt_cache_miss_tokens ??
		(detailedCacheHitTokens === undefined
			? undefined
			: inputTokens - detailedCacheHitTokens);
	if (
		cacheHitTokens !== undefined &&
		cacheMissTokens !== undefined &&
		pricing.cached_input_micro_usd_per_mtok !== null
	) {
		return (
			Math.round(
				(cacheHitTokens * pricing.cached_input_micro_usd_per_mtok) / 1_000_000,
			) +
			Math.round(
				(cacheMissTokens * pricing.input_micro_usd_per_mtok) / 1_000_000,
			)
		);
	}

	return Math.round(
		(inputTokens * pricing.input_micro_usd_per_mtok) / 1_000_000,
	);
}

/**
 * Meters a completed non-streaming exchange (BUILD_PLAYBOOK.md phase 1 step
 * 7): exact tokens from provider `usage` when present, otherwise the
 * chars/4 estimate with `costEstimated` set so dashboards can distinguish
 * them. Cost uses the date-effective pricing row and the integer
 * micro-USD formula from IMPLEMENTATION_GUIDE.md §3.5 — `Math.round` is
 * applied per-component before summing, matching the playbook's formula
 * exactly.
 */
export function meterUsage(
	db: Database.Database,
	model: string,
	req: ChatRequest,
	response: ChatResponse,
): MeterResult {
	const pricing = findCurrentPricing(db, model);
	if (!pricing) {
		throw new Error(
			`No effective model_pricing row for "${model}" — resolveProvider should have rejected this request first.`,
		);
	}

	const costEstimated = response.usage === undefined;
	const inputTokens =
		response.usage?.prompt_tokens ?? estimatePromptTokens(req);
	const outputTokens =
		response.usage?.completion_tokens ?? estimateCompletionTokens(response);

	const costMicroUsd =
		priceInputTokens(response.usage, inputTokens, pricing) +
		Math.round((outputTokens * pricing.output_micro_usd_per_mtok) / 1_000_000);

	return { inputTokens, outputTokens, costMicroUsd, costEstimated };
}
