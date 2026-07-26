import { type ChatRequest, ChatRequestSchema } from "@promptgate/shared";
import { describe, expect, test } from "vitest";

import { cacheKeyOf, stableStringify } from "./cache-key.js";

const COMPLETE_REQUEST = {
	model: "gpt-5.6-terra",
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "Describe this image." },
				{
					type: "image_url",
					image_url: { url: "https://example.test/cat.png" },
				},
			],
		},
	],
	temperature: 0.7,
	top_p: 0.9,
	max_tokens: 256,
	stop: ["END", "STOP"],
	response_format: {
		type: "json_schema",
		json_schema: {
			name: "answer",
			schema: { required: ["answer"], type: "object" },
		},
	},
	reasoning_effort: "high",
	seed: 42,
	n: 2,
	presence_penalty: 0.3,
	frequency_penalty: 0.2,
	logit_bias: { "198": -100, "464": 5 },
	tools: [
		{
			type: "function",
			function: {
				name: "lookup_weather",
				description: "Look up weather.",
				parameters: {
					properties: { city: { type: "string" } },
					type: "object",
				},
			},
		},
	],
	tool_choice: { type: "function", function: { name: "lookup_weather" } },
	parallel_tool_calls: false,
	user: "user_123",
	extra_body: { google: { thinking_config: { include_thoughts: true } } },
} as const;

const FORWARDED_FIELD_CHANGES: Record<keyof typeof COMPLETE_REQUEST, unknown> =
	{
		model: "gpt-5.6-terra-changed",
		messages: [{ role: "user", content: "A different message." }],
		temperature: 0.1,
		top_p: 0.1,
		max_tokens: 128,
		stop: "HALT",
		response_format: { type: "json_object" },
		reasoning_effort: "low",
		seed: 7,
		n: 1,
		presence_penalty: 0.1,
		frequency_penalty: 0.1,
		logit_bias: { "198": 1 },
		tools: [{ type: "function", function: { name: "different_tool" } }],
		tool_choice: "none",
		parallel_tool_calls: true,
		user: "user_456",
		extra_body: { google: { thinking_config: { include_thoughts: false } } },
	};

function requestOf(body: Record<string, unknown>): ChatRequest {
	return ChatRequestSchema.parse(body);
}

function shuffledObject(value: unknown, random: () => number): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => shuffledObject(entry, random));
	}

	if (value !== null && typeof value === "object") {
		const shuffledEntries = Object.entries(value)
			.map(([key, entry]) => [key, shuffledObject(entry, random)] as const)
			.sort(() => random() - 0.5);
		return Object.fromEntries(shuffledEntries);
	}

	return value;
}

function pseudoRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

describe("stableStringify", () => {
	test("sorts object keys recursively while preserving array order", () => {
		expect(
			stableStringify({
				z: [{ b: 2, a: 1 }, "second"],
				a: { y: true, x: null },
			}),
		).toBe('{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},"second"]}');
	});
});

describe("cacheKeyOf", () => {
	test("is invariant to key insertion order at every object level", () => {
		const expected = cacheKeyOf(requestOf({ ...COMPLETE_REQUEST }));

		for (let seed = 1; seed <= 100; seed += 1) {
			const shuffled = shuffledObject(
				COMPLETE_REQUEST,
				pseudoRandom(seed),
			) as Record<string, unknown>;
			expect(cacheKeyOf(requestOf(shuffled))).toBe(expected);
		}
	});

	test("is invariant to insignificant JSON source whitespace", () => {
		const compact = JSON.stringify(COMPLETE_REQUEST);
		const spaced = JSON.stringify(COMPLETE_REQUEST, null, 4);

		expect(cacheKeyOf(requestOf(JSON.parse(spaced)))).toBe(
			cacheKeyOf(requestOf(JSON.parse(compact))),
		);
	});

	test("changes when any forwarded top-level field changes", () => {
		const base = requestOf({ ...COMPLETE_REQUEST });
		const expected = cacheKeyOf(base);

		for (const field of Object.keys(COMPLETE_REQUEST) as Array<
			keyof typeof COMPLETE_REQUEST
		>) {
			const changed = requestOf({
				...COMPLETE_REQUEST,
				[field]: FORWARDED_FIELD_CHANGES[field],
			});
			expect(cacheKeyOf(changed), field).not.toBe(expected);
		}
	});

	test("changes for a new provider field without needing an allowlist update", () => {
		const base = requestOf({ ...COMPLETE_REQUEST });
		const withNewForwardedField = requestOf({
			...COMPLETE_REQUEST,
			future_provider_option: { enabled: true },
		});

		expect(cacheKeyOf(withNewForwardedField)).not.toBe(cacheKeyOf(base));
	});

	test("excludes stream controls and every pg_* field only", () => {
		const base = requestOf({ ...COMPLETE_REQUEST });
		const requestWithExcludedFields = requestOf({
			...COMPLETE_REQUEST,
			stream: true,
			stream_options: { include_usage: false, continuous_usage_stats: true },
			pg_prompt: "answer@prod",
			pg_vars: { audience: "engineer" },
			pg_feature: "summary",
			pg_no_cache: true,
			pg_future_extension: { ignored: true },
		});

		expect(cacheKeyOf(requestWithExcludedFields)).toBe(cacheKeyOf(base));
	});
});
