import { types } from "node:util";
import { z } from "zod";
import { type ChatRequest, ChatRequestSchema } from "./wire/chat-request.ts";
import { type ChatResponse, ChatResponseSchema } from "./wire/chat-response.ts";

export {
	type ChatRequest,
	ChatRequestSchema,
	type ChatResponse,
	ChatResponseSchema,
};

export const EVAL_MODELS = [
	"gpt-5.6-luna",
	"gemini-2.5-flash",
	"deepseek-v4-flash",
	"gpt-5.6-terra",
	"claude-sonnet-5",
] as const;

export const EvalModelSchema = z.enum(EVAL_MODELS);

export type EvalJsonValue =
	| null
	| boolean
	| number
	| string
	| EvalJsonValue[]
	| { [key: string]: EvalJsonValue };

export type EvalJsonRecord = { [key: string]: EvalJsonValue };

type NormalizedJson = { ok: true; value: EvalJsonValue } | { ok: false };

const INVALID_JSON = { ok: false } as const;

/**
 * Snapshot caller data into getter-free, null-prototype JSON values before
 * serialization. Descriptor inspection prevents accessors and hidden hooks
 * from changing or leaking data after validation.
 */
function normalizeEvalJson(
	input: unknown,
	ancestors: WeakSet<object> = new WeakSet(),
): NormalizedJson {
	if (
		input === null ||
		typeof input === "boolean" ||
		typeof input === "string"
	) {
		return { ok: true, value: input };
	}
	if (typeof input === "number") {
		return Number.isFinite(input) ? { ok: true, value: input } : INVALID_JSON;
	}
	if (
		typeof input !== "object" ||
		types.isProxy(input) ||
		ancestors.has(input)
	) {
		return INVALID_JSON;
	}

	ancestors.add(input);
	try {
		const array = Array.isArray(input);
		const prototype = Object.getPrototypeOf(input);
		const keys = Reflect.ownKeys(input);
		if (keys.some((key) => typeof key === "symbol")) {
			return INVALID_JSON;
		}

		if (array) {
			if (prototype !== Array.prototype && prototype !== null) {
				return INVALID_JSON;
			}
			const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
			if (
				lengthDescriptor === undefined ||
				!("value" in lengthDescriptor) ||
				!Number.isSafeInteger(lengthDescriptor.value) ||
				lengthDescriptor.value < 0
			) {
				return INVALID_JSON;
			}
			const length = lengthDescriptor.value as number;
			if (
				keys.length !== length + 1 ||
				!keys.includes("length") ||
				!Array.from({ length }, (_, index) => String(index)).every((key) =>
					keys.includes(key),
				)
			) {
				return INVALID_JSON;
			}

			const output: EvalJsonValue[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(
					input,
					String(index),
				);
				if (
					descriptor === undefined ||
					!("value" in descriptor) ||
					descriptor.enumerable !== true
				) {
					return INVALID_JSON;
				}
				const normalized = normalizeEvalJson(descriptor.value, ancestors);
				if (!normalized.ok) {
					return INVALID_JSON;
				}
				output.push(normalized.value);
			}
			Object.setPrototypeOf(output, null);
			return { ok: true, value: output };
		}

		if (prototype !== Object.prototype && prototype !== null) {
			return INVALID_JSON;
		}
		const output: EvalJsonRecord = Object.create(null) as EvalJsonRecord;
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (
				descriptor === undefined ||
				!("value" in descriptor) ||
				descriptor.enumerable !== true
			) {
				return INVALID_JSON;
			}
			const normalized = normalizeEvalJson(descriptor.value, ancestors);
			if (!normalized.ok) {
				return INVALID_JSON;
			}
			Object.defineProperty(output, key, {
				configurable: true,
				enumerable: true,
				value: normalized.value,
				writable: true,
			});
		}
		return { ok: true, value: output };
	} catch {
		return INVALID_JSON;
	} finally {
		ancestors.delete(input);
	}
}

/** Strict, data-only variables safe to serialize after the Zod boundary. */
export const EvalJsonRecordSchema = z.unknown().transform((input, context) => {
	const normalized = normalizeEvalJson(input);
	if (
		!normalized.ok ||
		normalized.value === null ||
		typeof normalized.value !== "object" ||
		Array.isArray(normalized.value)
	) {
		context.addIssue({
			code: "custom",
			message: "Expected a data-only JSON object.",
		});
		return z.NEVER;
	}
	return normalized.value;
});

const EVAL_GATEWAY_REQUEST_KEYS = new Set([
	"messages",
	"model",
	"pg_feature",
	"pg_no_cache",
	"pg_prompt",
	"pg_vars",
	"reasoning_effort",
	"response_format",
	"stream",
	"temperature",
]);

/**
 * The canonical shared chat request narrowed to PromptGate's fixed eval
 * transport policy. The variables transform snapshots data before stringify.
 */
export const EvalGatewayRequestSchema = ChatRequestSchema.transform(
	(request, context) => {
		let valid = true;
		const issue = (message: string, path: PropertyKey[] = []): void => {
			valid = false;
			context.addIssue({ code: "custom", message, path });
		};

		const model = EvalModelSchema.safeParse(request.model);
		if (!model.success) {
			issue("Unsupported eval model.", ["model"]);
		}
		if (request.messages.length !== 0) {
			issue("Eval registry requests must not append messages.", ["messages"]);
		}
		if (request.stream !== false) {
			issue("Eval gateway requests must be non-streaming.", ["stream"]);
		}
		if (request.pg_prompt === undefined) {
			issue("Eval gateway requests require pg_prompt.", ["pg_prompt"]);
		}
		if (request.pg_feature !== "eval") {
			issue("Eval gateway requests require pg_feature=eval.", ["pg_feature"]);
		}
		if (request.pg_no_cache === undefined) {
			issue("Eval gateway requests require pg_no_cache.", ["pg_no_cache"]);
		}
		if (
			request.reasoning_effort !== undefined &&
			request.reasoning_effort !== "high"
		) {
			issue("Eval reasoning effort must be high when supplied.", [
				"reasoning_effort",
			]);
		}
		if (
			request.response_format !== undefined &&
			(request.response_format.type !== "json_object" ||
				Object.keys(request.response_format).length !== 1)
		) {
			issue("Eval response format must be exactly json_object.", [
				"response_format",
			]);
		}
		if (model.success) {
			const expectedTemperature =
				model.data === "claude-sonnet-5" || model.data === "gpt-5.6-terra"
					? undefined
					: 0;
			if (request.temperature !== expectedTemperature) {
				issue("Eval request temperature violates the pinned model policy.", [
					"temperature",
				]);
			}
		}
		for (const key of Object.keys(request)) {
			if (!EVAL_GATEWAY_REQUEST_KEYS.has(key)) {
				issue(`Unexpected eval gateway request field: ${key}.`, [key]);
			}
		}

		const variables = EvalJsonRecordSchema.safeParse(request.pg_vars);
		if (!variables.success) {
			issue("Eval gateway variables must be data-only JSON.", ["pg_vars"]);
		}
		if (!valid || !model.success || !variables.success) {
			return z.NEVER;
		}
		return {
			...request,
			model: model.data,
			pg_vars: variables.data,
		};
	},
);

/**
 * The canonical shared chat response plus the one eval-specific success rule:
 * a non-streaming completion must expose string content in its first choice.
 */
export const EvalGatewayResponseSchema = ChatResponseSchema.transform(
	(response, context) => {
		const content = response.choices[0]?.message.content;
		if (typeof content !== "string") {
			context.addIssue({
				code: "custom",
				message:
					"Eval gateway response must include first-choice string content.",
				path: ["choices", 0, "message", "content"],
			});
			return z.NEVER;
		}
		return { content, response };
	},
);
