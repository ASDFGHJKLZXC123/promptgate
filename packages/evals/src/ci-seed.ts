import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readFile,
	rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import fixture from "../fixtures/prompts/safety_screen.json" with {
	type: "json",
};
import type { AdminConfig } from "./admin-client.js";
import { loadDataset } from "./dataset.js";
import type { FetchLike } from "./gateway-client.js";
import type { JudgeSeedResult } from "./judge-seed.js";

const CI_KEY_NAME = "ci-evals";
const CI_KEY_BUDGET_MICRO_USD = 1_000_000;
const CI_KEY_RATE_LIMIT_RPM = 1_000;
const CERTIFIED_GOOD_DIGEST =
	"f8da4cd3b3ba21b17c2525ea5f7dd5767bf9bfc026c66f0175649e351632c944";
const CERTIFIED_DEGRADED_DIGEST =
	"4f9969b7d21e0526eabeaa04fe31e89b218fba71ee4695ffd9609c7db5908652";

const PromptVersionSchema = z
	.object({
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
						name: z.literal("note"),
						required: z.literal(true),
					})
					.strict(),
			)
			.length(1),
		notes: z.string().trim().min(1),
	})
	.strict();

const SafetyFixtureSchema = z
	.object({
		slug: z.literal("safety_screen"),
		description: z.string().trim().min(1),
		versions: z.tuple([PromptVersionSchema, PromptVersionSchema]),
		labels: z
			.object({
				prod: z.literal(1),
				candidate: z.union([z.literal(1), z.literal(2)]),
			})
			.strict(),
	})
	.strict();

const ApiKeySummarySchema = z
	.object({
		id: z.number().int().positive().safe(),
		name: z.string().min(1),
		budget_micro_usd_month: z.number().int().nonnegative().safe(),
		rate_limit_rpm: z.number().int().positive().safe(),
		disabled: z.boolean(),
	})
	.passthrough();
const ApiKeySummariesSchema = z.array(ApiKeySummarySchema);
const CreatedApiKeySchema = z
	.object({
		plaintext_key: z.string().regex(/^pg-[a-f0-9]{48}$/),
	})
	.strict();
const PromptSummarySchema = z
	.object({
		id: z.number().int().positive().safe(),
		slug: z.string().min(1),
		description: z.string().nullable(),
		latest_version: z.number().int().positive().safe().nullable(),
		labels: z.array(
			z.object({
				label: z.string().min(1),
				version: z.number().int().positive().safe(),
			}),
		),
	})
	.passthrough();
const PromptSummariesSchema = z.array(PromptSummarySchema);
const CreatedPromptSchema = z
	.object({ id: z.number().int().positive().safe() })
	.passthrough();
const CreatedVersionSchema = z
	.object({ version: z.number().int().positive().safe() })
	.passthrough();
const LabelResultSchema = z
	.object({
		label: z.string().min(1),
		to_version: z.number().int().positive().safe(),
	})
	.passthrough();
const DatasetResultSchema = z
	.object({ id: z.number().int().positive().safe() })
	.passthrough();
const ModelsResultSchema = z
	.object({
		object: z.literal("list"),
		data: z.array(
			z
				.object({
					id: z.string().min(1),
					object: z.literal("model"),
				})
				.passthrough(),
		),
	})
	.passthrough();

export class CiSeedError extends Error {
	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = "CiSeedError";
	}
}

export interface CiSeedConfig {
	admin: AdminConfig;
	keyFile: string;
}

export interface CiSeedResult {
	key: "created" | "reused";
	safetyPrompt: "created" | "repaired" | "already_exists";
	judgePrompt: JudgeSeedResult;
	datasetId: number;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safetyFixture() {
	const parsed = SafetyFixtureSchema.safeParse(fixture);
	if (!parsed.success) {
		throw new CiSeedError("The CI safety prompt fixture is invalid.");
	}
	if (
		sha256(parsed.data.versions[0]) !== CERTIFIED_GOOD_DIGEST ||
		sha256(parsed.data.versions[1]) !== CERTIFIED_DEGRADED_DIGEST
	) {
		throw new CiSeedError(
			"The CI safety prompt fixture does not match the certified Phase 5 prompts.",
		);
	}
	return parsed.data;
}

const checkedFixture = safetyFixture();
export const SAFETY_SCREEN_FIXTURE = checkedFixture;
export const SAFETY_SCREEN_VERSION_DIGESTS = [
	sha256(checkedFixture.versions[0]),
	sha256(checkedFixture.versions[1]),
] as const;
const SAFETY_FIXTURE_MARKER = sha256({
	versions: checkedFixture.versions,
});
export const SAFETY_SCREEN_DESCRIPTION = `${checkedFixture.description} [promptgate-fixture:${SAFETY_FIXTURE_MARKER}]`;

function endpoint(baseUrl: URL, path: string): URL {
	const normalized = baseUrl.href.endsWith("/")
		? baseUrl
		: new URL(`${baseUrl.href}/`);
	return new URL(path, normalized);
}

async function responseJson(
	response: Response,
	context: string,
): Promise<unknown> {
	if (
		response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !==
		"application/json"
	) {
		throw new CiSeedError(`${context} did not return JSON.`);
	}
	try {
		return await response.json();
	} catch {
		throw new CiSeedError(`${context} returned invalid JSON.`);
	}
}

async function adminRequest(
	fetcher: FetchLike,
	config: AdminConfig,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	try {
		return await fetcher(endpoint(config.baseUrl, path), {
			...init,
			headers: {
				"x-admin-token": config.adminToken,
				...(init.body === undefined
					? {}
					: { "content-type": "application/json" }),
				...init.headers,
			},
		});
	} catch {
		throw new CiSeedError("The CI seed admin request could not be completed.");
	}
}

async function parsedAdminRequest<T>(
	fetcher: FetchLike,
	config: AdminConfig,
	path: string,
	schema: z.ZodType<T>,
	init: RequestInit = {},
): Promise<T> {
	const response = await adminRequest(fetcher, config, path, init);
	if (!response.ok) {
		throw new CiSeedError(
			`The CI seed admin request failed with HTTP status ${response.status}.`,
		);
	}
	const parsed = schema.safeParse(
		await responseJson(response, "CI seed admin"),
	);
	if (!parsed.success) {
		throw new CiSeedError("The CI seed admin response was invalid.");
	}
	return parsed.data;
}

async function listKeys(
	fetcher: FetchLike,
	config: AdminConfig,
): Promise<z.infer<typeof ApiKeySummariesSchema>> {
	return parsedAdminRequest(
		fetcher,
		config,
		"admin/api/keys",
		ApiKeySummariesSchema,
	);
}

async function listPrompts(
	fetcher: FetchLike,
	config: AdminConfig,
): Promise<z.infer<typeof PromptSummariesSchema>> {
	return parsedAdminRequest(
		fetcher,
		config,
		"admin/api/prompts",
		PromptSummariesSchema,
	);
}

async function readSecureKeyFile(path: string): Promise<string | undefined> {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		throw new CiSeedError("The CI key handoff file could not be inspected.");
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new CiSeedError("The CI key handoff path must be a regular file.");
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new CiSeedError(
			"The CI key handoff file must not be accessible by group or other users.",
		);
	}
	let candidate: string;
	try {
		candidate = await readFile(path, "utf8");
	} catch {
		throw new CiSeedError("The CI key handoff file could not be read.");
	}
	if (!/^pg-[a-f0-9]{48}$/.test(candidate)) {
		throw new CiSeedError("The CI key handoff file is invalid.");
	}
	return candidate;
}

interface KeyFileReservation {
	handle: FileHandle;
}

const RECOVERY_A_INSTRUCTION =
	"discard and recreate the ephemeral gateway, database, and key handoff before rerunning";

async function reserveSecureKeyFile(path: string): Promise<KeyFileReservation> {
	const parent = dirname(path);
	let handle: FileHandle | undefined;
	try {
		await mkdir(parent, { recursive: true, mode: 0o700 });
		handle = await open(path, "wx", 0o600);
		await handle.chmod(0o600);
		await handle.sync();
		return { handle };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (handle) {
			await rm(path, { force: true }).catch(() => undefined);
		}
		throw new CiSeedError(
			"The CI key handoff path must be absent, writable, and reservable before gateway key creation.",
			{ cause: error },
		);
	}
}

async function publishSecureKeyFile(
	reservation: KeyFileReservation,
	key: string,
): Promise<void> {
	try {
		await reservation.handle.writeFile(key, "utf8");
		await reservation.handle.sync();
		await reservation.handle.close();
	} catch (error) {
		await reservation.handle.close().catch(() => undefined);
		throw new CiSeedError(
			`The CI gateway key may have been created but its secure handoff did not complete; ${RECOVERY_A_INSTRUCTION}.`,
			{ cause: error },
		);
	}
}

async function verifyClientKey(
	fetcher: FetchLike,
	config: AdminConfig,
	key: string,
): Promise<void> {
	let response: Response;
	try {
		response = await fetcher(endpoint(config.baseUrl, "v1/models"), {
			headers: { authorization: `Bearer ${key}` },
		});
	} catch {
		throw new CiSeedError("The saved CI gateway key could not be verified.");
	}
	if (!response.ok) {
		throw new CiSeedError("The saved CI gateway key was not accepted.");
	}
	const parsed = ModelsResultSchema.safeParse(
		await responseJson(response, "CI key verification"),
	);
	if (!parsed.success) {
		throw new CiSeedError("The CI key verification response was invalid.");
	}
}

async function ensureCiKey(
	fetcher: FetchLike,
	config: AdminConfig,
	keyFile: string,
): Promise<"created" | "reused"> {
	const keys = await listKeys(fetcher, config);
	if (keys.length > 0) {
		if (keys.length !== 1 || keys[0]?.name !== CI_KEY_NAME) {
			throw new CiSeedError(
				"The CI seed requires either zero gateway keys initially or exactly one key named ci-evals on reuse.",
			);
		}
		const existing = keys[0];
		if (
			existing.budget_micro_usd_month !== CI_KEY_BUDGET_MICRO_USD ||
			existing.rate_limit_rpm !== CI_KEY_RATE_LIMIT_RPM ||
			existing.disabled
		) {
			throw new CiSeedError(
				"The existing CI gateway key does not match the locked budget, rate, and enabled state.",
			);
		}
		let key: string | undefined;
		try {
			key = await readSecureKeyFile(keyFile);
		} catch (error) {
			throw new CiSeedError(
				`The only CI gateway key has no valid secure handoff; ${RECOVERY_A_INSTRUCTION}.`,
				{ cause: error },
			);
		}
		if (key === undefined) {
			throw new CiSeedError(
				`The only CI gateway key has no secure handoff; ${RECOVERY_A_INSTRUCTION}.`,
			);
		}
		try {
			await verifyClientKey(fetcher, config, key);
		} catch (error) {
			throw new CiSeedError(
				`The secure handoff does not authenticate as the only CI gateway key; ${RECOVERY_A_INSTRUCTION}.`,
				{ cause: error },
			);
		}
		const verifiedKeys = await listKeys(fetcher, config);
		if (
			verifiedKeys.length !== 1 ||
			verifiedKeys[0]?.id !== existing.id ||
			verifiedKeys[0]?.name !== CI_KEY_NAME ||
			verifiedKeys[0]?.budget_micro_usd_month !== CI_KEY_BUDGET_MICRO_USD ||
			verifiedKeys[0]?.rate_limit_rpm !== CI_KEY_RATE_LIMIT_RPM ||
			verifiedKeys[0]?.disabled
		) {
			throw new CiSeedError(
				"The CI gateway key inventory changed during verification; discard and recreate the ephemeral gateway, database, and key handoff.",
			);
		}
		return "reused";
	}

	const reservation = await reserveSecureKeyFile(keyFile);
	let created: z.infer<typeof CreatedApiKeySchema>;
	try {
		created = await parsedAdminRequest(
			fetcher,
			config,
			"admin/api/keys",
			CreatedApiKeySchema,
			{
				method: "POST",
				body: JSON.stringify({
					name: CI_KEY_NAME,
					budget_micro_usd_month: CI_KEY_BUDGET_MICRO_USD,
					rate_limit_rpm: CI_KEY_RATE_LIMIT_RPM,
				}),
			},
		);
	} catch (error) {
		await reservation.handle.close().catch(() => undefined);
		throw new CiSeedError(
			`CI gateway key creation did not return a durable handoff; ${RECOVERY_A_INSTRUCTION}.`,
			{ cause: error },
		);
	}
	await publishSecureKeyFile(reservation, created.plaintext_key);
	let persisted: string | undefined;
	try {
		persisted = await readSecureKeyFile(keyFile);
		await verifyClientKey(fetcher, config, persisted ?? "");
	} catch (error) {
		throw new CiSeedError(
			`The created CI gateway key could not be verified from its secure handoff; ${RECOVERY_A_INSTRUCTION}.`,
			{ cause: error },
		);
	}
	if (persisted !== created.plaintext_key) {
		throw new CiSeedError(
			`The created CI gateway key did not match its secure handoff; ${RECOVERY_A_INSTRUCTION}.`,
		);
	}
	const createdKeys = await listKeys(fetcher, config);
	if (
		createdKeys.length !== 1 ||
		createdKeys[0]?.name !== CI_KEY_NAME ||
		createdKeys[0]?.budget_micro_usd_month !== CI_KEY_BUDGET_MICRO_USD ||
		createdKeys[0]?.rate_limit_rpm !== CI_KEY_RATE_LIMIT_RPM ||
		createdKeys[0]?.disabled
	) {
		throw new CiSeedError(
			`The fresh gateway did not retain exactly the locked ci-evals key; ${RECOVERY_A_INSTRUCTION}.`,
		);
	}
	return "created";
}

async function addSafetyVersion(
	fetcher: FetchLike,
	config: AdminConfig,
	version: 1 | 2,
): Promise<void> {
	const created = await parsedAdminRequest(
		fetcher,
		config,
		`admin/api/prompts/${SAFETY_SCREEN_FIXTURE.slug}/versions`,
		CreatedVersionSchema,
		{
			method: "POST",
			body: JSON.stringify(SAFETY_SCREEN_FIXTURE.versions[version - 1]),
		},
	);
	if (created.version !== version) {
		throw new CiSeedError(
			"The CI safety prompt version sequence was incompatible.",
		);
	}
}

async function ensureSafetyPrompt(
	fetcher: FetchLike,
	config: AdminConfig,
): Promise<"created" | "repaired" | "already_exists"> {
	const created = await adminRequest(fetcher, config, "admin/api/prompts", {
		method: "POST",
		body: JSON.stringify({
			slug: SAFETY_SCREEN_FIXTURE.slug,
			description: SAFETY_SCREEN_DESCRIPTION,
		}),
	});
	let status: "created" | "repaired" | "already_exists";
	if (created.ok) {
		const parsed = CreatedPromptSchema.safeParse(
			await responseJson(created, "CI safety prompt creation"),
		);
		if (!parsed.success) {
			throw new CiSeedError(
				"The CI safety prompt creation response was invalid.",
			);
		}
		await addSafetyVersion(fetcher, config, 1);
		await addSafetyVersion(fetcher, config, 2);
		status = "created";
	} else if (created.status === 409) {
		const existing = (await listPrompts(fetcher, config)).find(
			(prompt) => prompt.slug === SAFETY_SCREEN_FIXTURE.slug,
		);
		if (
			!existing ||
			existing.description !== SAFETY_SCREEN_DESCRIPTION ||
			(existing.latest_version !== null && existing.latest_version > 2)
		) {
			throw new CiSeedError(
				"The existing CI safety prompt is incompatible with the locked fixture.",
			);
		}
		for (
			let version = (existing.latest_version ?? 0) + 1;
			version <= 2;
			version += 1
		) {
			await addSafetyVersion(fetcher, config, version as 1 | 2);
		}
		status = existing.latest_version === 2 ? "already_exists" : "repaired";
	} else {
		throw new CiSeedError(
			`The CI safety prompt creation failed with HTTP status ${created.status}.`,
		);
	}

	const summary = (await listPrompts(fetcher, config)).find(
		(prompt) => prompt.slug === SAFETY_SCREEN_FIXTURE.slug,
	);
	if (
		!summary ||
		summary.description !== SAFETY_SCREEN_DESCRIPTION ||
		summary.latest_version !== 2
	) {
		throw new CiSeedError("The seeded CI safety prompt was invalid.");
	}
	for (const [label, version] of Object.entries(SAFETY_SCREEN_FIXTURE.labels)) {
		if (
			summary.labels.find((candidate) => candidate.label === label)?.version ===
			version
		) {
			continue;
		}
		const moved = await parsedAdminRequest(
			fetcher,
			config,
			`admin/api/prompts/${SAFETY_SCREEN_FIXTURE.slug}/labels/${label}`,
			LabelResultSchema,
			{
				method: "PUT",
				body: JSON.stringify({ version }),
			},
		);
		if (moved.label !== label || moved.to_version !== version) {
			throw new CiSeedError("The CI safety prompt label response was invalid.");
		}
	}
	return status;
}

async function seedJudge(
	config: AdminConfig,
	fetcher: FetchLike,
): Promise<JudgeSeedResult> {
	const source =
		import.meta.url.endsWith(".ts") &&
		existsSync(new URL("./judge-seed.ts", import.meta.url));
	const module = source
		? await import(new URL("./judge-seed.ts", import.meta.url).href)
		: await import("./judge-seed.js");
	return module.seedJudgeRubric(config, fetcher);
}

function validateConfig(config: CiSeedConfig): string {
	if (
		!(config.admin.baseUrl instanceof URL) ||
		!["http:", "https:"].includes(config.admin.baseUrl.protocol) ||
		config.admin.baseUrl.username ||
		config.admin.baseUrl.password ||
		config.admin.baseUrl.search ||
		config.admin.baseUrl.hash
	) {
		throw new CiSeedError(
			"The CI seed gateway URL must be HTTP(S) without credentials, query, or fragment.",
		);
	}
	if (config.admin.adminToken.trim().length < 16) {
		throw new CiSeedError(
			"The CI seed admin token must contain at least 16 non-whitespace characters.",
		);
	}
	if (config.keyFile.trim() === "") {
		throw new CiSeedError("PG_EVAL_KEY_FILE is required for pg-eval seed-ci.");
	}
	return resolve(config.keyFile);
}

export async function seedCi(
	config: CiSeedConfig,
	fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<CiSeedResult> {
	const keyFile = validateConfig(config);
	const dataset = await loadDataset(
		fileURLToPath(
			new URL("../datasets/safety_screening.yaml", import.meta.url),
		),
	);
	if (
		dataset.prompts.length !== 1 ||
		dataset.prompts[0] !== "safety_screen@candidate" ||
		dataset.providers.length !== 1 ||
		dataset.providers[0] !== "deepseek-v4-flash" ||
		dataset.tests.length !== 50 ||
		dataset.defaultTest.threshold !== 0.8
	) {
		throw new CiSeedError(
			"The CI dataset does not match the approved one-target safety gate.",
		);
	}

	const key = await ensureCiKey(fetcher, config.admin, keyFile);
	const safetyPrompt = await ensureSafetyPrompt(fetcher, config.admin);
	const judgePrompt = await seedJudge(config.admin, fetcher);
	const datasetRow = await parsedAdminRequest(
		fetcher,
		config.admin,
		"admin/api/evals/datasets",
		DatasetResultSchema,
		{
			method: "POST",
			body: JSON.stringify({
				slug: "safety_screening",
				file_path: dataset.path,
				description: dataset.description,
			}),
		},
	);
	return {
		key,
		safetyPrompt,
		judgePrompt,
		datasetId: datasetRow.id,
	};
}
