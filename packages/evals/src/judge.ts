import { z } from "zod";

import type {
	RubricEvaluator,
	RubricInput,
	RubricOutcome,
} from "./assertions.js";
import type { GatewayCall, GatewayClient } from "./gateway-client.js";

export const JUDGE_MODEL = "gpt-5.6-terra" as const;
export const JUDGE_PROMPT_REF = "judge_rubric_v1@1" as const;
export const MAX_JUDGE_RATIONALE_LENGTH = 1_000;

const JudgeResponseSchema = z
	.object({
		pass: z.boolean(),
		score: z.number().finite().min(0).max(1),
		rationale: z.string().trim().min(1).max(MAX_JUDGE_RATIONALE_LENGTH),
	})
	.strict();

export interface JudgeGateway {
	complete(call: GatewayCall): Promise<{ content: string }>;
}

export class JudgeInfrastructureError extends Error {
	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "JudgeInfrastructureError";
	}
}

function serializeUntrusted(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error("not serializable");
		}
		return serialized;
	} catch {
		throw new JudgeInfrastructureError(
			"Judge input could not be serialized safely.",
		);
	}
}

function judgeVars(input: RubricInput): Record<string, string> {
	return {
		payload: serializeUntrusted({
			candidate: input.output,
			rubric: input.rubric,
			context: {
				description: input.context.description,
				vars: input.context.vars,
			},
		}),
	};
}

function parseJudgeResponse(content: string): RubricOutcome {
	let payload: unknown;
	try {
		payload = JSON.parse(content);
	} catch {
		throw new JudgeInfrastructureError("Judge returned malformed JSON.");
	}
	const parsed = JudgeResponseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new JudgeInfrastructureError("Judge returned an invalid result.");
	}
	return {
		pass: parsed.data.pass,
		score: parsed.data.score,
		detail: parsed.data.rationale,
	};
}

/** Creates the Step 5 judge without performing a request until an assertion runs. */
export function createGatewayRubricEvaluator(
	client: JudgeGateway | GatewayClient,
): RubricEvaluator {
	return async (input) => {
		let response: { content: string };
		try {
			response = await client.complete({
				model: JUDGE_MODEL,
				prompt: JUDGE_PROMPT_REF,
				vars: judgeVars(input),
				reasoningEffort: "high",
				responseFormat: { type: "json_object" },
			});
		} catch (error) {
			if (error instanceof JudgeInfrastructureError) {
				throw error;
			}
			throw new JudgeInfrastructureError("Judge gateway request failed.");
		}
		return parseJudgeResponse(response.content);
	};
}
