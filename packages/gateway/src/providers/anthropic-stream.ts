import {
	type ChatRequest,
	type ChatUsage,
	ChatUsageSchema,
	type FinishReason,
} from "@promptgate/shared";
import { z } from "zod";

import { toAnthropicRequest } from "./anthropic-translate.js";
import {
	ProviderConfigError,
	ProviderError,
	StreamContractError,
} from "./provider-error.js";
import {
	defaultRetryDeps,
	fetchWithRetry,
	type RetryFetchDeps,
} from "./retry.js";
import {
	parseSseEvents,
	type SseEvent,
	SseTruncationError,
} from "./sse-parse.js";
import type { SseChunk } from "./types.js";

/**
 * Anthropic streaming adapter (BUILD_PLAYBOOK.md phase 2 step 4,
 * IMPLEMENTATION_GUIDE.md §3.2/§3.3). Anthropic is not OpenAI-compatible, so —
 * unlike `openai-compatible-stream.ts`, which forwards upstream bytes verbatim
 * — this translates the native event stream into OpenAI `chat.completion.chunk`
 * frames one event at a time:
 *
 *   message_start                       → one role chunk; stash input_tokens
 *   content_block_start   (text)        → open the block (emits nothing)
 *   content_block_start   (tool_use)    → open the block + one tool_calls chunk
 *   content_block_delta   (text_delta)  → one content-delta chunk
 *   content_block_delta   (input_json)  → one tool_calls arguments chunk
 *   content_block_stop                  → close the block (emits nothing)
 *   ping                                → emits nothing
 *   message_delta                       → stash stop_reason + output_tokens
 *   message_stop                        → finish chunk + usage chunk + [DONE]
 *
 * The terminal triple is withheld until a clean EOF proves no later data event
 * follows `message_stop`; on any lifecycle/ordering/coherence violation the
 * generator raises `StreamContractError` and fails closed, never presenting an
 * unfinished tool call as text or reporting a false success (§3.3). The request
 * is built by reusing `toAnthropicRequest` (identical to the step-2
 * non-streaming subset) plus `stream: true`, so tools, images, structured
 * outputs, fail-closed sampling, and the thinking-disabled semantics stay the
 * same. Thinking is disabled by that request, so any thinking/signature block
 * or delta — and any other unknown block/delta — fails closed.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Official Anthropic Messages contract, verified 2026-07-25 (ORCHESTRATOR.md). */
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicStreamConfig {
	apiKey: string | undefined;
	defaultMaxTokens: number;
	retryDeps?: RetryFetchDeps;
	/** Deterministic clock (epoch ms) for the synthesized OpenAI `created`. */
	now: () => number;
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
 * RFC 9110. Mirrors the check in `openai-compatible-stream.ts`; kept local so
 * this module owns its own transport guard.
 */
function isEventStream(contentType: string | null): boolean {
	if (!contentType) {
		return false;
	}
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "text/event-stream";
}

// --- Anthropic-side streaming event schemas (strict trust boundary, §3.2) ---

/**
 * A native token count this narrow adapter cannot account for or price yet
 * (cache creation/read, server-tool iteration input, disabled-thinking output).
 * Anthropic may report these as absent, `null`, or `0`; any nonzero value fails
 * closed until the relevant billing exists (aligned with step-2 non-streaming).
 */
const ZeroOnlyTokenCount = z
	.number()
	.int()
	.nonnegative()
	.max(0)
	.nullable()
	.optional();

/**
 * message_start: identity, empty content, null stop reason/sequence, and
 * start-state usage. Both `input_tokens` and `output_tokens` are required
 * nonnegative integers; `output_tokens` is retained only as the validated
 * cumulative start value (the billed output count comes from the cumulative
 * message_delta usage, §3.5).
 */
const MessageStartSchema = z.looseObject({
	type: z.literal("message_start"),
	message: z.looseObject({
		id: z.string().min(1),
		type: z.literal("message"),
		role: z.literal("assistant"),
		model: z.string().min(1),
		content: z.array(z.unknown()).max(0),
		stop_reason: z.null(),
		stop_sequence: z.null(),
		usage: z.looseObject({
			input_tokens: z.number().int().nonnegative(),
			output_tokens: z.number().int().nonnegative(),
			cache_creation_input_tokens: ZeroOnlyTokenCount,
			cache_read_input_tokens: ZeroOnlyTokenCount,
		}),
	}),
});

/** The `type` + `index` envelope shared by every content-block event. */
const ContentBlockEnvelopeSchema = z.looseObject({
	index: z.number().int().nonnegative(),
});

const TextBlockStartSchema = z.looseObject({
	type: z.literal("text"),
	text: z.literal(""),
});

const ToolUseBlockStartSchema = z.looseObject({
	type: z.literal("tool_use"),
	id: z.string().min(1),
	name: z.string().min(1),
	input: z.record(z.string(), z.unknown()),
});

const TextDeltaSchema = z.looseObject({
	type: z.literal("text_delta"),
	text: z.string(),
});

const InputJsonDeltaSchema = z.looseObject({
	type: z.literal("input_json_delta"),
	partial_json: z.string(),
});

/**
 * A refusal `stop_details` object (only coherent with the `refusal` stop_reason).
 * Requires the current official shape — `type: "refusal"`, a `category` that is a
 * nonempty string or null (a nonempty string rather than a closed enum keeps
 * future additive categories compatible), and a string-or-null `explanation` —
 * while staying loose for additive extra keys.
 */
const RefusalStopDetailsSchema = z.looseObject({
	type: z.literal("refusal"),
	category: z.string().min(1).nullable(),
	explanation: z.string().nullable(),
});

/**
 * message_delta.delta: the terminal stop signal plus native side-channel fields
 * this adapter must not silently trust.
 * - `stop_sequence` is a nonempty string only for the `stop_sequence` reason and
 *   `null` otherwise (coherence refine below);
 * - `container` (server-tool container state) may be absent or null only;
 * - `stop_details` may be absent/null, or a refusal details object that is only
 *   coherent with the `refusal` stop_reason.
 */
const MessageDeltaDeltaSchema = z
	.looseObject({
		stop_reason: z.string().nullable(),
		stop_sequence: z.string().nullable(),
		container: z.null().optional(),
		stop_details: z.union([z.null(), RefusalStopDetailsSchema]).optional(),
	})
	.refine(
		(delta) =>
			delta.stop_reason === "stop_sequence"
				? typeof delta.stop_sequence === "string" &&
					delta.stop_sequence.length > 0
				: delta.stop_sequence === null,
		{ message: "stop_sequence must be set only for the stop_sequence reason" },
	)
	.refine(
		(delta) =>
			delta.stop_details === undefined ||
			delta.stop_details === null ||
			delta.stop_reason === "refusal",
		{ message: "refusal stop_details require the refusal stop_reason" },
	);

/**
 * output_tokens_details: when present as an object, `thinking_tokens` must be
 * exactly the integer 0 (present, not null/absent) because thinking is disabled;
 * any positive value fails. Kept loose for additive extra keys.
 */
const OutputTokensDetailsSchema = z.looseObject({
	thinking_tokens: z.literal(0),
});

/**
 * message_delta.usage: `output_tokens` is the required cumulative count; every
 * other native counter must be absent/null/zero (or, for `server_tool_use`,
 * absent/null) because this adapter neither enables nor prices those paths.
 */
const MessageDeltaUsageSchema = z.looseObject({
	output_tokens: z.number().int().nonnegative(),
	input_tokens: ZeroOnlyTokenCount,
	cache_creation_input_tokens: ZeroOnlyTokenCount,
	cache_read_input_tokens: ZeroOnlyTokenCount,
	server_tool_use: z.null().optional(),
	output_tokens_details: z
		.union([z.null(), OutputTokensDetailsSchema])
		.optional(),
});

const MessageDeltaSchema = z.looseObject({
	type: z.literal("message_delta"),
	delta: MessageDeltaDeltaSchema,
	usage: MessageDeltaUsageSchema,
});

/**
 * Maps an Anthropic `stop_reason` to an OpenAI `finish_reason`, returning null
 * when the reason is unmapped or incoherent with whether any tool call was
 * emitted. This mirrors the step-2 non-streaming mapping in
 * `anthropic-translate.ts` (`mapStopReason`) exactly; it is duplicated here (not
 * shared) so the committed step-2 translator stays untouched, and it raises the
 * streaming-appropriate `StreamContractError` rather than the non-streaming
 * `ProviderError`.
 */
function mapStreamStopReason(
	stopReason: string | null,
	hasToolCalls: boolean,
): FinishReason | null {
	if ((stopReason === "tool_use") !== hasToolCalls) {
		return null;
	}
	switch (stopReason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "refusal":
			return "content_filter";
		default:
			return null;
	}
}

/**
 * One open content block being translated. A tool_use block accumulates every
 * `input_json_delta.partial_json` fragment in `args` so the concatenation can be
 * validated as a JSON object when the block closes.
 */
type OpenBlock =
	| { index: number; kind: "text" }
	| { index: number; kind: "tool_use"; toolIndex: number; args: string };

/**
 * Validates a tool call's accumulated `input_json_delta` payload at
 * content_block_stop: the concatenated fragments must parse to a non-null,
 * non-array JSON object. An empty accumulation (no fragments, or only empty
 * fragments), malformed JSON, or a scalar/array value fails closed — a partial
 * or non-object tool input must never be presented as a completed call.
 */
function validateToolInput(accumulated: string): void {
	if (accumulated.length === 0) {
		fail("Anthropic tool_use block closed with no input_json fragments.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(accumulated) as unknown;
	} catch {
		fail("Anthropic tool_use input did not concatenate to valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail("Anthropic tool_use input must be a JSON object.");
	}
}

interface ChunkIdentity {
	id: string;
	model: string;
	created: number;
}

function fail(message: string): never {
	throw new StreamContractError("anthropic", message);
}

function parseEventData(event: string | null, data: string): { type: string } {
	if (event === null) {
		fail("Anthropic stream event is missing its event name.");
	}
	let json: unknown;
	try {
		json = JSON.parse(data) as unknown;
	} catch {
		fail("Anthropic stream sent a malformed JSON event payload.");
	}
	if (
		typeof json !== "object" ||
		json === null ||
		typeof (json as { type?: unknown }).type !== "string"
	) {
		fail("Anthropic stream event payload is missing a string type.");
	}
	const typed = json as { type: string };
	// Event name and data.type must agree — an incoherent frame is fail-closed,
	// never trusted on either side.
	if (typed.type !== event) {
		fail("Anthropic stream event name and payload type disagree.");
	}
	return typed;
}

function frame(obj: unknown): SseChunk {
	return { data: JSON.stringify(obj), done: false };
}

function roleFrame(id: ChunkIdentity): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: "" },
				finish_reason: null,
			},
		],
		usage: null,
	});
}

function contentFrame(id: ChunkIdentity, text: string): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		usage: null,
	});
}

function toolCallStartFrame(
	id: ChunkIdentity,
	toolIndex: number,
	callId: string,
	name: string,
): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: toolIndex,
							id: callId,
							type: "function",
							function: { name, arguments: "" },
						},
					],
				},
				finish_reason: null,
			},
		],
		usage: null,
	});
}

function toolCallArgsFrame(
	id: ChunkIdentity,
	toolIndex: number,
	partialJson: string,
): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{ index: toolIndex, function: { arguments: partialJson } },
					],
				},
				finish_reason: null,
			},
		],
		usage: null,
	});
}

function finishFrame(id: ChunkIdentity, finishReason: FinishReason): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		usage: null,
	});
}

function usageFrame(id: ChunkIdentity, usage: ChatUsage): SseChunk {
	return frame({
		id: id.id,
		object: "chat.completion.chunk",
		created: id.created,
		model: id.model,
		choices: [],
		usage,
	});
}

/**
 * Pure event → OpenAI-frame state machine. Consumes the parsed `{event, data}`
 * stream from `parseSseEvents` and yields already-serialized `SseChunk`s. The
 * terminal finish/usage/[DONE] triple is only emitted after the event stream
 * ends cleanly following a valid `message_stop`, so a truncation or a stray
 * post-stop event fails the exchange before any success signal reaches the
 * client (§3.3 blocker-2 analogue).
 */
async function* translateEvents(
	events: AsyncGenerator<SseEvent>,
	created: number,
): AsyncGenerator<SseChunk> {
	let identity: ChunkIdentity | undefined;
	let inputTokens: number | undefined;
	// Cumulative output tokens: seeded from the validated message_start start
	// state and advanced by each message_delta; the latest value is billed (§3.5).
	let cumulativeOutputTokens: number | undefined;
	let finishReason: FinishReason | undefined;
	let openBlock: OpenBlock | null = null;
	let nextBlockIndex = 0;
	let toolCallCount = 0;
	const toolIds = new Set<string>();
	// ≥1 message_delta has arrived (content blocks may no longer open).
	let sawMessageDelta = false;
	// The single supported non-null terminal stop_reason has arrived.
	let sawTerminalStopReason = false;
	let sawMessageStop = false;

	for await (const { event, data } of events) {
		if (sawMessageStop) {
			// message_stop is terminal: nothing but a clean EOF may follow it.
			fail("Anthropic stream produced an event after message_stop.");
		}
		const payload = parseEventData(event, data);

		switch (payload.type) {
			case "message_start": {
				if (identity !== undefined) {
					fail("Anthropic stream sent more than one message_start.");
				}
				const parsed = MessageStartSchema.safeParse(payload);
				if (!parsed.success) {
					fail("Anthropic message_start failed contract validation.");
				}
				const message = parsed.data.message;
				identity = { id: message.id, model: message.model, created };
				inputTokens = message.usage.input_tokens;
				cumulativeOutputTokens = message.usage.output_tokens;
				yield roleFrame(identity);
				break;
			}

			case "content_block_start": {
				if (identity === undefined || sawMessageDelta) {
					fail("Anthropic content_block_start arrived out of order.");
				}
				if (openBlock !== null) {
					fail(
						"Anthropic content_block_start before the previous block closed.",
					);
				}
				const envelope = ContentBlockEnvelopeSchema.safeParse(payload);
				const block = (payload as { content_block?: unknown }).content_block;
				if (
					!envelope.success ||
					envelope.data.index !== nextBlockIndex ||
					typeof block !== "object" ||
					block === null
				) {
					fail("Anthropic content_block_start is malformed or misindexed.");
				}
				const blockType = (block as { type?: unknown }).type;
				if (blockType === "text") {
					if (!TextBlockStartSchema.safeParse(block).success) {
						fail("Anthropic text content_block_start is malformed.");
					}
					openBlock = { index: nextBlockIndex, kind: "text" };
				} else if (blockType === "tool_use") {
					const tool = ToolUseBlockStartSchema.safeParse(block);
					if (!tool.success) {
						fail("Anthropic tool_use content_block_start is malformed.");
					}
					// The start block only carries the empty placeholder input; the real
					// arguments stream as input_json_delta fragments. A non-empty object
					// here would be silently dropped, so reject it.
					if (Object.keys(tool.data.input).length !== 0) {
						fail(
							"Anthropic tool_use content_block_start input must be the empty placeholder object.",
						);
					}
					if (toolIds.has(tool.data.id)) {
						fail("Anthropic stream repeated a tool_use id.");
					}
					toolIds.add(tool.data.id);
					const toolIndex = toolCallCount++;
					openBlock = {
						index: nextBlockIndex,
						kind: "tool_use",
						toolIndex,
						args: "",
					};
					yield toolCallStartFrame(
						identity,
						toolIndex,
						tool.data.id,
						tool.data.name,
					);
				} else if (
					blockType === "thinking" ||
					blockType === "redacted_thinking"
				) {
					// Thinking is disabled by the request; a thinking block must never
					// be dropped or surfaced as text.
					fail(
						"Anthropic streamed a thinking block despite thinking disabled.",
					);
				} else {
					fail("Anthropic streamed an unsupported content block type.");
				}
				nextBlockIndex++;
				break;
			}

			case "content_block_delta": {
				const envelope = ContentBlockEnvelopeSchema.safeParse(payload);
				if (
					identity === undefined ||
					openBlock === null ||
					!envelope.success ||
					envelope.data.index !== openBlock.index
				) {
					fail("Anthropic content_block_delta references no open block.");
				}
				const delta = (payload as { delta?: unknown }).delta;
				if (openBlock.kind === "text") {
					const text = TextDeltaSchema.safeParse(delta);
					if (!text.success) {
						fail("Anthropic text block received a non-text delta.");
					}
					yield contentFrame(identity, text.data.text);
				} else {
					const json = InputJsonDeltaSchema.safeParse(delta);
					if (!json.success) {
						fail("Anthropic tool_use block received a non-input_json delta.");
					}
					// Accumulate the fragment for whole-input validation at block stop,
					// but still forward each original fragment incrementally.
					openBlock.args += json.data.partial_json;
					yield toolCallArgsFrame(
						identity,
						openBlock.toolIndex,
						json.data.partial_json,
					);
				}
				break;
			}

			case "content_block_stop": {
				const envelope = ContentBlockEnvelopeSchema.safeParse(payload);
				if (
					openBlock === null ||
					!envelope.success ||
					envelope.data.index !== openBlock.index
				) {
					fail("Anthropic content_block_stop does not match the open block.");
				}
				if (openBlock.kind === "tool_use") {
					validateToolInput(openBlock.args);
				}
				openBlock = null;
				break;
			}

			case "ping":
				// Keep-alive: no state change, nothing emitted.
				break;

			case "message_delta": {
				// Anthropic emits one or more message_delta events after every content
				// block closes, carrying cumulative usage and (on the last) the
				// terminal stop_reason.
				if (
					identity === undefined ||
					cumulativeOutputTokens === undefined ||
					openBlock !== null
				) {
					fail("Anthropic message_delta arrived out of order.");
				}
				if (sawTerminalStopReason) {
					fail(
						"Anthropic sent a message_delta after the terminal stop_reason.",
					);
				}
				const parsed = MessageDeltaSchema.safeParse(payload);
				if (!parsed.success) {
					fail("Anthropic message_delta failed contract validation.");
				}
				const nextOutput = parsed.data.usage.output_tokens;
				if (nextOutput < cumulativeOutputTokens) {
					fail("Anthropic message_delta reported decreasing output_tokens.");
				}
				cumulativeOutputTokens = nextOutput;
				sawMessageDelta = true;
				const stopReason = parsed.data.delta.stop_reason;
				if (stopReason !== null) {
					const mapped = mapStreamStopReason(stopReason, toolCallCount > 0);
					if (mapped === null) {
						fail("Anthropic message_delta carried an unsupported stop_reason.");
					}
					finishReason = mapped;
					sawTerminalStopReason = true;
				}
				break;
			}

			case "message_stop": {
				if (
					identity === undefined ||
					openBlock !== null ||
					!sawTerminalStopReason ||
					inputTokens === undefined ||
					cumulativeOutputTokens === undefined ||
					finishReason === undefined
				) {
					fail(
						"Anthropic message_stop arrived before the stream was complete.",
					);
				}
				sawMessageStop = true;
				break;
			}

			case "error":
				// An upstream error event fails closed without echoing its message.
				throw new StreamContractError(
					"anthropic",
					"Anthropic stream delivered an error event.",
				);

			default:
				fail("Anthropic stream delivered an unsupported event type.");
		}
	}

	// A clean EOF is required after a valid message_stop before any success
	// signal is emitted. Absent it, the exchange fails closed with no [DONE].
	if (
		!sawMessageStop ||
		identity === undefined ||
		inputTokens === undefined ||
		cumulativeOutputTokens === undefined ||
		finishReason === undefined
	) {
		fail("Anthropic stream ended before a clean message_stop.");
	}

	const usage = ChatUsageSchema.parse({
		prompt_tokens: inputTokens,
		completion_tokens: cumulativeOutputTokens,
		total_tokens: inputTokens + cumulativeOutputTokens,
	});
	yield finishFrame(identity, finishReason);
	yield usageFrame(identity, usage);
	yield { data: "[DONE]", done: true };
}

/**
 * Streams the Anthropic Messages endpoint (BUILD_PLAYBOOK.md phase 2 step 4).
 * Requires `ANTHROPIC_API_KEY` only here, at invocation. Fetches with the shared
 * bounded 429/5xx retry (so retries happen before any body streaming), validates
 * the success Content-Type before consuming the body or committing headers, then
 * translates the native event stream into OpenAI chunk frames. All failures fail
 * closed as typed errors, never leaking the upstream body.
 */
export async function* streamAnthropic(
	config: AnthropicStreamConfig,
	req: ChatRequest,
	signal: AbortSignal,
): AsyncGenerator<SseChunk> {
	if (!config.apiKey) {
		throw new ProviderConfigError(
			"anthropic",
			"ANTHROPIC_API_KEY is not configured.",
		);
	}

	const body = {
		...toAnthropicRequest(req, config.defaultMaxTokens),
		stream: true as const,
	};
	const response = await fetchWithRetry(
		ANTHROPIC_MESSAGES_URL,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": config.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				accept: "text/event-stream",
			},
			body: JSON.stringify(body),
			signal,
		},
		config.retryDeps ?? defaultRetryDeps,
	);

	if (!response.ok) {
		throw new ProviderError(
			"anthropic",
			response.status,
			await readErrorBody(response),
			`Anthropic request failed with status ${response.status}.`,
		);
	}
	// Validate the success Content-Type BEFORE consuming the body or committing
	// any client headers. A wrong-MIME HTTP 200 (e.g. a buffered JSON error page)
	// is a safe pre-header provider error; the body is cancelled unread.
	if (!isEventStream(response.headers.get("content-type"))) {
		await response.body?.cancel().catch(() => {});
		throw new StreamContractError(
			"anthropic",
			"Anthropic streaming response had an unexpected content-type.",
		);
	}
	if (!response.body) {
		throw new StreamContractError(
			"anthropic",
			"Anthropic streaming response had no body.",
		);
	}

	const created = Math.floor(config.now() / 1000);
	const events = parseSseEvents(response.body, {
		pendingEventSentinel: "message_stop",
	});
	try {
		yield* translateEvents(events, created);
	} catch (error) {
		if (error instanceof SseTruncationError) {
			throw new StreamContractError(
				"anthropic",
				"Anthropic SSE stream was truncated.",
			);
		}
		throw error;
	}
}
