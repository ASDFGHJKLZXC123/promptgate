import {
	ChatCompletionChunkSchema,
	type ChatResponse,
	ChatResponseSchema,
	type ChatUsage,
	type FinishReason,
} from "@promptgate/shared";

import { stableStringify } from "./cache-key.js";

type JsonRecord = Record<string, unknown>;

interface ToolState {
	id: string;
	type: "function";
	name: string;
	arguments: string;
}

interface ChoiceState {
	role?: "assistant";
	content: string;
	reasoningContent: string;
	finishReason?: FinishReason;
	extras: JsonRecord;
	tools: Map<number, ToolState>;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

/**
 * Best-effort, deterministic stream-to-response assembler for cache writes.
 * It is deliberately not a provider trust boundary: an ineligible transcript
 * only suppresses caching, never interrupts the already-authoritative live
 * stream. The provider adapters retain their Phase 2 fail-closed role.
 */
export class StreamingResponseAssembler {
	private eligible = true;
	private identity: { id: string; created: number; model: string } | undefined;
	private usage: ChatUsage | undefined;
	private sawDone = false;
	private readonly extras: JsonRecord = {};
	private readonly choices = new Map<number, ChoiceState>();

	observePayload(payload: string): void {
		// A usage-bearing frame is terminal under PromptGate's stream contract.
		// Anything after it cannot be represented by a cached response safely.
		if (!this.eligible || this.sawDone || this.usage !== undefined) {
			this.eligible = false;
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(payload) as unknown;
		} catch {
			this.eligible = false;
			return;
		}
		const parsed = ChatCompletionChunkSchema.safeParse(value);
		if (!parsed.success || !isRecord(value)) {
			this.eligible = false;
			return;
		}
		const chunk = parsed.data;
		if (this.identity === undefined) {
			this.identity = {
				id: chunk.id,
				created: chunk.created,
				model: chunk.model,
			};
		} else if (
			this.identity.id !== chunk.id ||
			this.identity.created !== chunk.created ||
			this.identity.model !== chunk.model
		) {
			this.eligible = false;
			return;
		}

		for (const [key, extra] of Object.entries(value)) {
			if (
				["id", "object", "created", "model", "choices", "usage"].includes(key)
			) {
				continue;
			}
			if (key in this.extras && !sameJson(this.extras[key], extra)) {
				this.eligible = false;
				return;
			}
			this.extras[key] = extra;
		}

		if (chunk.usage != null) {
			if (this.usage !== undefined) {
				this.eligible = false;
				return;
			}
			this.usage = chunk.usage;
		}

		const seenIndexes = new Set<number>();
		for (const choice of chunk.choices) {
			if (seenIndexes.has(choice.index)) {
				this.eligible = false;
				return;
			}
			seenIndexes.add(choice.index);
			let state = this.choices.get(choice.index);
			if (!state) {
				state = {
					content: "",
					reasoningContent: "",
					extras: {},
					tools: new Map(),
				};
				this.choices.set(choice.index, state);
			}
			if (state.finishReason !== undefined) {
				this.eligible = false;
				return;
			}

			const rawChoice = value.choices;
			const raw = Array.isArray(rawChoice)
				? rawChoice.find(
						(item) => isRecord(item) && item.index === choice.index,
					)
				: undefined;
			if (!isRecord(raw) || !isRecord(raw.delta)) {
				this.eligible = false;
				return;
			}
			for (const [key, extra] of Object.entries(raw)) {
				if (["index", "delta", "finish_reason"].includes(key)) {
					continue;
				}
				if (key in state.extras && !sameJson(state.extras[key], extra)) {
					this.eligible = false;
					return;
				}
				state.extras[key] = extra;
			}
			if (!this.observeDelta(state, raw.delta)) {
				this.eligible = false;
				return;
			}
			if (choice.finish_reason != null) {
				state.finishReason = choice.finish_reason;
			}
		}
	}

	observeDone(payload: string): void {
		if (!this.eligible || this.sawDone || payload !== "[DONE]") {
			this.eligible = false;
			return;
		}
		this.sawDone = true;
	}

	finish(): ChatResponse | null {
		if (
			!this.eligible ||
			!this.sawDone ||
			this.identity === undefined ||
			this.usage === undefined ||
			this.choices.size === 0
		) {
			return null;
		}
		const choices = [...this.choices.entries()]
			.sort(([left], [right]) => left - right)
			.map(([index, state]) => {
				if (state.role !== "assistant" || state.finishReason === undefined) {
					return null;
				}
				if (
					[...state.tools.values()].some(
						(tool) => !isJsonObject(tool.arguments),
					)
				) {
					return null;
				}
				const message: JsonRecord = {
					role: "assistant",
					content: state.content.length > 0 ? state.content : null,
				};
				if (state.reasoningContent.length > 0) {
					message.reasoning_content = state.reasoningContent;
				}
				if (state.tools.size > 0) {
					message.tool_calls = [...state.tools.entries()]
						.sort(([left], [right]) => left - right)
						.map(([, tool]) => ({
							id: tool.id,
							type: tool.type,
							function: { name: tool.name, arguments: tool.arguments },
						}));
				}
				return {
					...state.extras,
					index,
					message,
					finish_reason: state.finishReason,
				};
			});
		if (choices.some((choice) => choice === null)) {
			return null;
		}
		const parsed = ChatResponseSchema.safeParse({
			...this.extras,
			...this.identity,
			object: "chat.completion",
			choices,
			usage: this.usage,
		});
		return parsed.success ? parsed.data : null;
	}

	private observeDelta(state: ChoiceState, delta: JsonRecord): boolean {
		for (const key of Object.keys(delta)) {
			if (
				!["role", "content", "reasoning_content", "tool_calls"].includes(key)
			) {
				return false;
			}
		}
		if (delta.role !== undefined) {
			if (
				delta.role !== "assistant" ||
				(state.role && state.role !== delta.role)
			) {
				return false;
			}
			state.role = "assistant";
		}
		if (delta.content !== undefined && delta.content !== null) {
			if (typeof delta.content !== "string") {
				return false;
			}
			state.content += delta.content;
		}
		if (
			delta.reasoning_content !== undefined &&
			delta.reasoning_content !== null
		) {
			if (typeof delta.reasoning_content !== "string") {
				return false;
			}
			state.reasoningContent += delta.reasoning_content;
		}
		if (delta.tool_calls !== undefined) {
			if (!Array.isArray(delta.tool_calls)) {
				return false;
			}
			for (const rawTool of delta.tool_calls) {
				if (!this.observeTool(state, rawTool)) {
					return false;
				}
			}
		}
		return true;
	}

	private observeTool(state: ChoiceState, rawTool: unknown): boolean {
		if (!isRecord(rawTool)) {
			return false;
		}
		for (const key of Object.keys(rawTool)) {
			if (!["index", "id", "type", "function"].includes(key)) {
				return false;
			}
		}
		const toolIndex = rawTool.index;
		if (
			!Number.isInteger(toolIndex) ||
			typeof toolIndex !== "number" ||
			toolIndex < 0
		) {
			return false;
		}
		const fn = rawTool.function;
		if (fn !== undefined && !isRecord(fn)) {
			return false;
		}
		if (
			fn !== undefined &&
			Object.keys(fn).some((key) => !["name", "arguments"].includes(key))
		) {
			return false;
		}
		const existing = state.tools.get(toolIndex);
		const id = rawTool.id;
		const type = rawTool.type;
		const name = fn?.name;
		const argumentsPart = fn?.arguments;
		if (
			(id !== undefined && typeof id !== "string") ||
			(type !== undefined && type !== "function") ||
			(name !== undefined && typeof name !== "string") ||
			(argumentsPart !== undefined && typeof argumentsPart !== "string")
		) {
			return false;
		}
		if (!existing) {
			if (
				typeof id !== "string" ||
				type !== "function" ||
				typeof name !== "string"
			) {
				return false;
			}
			state.tools.set(toolIndex, {
				id,
				type,
				name,
				arguments: typeof argumentsPart === "string" ? argumentsPart : "",
			});
			return true;
		}
		if (
			(id !== undefined && id !== existing.id) ||
			(type !== undefined && type !== existing.type) ||
			(name !== undefined && name !== existing.name)
		) {
			return false;
		}
		if (typeof argumentsPart === "string") {
			existing.arguments += argumentsPart;
		}
		return true;
	}
}

function isJsonObject(text: string): boolean {
	try {
		const value = JSON.parse(text) as unknown;
		return isRecord(value);
	} catch {
		return false;
	}
}
