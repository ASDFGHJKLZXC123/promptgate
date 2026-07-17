import { z } from "zod";

/**
 * Chat message shape (OpenAI chat/completions wire format). Only `role`,
 * `content`, and `name` are validated fields; anything else a client sends
 * (tool_calls, tool_call_id, ...) passes through untouched — tool-call
 * translation is out of scope until phase 2.
 */

export const ChatRoleSchema = z.enum([
	"developer",
	"system",
	"user",
	"assistant",
	"tool",
]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

const ChatContentPartSchema = z.looseObject({
	type: z.string(),
});

export const ChatMessageContentSchema = z.union([
	z.string(),
	z.array(ChatContentPartSchema),
	z.null(),
]);
export type ChatMessageContent = z.infer<typeof ChatMessageContentSchema>;

export const ChatMessageSchema = z.looseObject({
	role: ChatRoleSchema,
	content: ChatMessageContentSchema.optional(),
	name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
