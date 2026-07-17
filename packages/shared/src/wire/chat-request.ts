import { z } from "zod";
import { ReasoningEffortSchema, ResponseFormatSchema } from "./common.js";
import { ChatMessageSchema } from "./message.js";
import { PgExtensionFieldsSchema } from "./pg-extensions.js";

/**
 * POST /v1/chat/completions request body (IMPLEMENTATION_GUIDE.md §5.1).
 * Only the fields PromptGate actively reads are typed; everything else a
 * client sends (tools, seed, n, logit_bias, ...) passes through unvalidated
 * so the OpenAI-routed adapter can forward it verbatim (§3.2).
 */
export const ChatRequestSchema = z
	.looseObject({
		model: z.string().min(1),
		messages: z.array(ChatMessageSchema),
		temperature: z.number().min(0).max(2).optional(),
		top_p: z.number().min(0).max(1).optional(),
		max_tokens: z.number().int().positive().optional(),
		stream: z.boolean().optional(),
		stop: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
		response_format: ResponseFormatSchema.optional(),
		reasoning_effort: ReasoningEffortSchema.optional(),
	})
	.extend(PgExtensionFieldsSchema.shape);

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
