import { describe, expect, test } from "vitest";
import {
	PgExtensionFieldsSchema,
	PgFeatureSchema,
	PgNoCacheSchema,
	PgPromptRefSchema,
	PgVarsSchema,
} from "./pg-extensions.js";

describe("pg_* extension field schemas", () => {
	test("PgPromptRefSchema accepts a slug@label ref", () => {
		expect(PgPromptRefSchema.safeParse("safety_screen@prod").success).toBe(
			true,
		);
	});

	test("PgPromptRefSchema rejects an empty string", () => {
		expect(PgPromptRefSchema.safeParse("").success).toBe(false);
	});

	test("PgVarsSchema accepts an arbitrary flat variable map", () => {
		const result = PgVarsSchema.safeParse({ note: "hello", count: 3 });
		expect(result.success).toBe(true);
	});

	test("PgVarsSchema preserves an own __proto__ key parsed from JSON", () => {
		const input: unknown = JSON.parse('{"__proto__":"value"}');
		const result = PgVarsSchema.safeParse(input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(Object.hasOwn(result.data, "__proto__")).toBe(true);
			expect(
				Object.getOwnPropertyDescriptor(result.data, "__proto__")?.value,
			).toBe("value");
		}
	});

	test("PgVarsSchema rejects arrays, null, instances, and symbol keys", () => {
		expect(PgVarsSchema.safeParse([]).success).toBe(false);
		expect(PgVarsSchema.safeParse(null).success).toBe(false);
		expect(PgVarsSchema.safeParse(new Date()).success).toBe(false);
		const withSymbol = { note: "hello", [Symbol("secret")]: "nope" };
		expect(PgVarsSchema.safeParse(withSymbol).success).toBe(false);
	});

	test("PgFeatureSchema rejects an empty string", () => {
		expect(PgFeatureSchema.safeParse("").success).toBe(false);
	});

	test("PgNoCacheSchema only accepts booleans", () => {
		expect(PgNoCacheSchema.safeParse(true).success).toBe(true);
		expect(PgNoCacheSchema.safeParse("true").success).toBe(false);
	});

	test("PgExtensionFieldsSchema treats all fields as optional", () => {
		expect(PgExtensionFieldsSchema.safeParse({}).success).toBe(true);
	});

	test("PgExtensionFieldsSchema rejects a malformed field when present", () => {
		const result = PgExtensionFieldsSchema.safeParse({ pg_no_cache: "yes" });
		expect(result.success).toBe(false);
	});
});
