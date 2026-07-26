import { z } from "zod";
import { ChatUsageSchema } from "./chat-response.js";
import { FinishReasonSchema } from "./common.js";

/**
 * One OpenAI `chat.completion.chunk` frame from a streaming
 * `POST /v1/chat/completions` response (IMPLEMENTATION_GUIDE.md §3.3). The
 * OpenAI-compatible providers (OpenAI, Gemini, DeepSeek) each stream these;
 * PromptGate validates the chunk identity and the fields it consumes while
 * letting provider-specific extras pass through via loose objects — DeepSeek's
 * `reasoning_content`/`logprobs`/`system_fingerprint`, and the OpenAI/Gemini
 * `*_tokens_details` breakdowns are all preserved verbatim on the forwarded
 * wire bytes (BUILD_PLAYBOOK.md phase 2 step 3).
 */

/**
 * A per-choice delta. `content` is the visible text increment; a nonempty
 * `content` is what marks the first token for latency metering. DeepSeek's
 * `reasoning_content` is a separate hidden-thinking channel and is deliberately
 * NOT `content`, so it never counts as the first token (phase 2 step 3).
 */
export const ChatChunkDeltaSchema = z.looseObject({
	role: z.string().optional(),
	content: z.string().nullish(),
	reasoning_content: z.string().nullish(),
});
export type ChatChunkDelta = z.infer<typeof ChatChunkDeltaSchema>;

export const ChatChunkChoiceSchema = z.looseObject({
	index: z.number().int().nonnegative(),
	delta: ChatChunkDeltaSchema,
	finish_reason: FinishReasonSchema.nullish(),
});
export type ChatChunkChoice = z.infer<typeof ChatChunkChoiceSchema>;

/**
 * A streamed chunk. Nonterminal chunks in the authored contracts carry
 * `usage: null` (or omit it) with a populated `choices` array; the single
 * terminal usage chunk requested via `stream_options.include_usage` carries
 * empty `choices` and a validated `ChatUsageSchema`. This schema only validates
 * that `usage`, when present and non-null, is well-formed — the terminal
 * ordering rules (exactly one usage chunk, empty choices, before `[DONE]`) are
 * enforced by the streaming adapter, which fails closed on violation.
 */
export const ChatCompletionChunkSchema = z.looseObject({
	id: z.string(),
	object: z.literal("chat.completion.chunk"),
	created: z.number().int().nonnegative(),
	model: z.string(),
	choices: z.array(ChatChunkChoiceSchema),
	usage: ChatUsageSchema.nullish(),
});
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;
