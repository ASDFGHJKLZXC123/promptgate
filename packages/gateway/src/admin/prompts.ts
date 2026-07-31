import { ChatMessageSchema } from "@promptgate/shared";
import type Database from "better-sqlite3";
import { createTwoFilesPatch } from "diff";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { sendError } from "../errors.js";
import {
	addVersion,
	createPrompt,
	findPromptBySlug,
	findPromptDetail,
	findPromptVersion,
	type JsonValue,
	listPromptSummaries,
	setLabel,
} from "../registry/dao.js";

const slugSchema = z.string().trim().min(1);
const labelSchema = z.string().trim().min(1);

const promptParamsSchema = z.object({ slug: slugSchema }).strict();
const versionParamsSchema = z
	.object({
		slug: slugSchema,
		a: z.coerce.number().int().positive().safe(),
		b: z.coerce.number().int().positive().safe(),
	})
	.strict();
const labelParamsSchema = z
	.object({ slug: slugSchema, label: labelSchema })
	.strict();

const createPromptSchema = z
	.object({
		slug: slugSchema,
		description: z.string().nullable().optional(),
	})
	.strict();

const variableDeclarationSchema = z
	.object({
		name: z.string().trim().min(1),
		required: z.boolean(),
		description: z.string().optional(),
	})
	.strict();

const createVersionSchema = z
	.object({
		messages_json: z.array(ChatMessageSchema),
		variables_json: z.array(variableDeclarationSchema),
		notes: z.string().nullable().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const names = new Set<string>();
		for (const [index, variable] of value.variables_json.entries()) {
			if (names.has(variable.name)) {
				ctx.addIssue({
					code: "custom",
					message: "Variable names must be unique.",
					path: ["variables_json", index, "name"],
				});
			}
			names.add(variable.name);
		}
	});

const labelBodySchema = z
	.object({ version: z.number().int().positive().safe() })
	.strict();

function parseOrReply<T>(
	schema: z.ZodType<T>,
	value: unknown,
	reply: FastifyReply,
): T | undefined {
	const result = schema.safeParse(value);
	if (!result.success) {
		sendError(reply, 400, "Invalid request payload.", "invalid_request_error");
		return undefined;
	}
	return result.data;
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "SQLITE_CONSTRAINT_UNIQUE"
	);
}

function toJsonValue(value: unknown): JsonValue | null {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const converted = toJsonValue(item);
			if (converted === null && item !== null) {
				return null;
			}
			items.push(converted);
		}
		return items;
	}
	if (typeof value === "object") {
		const object: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value)) {
			const converted = toJsonValue(item);
			if (converted === null && item !== null) {
				return null;
			}
			object[key] = converted;
		}
		return object;
	}
	return null;
}

function toJsonArray(value: unknown): JsonValue[] | null {
	const converted = toJsonValue(value);
	return Array.isArray(converted) ? converted : null;
}

function sortJsonKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(sortJsonKeys);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, sortJsonKeys(item)]),
		);
	}
	return value;
}

function prettyMessages(json: string): string {
	const parsed: unknown = JSON.parse(json);
	const validated = z.array(ChatMessageSchema).safeParse(parsed);
	if (!validated.success) {
		throw new Error("Stored prompt messages are not a JSON array");
	}
	const messages = toJsonArray(validated.data);
	if (!messages) {
		throw new Error("Stored prompt messages cannot be represented as JSON");
	}
	return `${JSON.stringify(sortJsonKeys(messages), null, 2)}\n`;
}

/** Parses a persisted JSON array without allowing a partial detail response. */
function parseStoredJsonArray(json: string, column: string): JsonValue[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error(`Stored prompt ${column} is invalid JSON`);
	}
	const array = toJsonArray(parsed);
	if (!array) {
		throw new Error(`Stored prompt ${column} is not a JSON array`);
	}
	return array;
}

function promptNotFound(reply: FastifyReply): FastifyReply {
	return sendError(reply, 404, "Prompt not found.", "prompt_not_found");
}

function versionNotFound(reply: FastifyReply): FastifyReply {
	return sendError(
		reply,
		404,
		"Prompt version not found.",
		"prompt_version_not_found",
	);
}

/** Registers prompt-registry routes inside the existing authenticated admin scope. */
export function registerPromptAdminRoutes(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.get("/api/prompts", (_request, reply) => {
		return reply.send(listPromptSummaries(db));
	});

	server.post("/api/prompts", async (request, reply) => {
		const body = parseOrReply(createPromptSchema, request.body, reply);
		if (!body) {
			return reply;
		}
		try {
			return reply.send(createPrompt(db, body.slug, body.description ?? null));
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return sendError(
					reply,
					409,
					"A prompt with that slug already exists.",
					"prompt_slug_conflict",
				);
			}
			throw error;
		}
	});

	server.get("/api/prompts/:slug", (request, reply) => {
		const params = parseOrReply(promptParamsSchema, request.params, reply);
		if (!params) {
			return reply;
		}
		const prompt = findPromptDetail(db, params.slug);
		if (!prompt) {
			return promptNotFound(reply);
		}

		return reply.send({
			id: prompt.id,
			slug: prompt.slug,
			description: prompt.description,
			created_at: prompt.created_at,
			labels: prompt.labels,
			versions: prompt.versions.map((version) => ({
				version: version.version,
				messages_json: parseStoredJsonArray(
					version.messages_json,
					"messages_json",
				),
				variables_json: parseStoredJsonArray(
					version.variables_json,
					"variables_json",
				),
				notes: version.notes,
				created_at: version.created_at,
			})),
		});
	});

	server.post("/api/prompts/:slug/versions", async (request, reply) => {
		const params = parseOrReply(promptParamsSchema, request.params, reply);
		if (!params) {
			return reply;
		}
		const body = parseOrReply(createVersionSchema, request.body, reply);
		if (!body) {
			return reply;
		}
		const prompt = findPromptBySlug(db, params.slug);
		if (!prompt) {
			return promptNotFound(reply);
		}
		const messages = toJsonArray(body.messages_json);
		const variables = toJsonArray(body.variables_json);
		if (!messages || !variables) {
			return sendError(
				reply,
				400,
				"Invalid request payload.",
				"invalid_request_error",
			);
		}
		const added = addVersion(
			db,
			prompt.id,
			messages,
			variables,
			body.notes ?? null,
		);
		return reply.send({
			prompt_id: added.promptId,
			version: added.version,
			messages_json: added.messages_json,
			variables_json: added.variables_json,
			notes: added.notes,
		});
	});

	server.get("/api/prompts/:slug/versions/:a/diff/:b", (request, reply) => {
		const params = parseOrReply(versionParamsSchema, request.params, reply);
		if (!params) {
			return reply;
		}
		const prompt = findPromptBySlug(db, params.slug);
		if (!prompt) {
			return promptNotFound(reply);
		}
		const before = findPromptVersion(db, prompt.id, params.a);
		const after = findPromptVersion(db, prompt.id, params.b);
		if (!before || !after) {
			return versionNotFound(reply);
		}
		const patch = createTwoFilesPatch(
			`${prompt.slug}@${before.version}.messages.json`,
			`${prompt.slug}@${after.version}.messages.json`,
			prettyMessages(before.messages_json),
			prettyMessages(after.messages_json),
		);
		return reply.type("text/plain; charset=utf-8").send(patch);
	});

	server.put("/api/prompts/:slug/labels/:label", async (request, reply) => {
		const params = parseOrReply(labelParamsSchema, request.params, reply);
		if (!params) {
			return reply;
		}
		const body = parseOrReply(labelBodySchema, request.body, reply);
		if (!body) {
			return reply;
		}
		const prompt = findPromptBySlug(db, params.slug);
		if (!prompt) {
			return promptNotFound(reply);
		}
		if (!findPromptVersion(db, prompt.id, body.version)) {
			return versionNotFound(reply);
		}
		const moved = setLabel(db, prompt.id, params.label, body.version);
		return reply.send({
			prompt_id: moved.promptId,
			label: moved.label,
			from_version: moved.fromVersion,
			to_version: moved.toVersion,
		});
	});
}
