import { Buffer } from "node:buffer";
import {
	type ChatRequest,
	type ChatResponse,
	ChatResponseSchema,
	type FinishReason,
} from "@promptgate/shared";
import { z } from "zod";

import { ProviderError, ProviderRequestError } from "./provider-error.js";

/**
 * Pure OpenAI ⇆ Anthropic translation for the non-streaming Messages API
 * (BUILD_PLAYBOOK.md phase 2 step 2, IMPLEMENTATION_GUIDE.md §3.2). Kept
 * separate from the transport in `anthropic.ts` so every mapping rule is
 * unit-testable offline against the committed fixtures. Anthropic is not
 * OpenAI-compatible, so — unlike `openai-compatible.ts` — the request is built
 * field-by-field from exactly the fields the translation table covers and the
 * response is reassembled into the shared OpenAI shape.
 *
 * Supported behaviour-changing fields are never silently dropped. Sampling
 * parameters are handled against current Anthropic (Sonnet 5) semantics, which
 * reject non-default `temperature`/`top_p`: an exact no-op default is omitted;
 * any other value is a typed client error (400) rather than a silent drop or a
 * blind forward that the model would 400 on. `stop` becomes `stop_sequences`
 * and `reasoning_effort` becomes `output_config.effort`.
 *
 * Claude Sonnet 5 enables adaptive thinking by default and can otherwise return
 * signature-bearing `thinking` blocks. The OpenAI chat message shape cannot
 * preserve those blocks across a tool-call round trip, so this compatibility
 * adapter explicitly sends `thinking: {type:"disabled"}`. Anthropic documents
 * that `output_config.effort` still controls text and tool-call token spend when
 * extended thinking is disabled.
 *
 * Two failure modes are distinguished:
 * - A request shape the translation cannot represent is a caller error, raised
 *   as a client-safe `ProviderRequestError` (HTTP 400) before any upstream call.
 * - An upstream response that violates the Anthropic contract is a
 *   `ProviderError` (HTTP 502) that fails closed and never echoes the body.
 */

// --- OpenAI-side request schemas (the fields ChatRequestSchema leaves loose) ---

/** OpenAI function-tool definition — the only tool kind Anthropic translation supports. */
const OpenAiFunctionToolSchema = z.looseObject({
	type: z.literal("function"),
	function: z.looseObject({
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
		strict: z.boolean().nullable().optional(),
	}),
});

/** OpenAI `tool_choice`: a string mode or a forced named function. */
const OpenAiToolChoiceSchema = z.union([
	z.enum(["auto", "required", "none"]),
	z.looseObject({
		type: z.literal("function"),
		function: z.looseObject({ name: z.string().min(1) }),
	}),
]);

/** Tools/tool_choice/parallel_tool_calls picked off the otherwise-loose request body. */
const AnthropicRoutedExtrasSchema = z.looseObject({
	tools: z.array(OpenAiFunctionToolSchema).optional(),
	tool_choice: OpenAiToolChoiceSchema.optional(),
	parallel_tool_calls: z.boolean().optional(),
});

/** An assistant `tool_call` — a function call whose arguments are a JSON string. */
const OpenAiToolCallSchema = z.looseObject({
	id: z.string().min(1),
	type: z.literal("function"),
	function: z.looseObject({
		name: z.string().min(1),
		arguments: z.string(),
	}),
});

const AssistantToolCallsSchema = z.looseObject({
	tool_calls: z.array(OpenAiToolCallSchema).optional(),
});

const ToolMessageSchema = z.looseObject({
	tool_call_id: z.string().min(1),
});

/** A text content part (`{type:"text", text}`) inside an array-shaped message content. */
const TextContentPartSchema = z.looseObject({
	type: z.literal("text"),
	text: z.string(),
});

/** A user `image_url` content part (`{type:"image_url", image_url:{url}}`). */
const ImageUrlPartSchema = z.looseObject({
	type: z.literal("image_url"),
	image_url: z.looseObject({
		url: z.string().min(1),
		detail: z.enum(["auto", "low", "high"]).optional(),
	}),
});

// --- Anthropic-side request shapes ---

interface AnthropicTextBlock {
	type: "text";
	text: string;
}
interface AnthropicImageBlock {
	type: "image";
	source:
		| { type: "url"; url: string }
		| { type: "base64"; media_type: string; data: string };
}
interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
}
type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
	strict?: boolean;
}

type AnthropicToolChoice =
	| { type: "auto"; disable_parallel_tool_use?: boolean }
	| { type: "any"; disable_parallel_tool_use?: boolean }
	| { type: "none" }
	| { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

interface AnthropicOutputConfig {
	format?: { type: "json_schema"; schema: Record<string, unknown> };
	effort?: AnthropicEffort;
}

export interface AnthropicRequest {
	model: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	thinking: { type: "disabled" };
	system?: string;
	stop_sequences?: string[];
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	output_config?: AnthropicOutputConfig;
}

/** Anthropic's supported image media types for inline (base64) sources. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/** `data:<media_type>;base64,<canonical-base64>` — canonical alphabet, padding only at the end. */
const DATA_URL_PATTERN =
	/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

function reject(message: string): never {
	throw new ProviderRequestError("anthropic", message);
}

/** Fails closed on an upstream contract violation (HTTP 502), never echoing the body. */
function rejectUpstream(message: string): never {
	throw new ProviderError("anthropic", 502, null, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOrReject<T>(
	schema: z.ZodType<T>,
	value: unknown,
	message: string,
): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		reject(message);
	}
	return result.data;
}

/** The declared `type` of an array content part, or undefined if it isn't a typed object. */
function partType(part: unknown): string | undefined {
	if (isPlainObject(part) && typeof part.type === "string") {
		return part.type;
	}
	return undefined;
}

/** Translates a user `image_url` part into an Anthropic `image` block (§3.2). */
function translateImagePart(part: unknown): AnthropicImageBlock {
	const parsed = parseOrReject(
		ImageUrlPartSchema,
		part,
		"Anthropic-routed image_url part is malformed.",
	);
	const url = parsed.image_url.url;
	const detail = parsed.image_url.detail;
	if (detail !== undefined && detail !== "auto") {
		reject(
			"Anthropic-routed image detail must be auto or omitted; low/high have no Anthropic equivalent.",
		);
	}

	if (/^https?:\/\//i.test(url)) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			reject("Anthropic-routed image URL is malformed.");
		}
		if (
			(parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
			parsedUrl.hostname.length === 0
		) {
			reject("Anthropic-routed image URL is malformed.");
		}
		return { type: "image", source: { type: "url", url } };
	}
	if (url.startsWith("data:")) {
		const match = DATA_URL_PATTERN.exec(url);
		if (!match) {
			reject("Anthropic-routed image data URL is malformed.");
		}
		const mediaType = match[1].toLowerCase();
		const data = match[2];
		if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
			reject("Anthropic-routed image has an unsupported media type.");
		}
		if (data.length === 0 || data.length % 4 !== 0) {
			reject("Anthropic-routed image has invalid base64 data.");
		}
		if (Buffer.from(data, "base64").toString("base64") !== data) {
			reject("Anthropic-routed image has non-canonical base64 data.");
		}
		return {
			type: "image",
			source: { type: "base64", media_type: mediaType, data },
		};
	}
	reject("Anthropic-routed image_url must be an http(s) or data URL.");
}

/**
 * Translates OpenAI `user` message content (string, parts array, or null) into
 * Anthropic content blocks. Text parts become text blocks and `image_url`
 * parts become image blocks; any other part type is unsupported and rejected.
 */
function translateUserContent(content: unknown): AnthropicContentBlock[] {
	if (content === undefined || content === null) {
		return [];
	}
	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content }] : [];
	}
	if (Array.isArray(content)) {
		return content
			.map((part): AnthropicContentBlock => {
				const type = partType(part);
				if (type === "text") {
					return {
						type: "text",
						text: parseOrReject(
							TextContentPartSchema,
							part,
							"Anthropic-routed user text part is malformed.",
						).text,
					};
				}
				if (type === "image_url") {
					return translateImagePart(part);
				}
				return reject(
					"Anthropic-routed user message has an unsupported content part.",
				);
			})
			.filter((block) => block.type !== "text" || block.text.length > 0);
	}
	return reject("Anthropic-routed user content is not a supported shape.");
}

/**
 * Flattens text-only content (system/developer/assistant) into a string.
 * Images are only supported in user roles, so an image part here — or any other
 * non-text part — is rejected as content in an unsupported role.
 */
function textOnlyContent(content: unknown, role: string): string {
	if (content === undefined || content === null) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part): string => {
				const type = partType(part);
				if (type === "text") {
					return parseOrReject(
						TextContentPartSchema,
						part,
						`Anthropic-routed ${role} text part is malformed.`,
					).text;
				}
				if (type === "image_url") {
					return reject(
						`Anthropic-routed images are only supported in user messages, not ${role} messages.`,
					);
				}
				return reject(
					`Anthropic-routed ${role} message has an unsupported content part.`,
				);
			})
			.join("");
	}
	return reject(`Anthropic-routed ${role} content is not a supported shape.`);
}

/** Parses an assistant tool_call's JSON-string arguments; requires a plain object. */
function parseToolArguments(args: string): Record<string, unknown> {
	if (args.trim() === "") {
		reject(
			"Anthropic-routed assistant tool_call arguments must be a JSON object.",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(args) as unknown;
	} catch {
		reject(
			"Anthropic-routed assistant tool_call arguments must be valid JSON.",
		);
	}
	if (!isPlainObject(parsed)) {
		reject(
			"Anthropic-routed assistant tool_call arguments must be a JSON object.",
		);
	}
	return parsed;
}

/**
 * Validates that a run of tool-result messages coherently answers the
 * immediately preceding assistant `tool_calls`: every id appears exactly once,
 * with no unknown, duplicate, extra, or missing reference. Parallel tool
 * execution order is intentionally irrelevant because ids carry the linkage.
 */
function validateToolResults(expected: string[], resultIds: string[]): void {
	const expectedSet = new Set(expected);
	if (expectedSet.size !== expected.length) {
		reject("Anthropic-routed assistant tool_calls contain duplicate ids.");
	}
	if (resultIds.length > expected.length) {
		reject("Anthropic-routed tool results outnumber the assistant tool calls.");
	}
	const seen = new Set<string>();
	for (const id of resultIds) {
		if (!expectedSet.has(id)) {
			reject(
				"Anthropic-routed tool result references an unknown tool_call_id.",
			);
		}
		if (seen.has(id)) {
			reject(
				"Anthropic-routed tool result references a duplicate tool_call_id.",
			);
		}
		seen.add(id);
	}
	if (resultIds.length < expected.length) {
		reject("Anthropic-routed assistant tool call has no matching tool result.");
	}
}

/** Strict tool schemas require every object node to reject undeclared keys. */
function validateStrictToolSchema(schema: Record<string, unknown>): void {
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				visit(item);
			}
			return;
		}
		if (!isPlainObject(node)) {
			return;
		}

		const type = node.type;
		const isObjectSchema =
			type === "object" || (Array.isArray(type) && type.includes("object"));
		if (isObjectSchema && node.additionalProperties !== false) {
			reject(
				"Anthropic-routed strict tool schemas require additionalProperties:false on every object.",
			);
		}
		for (const value of Object.values(node)) {
			visit(value);
		}
	};

	visit(schema);
}

function translateTools(
	tools: z.infer<typeof OpenAiFunctionToolSchema>[],
): AnthropicTool[] {
	return tools.map((tool) => {
		const parameters = tool.function.parameters;
		let inputSchema: Record<string, unknown>;
		if (parameters === undefined) {
			inputSchema =
				tool.function.strict === true
					? { type: "object", additionalProperties: false }
					: { type: "object" };
		} else if (parameters.type === "object") {
			inputSchema = parameters;
		} else {
			return reject("Anthropic tool input_schema must be an object schema.");
		}
		if (tool.function.strict === true) {
			validateStrictToolSchema(inputSchema);
		}

		const translated: AnthropicTool = {
			name: tool.function.name,
			input_schema: inputSchema,
		};
		if (tool.function.description !== undefined) {
			translated.description = tool.function.description;
		}
		// Preserve function.strict — it is behaviour-changing and must not be dropped.
		if (typeof tool.function.strict === "boolean") {
			translated.strict = tool.function.strict;
		}
		return translated;
	});
}

function translateToolChoice(
	choice: z.infer<typeof OpenAiToolChoiceSchema>,
	toolNames: Set<string>,
): AnthropicToolChoice {
	if (choice === "auto") {
		return { type: "auto" };
	}
	if (choice === "required") {
		return { type: "any" };
	}
	if (choice === "none") {
		return { type: "none" };
	}
	if (!toolNames.has(choice.function.name)) {
		reject("Anthropic-routed tool_choice names a tool that is not defined.");
	}
	return { type: "tool", name: choice.function.name };
}

/**
 * `response_format` → Anthropic structured outputs (§3.2). `text` is the OpenAI
 * default and needs no translation; `json_object` maps to the open object
 * schema; `json_schema` forwards the client's schema and requires it to be an
 * actual object schema — it is never replaced with an open object.
 */
function translateResponseFormat(
	responseFormat: ChatRequest["response_format"],
): AnthropicOutputConfig["format"] | undefined {
	if (responseFormat === undefined || responseFormat.type === "text") {
		return undefined;
	}
	if (responseFormat.type === "json_object") {
		return { type: "json_schema", schema: { type: "object" } };
	}
	const schema = responseFormat.json_schema.schema;
	if (!isPlainObject(schema)) {
		reject(
			"Anthropic-routed json_schema response_format requires an object schema.",
		);
	}
	return { type: "json_schema", schema };
}

/** `reasoning_effort` → `output_config.effort`; `none`/`minimal` have no Anthropic equivalent. */
function translateReasoningEffort(
	effort: ChatRequest["reasoning_effort"],
): AnthropicEffort | undefined {
	if (effort === undefined) {
		return undefined;
	}
	if (effort === "none" || effort === "minimal") {
		reject(`Anthropic-routed reasoning_effort "${effort}" is not supported.`);
	}
	return effort;
}

function applySamplingAndStop(
	request: AnthropicRequest,
	req: ChatRequest,
): void {
	// stop → stop_sequences; omit null/absent, never silently drop a real value.
	const stop = req.stop;
	if (stop !== undefined && stop !== null) {
		const sequences = typeof stop === "string" ? [stop] : stop;
		if (sequences.length > 0) {
			if (sequences.length > 4) {
				reject("Anthropic-routed stop supports at most four sequences.");
			}
			if (sequences.some((sequence) => sequence.length === 0)) {
				reject("Anthropic-routed stop sequences must not be empty.");
			}
			request.stop_sequences = sequences;
		}
	}
	// Sonnet 5 rejects non-default temperature/top_p: omit the no-op default,
	// surface anything else as a client error instead of dropping it.
	if (req.temperature !== undefined && req.temperature !== 1) {
		reject(
			"Anthropic-routed temperature must be exactly 1 (the default) or omitted.",
		);
	}
	if (req.top_p !== undefined && req.top_p < 0.99) {
		reject("Anthropic-routed top_p must be at least 0.99 or omitted.");
	}
}

function applyTools(request: AnthropicRequest, req: ChatRequest): void {
	const extras = parseOrReject(
		AnthropicRoutedExtrasSchema,
		req,
		"Anthropic-routed tools or tool_choice are malformed.",
	);
	const tools = extras.tools ?? [];

	if (tools.length === 0) {
		if (extras.tool_choice !== undefined) {
			reject("Anthropic-routed tool_choice requires at least one tool.");
		}
		return;
	}

	const toolNames = new Set(tools.map((tool) => tool.function.name));
	if (toolNames.size !== tools.length) {
		reject("Anthropic-routed tools must have unique names.");
	}
	request.tools = translateTools(tools);

	let choice: AnthropicToolChoice | undefined =
		extras.tool_choice !== undefined
			? translateToolChoice(extras.tool_choice, toolNames)
			: undefined;
	// parallel_tool_calls:false → disable_parallel_tool_use:true, synthesizing an
	// auto choice to carry it when the caller supplied none. Anthropic's `none`
	// variant has no disable_parallel_tool_use field, and the flag is a no-op
	// when all tool calls are already forbidden.
	if (extras.parallel_tool_calls === false && choice?.type !== "none") {
		choice = {
			...(choice ?? { type: "auto" }),
			disable_parallel_tool_use: true,
		};
	}
	if (choice !== undefined) {
		request.tool_choice = choice;
	}
}

function applyOutputConfig(request: AnthropicRequest, req: ChatRequest): void {
	const format = translateResponseFormat(req.response_format);
	const effort = translateReasoningEffort(req.reasoning_effort);
	if (format === undefined && effort === undefined) {
		return;
	}
	const outputConfig: AnthropicOutputConfig = {};
	if (format !== undefined) {
		outputConfig.format = format;
	}
	if (effort !== undefined) {
		outputConfig.effort = effort;
	}
	request.output_config = outputConfig;
}

/**
 * Translates a validated OpenAI-shaped `ChatRequest` into an Anthropic Messages
 * request. `system`/`developer` messages are concatenated into the single
 * `system` param; `max_tokens` defaults to the injected value when absent;
 * assistant `tool_calls` become `tool_use` blocks and the tool messages that
 * answer them become one grouped `tool_result` user message (validated for
 * coherence first). Optional keys are only emitted when present.
 */
export function toAnthropicRequest(
	req: ChatRequest,
	defaultMaxTokens: number,
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	const systemParts: string[] = [];

	const source = req.messages;
	let index = 0;
	while (index < source.length) {
		const message = source[index];
		const role = message.role;

		if (role === "system" || role === "developer") {
			const text = textOnlyContent(message.content, role);
			if (text.length > 0) {
				systemParts.push(text);
			}
			index++;
			continue;
		}

		if (role === "user") {
			const blocks = translateUserContent(message.content);
			if (blocks.length === 0) {
				reject("Anthropic-routed user message has no supported content.");
			}
			messages.push({ role: "user", content: blocks });
			index++;
			continue;
		}

		if (role === "assistant") {
			const blocks: AnthropicContentBlock[] = [];
			const assistantText = textOnlyContent(message.content, "assistant");
			if (assistantText.length > 0) {
				blocks.push({ type: "text", text: assistantText });
			}

			const assistant = parseOrReject(
				AssistantToolCallsSchema,
				message,
				"Anthropic-routed assistant tool_calls are malformed.",
			);
			const toolCalls = assistant.tool_calls ?? [];
			for (const call of toolCalls) {
				blocks.push({
					type: "tool_use",
					id: call.id,
					name: call.function.name,
					input: parseToolArguments(call.function.arguments),
				});
			}
			if (blocks.length === 0) {
				reject("Anthropic-routed assistant message has no supported content.");
			}
			messages.push({ role: "assistant", content: blocks });
			index++;

			if (toolCalls.length > 0) {
				const expected = toolCalls.map((call) => call.id);
				const resultIds: string[] = [];
				const resultBlocks: AnthropicToolResultBlock[] = [];
				while (index < source.length && source[index].role === "tool") {
					const toolMessage = parseOrReject(
						ToolMessageSchema,
						source[index],
						"Anthropic-routed tool message requires a string tool_call_id.",
					);
					resultIds.push(toolMessage.tool_call_id);
					resultBlocks.push({
						type: "tool_result",
						tool_use_id: toolMessage.tool_call_id,
						content: textOnlyContent(source[index].content, "tool"),
					});
					index++;
				}
				validateToolResults(expected, resultIds);
				messages.push({ role: "user", content: resultBlocks });
			}
			continue;
		}

		// A `tool` message reached here is not preceded by an assistant tool call.
		reject(
			"Anthropic-routed tool result does not answer a preceding assistant tool call.",
		);
	}

	// The hoisted conversation must be non-empty (reject empty and system-only).
	if (messages.length === 0) {
		reject("Anthropic-routed request has no user or assistant messages.");
	}
	if (messages.at(-1)?.role !== "user") {
		reject(
			"Anthropic-routed requests must end with a user message; assistant prefilling is not supported by Claude Sonnet 5.",
		);
	}

	const request: AnthropicRequest = {
		model: req.model,
		messages,
		max_tokens: req.max_tokens ?? defaultMaxTokens,
		thinking: { type: "disabled" },
	};

	const systemText = systemParts.join("\n\n");
	if (systemText.length > 0) {
		request.system = systemText;
	}

	applySamplingAndStop(request, req);
	applyTools(request, req);
	applyOutputConfig(request, req);

	return request;
}

// --- Anthropic-side response schemas ---

const AnthropicResponseTextBlockSchema = z.looseObject({
	type: z.literal("text"),
	text: z.string(),
});

const AnthropicResponseToolUseBlockSchema = z.looseObject({
	type: z.literal("tool_use"),
	id: z.string().min(1),
	name: z.string().min(1),
	input: z.custom<Record<string, unknown>>((value) => isPlainObject(value), {
		message: "tool_use.input must be a JSON object",
	}),
});

/** Strict exact union — any other block type (e.g. `thinking`) fails closed. */
const AnthropicResponseBlockSchema = z.discriminatedUnion("type", [
	AnthropicResponseTextBlockSchema,
	AnthropicResponseToolUseBlockSchema,
]);

const AnthropicStopReasonSchema = z.enum([
	"end_turn",
	"max_tokens",
	"stop_sequence",
	"tool_use",
	"pause_turn",
	"refusal",
	"model_context_window_exceeded",
]);

const AnthropicResponseSchema = z.looseObject({
	id: z.string().min(1),
	type: z.literal("message"),
	role: z.literal("assistant"),
	model: z.string().min(1),
	content: z.array(AnthropicResponseBlockSchema),
	// Non-streaming Messages responses always carry a non-null stop reason.
	stop_reason: AnthropicStopReasonSchema,
	usage: z.looseObject({
		input_tokens: z.number().int().nonnegative(),
		output_tokens: z.number().int().nonnegative(),
		// Cache-aware billing doesn't exist yet, so any nonzero cache count fails
		// closed (absent or exactly zero are the only accepted values).
		cache_creation_input_tokens: z
			.number()
			.int()
			.nonnegative()
			.max(0)
			.optional(),
		cache_read_input_tokens: z.number().int().nonnegative().max(0).optional(),
	}),
});

interface OpenAiResponseToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * Maps Anthropic `stop_reason` to an OpenAI `finish_reason` (§3.2), failing
 * closed on unmapped reasons (`pause_turn`, `compaction`, null, unknown). Also
 * enforces the `tool_use` invariant: that reason appears if and only if the
 * response translated at least one tool call.
 */
function mapStopReason(
	stopReason: string | null,
	hasToolCalls: boolean,
): FinishReason {
	if ((stopReason === "tool_use") !== hasToolCalls) {
		rejectUpstream(
			"Anthropic stop_reason is incoherent with the response's tool_use blocks.",
		);
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
			return rejectUpstream("Anthropic returned an unsupported stop_reason.");
	}
}

/**
 * Translates a validated Anthropic Messages response into the shared OpenAI
 * `ChatResponse` shape. `text` blocks become `message.content`; `tool_use`
 * blocks become `message.tool_calls` with JSON-string arguments. A refusal has
 * no translated content, so its `content` is null. Usage is normalized with
 * `prompt_tokens` kept equal to `input_tokens`. A response that fails the strict
 * contract schema fails closed as a provider error (HTTP 502), never echoing
 * the upstream body. `createdAtSeconds` is injected so `created` is
 * deterministic in tests.
 */
export function fromAnthropicResponse(
	raw: unknown,
	createdAtSeconds: number,
): ChatResponse {
	const parsed = AnthropicResponseSchema.safeParse(raw);
	if (!parsed.success) {
		rejectUpstream("Anthropic response failed contract validation.");
	}
	const message = parsed.data;

	const textSegments: string[] = [];
	const toolCalls: OpenAiResponseToolCall[] = [];
	const toolCallIds = new Set<string>();
	for (const block of message.content) {
		if (block.type === "text") {
			textSegments.push(block.text);
		} else {
			if (toolCallIds.has(block.id)) {
				rejectUpstream(
					"Anthropic response contains duplicate tool_use block ids.",
				);
			}
			toolCallIds.add(block.id);
			toolCalls.push({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: JSON.stringify(block.input),
				},
			});
		}
	}

	const finishReason = mapStopReason(message.stop_reason, toolCalls.length > 0);

	const assistantMessage: Record<string, unknown> = {
		role: "assistant",
		// A refusal's partial output is incomplete and must not be presented as a
		// successful assistant message.
		content:
			finishReason === "content_filter" || textSegments.length === 0
				? null
				: textSegments.join(""),
	};
	if (toolCalls.length > 0) {
		assistantMessage.tool_calls = toolCalls;
	}

	return ChatResponseSchema.parse({
		id: message.id,
		object: "chat.completion",
		created: createdAtSeconds,
		model: message.model,
		choices: [
			{
				index: 0,
				message: assistantMessage,
				finish_reason: finishReason,
			},
		],
		usage: {
			prompt_tokens: message.usage.input_tokens,
			completion_tokens: message.usage.output_tokens,
			total_tokens: message.usage.input_tokens + message.usage.output_tokens,
		},
	});
}
