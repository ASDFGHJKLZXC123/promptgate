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
