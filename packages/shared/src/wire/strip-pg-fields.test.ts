import { describe, expect, test } from "vitest";
import { stripPgFields } from "./strip-pg-fields.js";

describe("stripPgFields", () => {
	test("strips all known pg_* extension fields", () => {
		const result = stripPgFields({
			model: "gpt-5.6-terra",
			pg_prompt: "safety_screen@prod",
			pg_vars: { note: "hi" },
			pg_feature: "inbox_summary",
			pg_no_cache: true,
		});

		expect(result).toEqual({ model: "gpt-5.6-terra" });
	});

	test("preserves known passthrough fields", () => {
		const result = stripPgFields({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.7,
			pg_prompt: "safety_screen@prod",
		});

		expect(result).toEqual({
			model: "gpt-5.6-terra",
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.7,
		});
	});

	test("preserves unrecognized/unknown fields for provider forwarding", () => {
		const result = stripPgFields({
			model: "gpt-5.6-terra",
			seed: 42,
			tools: [{ type: "function", function: { name: "lookup" } }],
			pg_no_cache: true,
		});

		expect(result).toEqual({
			model: "gpt-5.6-terra",
			seed: 42,
			tools: [{ type: "function", function: { name: "lookup" } }],
		});
	});

	test("only strips keys with the exact pg_ prefix, not lookalikes", () => {
		const result = stripPgFields({
			pgfoo: "not stripped",
			pg: "not stripped either",
			pg_prompt: "stripped",
		});

		expect(result).toEqual({
			pgfoo: "not stripped",
			pg: "not stripped either",
		});
	});

	test("does not mutate the input object", () => {
		const input = { model: "gpt-5.6-terra", pg_no_cache: true };
		stripPgFields(input);

		expect(input).toEqual({ model: "gpt-5.6-terra", pg_no_cache: true });
	});

	test("returns an empty object when given an empty object", () => {
		expect(stripPgFields({})).toEqual({});
	});

	test("returns an empty object when every field is a pg_* field", () => {
		expect(stripPgFields({ pg_prompt: "x", pg_no_cache: false })).toEqual({});
	});
});
