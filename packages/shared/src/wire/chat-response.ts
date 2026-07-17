import { z } from "zod";
import { FinishReasonSchema } from "./common.js";
import { ChatMessageSchema } from "./message.js";

/**
 * Token usage as returned by both providers (§3.5 — the source of truth for
 * metering). Extra breakdown fields (prompt_tokens_details, ...) pass
 * through unvalidated.
 */
export const ChatUsageSchema = z.looseObject({
	prompt_tokens: z.number().int().nonnegative(),
	completion_tokens: z.number().int().nonnegative(),
	total_tokens: z.number().int().nonnegative(),
});
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
