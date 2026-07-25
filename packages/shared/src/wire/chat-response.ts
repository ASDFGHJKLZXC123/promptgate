import { z } from "zod";
import { FinishReasonSchema } from "./common.js";
import { ChatMessageSchema } from "./message.js";

/**
 * Normalized token usage returned by the approved providers (§3.5 — the
 * source of truth for metering). Extra breakdown fields
 * (prompt_tokens_details, ...) pass
 * through unvalidated.
 *
 * `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` (BUILD_PLAYBOOK.md
 * phase 1 step 9, human-approved four-provider scope amendment 2026-07-25)
 * are an optional pair reported by providers that split cached vs. uncached
 * input pricing (e.g. DeepSeek): both present or both absent, and when
 * present they must sum to `prompt_tokens` — `meterUsage` trusts that
 * invariant rather than re-deriving it.
 */
export const ChatUsageSchema = z
	.looseObject({
		prompt_tokens: z.number().int().nonnegative(),
		completion_tokens: z.number().int().nonnegative(),
		total_tokens: z.number().int().nonnegative(),
		prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
		prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
	})
	.refine(
		(usage) =>
			(usage.prompt_cache_hit_tokens === undefined) ===
			(usage.prompt_cache_miss_tokens === undefined),
		{
			message:
				"prompt_cache_hit_tokens and prompt_cache_miss_tokens must be provided together.",
		},
	)
	.refine(
		(usage) =>
			usage.prompt_cache_hit_tokens === undefined ||
			usage.prompt_cache_miss_tokens === undefined ||
			usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens ===
				usage.prompt_tokens,
		{
			message:
				"prompt_cache_hit_tokens + prompt_cache_miss_tokens must equal prompt_tokens.",
		},
	);
export type ChatUsage = z.infer<typeof ChatUsageSchema>;

export const ChatChoiceSchema = z.looseObject({
	index: z.number().int().nonnegative(),
	message: ChatMessageSchema,
	finish_reason: FinishReasonSchema.nullable(),
});
export type ChatChoice = z.infer<typeof ChatChoiceSchema>;

/**
 * POST /v1/chat/completions response body (non-streaming;
 * IMPLEMENTATION_GUIDE.md §5.1). `usage` is optional here because a
 * provider hiccup can omit it — the metering pipeline falls back to an
 * estimate in that case (§3.5), it is not a validation failure.
 */
export const ChatResponseSchema = z.looseObject({
	id: z.string(),
	object: z.string(),
	created: z.number().int().nonnegative(),
	model: z.string(),
	choices: z.array(ChatChoiceSchema),
	usage: ChatUsageSchema.optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
