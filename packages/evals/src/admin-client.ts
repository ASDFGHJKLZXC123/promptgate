import { z } from "zod";

import type { FetchLike } from "./gateway-client.js";

export class EvalAdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalAdminError";
	}
}

export interface AdminConfig {
	baseUrl: URL;
	adminToken: string;
}

export interface PromptSummary {
	id: number;
	slug: string;
	latest_version: number | null;
	labels: readonly { label: string; version: number }[];
}

const PromptSummariesSchema = z.array(
	z
		.object({
			id: z.number().int().positive(),
			slug: z.string().min(1),
			latest_version: z.number().int().positive().nullable(),
			labels: z.array(
				z.object({
					label: z.string().min(1),
					version: z.number().int().positive(),
				}),
			),
		})
		.passthrough(),
);

function endpoint(baseUrl: URL, path: string): URL {
	const normalized = baseUrl.href.endsWith("/")
		? baseUrl
		: new URL(`${baseUrl.href}/`);
	return new URL(path, normalized);
}

export function resolveAdminConfig(
	input: {
		flags?: Readonly<{ gateway?: string; adminToken?: string }>;
		env?: Readonly<Record<string, string | undefined>>;
	} = {},
): AdminConfig {
	const flags = input.flags ?? {};
	const env = input.env ?? process.env;
	const rawUrl = flags.gateway ?? env.PG_GATEWAY_URL;
	const adminToken = flags.adminToken ?? env.PG_ADMIN_TOKEN;
	if (rawUrl === undefined || rawUrl.trim() === "")
		throw new EvalAdminError(
			"Gateway URL (--gateway or PG_GATEWAY_URL) is required.",
		);
	if (adminToken === undefined || adminToken.trim().length < 16)
		throw new EvalAdminError(
			"Admin token (--admin-token or PG_ADMIN_TOKEN) must contain at least 16 non-whitespace characters.",
		);
	let baseUrl: URL;
	try {
		baseUrl = new URL(rawUrl);
	} catch {
		throw new EvalAdminError("Gateway URL must be a valid HTTP(S) URL.");
	}
	if (
		!["http:", "https:"].includes(baseUrl.protocol) ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash
	)
		throw new EvalAdminError(
			"Gateway URL must be HTTP(S) without credentials, query, or fragment.",
		);
	return { baseUrl, adminToken };
}

export class AdminClient {
	private readonly config: AdminConfig;
	private readonly fetcher: FetchLike;

	constructor(
		config: AdminConfig,
		fetcher: FetchLike = globalThis.fetch.bind(globalThis),
	) {
		this.config = config;
		this.fetcher = fetcher;
	}
	private async request(
		path: string,
		init: RequestInit = {},
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetcher(endpoint(this.config.baseUrl, path), {
				...init,
				headers: {
					"x-admin-token": this.config.adminToken,
					"content-type": "application/json",
					...init.headers,
				},
			});
		} catch {
			throw new EvalAdminError("Admin request could not be completed.");
		}
		if (!response.ok)
			throw new EvalAdminError(
				`Admin request failed with HTTP status ${response.status}.`,
			);
		if (
			response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !==
			"application/json"
		)
			throw new EvalAdminError(
				"Admin response must have application/json content type.",
			);
		try {
			return await response.json();
		} catch {
			throw new EvalAdminError("Admin response was not valid JSON.");
		}
	}
	async promptSummaries(): Promise<readonly PromptSummary[]> {
		const parsed = PromptSummariesSchema.safeParse(
			await this.request("admin/api/prompts"),
		);
		if (!parsed.success)
			throw new EvalAdminError("Admin prompt response was invalid.");
		return parsed.data;
	}
	async upsertDataset(body: unknown): Promise<{ id: number }> {
		const parsed = z
			.object({ id: z.number().int().positive() })
			.passthrough()
			.safeParse(
				await this.request("admin/api/evals/datasets", {
					method: "POST",
					body: JSON.stringify(body),
				}),
			);
		if (!parsed.success)
			throw new EvalAdminError("Admin dataset response was invalid.");
		return parsed.data;
	}
	async createRun(body: unknown): Promise<void> {
		const expected = z
			.object({
				results: z
					.array(z.object({ case_id: z.string().min(1) }).passthrough())
					.min(1),
			})
			.passthrough()
			.safeParse(body);
		if (!expected.success)
			throw new EvalAdminError("Eval run request was invalid.");
		const expectedIds = new Set(
			expected.data.results.map((result) => result.case_id),
		);
		if (expectedIds.size !== expected.data.results.length)
			throw new EvalAdminError("Eval run request contains duplicate case IDs.");
		const payload = await this.request("admin/api/evals/runs", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const persisted = z
			.object({
				run: z.object({ id: z.number().int().positive() }).passthrough(),
				results: z.array(
					z.object({ case_id: z.string().min(1) }).passthrough(),
				),
			})
			.strict()
			.safeParse(payload);
		const persistedIds = persisted.success
			? new Set(persisted.data.results.map((result) => result.case_id))
			: undefined;
		if (
			!persisted.success ||
			persisted.data.results.length !== expectedIds.size ||
			persistedIds?.size !== expectedIds.size ||
			persisted.data.results.some((result) => !expectedIds.has(result.case_id))
		)
			throw new EvalAdminError(
				"Admin eval run response did not confirm every result.",
			);
	}
	async historicalRuns(query: URLSearchParams): Promise<unknown> {
		return this.request(`admin/api/evals/runs?${query.toString()}`);
	}
}
