import { describe, expect, test } from "vitest";
import { EvalGatewayRequestSchema } from "./eval.js";

function deepSeekRequest(temperature?: 0): Record<string, unknown> {
	return {
		model: "deepseek-v4-flash",
		messages: [],
		stream: false,
		pg_prompt: "safety_screen@candidate",
		pg_vars: { note: "review" },
		pg_feature: "eval",
		pg_no_cache: true,
		...(temperature === undefined ? {} : { temperature }),
	};
}

function terraRequest(temperature?: 0): Record<string, unknown> {
	return {
		model: "gpt-5.6-terra",
		messages: [],
		stream: false,
		pg_prompt: "judge_rubric_v1@1",
		pg_vars: { payload: "{}" },
		pg_feature: "eval",
		pg_no_cache: true,
		reasoning_effort: "high",
		response_format: { type: "json_object" },
		...(temperature === undefined ? {} : { temperature }),
	};
}

describe("eval temperature policy", () => {
	test("accepts only the approved Terra omission and DeepSeek zero value", () => {
		expect(EvalGatewayRequestSchema.safeParse(terraRequest()).success).toBe(
			true,
		);
		expect(EvalGatewayRequestSchema.safeParse(terraRequest(0)).success).toBe(
			false,
		);
		expect(EvalGatewayRequestSchema.safeParse(deepSeekRequest(0)).success).toBe(
			true,
		);
		expect(EvalGatewayRequestSchema.safeParse(deepSeekRequest()).success).toBe(
			false,
		);
	});
});
