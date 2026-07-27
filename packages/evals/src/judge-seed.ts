import { createHash } from "node:crypto";
import { z } from "zod";
import fixture from "../fixtures/prompts/judge_rubric_v1.json" with {
	type: "json",
};

import type { FetchLike } from "./gateway-client.js";

const FixtureSchema = z
	.object({
		slug: z.literal("judge_rubric_v1"),
		description: z.string().trim().min(1),
		messages_json: z
			.array(
				z
					.object({
						role: z.enum(["system", "user"]),
						content: z.string().min(1),
					})
					.strict(),
			)
			.length(2),
		variables_json: z
			.array(
				z
					.object({
						name: z.literal("payload"),
						required: z.literal(true),
						description: z.string().trim().min(1),
					})
					.strict(),
			)
			.length(1),
		notes: z.string().trim().min(1),
	})
	.strict();

const CreatedPromptSchema = z
	.object({ id: z.number().int().positive() })
	.passthrough();
const CreatedVersionSchema = z.object({ version: z.literal(1) }).passthrough();

export const JUDGE_RUBRIC_FIXTURE = FixtureSchema.parse(fixture);
const JUDGE_FIXTURE_DIGEST = createHash("sha256")
	.update(
		JSON.stringify({
			messages_json: JUDGE_RUBRIC_FIXTURE.messages_json,
			variables_json: JUDGE_RUBRIC_FIXTURE.variables_json,
			notes: JUDGE_RUBRIC_FIXTURE.notes,
		}),
	)
	.digest("hex");
export const JUDGE_RUBRIC_DESCRIPTION = `${JUDGE_RUBRIC_FIXTURE.description} [promptgate-fixture:${JUDGE_FIXTURE_DIGEST}]`;

export class JudgeSeedError extends Error {
	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "JudgeSeedError";
	}
}

export interface JudgeSeedConfig {
	baseUrl: URL;
	adminToken: string;
}

export type JudgeSeedResult = "created" | "already_exists" | "repaired";

function validateSeedConfig(config: JudgeSeedConfig): void {
	if (
		!(config.baseUrl instanceof URL) ||
		(config.baseUrl.protocol !== "http:" &&
			config.baseUrl.protocol !== "https:") ||
		config.baseUrl.username.length > 0 ||
		config.baseUrl.password.length > 0 ||
		config.baseUrl.search.length > 0 ||
		config.baseUrl.hash.length > 0
	) {
		throw new JudgeSeedError(
			"Judge seed gateway URL must be an HTTP(S) URL without credentials, a query, or a fragment.",
		);
	}
	if (
		typeof config.adminToken !== "string" ||
		config.adminToken.trim().length < 16
	) {
		throw new JudgeSeedError(
			"Judge seed admin token must contain at least 16 non-whitespace characters.",
		);
	}
}

function adminUrl(baseUrl: URL, path: string): URL {
	const normalized = baseUrl.href.endsWith("/")
		? baseUrl
		: new URL(`${baseUrl.href}/`);
	return new URL(path, normalized);
}

async function parseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new JudgeSeedError("Judge seed admin response was not valid JSON.");
	}
}

async function post(
	fetcher: FetchLike,
	config: JudgeSeedConfig,
	path: string,
	body: unknown,
): Promise<Response> {
	try {
		return await fetcher(adminUrl(config.baseUrl, path), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-admin-token": config.adminToken,
			},
			body: JSON.stringify(body),
		});
	} catch {
		throw new JudgeSeedError("Judge seed admin request failed.");
	}
}

const PromptSummarySchema = z
	.object({
		slug: z.string(),
		description: z.string().nullable(),
		latest_version: z.number().int().positive().nullable(),
	})
	.passthrough();

async function existingPromptVersion(
	fetcher: FetchLike,
	config: JudgeSeedConfig,
): Promise<number | null> {
	let response: Response;
	try {
		response = await fetcher(adminUrl(config.baseUrl, "admin/api/prompts"), {
			headers: { "x-admin-token": config.adminToken },
		});
	} catch {
		throw new JudgeSeedError("Judge seed admin request failed.");
	}
	if (!response.ok) {
		throw new JudgeSeedError(
			`Judge seed prompt lookup failed with HTTP status ${response.status}.`,
		);
	}
	const prompts = z
		.array(PromptSummarySchema)
		.safeParse(await parseJson(response));
	if (!prompts.success) {
		throw new JudgeSeedError(
			"Judge seed prompt lookup returned an invalid result.",
		);
	}
	const existing = prompts.data.find(
		(prompt) => prompt.slug === JUDGE_RUBRIC_FIXTURE.slug,
	);
	if (existing?.description !== JUDGE_RUBRIC_DESCRIPTION) {
		throw new JudgeSeedError(
			"Judge rubric already exists but does not match the locked fixture marker.",
		);
	}
	if (existing.latest_version !== null && existing.latest_version !== 1) {
		throw new JudgeSeedError(
			"Judge rubric already exists with an incompatible version.",
		);
	}
	return existing.latest_version;
}

async function createVersion(
	fetcher: FetchLike,
	config: JudgeSeedConfig,
): Promise<void> {
	const version = await post(
		fetcher,
		config,
		`admin/api/prompts/${JUDGE_RUBRIC_FIXTURE.slug}/versions`,
		{
			messages_json: JUDGE_RUBRIC_FIXTURE.messages_json,
			variables_json: JUDGE_RUBRIC_FIXTURE.variables_json,
			notes: JUDGE_RUBRIC_FIXTURE.notes,
		},
	);
	if (!version.ok) {
		throw new JudgeSeedError(
			`Judge seed version creation failed with HTTP status ${version.status}.`,
		);
	}
	const createdVersion = CreatedVersionSchema.safeParse(
		await parseJson(version),
	);
	if (!createdVersion.success) {
		throw new JudgeSeedError(
			"Judge seed version creation returned an invalid result.",
		);
	}
}

/**
 * Creates exactly version 1, and recognizes only the same marker-bearing v1
 * fixture as an idempotent no-op. Anything else fails before mutation.
 */
export async function seedJudgeRubric(
	config: JudgeSeedConfig,
	fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<JudgeSeedResult> {
	validateSeedConfig(config);
	const created = await post(fetcher, config, "admin/api/prompts", {
		slug: JUDGE_RUBRIC_FIXTURE.slug,
		description: JUDGE_RUBRIC_DESCRIPTION,
	});
	if (created.status === 409) {
		const existingVersion = await existingPromptVersion(fetcher, config);
		if (existingVersion === 1) {
			return "already_exists";
		}
		await createVersion(fetcher, config);
		return "repaired";
	}
	if (!created.ok) {
		throw new JudgeSeedError(
			`Judge seed prompt creation failed with HTTP status ${created.status}.`,
		);
	}
	const createdPrompt = CreatedPromptSchema.safeParse(await parseJson(created));
	if (!createdPrompt.success) {
		throw new JudgeSeedError(
			"Judge seed prompt creation returned an invalid result.",
		);
	}

	await createVersion(fetcher, config);
	return "created";
}
