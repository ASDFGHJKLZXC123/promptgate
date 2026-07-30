import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CiSeedError,
	SAFETY_SCREEN_DESCRIPTION,
	SAFETY_SCREEN_FIXTURE,
	SAFETY_SCREEN_VERSION_DIGESTS,
	seedCi,
} from "./ci-seed.js";
import type { FetchLike } from "./gateway-client.js";
import { JUDGE_RUBRIC_DESCRIPTION } from "./judge-seed.js";

const adminToken = "ci-admin-token-123456789";
const gatewayKey = `pg-${"a".repeat(48)}`;
const otherGatewayKey = `pg-${"b".repeat(48)}`;
const temporaryDirectories: string[] = [];

interface StoredKey {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	plaintext: string;
}

interface StoredPrompt {
	id: number;
	slug: string;
	description: string | null;
	versions: unknown[];
	labels: Map<string, number>;
}

interface SeedState {
	keys: StoredKey[];
	prompts: StoredPrompt[];
	datasets: unknown[];
	labelWrites: number;
}

interface SeedGatewayOptions {
	beforeKeyCreate?: () => void;
	keyCreateResponseStatus?: number;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function createSeedGateway(
	initial: Partial<SeedState> = {},
	options: SeedGatewayOptions = {},
): {
	fetcher: ReturnType<typeof vi.fn<FetchLike>>;
	state: SeedState;
} {
	const state: SeedState = {
		keys: initial.keys ?? [],
		prompts: initial.prompts ?? [],
		datasets: initial.datasets ?? [],
		labelWrites: initial.labelWrites ?? 0,
	};
	const fetcher = vi.fn<FetchLike>(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			const path = url.pathname.replace(/^\/base/, "");

			if (path.startsWith("/admin/")) {
				if (headers.get("x-admin-token") !== adminToken) {
					return json({ error: "unauthorized" }, 401);
				}
			}

			if (path === "/admin/api/keys" && method === "GET") {
				return json(
					state.keys.map(({ plaintext: _plaintext, ...summary }) => summary),
				);
			}
			if (path === "/admin/api/keys" && method === "POST") {
				options.beforeKeyCreate?.();
				const body = requestBody(init);
				if (state.keys.some((key) => key.name === body.name)) {
					return json({ error: "conflict" }, 409);
				}
				state.keys.push({
					id: state.keys.length + 1,
					name: String(body.name),
					budget_micro_usd_month: Number(body.budget_micro_usd_month),
					rate_limit_rpm: Number(body.rate_limit_rpm),
					disabled: false,
					plaintext: gatewayKey,
				});
				return json(
					{ plaintext_key: gatewayKey },
					options.keyCreateResponseStatus,
				);
			}
			if (path === "/v1/models" && method === "GET") {
				const plaintext = headers
					.get("authorization")
					?.replace(/^Bearer[ \t]+/i, "");
				if (
					!state.keys.some(
						(key) => key.plaintext === plaintext && !key.disabled,
					)
				) {
					return json({ error: "unauthorized" }, 401);
				}
				return json({
					object: "list",
					data: [
						{
							id: "deepseek-v4-flash",
							object: "model",
							owned_by: "deepseek",
						},
					],
				});
			}
			if (path === "/admin/api/prompts" && method === "GET") {
				return json(
					state.prompts.map((prompt) => ({
						id: prompt.id,
						slug: prompt.slug,
						description: prompt.description,
						latest_version:
							prompt.versions.length === 0 ? null : prompt.versions.length,
						labels: [...prompt.labels].map(([label, version]) => ({
							label,
							version,
						})),
					})),
				);
			}
			if (path === "/admin/api/prompts" && method === "POST") {
				const body = requestBody(init);
				if (state.prompts.some((prompt) => prompt.slug === body.slug)) {
					return json({ error: "conflict" }, 409);
				}
				const prompt: StoredPrompt = {
					id: state.prompts.length + 1,
					slug: String(body.slug),
					description:
						body.description === null ? null : String(body.description),
					versions: [],
					labels: new Map(),
				};
				state.prompts.push(prompt);
				return json({ id: prompt.id });
			}
			const versionMatch = /^\/admin\/api\/prompts\/([^/]+)\/versions$/.exec(
				path,
			);
			if (versionMatch && method === "POST") {
				const prompt = state.prompts.find(
					(candidate) => candidate.slug === versionMatch[1],
				);
				if (!prompt) return json({ error: "missing" }, 404);
				prompt.versions.push(requestBody(init));
				return json({ version: prompt.versions.length });
			}
			const labelMatch =
				/^\/admin\/api\/prompts\/([^/]+)\/labels\/([^/]+)$/.exec(path);
			if (labelMatch && method === "PUT") {
				const prompt = state.prompts.find(
					(candidate) => candidate.slug === labelMatch[1],
				);
				if (!prompt) return json({ error: "missing" }, 404);
				const version = Number(requestBody(init).version);
				prompt.labels.set(String(labelMatch[2]), version);
				state.labelWrites += 1;
				return json({
					label: labelMatch[2],
					to_version: version,
				});
			}
			if (path === "/admin/api/evals/datasets" && method === "POST") {
				const body = requestBody(init);
				const index = state.datasets.findIndex(
					(candidate) => (candidate as { slug?: unknown }).slug === body.slug,
				);
				if (index === -1) {
					state.datasets.push(body);
				} else {
					state.datasets[index] = body;
				}
				return json(
					{ id: index === -1 ? state.datasets.length : index + 1 },
					201,
				);
			}
			return json({ error: "not found" }, 404);
		},
	);
	return { fetcher, state };
}

function temporaryKeyFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "promptgate-ci-seed-"));
	temporaryDirectories.push(directory);
	return join(directory, "ci-eval.key");
}

function config(keyFile: string) {
	return {
		admin: {
			baseUrl: new URL("https://gateway.example/base"),
			adminToken,
		},
		keyFile,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Phase 6 CI seed", () => {
	test("preserves the certified good and degraded prompt request bodies", () => {
		expect(SAFETY_SCREEN_VERSION_DIGESTS).toEqual([
			"f8da4cd3b3ba21b17c2525ea5f7dd5767bf9bfc026c66f0175649e351632c944",
			"4f9969b7d21e0526eabeaa04fe31e89b218fba71ee4695ffd9609c7db5908652",
		]);
		expect(
			SAFETY_SCREEN_FIXTURE.versions.map((version) =>
				createHash("sha256").update(JSON.stringify(version)).digest("hex"),
			),
		).toEqual(SAFETY_SCREEN_VERSION_DIGESTS);
		expect(SAFETY_SCREEN_FIXTURE.labels).toEqual({
			prod: 1,
			candidate: 1,
		});
	});

	test("creates the exact key, prompts, labels, and dataset, then reuses them without duplicate writes", async () => {
		const keyFile = temporaryKeyFile();
		let observedReservation = false;
		const { fetcher, state } = createSeedGateway(
			{},
			{
				beforeKeyCreate: () => {
					expect(readFileSync(keyFile, "utf8")).toBe("");
					expect(statSync(keyFile).mode & 0o777).toBe(0o600);
					observedReservation = true;
				},
			},
		);

		await expect(seedCi(config(keyFile), fetcher)).resolves.toEqual({
			key: "created",
			safetyPrompt: "created",
			judgePrompt: "created",
			datasetId: 1,
		});
		expect(observedReservation).toBe(true);
		expect(state.keys).toEqual([
			{
				id: 1,
				name: "ci-evals",
				budget_micro_usd_month: 1_000_000,
				rate_limit_rpm: 1_000,
				disabled: false,
				plaintext: gatewayKey,
			},
		]);
		expect(readFileSync(keyFile, "utf8")).toBe(gatewayKey);
		expect(statSync(keyFile).mode & 0o077).toBe(0);

		const safety = state.prompts.find(
			(prompt) => prompt.slug === "safety_screen",
		);
		expect(safety).toMatchObject({
			description: SAFETY_SCREEN_DESCRIPTION,
			versions: SAFETY_SCREEN_FIXTURE.versions,
		});
		expect(Object.fromEntries(safety?.labels ?? [])).toEqual({
			prod: 1,
			candidate: 1,
		});
		expect(
			state.prompts.find((prompt) => prompt.slug === "judge_rubric_v1"),
		).toMatchObject({
			description: JUDGE_RUBRIC_DESCRIPTION,
			versions: [expect.any(Object)],
		});
		expect(state.datasets).toHaveLength(1);
		expect(state.datasets[0]).toMatchObject({
			slug: "safety_screening",
			description: expect.any(String),
		});
		const writesAfterFirstSeed = state.labelWrites;
		const versionsAfterFirstSeed = state.prompts.map(
			(prompt) => prompt.versions.length,
		);

		await expect(seedCi(config(keyFile), fetcher)).resolves.toEqual({
			key: "reused",
			safetyPrompt: "already_exists",
			judgePrompt: "already_exists",
			datasetId: 1,
		});
		expect(state.keys).toHaveLength(1);
		expect(state.labelWrites).toBe(writesAfterFirstSeed);
		expect(state.prompts.map((prompt) => prompt.versions.length)).toEqual(
			versionsAfterFirstSeed,
		);
		expect(state.datasets).toHaveLength(1);
	});

	test("recovers partial prompt creation without duplicating existing versions", async () => {
		const keyFile = temporaryKeyFile();
		writeFileSync(keyFile, gatewayKey, { mode: 0o600 });
		const { fetcher, state } = createSeedGateway({
			keys: [
				{
					id: 1,
					name: "ci-evals",
					budget_micro_usd_month: 1_000_000,
					rate_limit_rpm: 1_000,
					disabled: false,
					plaintext: gatewayKey,
				},
			],
			prompts: [
				{
					id: 1,
					slug: "safety_screen",
					description: SAFETY_SCREEN_DESCRIPTION,
					versions: [SAFETY_SCREEN_FIXTURE.versions[0]],
					labels: new Map(),
				},
			],
		});

		await expect(seedCi(config(keyFile), fetcher)).resolves.toMatchObject({
			key: "reused",
			safetyPrompt: "repaired",
			judgePrompt: "created",
		});
		expect(
			state.prompts.find((prompt) => prompt.slug === "safety_screen")?.versions,
		).toEqual(SAFETY_SCREEN_FIXTURE.versions);
	});

	test("fails closed for a missing handoff file or incompatible existing seed state", async () => {
		const missingFile = temporaryKeyFile();
		const existingKey = createSeedGateway({
			keys: [
				{
					id: 1,
					name: "ci-evals",
					budget_micro_usd_month: 1_000_000,
					rate_limit_rpm: 1_000,
					disabled: false,
					plaintext: gatewayKey,
				},
			],
		});
		await expect(
			seedCi(config(missingFile), existingKey.fetcher),
		).rejects.toThrow("discard and recreate the ephemeral gateway");
		expect(existingKey.state.prompts).toHaveLength(0);

		const staleFile = temporaryKeyFile();
		writeFileSync(staleFile, gatewayKey, { mode: 0o600 });
		const missingKey = createSeedGateway();
		await expect(seedCi(config(staleFile), missingKey.fetcher)).rejects.toThrow(
			"handoff path must be absent",
		);
		expect(readFileSync(staleFile, "utf8")).toBe(gatewayKey);
		expect(missingKey.state.keys).toHaveLength(0);

		const incompatibleFile = temporaryKeyFile();
		writeFileSync(incompatibleFile, gatewayKey, { mode: 0o600 });
		const incompatible = createSeedGateway({
			keys: [
				{
					id: 1,
					name: "ci-evals",
					budget_micro_usd_month: 999_999,
					rate_limit_rpm: 1_000,
					disabled: false,
					plaintext: gatewayKey,
				},
			],
		});
		await expect(
			seedCi(config(incompatibleFile), incompatible.fetcher),
		).rejects.toThrow(CiSeedError);
		expect(incompatible.state.prompts).toHaveLength(0);
	});

	test("rejects multiple gateway keys even when the handoff authenticates as another enabled key", async () => {
		const keyFile = temporaryKeyFile();
		writeFileSync(keyFile, otherGatewayKey, { mode: 0o600 });
		const { fetcher, state } = createSeedGateway({
			keys: [
				{
					id: 1,
					name: "ci-evals",
					budget_micro_usd_month: 1_000_000,
					rate_limit_rpm: 1_000,
					disabled: false,
					plaintext: gatewayKey,
				},
				{
					id: 2,
					name: "unbounded-other-key",
					budget_micro_usd_month: 50_000_000,
					rate_limit_rpm: 10_000,
					disabled: false,
					plaintext: otherGatewayKey,
				},
			],
		});

		await expect(seedCi(config(keyFile), fetcher)).rejects.toThrow(
			"exactly one key named ci-evals",
		);
		expect(state.prompts).toHaveLength(0);
		expect(state.datasets).toHaveLength(0);
		expect(
			fetcher.mock.calls.some(([input]) =>
				new URL(String(input)).pathname.endsWith("/v1/models"),
			),
		).toBe(false);
	});

	test("retains the reserved handoff marker and requires Recovery A after an ambiguous key-creation failure", async () => {
		const keyFile = temporaryKeyFile();
		const { fetcher, state } = createSeedGateway(
			{},
			{ keyCreateResponseStatus: 500 },
		);

		await expect(seedCi(config(keyFile), fetcher)).rejects.toThrow(
			"discard and recreate the ephemeral gateway",
		);
		expect(state.keys).toHaveLength(1);
		expect(readFileSync(keyFile, "utf8")).toBe("");
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		expect(state.prompts).toHaveLength(0);
		expect(state.datasets).toHaveLength(0);

		await expect(seedCi(config(keyFile), fetcher)).rejects.toThrow(
			"discard and recreate the ephemeral gateway",
		);
		expect(state.keys).toHaveLength(1);
	});

	test("rejects an incompatible marker-bearing prompt before adding versions or labels", async () => {
		const keyFile = temporaryKeyFile();
		const { fetcher, state } = createSeedGateway({
			prompts: [
				{
					id: 1,
					slug: "safety_screen",
					description: "untrusted prompt",
					versions: [],
					labels: new Map(),
				},
			],
		});

		await expect(seedCi(config(keyFile), fetcher)).rejects.toThrow(
			"incompatible with the locked fixture",
		);
		expect(state.prompts[0]?.versions).toHaveLength(0);
		expect(state.labelWrites).toBe(0);
	});
});
