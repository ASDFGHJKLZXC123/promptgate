import {
	ChatCompletionChunkSchema,
	type ChatRequest,
	type ChatUsage,
	StreamOptionsSchema,
	stripPgFields,
} from "@promptgate/shared";

import {
	ProviderConfigError,
	ProviderError,
	ProviderRequestError,
	StreamContractError,
} from "./provider-error.js";
import { fetchWithRetry, type RetryFetchDeps } from "./retry.js";
import { parseSseData, SseTruncationError } from "./sse-parse.js";
import type { ProviderName, SseChunk } from "./types.js";

/** The literal SSE `data:` payload that terminates an OpenAI-compatible stream. */
const DONE_PAYLOAD = "[DONE]";

export interface CompatibleStreamConfig {
	name: ProviderName;
	label: string;
	url: string;
	apiKey: string | undefined;
	missingKeyMessage: string;
	retryDeps: RetryFetchDeps;
	extraRetryStatuses: readonly number[];
}

async function readErrorBody(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

/**
 * True when `contentType` is the `text/event-stream` media type — matched
 * case-insensitively and tolerant of parameters (e.g. `; charset=utf-8`), per
 * RFC 9110 media-type rules (BUILD_PLAYBOOK.md phase 2 step 3, blocker 7).
 */
function isEventStream(contentType: string | null): boolean {
	if (!contentType) {
		return false;
	}
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "text/event-stream";
}

/**
 * Builds the forwarded streaming request body (BUILD_PLAYBOOK.md phase 2 step
 * 3): strip every `pg_*` field (§5.1), force `stream: true`, and inject
 * `stream_options.include_usage: true` while preserving any valid caller
 * `stream_options` fields. All other compatible request fields — Gemini's
 * `extra_body.google`, DeepSeek's `thinking`, seeds, tools, … — pass through
 * verbatim (§3.2). `stream_options` is the one field PromptGate merges, so it
 * is validated with Zod; a malformed caller value is a client error (400)
 * raised before any upstream fetch, never a silent coercion.
 */
export function buildStreamRequestBody(
	req: ChatRequest,
	provider: ProviderName,
): Record<string, unknown> {
	const base = stripPgFields(req);
	const parsedOptions = StreamOptionsSchema.safeParse(
		base.stream_options ?? {},
	);
	if (!parsedOptions.success) {
		throw new ProviderRequestError(
			provider,
			"Invalid stream_options: it must be an object with a boolean include_usage.",
		);
	}
	return {
		...base,
		stream: true,
		stream_options: { ...parsedOptions.data, include_usage: true },
	};
}

/**
 * Validates one SSE `data:` payload as an OpenAI `chat.completion.chunk`
 * (identity + the fields PromptGate consumes) while retaining provider-specific
 * unknown fields via the shared loose-object schema. Fails closed on malformed
 * JSON or a chunk-identity/usage violation, never leaking the payload.
 */
function parseChunk(provider: ProviderName, payload: string) {
	let json: unknown;
	try {
		json = JSON.parse(payload);
	} catch {
		throw new StreamContractError(
			provider,
			"Upstream sent a malformed JSON stream chunk.",
		);
	}
	const result = ChatCompletionChunkSchema.safeParse(json);
	if (!result.success) {
		throw new StreamContractError(
			provider,
			"Upstream stream chunk failed chat.completion.chunk validation.",
		);
	}
	return result.data;
}

/**
 * Streams an OpenAI-compatible provider (OpenAI, Gemini, DeepSeek). Requires
 * the provider key only here, at invocation. Fetches with the shared bounded
 * retry (so 429/5xx retries happen before any body streaming), then parses the
 * SSE transcript and forwards each validated `data:` payload promptly as an
 * `SseChunk`, preserving the provider's original JSON bytes and emitting
 * exactly one terminal `[DONE]`.
 *
 * Fail-closed transcript rules (each raises `StreamContractError`, closing the
 * stream without leaking the upstream body):
 * - a frame after `[DONE]`;
 * - `[DONE]` with no preceding terminal usage chunk (missing usage);
 * - a second usage-bearing chunk (duplicate usage);
 * - a usage-bearing chunk whose `choices` are non-empty;
 * - the byte stream ending without `[DONE]` (missing DONE) or mid-line
 *   (truncated SSE).
 */
export async function* streamOpenAiCompatible(
	config: CompatibleStreamConfig,
	req: ChatRequest,
	signal: AbortSignal,
): AsyncGenerator<SseChunk> {
	if (!config.apiKey) {
		throw new ProviderConfigError(config.name, config.missingKeyMessage);
	}

	const body = buildStreamRequestBody(req, config.name);
	const response = await fetchWithRetry(
		config.url,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal,
		},
		config.retryDeps,
		config.extraRetryStatuses,
	);

	if (!response.ok) {
		throw new ProviderError(
			config.name,
			response.status,
			await readErrorBody(response),
			`${config.label} request failed with status ${response.status}.`,
		);
	}
	// Validate the success Content-Type BEFORE consuming the body or committing
	// any client headers (blocker 7). A wrong-MIME HTTP 200 (e.g. a buffered
	// JSON error page) is a safe pre-header provider error; the body is cancelled
	// unread so nothing leaks.
	if (!isEventStream(response.headers.get("content-type"))) {
		await response.body?.cancel().catch(() => {});
		throw new StreamContractError(
			config.name,
			`${config.label} streaming response had an unexpected content-type.`,
		);
	}
	if (!response.body) {
		throw new StreamContractError(
			config.name,
			`${config.label} streaming response had no body.`,
		);
	}

	let sawUsage = false;
	let sawDone = false;
	try {
		for await (const payload of parseSseData(response.body, {
			pendingSentinel: DONE_PAYLOAD,
		})) {
			if (payload === DONE_PAYLOAD) {
				if (sawDone) {
					throw new StreamContractError(
						config.name,
						"Upstream sent more than one [DONE] sentinel.",
					);
				}
				if (!sawUsage) {
					throw new StreamContractError(
						config.name,
						"Upstream stream ended without a terminal usage chunk.",
					);
				}
				sawDone = true;
				// Buffer the sentinel — do NOT yield it until a clean EOF proves no
				// later data frame exists (blocker 2). A client must never receive
				// [DONE] and then have the exchange marked failed.
				continue;
			}
			if (sawDone) {
				throw new StreamContractError(
					config.name,
					"Upstream sent a data frame after [DONE].",
				);
			}
			if (sawUsage) {
				// The usage chunk is terminal/final under the authored contract:
				// nothing but [DONE] (and comments, which never surface here) may
				// follow it.
				throw new StreamContractError(
					config.name,
					"Upstream sent a data frame after the terminal usage chunk.",
				);
			}
			const chunk = parseChunk(config.name, payload);
			if (chunk.usage != null) {
				if (chunk.choices.length !== 0) {
					throw new StreamContractError(
						config.name,
						"Terminal usage chunk must have empty choices.",
					);
				}
				sawUsage = true;
			}
			yield { data: payload, done: false };
		}
	} catch (error) {
		if (error instanceof SseTruncationError) {
			throw new StreamContractError(
				config.name,
				"Upstream SSE stream was truncated.",
			);
		}
		throw error;
	}

	if (!sawDone) {
		throw new StreamContractError(
			config.name,
			"Upstream SSE stream ended without [DONE].",
		);
	}
	// Clean EOF with a buffered sentinel: emit exactly one terminal [DONE], last.
	yield { data: DONE_PAYLOAD, done: true };
}

export interface StreamChunkReading {
	/** The nonempty visible `delta.content`, or null (role/empty/reasoning). */
	contentDelta: string | null;
	/** Total visible `delta.content` characters across every choice. */
	visibleContentChars: number;
	/** The terminal usage, when this chunk carries it; otherwise null. */
	usage: ChatUsage | null;
}

/**
 * Tee-reads an already-forwarded chunk payload for the pipeline's metering and
 * first-token timing (IMPLEMENTATION_GUIDE.md §3.3). The adapter has already
 * validated and fail-closed on this payload, so this is a typed, defensive
 * read — not a second trust boundary. First-token content is a nonempty
 * `delta.content`; a role chunk (`content: ""`), an empty delta, and DeepSeek's
 * `reasoning_content` all read as no content, so they never mark the first
 * token. EVERY choice is inspected, not just `choices[0]`, so a preserved
 * `n > 1` cannot hide the earliest visible delta (BUILD_PLAYBOOK.md phase 2
 * step 3, blocker 4).
 */
export function readStreamChunk(payload: string): StreamChunkReading {
	let json: unknown;
	try {
		json = JSON.parse(payload);
	} catch {
		return { contentDelta: null, visibleContentChars: 0, usage: null };
	}
	const result = ChatCompletionChunkSchema.safeParse(json);
	if (!result.success) {
		return { contentDelta: null, visibleContentChars: 0, usage: null };
	}
	const chunk = result.data;
	let contentDelta: string | null = null;
	let visibleContentChars = 0;
	for (const choice of chunk.choices) {
		const content = choice.delta.content;
		if (typeof content === "string" && content.length > 0) {
			visibleContentChars += content.length;
			if (contentDelta === null) {
				contentDelta = content;
			}
		}
	}
	return { contentDelta, visibleContentChars, usage: chunk.usage ?? null };
}
