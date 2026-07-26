import { z } from "zod";

/**
 * `stream_options` on a streaming chat request (OpenAI wire format). PromptGate
 * MERGES this field before forwarding — it always forces
 * `include_usage: true` so the terminal usage chunk arrives for metering
 * (IMPLEMENTATION_GUIDE.md §3.3) — so it is a trust boundary that must be
 * validated (ORCHESTRATOR.md quality bars). Caller-supplied fields are
 * preserved via the loose object; only malformed shapes (a non-object, or a
 * non-boolean `include_usage`) are rejected, safely, before any upstream fetch.
 */
export const StreamOptionsSchema = z.looseObject({
	include_usage: z.boolean().optional(),
});
export type StreamOptions = z.infer<typeof StreamOptionsSchema>;
