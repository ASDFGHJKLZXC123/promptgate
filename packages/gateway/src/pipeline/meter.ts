import type { ChatRequest, ChatResponse, ChatUsage } from "@promptgate/shared";
import type Database from "better-sqlite3";

import {
	findCurrentPricing,
	type ModelPricingRow,
} from "../providers/pricing.dao.js";

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
 * Gemini's OpenAI-compatible response can report visible candidates in
 * `completion_tokens` while `total_tokens` also includes hidden thinking
 * output. Google bills candidates + thinking at the output rate, so Gemini's
 * billable output is the reconciled total minus prompt input. Other approved
 * providers already include reasoning inside `completion_tokens`.
 */
function exactOutputTokens(
	usage: NonNullable<ChatResponse["usage"]>,
	pricing: ModelPricingRow,
): number {
	return pricing.provider === "gemini"
		? usage.total_tokens - usage.prompt_tokens
		: usage.completion_tokens;
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
	pricing: ModelPricingRow,
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

function requirePricing(db: Database.Database, model: string): ModelPricingRow {
	const pricing = findCurrentPricing(db, model);
	if (!pricing) {
		throw new Error(
			`No effective model_pricing row for "${model}" — resolveProvider should have rejected this request first.`,
		);
	}
	return pricing;
}

/**
 * Prices an exact usage report (IMPLEMENTATION_GUIDE.md §3.5): provider-
 * specific output normalization (Gemini's hidden-thinking total), the
 * cache-aware input split (DeepSeek hit/miss, Gemini cached_tokens), and the
 * ordinary output rate — each component rounded before summing. Shared by the
 * non-streaming and streaming paths so both apply the identical rules.
 */
function meterExactUsage(
	usage: ChatUsage,
	pricing: ModelPricingRow,
): MeterResult {
	const inputTokens = usage.prompt_tokens;
	const outputTokens = exactOutputTokens(usage, pricing);
	const costMicroUsd =
		priceInputTokens(usage, inputTokens, pricing) +
		Math.round((outputTokens * pricing.output_micro_usd_per_mtok) / 1_000_000);
	return { inputTokens, outputTokens, costMicroUsd, costEstimated: false };
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
	const pricing = requirePricing(db, model);
	if (response.usage !== undefined) {
		return meterExactUsage(response.usage, pricing);
	}

	const inputTokens = estimatePromptTokens(req);
	const outputTokens = estimateCompletionTokens(response);
	const costMicroUsd =
		priceInputTokens(undefined, inputTokens, pricing) +
		Math.round((outputTokens * pricing.output_micro_usd_per_mtok) / 1_000_000);
	return { inputTokens, outputTokens, costMicroUsd, costEstimated: true };
}

/**
 * Meters a completed stream from its captured terminal usage chunk
 * (BUILD_PLAYBOOK.md phase 2 step 3). Streaming always fails closed without a
 * terminal usage chunk, so there is no estimate fallback here — the exact
 * provider-specific Gemini/DeepSeek rules apply, identical to the non-streaming
 * exact path.
 */
export function meterStreamUsage(
	db: Database.Database,
	model: string,
	usage: ChatUsage,
): MeterResult {
	return meterExactUsage(usage, requirePricing(db, model));
}

/**
 * Meters a stream that ended without a terminal provider usage report, whether
 * from a client disconnect or a post-header provider/contract failure. The
 * only output we can responsibly estimate is text actually emitted to the
 * client; hidden reasoning and tool arguments deliberately do not get invented.
 */
export function meterAbortedStream(
	db: Database.Database,
	model: string,
	req: ChatRequest,
	emittedVisibleChars: number,
): MeterResult {
	const pricing = requirePricing(db, model);
	const inputTokens = estimatePromptTokens(req);
	const outputTokens = estimateTokensFromChars(emittedVisibleChars);
	const costMicroUsd =
		priceInputTokens(undefined, inputTokens, pricing) +
		Math.round((outputTokens * pricing.output_micro_usd_per_mtok) / 1_000_000);
	return { inputTokens, outputTokens, costMicroUsd, costEstimated: true };
}
