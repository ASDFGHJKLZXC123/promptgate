import type { ChatRequest, ChatResponse } from "@promptgate/shared";

export const PROVIDER_NAMES = [
	"openai",
	"anthropic",
	"gemini",
	"deepseek",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * One frame of a translated OpenAI `chat.completion.chunk` SSE stream
 * (IMPLEMENTATION_GUIDE.md §3.3). Phase 2 adapters produce these: OpenAI's
 * OpenAI-compatible adapters tee-parse forwarded upstream bytes into frames;
 * Anthropic's adapter builds one frame per translated event
 * (`message_start` → role chunk, `content_block_delta` → content delta, …,
 * `message_stop` → finish + usage + the `[DONE]` sentinel).
 *
 * Design choice (phase 1, smallest forward-compatible shape): `data` carries
 * the already-serialized SSE `data:` payload — either a JSON
 * `chat.completion.chunk` object or the literal `[DONE]` sentinel — rather
 * than a structured chunk object. This keeps the adapter contract decoupled
 * from a specific chunk JSON schema (not yet defined in `@promptgate/shared`)
 * while still letting the pipeline know when the stream ends via `done`,
 * without string-comparing `data`. The pipeline frames the payload as
 * `data: ${data}\n\n` without reserializing it; phase 2 owns any tee-parsing
 * needed for `first_token_ms`/usage capture.
 */
export interface SseChunk {
	data: string;
	done: boolean;
}

/**
 * The provider seam (IMPLEMENTATION_GUIDE.md §3.2). `stream` is exercised
 * starting in phase 2; phase 1 only needs the interface shape to exist so
 * `openai.ts` (step 6) can implement it.
 *
 * `name` was widened to the human-approved four-provider scope
 * (BUILD_PLAYBOOK.md phase 1 step 9, 2026-07-25): `gemini` and `deepseek`
 * are added to the type only — their adapters/routing arrive in steps
 * 10–12, not here.
 */
export interface ProviderAdapter {
	name: ProviderName;
	complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
	stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk>;
}
