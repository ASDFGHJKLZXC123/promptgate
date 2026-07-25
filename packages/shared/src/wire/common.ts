import { z } from "zod";

/**
 * `response_format` (OpenAI chat/completions wire format). Anthropic
 * translation of this field (phase 2) targets json_object/json_schema only;
 * `text` is the OpenAI default and needs no translation.
 */
export const ResponseFormatSchema = z.discriminatedUnion("type", [
	z.looseObject({ type: z.literal("text") }),
	z.looseObject({ type: z.literal("json_object") }),
	z.looseObject({
		type: z.literal("json_schema"),
		json_schema: z.looseObject({
			name: z.string(),
			description: z.string().optional(),
			schema: z.record(z.string(), z.unknown()).optional(),
			strict: z.boolean().nullable().optional(),
		}),
	}),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const ReasoningEffortSchema = z.enum([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** OpenAI-compatible finish reasons accepted across the four provider adapters. */
export const FinishReasonSchema = z.enum([
	"stop",
	"length",
	"tool_calls",
	"content_filter",
	"function_call",
	"insufficient_system_resource",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;
