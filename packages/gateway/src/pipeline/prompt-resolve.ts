import {
	type ChatMessage,
	ChatMessageSchema,
	type ChatRequest,
	PgPromptRefSchema,
	PgVarsSchema,
	renderTemplate,
} from "@promptgate/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

import { resolveRef } from "../registry/dao.js";

const StoredMessagesSchema = z.array(ChatMessageSchema);
const VariableDeclarationSchema = z
	.object({
		name: z.string().trim().min(1),
		required: z.boolean(),
		description: z.string().optional(),
	})
	.strict();
const StoredVariablesSchema = z
	.array(VariableDeclarationSchema)
	.superRefine((variables, ctx) => {
		const names = new Set<string>();
		for (const [index, variable] of variables.entries()) {
			if (names.has(variable.name)) {
				ctx.addIssue({
					code: "custom",
					message: "Variable names must be unique.",
					path: [index, "name"],
				});
			}
			names.add(variable.name);
		}
	});

export interface PromptRefAttribution {
	promptId: number;
	promptVersion: number;
}

export type PromptResolveResult =
	| { ok: true; body: ChatRequest; promptRef: PromptRefAttribution | null }
	| {
			ok: false;
			code: "prompt_not_found" | "prompt_var_missing" | "provider_error";
			message: string;
			promptRef?: PromptRefAttribution;
	  };

function parseStoredJson<T>(schema: z.ZodType<T>, json: string): T | null {
	try {
		const parsed: unknown = JSON.parse(json);
		const result = schema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

function effectiveStringVariables(
	variables: ReadonlyArray<{ name: string; required: boolean }>,
	vars: Record<string, unknown>,
): { vars: Record<string, string>; missing: string[] } {
	// A null prototype preserves hostile-but-valid JSON keys such as
	// "__proto__" as ordinary own variables rather than invoking Object's
	// inherited setter while adapting values for the renderer.
	const strings = Object.create(null) as Record<string, string>;
	for (const [name, value] of Object.entries(vars)) {
		if (typeof value === "string") {
			strings[name] = value;
		}
	}

	const missing: string[] = [];
	for (const variable of variables) {
		if (
			variable.required &&
			(!Object.hasOwn(vars, variable.name) ||
				typeof vars[variable.name] !== "string")
		) {
			missing.push(variable.name);
		}
	}
	return { vars: strings, missing };
}

function renderMessage(
	message: ChatMessage,
	vars: Record<string, string>,
): { message: ChatMessage; missing: string[] } {
	// OpenAI content parts are not textual templates in v1. Preserve them
	// exactly, while rendering supported string content once (never recursively).
	if (typeof message.content !== "string") {
		return { message, missing: [] };
	}
	const rendered = renderTemplate(message.content, vars);
	return {
		message: { ...message, content: rendered.text },
		missing: rendered.missing,
	};
}

/**
 * Resolves one registry prompt after routing/pricing and before budget/cache.
 * Corrupt durable prompt payloads fail as a safe internal gateway error: they
 * are never forwarded, cached, or exposed as database details.
 */
export function resolvePromptRequest(
	db: Database.Database,
	body: ChatRequest,
): PromptResolveResult {
	if (body.pg_prompt === undefined) {
		return { ok: true, body, promptRef: null };
	}

	const ref = PgPromptRefSchema.safeParse(body.pg_prompt);
	const vars = PgVarsSchema.safeParse(body.pg_vars ?? {});
	if (!ref.success || !vars.success) {
		return {
			ok: false,
			code: "prompt_not_found",
			message: "Prompt not found.",
		};
	}
	const resolved = resolveRef(db, ref.data);
	if (!resolved) {
		return {
			ok: false,
			code: "prompt_not_found",
			message: "Prompt not found.",
		};
	}

	const promptRef = {
		promptId: resolved.promptId,
		promptVersion: resolved.version,
	};
	const storedMessages = parseStoredJson(
		StoredMessagesSchema,
		resolved.messages_json,
	);
	const storedVariables = parseStoredJson(
		StoredVariablesSchema,
		resolved.variables_json,
	);
	if (!storedMessages || !storedVariables) {
		return {
			ok: false,
			code: "provider_error",
			message: "The gateway could not resolve the stored prompt.",
			promptRef,
		};
	}

	const effective = effectiveStringVariables(storedVariables, vars.data);
	const rendered = storedMessages.map((message) =>
		renderMessage(message, effective.vars),
	);
	if (effective.missing.length > 0) {
		return {
			ok: false,
			code: "prompt_var_missing",
			message: `Missing prompt variables: ${effective.missing.join(", ")}.`,
			promptRef,
		};
	}

	return {
		ok: true,
		body: {
			...body,
			messages: [...rendered.map((result) => result.message), ...body.messages],
		},
		promptRef,
	};
}
