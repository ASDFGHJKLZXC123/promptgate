import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ADMIN_TOKEN = "promptgate-evals-admin-token";
const HASH = "a".repeat(64);

let tempDbDir: string | undefined;
let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-admin-evals-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	await vi.resetModules();
});

afterEach(() => {
	if (previousDbPath === undefined) delete process.env.DB_PATH;
	else process.env.DB_PATH = previousDbPath;
	if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
	else process.env.ADMIN_TOKEN = previousAdminToken;
	if (tempDbDir) rmSync(tempDbDir, { recursive: true, force: true });
	tempDbDir = undefined;
});

function headers(): Record<string, string> {
	return { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" };
}

async function buildTestServer() {
	const { buildServer } = await import("../server.js");
	return buildServer();
}

async function createDataset(
	server: Awaited<ReturnType<typeof buildTestServer>>,
) {
	return server.inject({
		method: "POST",
		url: "/admin/api/evals/datasets",
		headers: headers(),
		body: JSON.stringify({
			slug: "safety_screening",
			file_path: "packages/evals/datasets/safety_screening.yaml",
			description: "Safety suite",
		}),
	});
}

function runBody(datasetId: number) {
	return {
		dataset_id: datasetId,
		dataset_hash: HASH,
		prompt_id: 1,
		prompt_version: 2,
		prompt_ref: "safety_screen@candidate",
		model: "gpt-5.6-luna",
		git_sha: "abc1234",
		trigger: "ci" as const,
		cases_total: 2,
		cases_passed: 1,
		score_avg: 0.8,
		cost_micro_usd: 9,
		duration_ms: 80,
		results: [
			{
				case_id: "urgent-self-harm",
				passed: true,
				score: 0.8,
				detail_json: { assertions: [{ type: "contains", pass: true }] },
				latency_ms: 40,
				cost_micro_usd: 4,
			},
			{
				case_id: "benign-scheduling",
				passed: false,
				detail_json: { assertions: [{ type: "javascript", pass: false }] },
				latency_ms: 40,
				cost_micro_usd: 5,
			},
		],
	};
}

describe("admin eval persistence API", () => {
	test("requires the existing admin token", async () => {
		const server = await buildTestServer();
		try {
			const response = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs",
			});
			expect(response.statusCode).toBe(401);
			expect(response.json()).toMatchObject({
				error: { code: "invalid_admin_token" },
			});
		} finally {
			await server.close();
		}
	});

	test("upserts a dataset and atomically persists a run with JSON results", async () => {
		const server = await buildTestServer();
		try {
			const firstDataset = await createDataset(server);
			const sameDataset = await createDataset(server);
			expect(firstDataset.statusCode).toBe(201);
			expect(sameDataset.statusCode).toBe(201);
			const dataset = firstDataset.json() as { id: number };
			expect(sameDataset.json()).toMatchObject({ id: dataset.id });

			const persisted = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(runBody(dataset.id)),
			});
			expect(persisted.statusCode).toBe(201);
			const payload = persisted.json() as {
				run: { id: number; dataset_slug: string };
				results: Array<{ detail_json: unknown }>;
			};
			expect(payload.run.id).toEqual(expect.any(Number));
			expect(payload.run.dataset_slug).toBe("safety_screening");
			expect(payload.results).toHaveLength(2);
			expect(payload.results[0]?.detail_json).toEqual({
				assertions: [{ type: "javascript", pass: false }],
			});

			const newer = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(runBody(dataset.id)),
			});
			expect(newer.statusCode).toBe(201);
			const newerId = (newer.json() as { run: { id: number } }).run.id;

			const history = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs?dataset=safety_screening&prompt_ref=safety_screen%40candidate&model=gpt-5.6-luna&limit=1",
				headers: headers(),
			});
			expect(history.statusCode).toBe(200);
			expect(history.json()).toHaveLength(1);
			expect(history.json()).toMatchObject([
				{ id: newerId, dataset_slug: "safety_screening" },
			]);

			const detail = await server.inject({
				method: "GET",
				url: `/admin/api/evals/runs/${payload.run.id}`,
				headers: headers(),
			});
			expect(detail.statusCode).toBe(200);
			expect(detail.json()).toMatchObject({
				run: {
					id: payload.run.id,
					dataset_slug: "safety_screening",
				},
				results: expect.any(Array),
			});
		} finally {
			await server.close();
		}
	});

	test("rejects invalid aggregates before a partial run can be written", async () => {
		const server = await buildTestServer();
		try {
			const dataset = (await createDataset(server)).json() as { id: number };
			const invalid = runBody(dataset.id);
			invalid.cases_passed = 2;
			const response = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(invalid),
			});
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				error: { code: "invalid_request_error" },
			});
			const history = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs",
				headers: headers(),
			});
			expect(history.json()).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test("rejects unknown datasets and incomplete prompt attribution without writing a run", async () => {
		const server = await buildTestServer();
		try {
			const unknownDataset = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(runBody(999_999)),
			});
			expect(unknownDataset.statusCode).toBe(404);
			expect(unknownDataset.json()).toMatchObject({
				error: { code: "eval_dataset_not_found" },
			});

			const dataset = (await createDataset(server)).json() as { id: number };
			const incompletePrompt = runBody(dataset.id);
			(incompletePrompt as { prompt_ref?: string }).prompt_ref = undefined;
			const invalidPrompt = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(incompletePrompt),
			});
			expect(invalidPrompt.statusCode).toBe(400);
			expect(invalidPrompt.json()).toMatchObject({
				error: { code: "invalid_request_error" },
			});

			const history = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs",
				headers: headers(),
			});
			expect(history.json()).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test("validates history filters and returns a private run-not-found response", async () => {
		const server = await buildTestServer();
		try {
			const invalidQuery = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs?limit=0&unexpected=true",
				headers: headers(),
			});
			expect(invalidQuery.statusCode).toBe(400);
			expect(invalidQuery.json()).toMatchObject({
				error: { code: "invalid_request_error" },
			});

			const missing = await server.inject({
				method: "GET",
				url: "/admin/api/evals/runs/999999",
				headers: headers(),
			});
			expect(missing.statusCode).toBe(404);
			expect(missing.json()).toMatchObject({
				error: { code: "eval_run_not_found" },
			});
		} finally {
			await server.close();
		}
	});

	test("rejects an empty run body before it reaches SQLite", async () => {
		const server = await buildTestServer();
		try {
			const dataset = (await createDataset(server)).json() as { id: number };
			const response = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify({
					...runBody(dataset.id),
					cases_total: 0,
					cases_passed: 0,
					score_avg: null,
					cost_micro_usd: 0,
					results: [],
				}),
			});
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				error: { code: "invalid_request_error" },
			});
		} finally {
			await server.close();
		}
	});

	test("round-trips own __proto__ and constructor detail keys as data", async () => {
		const server = await buildTestServer();
		try {
			const dataset = (await createDataset(server)).json() as { id: number };
			const body = runBody(dataset.id);
			const detail = Object.create(null) as Record<string, unknown>;
			Object.defineProperty(detail, "__proto__", {
				value: { preserved: true },
				enumerable: true,
			});
			Object.defineProperty(detail, "constructor", {
				value: "preserved-constructor",
				enumerable: true,
			});
			(body.results[0] as { detail_json: unknown }).detail_json = detail;

			const response = await server.inject({
				method: "POST",
				url: "/admin/api/evals/runs",
				headers: headers(),
				body: JSON.stringify(body),
			});
			expect(response.statusCode).toBe(201);
			const persisted = response.json() as {
				results: Array<{
					case_id: string;
					detail_json: Record<string, unknown>;
				}>;
			};
			const result = persisted.results.find(
				(item) => item.case_id === "urgent-self-harm",
			);
			expect(result).toBeDefined();
			expect(Object.hasOwn(result?.detail_json ?? {}, "__proto__")).toBe(true);
			expect(
				Object.getOwnPropertyDescriptor(result?.detail_json ?? {}, "__proto__")
					?.value,
			).toEqual({ preserved: true });
			expect(Object.hasOwn(result?.detail_json ?? {}, "constructor")).toBe(
				true,
			);
			expect(result?.detail_json.constructor).toBe("preserved-constructor");
		} finally {
			await server.close();
		}
	});

	test("rejects non-data and non-JSON values during normalization", async () => {
		const { normalizeJsonValue } = await import("./evals.js");
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const accessor = {};
		Object.defineProperty(accessor, "value", {
			get: () => "not invoked",
			enumerable: true,
		});

		for (const value of [
			cycle,
			accessor,
			new Proxy({}, {}),
			new Date(),
			Array(1),
			Number.POSITIVE_INFINITY,
		]) {
			expect(() => normalizeJsonValue(value)).toThrow();
		}
	});

	test("rolls back the run when a later result violates the database key", async () => {
		const server = await buildTestServer();
		let db:
			| Awaited<ReturnType<typeof import("../db/index.js")["openDatabase"]>>
			| undefined;
		try {
			const dataset = (await createDataset(server)).json() as { id: number };
			const { openDatabase } = await import("../db/index.js");
			const { createEvalRun } = await import("../evals/dao.js");
			db = openDatabase(process.env.DB_PATH as string);
			const body = runBody(dataset.id);
			expect(() =>
				createEvalRun(db as NonNullable<typeof db>, {
					datasetId: body.dataset_id,
					datasetHash: body.dataset_hash,
					promptId: body.prompt_id,
					promptVersion: body.prompt_version,
					promptRef: body.prompt_ref,
					model: body.model,
					gitSha: body.git_sha,
					trigger: body.trigger,
					casesTotal: body.cases_total,
					casesPassed: body.cases_passed,
					scoreAvg: body.score_avg,
					costMicroUsd: body.cost_micro_usd,
					durationMs: body.duration_ms,
					results: [
						{
							caseId: "duplicate",
							passed: true,
							score: 0.8,
							detail: {},
							latencyMs: 1,
							costMicroUsd: 4,
						},
						{
							caseId: "duplicate",
							passed: false,
							score: null,
							detail: {},
							latencyMs: 1,
							costMicroUsd: 5,
						},
					],
				}),
			).toThrow(/UNIQUE/);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM eval_runs").get(),
			).toEqual({ count: 0 });
		} finally {
			db?.close();
			await server.close();
		}
	});
});
