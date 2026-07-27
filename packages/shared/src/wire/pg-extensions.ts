import { z } from "zod";

/**
 * PromptGate extension fields carried as extra body fields on an otherwise
 * OpenAI-compatible request (IMPLEMENTATION_GUIDE.md §5.1). Header fallbacks
 * (x-pg-prompt, etc.) are a separate concern handled by the request pipeline,
 * not by this wire schema.
 */

export const PgPromptRefSchema = z
	.string()
	.min(1, "pg_prompt must not be empty");
export type PgPromptRef = z.infer<typeof PgPromptRefSchema>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.getOwnPropertySymbols(value).length === 0
	);
}

/**
 * Keep variables broad (their values are validated by prompt resolution), but
 * preserve the caller's own JSON keys exactly. z.record clones a JSON
 * `__proto__` data key through a normal object and drops it; this custom
 * boundary validates a plain record while returning the original object.
 */
export const PgVarsSchema = z.custom<Record<string, unknown>>(isPlainRecord, {
	message: "pg_vars must be a plain object with string keys.",
});
export type PgVars = z.infer<typeof PgVarsSchema>;

export const PgFeatureSchema = z
	.string()
	.min(1, "pg_feature must not be empty");
export type PgFeature = z.infer<typeof PgFeatureSchema>;

export const PgNoCacheSchema = z.boolean();
export type PgNoCache = z.infer<typeof PgNoCacheSchema>;

export const PgExtensionFieldsSchema = z.object({
	pg_prompt: PgPromptRefSchema.optional(),
	pg_vars: PgVarsSchema.optional(),
	pg_feature: PgFeatureSchema.optional(),
	pg_no_cache: PgNoCacheSchema.optional(),
});
export type PgExtensionFields = z.infer<typeof PgExtensionFieldsSchema>;
