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

export const PgVarsSchema = z.record(z.string(), z.unknown());
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
