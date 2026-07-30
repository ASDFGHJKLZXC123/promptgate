import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

import { datasetPath, runEvaluation } from "./runner.js";

const DATASET_HASH = "a".repeat(64);

const dataset = {
	path: "/tmp/safety.yaml",
	datasetHash: DATASET_HASH,
	description: "Safety",
	prompts: ["safety@candidate"],
	providers: ["deepseek-v4-flash"],
	defaultTest: { threshold: 1 },
	tests: [
		{
			id: "case-a",
			description: "safe",
			vars: { note: "x" },
			assert: [{ type: "contains" as const, value: "safe" }],
		},
	],
	warnings: [],
};

describe("eval runner", () => {
	test("resolves dataset slugs and explicit YAML paths without duplicating extensions", () => {
		expect(datasetPath("safety")).toBe(
			fileURLToPath(new URL("../datasets/safety.yaml", import.meta.url)),
		);
		expect(datasetPath("missing-suite.yaml")).toBe(
			resolve("missing-suite.yaml"),
		);
		expect(datasetPath("missing-suite.yml")).toBe(resolve("missing-suite.yml"));
	});

	test("resolves a checked-in slug from the evals package working directory", () => {
		const packageRoot = fileURLToPath(new URL("../", import.meta.url));
		const runtime = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"const { datasetPath } = await import(process.argv[1]); process.stdout.write(datasetPath('safety_screening'));",
				fileURLToPath(new URL("../dist/runner.js", import.meta.url)),
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		expect(runtime.status, runtime.stderr).toBe(0);
		expect(runtime.stdout).toBe(
			fileURLToPath(
				new URL("../datasets/safety_screening.yaml", import.meta.url),
			),
		);
	});

	test("rejects an invalid supplied git SHA before reading the dataset or contacting services", async () => {
		const gateway = { complete: vi.fn() };
		const admin = {
			promptSummaries: vi.fn(),
			upsertDataset: vi.fn(),
			createRun: vi.fn(),
			historicalRuns: vi.fn(),
		};
		const loadDataset = vi.fn();
		await expect(
			runEvaluation(
				{
					dataset: "safety",
					prompt: "safety@candidate",
					gitSha: "not-a-sha",
				},
				{ gateway, admin, loadDataset },
			),
		).rejects.toThrow("git SHA is invalid");
		expect(loadDataset).not.toHaveBeenCalled();
		expect(admin.promptSummaries).not.toHaveBeenCalled();
		expect(gateway.complete).not.toHaveBeenCalled();
	});

	test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid direct request-pace option %s before dataset or service work",
		async (minRequestIntervalMs) => {
			const gateway = { complete: vi.fn() };
			const admin = {
				promptSummaries: vi.fn(),
				upsertDataset: vi.fn(),
				createRun: vi.fn(),
				historicalRuns: vi.fn(),
			};
			const loadDataset = vi.fn();
			await expect(
				runEvaluation(
					{
						dataset: "safety",
						prompt: "safety@candidate",
						minRequestIntervalMs,
					},
					{ gateway, admin, loadDataset },
				),
			).rejects.toThrow(
				"min-request-interval-ms must be a non-negative safe integer",
			);
			expect(loadDataset).not.toHaveBeenCalled();
			expect(admin.promptSummaries).not.toHaveBeenCalled();
			expect(gateway.complete).not.toHaveBeenCalled();
		},
	);

	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid max-pass-rate-drop option %s before dataset or service work",
		async (maxPassRateDrop) => {
			const gateway = { complete: vi.fn() };
			const admin = {
				promptSummaries: vi.fn(),
				upsertDataset: vi.fn(),
				createRun: vi.fn(),
				historicalRuns: vi.fn(),
			};
			const loadDataset = vi.fn();
			await expect(
				runEvaluation(
					{
						dataset: "safety",
						prompt: "safety@candidate",
						maxPassRateDrop,
					},
					{ gateway, admin, loadDataset },
				),
			).rejects.toThrow(
				"max-pass-rate-drop must be a finite number between 0 and 1",
			);
			expect(loadDataset).not.toHaveBeenCalled();
			expect(admin.promptSummaries).not.toHaveBeenCalled();
			expect(gateway.complete).not.toHaveBeenCalled();
		},
	);

	test("rejects ambiguous or unavailable concrete prompt refs before mutation or provider traffic", async () => {
		const gateway = { complete: vi.fn() };
		const upsertDataset = vi.fn();
		const createRun = vi.fn();
		for (const [prompt, latestVersion] of [
			["safety@candidate@extra", 2],
			["safety@3", 2],
			["safety@1", null],
		] as const) {
			const admin = {
				promptSummaries: vi.fn().mockResolvedValue([
					{
						id: 1,
						slug: "safety",
						latest_version: latestVersion,
						labels: [{ label: "candidate", version: 2 }],
					},
				]),
				upsertDataset,
				createRun,
				historicalRuns: vi.fn(),
			};
			await expect(
				runEvaluation(
					{ dataset: "safety", prompt },
					{
						gateway,
						admin,
						loadDataset: vi
							.fn()
							.mockResolvedValue({ ...dataset, prompts: [prompt] }),
						gitSha: () => "1234567",
					},
				),
			).rejects.toThrow();
		}
		expect(upsertDataset).not.toHaveBeenCalled();
		expect(createRun).not.toHaveBeenCalled();
		expect(gateway.complete).not.toHaveBeenCalled();
	});

	test("selects the first exact historical row before candidate traffic, ignoring newer other hashes and allowing duplicates", async () => {
		const scoredDataset = {
			...dataset,
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi
				.fn()
				.mockImplementation(
					async (call: { model: string; prompt: string }) => ({
						content:
							call.prompt === "judge_rubric_v1@1"
								? '{"pass":true,"score":0.86,"rationale":"ok"}'
								: "candidate",
						costMicroUsd: 1,
					}),
				),
		};
		const order: string[] = [];
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockImplementation(async () => {
				order.push("upsert");
				return { id: 4 };
			}),
			createRun: vi.fn().mockImplementation(async () => {
				order.push("persist");
			}),
			historicalRuns: vi.fn().mockImplementation(async () => {
				order.push("history");
				const exactHistory = {
					id: 9,
					dataset_slug: "safety",
					dataset_hash: DATASET_HASH,
					prompt_id: 1,
					prompt_version: 1,
					prompt_ref: "safety@prod",
					model: "deepseek-v4-flash",
					cases_total: 1,
					cases_passed: 1,
					score_avg: 0.9,
				};
				return [
					{
						...exactHistory,
						id: 15,
						dataset_hash: "b".repeat(64),
					},
					{
						...exactHistory,
						id: 13,
						prompt_version: 2,
					},
					{ ...exactHistory, id: 12, prompt_ref: "safety@candidate" },
					{ ...exactHistory, id: 11, model: "gemini-2.5-flash" },
					{ ...exactHistory, id: 10, cases_total: 2 },
					exactHistory,
					{ ...exactHistory, id: 8, score_avg: 1 },
				];
			}),
		};
		await expect(
			runEvaluation(
				{
					dataset: "safety",
					prompt: "safety@candidate",
					baseline: "prod",
					baselineFromHistory: true,
					maxScoreDrop: 0.05,
				},
				{
					gateway,
					admin,
					loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				},
			),
		).resolves.toMatchObject({ exitCode: 0 });
		expect(order[0]).toBe("history");
		expect(order).toEqual(["history", "upsert", "persist"]);
		expect(gateway.complete.mock.calls.map(([call]) => call.prompt)).toEqual([
			"safety@2",
			"judge_rubric_v1@1",
		]);
		expect(admin.createRun).toHaveBeenCalledTimes(1);
		const historyQuery = admin.historicalRuns.mock
			.calls[0]?.[0] as URLSearchParams;
		expect(historyQuery.get("dataset")).toBe("safety");
		expect(historyQuery.get("prompt_ref")).toBe("safety@prod");
		expect(historyQuery.get("model")).toBe("deepseek-v4-flash");
	});

	test.each([
		{
			name: "accepts an exact historical max-score-drop boundary",
			candidateScore: 0.85,
			expectedExitCode: 0,
		},
		{
			name: "rejects a historical score drop one-billionth beyond the boundary",
			candidateScore: 0.849999999,
			expectedExitCode: 1,
		},
	] as const)("$name", async ({ candidateScore, expectedExitCode }) => {
		const scoredDataset = {
			...dataset,
			defaultTest: { threshold: 0 },
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi.fn().mockImplementation(async (call: { prompt: string }) =>
				call.prompt === "judge_rubric_v1@1"
					? {
							content: JSON.stringify({
								pass: true,
								score: candidateScore,
								rationale: "boundary probe",
							}),
							costMicroUsd: 1,
						}
					: { content: "candidate", costMicroUsd: 1 },
			),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn().mockResolvedValue([
				{
					id: 9,
					dataset_slug: "safety",
					dataset_hash: DATASET_HASH,
					prompt_id: 1,
					prompt_version: 1,
					prompt_ref: "safety@prod",
					model: "deepseek-v4-flash",
					cases_total: 1,
					cases_passed: 1,
					score_avg: 0.9,
				},
			]),
		};

		const result = await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				baseline: "prod",
				baselineFromHistory: true,
				maxScoreDrop: 0.05,
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
			},
		);

		expect(result.exitCode).toBe(expectedExitCode);
		expect(admin.createRun).toHaveBeenCalledTimes(1);
	});

	test.each([
		{
			name: "accepts an exact 0.05 historical pass-rate drop",
			candidateFailures: 1,
			expectedExitCode: 0,
			expectedCandidatePasses: 19,
			expectedDrop: 0.050000000000000044,
		},
		{
			name: "rejects a historical pass-rate drop above 0.05",
			candidateFailures: 2,
			expectedExitCode: 1,
			expectedCandidatePasses: 18,
			expectedDrop: 0.09999999999999998,
		},
	] as const)(
		"$name",
		async ({
			candidateFailures,
			expectedExitCode,
			expectedCandidatePasses,
			expectedDrop,
		}) => {
			const passRateDataset = {
				...dataset,
				defaultTest: { threshold: 0.8 },
				tests: Array.from({ length: 20 }, (_, index) => ({
					id: `case-${index}`,
					description: "historical pass-rate probe",
					vars: { note: String(index) },
					assert: [{ type: "equals" as const, value: "safe" }],
				})),
			};
			const gateway = {
				complete: vi
					.fn()
					.mockImplementation(
						async (call: { vars: Record<string, unknown> }) => ({
							content:
								Number(call.vars.note) < candidateFailures ? "blocked" : "safe",
							costMicroUsd: 1,
						}),
					),
			};
			const admin = {
				promptSummaries: vi.fn().mockResolvedValue([
					{
						id: 1,
						slug: "safety",
						latest_version: 2,
						labels: [
							{ label: "candidate", version: 2 },
							{ label: "prod", version: 1 },
						],
					},
				]),
				upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
				createRun: vi.fn().mockResolvedValue(undefined),
				historicalRuns: vi.fn().mockResolvedValue([
					{
						id: 9,
						dataset_slug: "safety",
						dataset_hash: DATASET_HASH,
						prompt_id: 1,
						prompt_version: 1,
						prompt_ref: "safety@prod",
						model: "deepseek-v4-flash",
						cases_total: 20,
						cases_passed: 20,
						score_avg: null,
					},
				]),
			};

			const result = await runEvaluation(
				{
					dataset: "safety",
					prompt: "safety@candidate",
					baseline: "prod",
					baselineFromHistory: true,
				},
				{
					gateway,
					admin,
					loadDataset: vi.fn().mockResolvedValue(passRateDataset),
					gitSha: () => "1234567",
				},
			);

			expect(result.exitCode).toBe(expectedExitCode);
			expect(gateway.complete).toHaveBeenCalledTimes(20);
			expect(admin.createRun).toHaveBeenCalledTimes(1);
			expect(admin.createRun).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt_ref: "safety@candidate",
					cases_passed: expectedCandidatePasses,
					score_avg: null,
				}),
			);
			expect(result.markdown).toContain(
				`deepseek-v4-flash: baseline pass rate 1; candidate pass rate ${expectedCandidatePasses / 20}; pass-rate drop ${expectedDrop}; maximum allowed 0.05.`,
			);
		},
	);

	test("rejects absent or mismatched baseline history before mutation or provider traffic", async () => {
		const exactHistory = {
			id: 9,
			dataset_slug: "safety",
			dataset_hash: DATASET_HASH,
			prompt_id: 1,
			prompt_version: 1,
			prompt_ref: "safety@prod",
			model: "deepseek-v4-flash",
			cases_total: 1,
			cases_passed: 1,
			score_avg: 0.9,
		};
		const histories = [
			[],
			...[
				{ dataset_slug: "other" },
				{ dataset_hash: "b".repeat(64) },
				{ prompt_id: 2 },
				{ prompt_version: 2 },
				{ prompt_ref: "safety@candidate" },
				{ model: "gemini-2.5-flash" },
				{ cases_total: 2 },
			].map((mismatch) => [{ ...exactHistory, ...mismatch }]),
		];
		for (const history of histories) {
			const gateway = { complete: vi.fn() };
			const admin = {
				promptSummaries: vi.fn().mockResolvedValue([
					{
						id: 1,
						slug: "safety",
						latest_version: 2,
						labels: [
							{ label: "candidate", version: 2 },
							{ label: "prod", version: 1 },
						],
					},
				]),
				upsertDataset: vi.fn(),
				createRun: vi.fn(),
				historicalRuns: vi.fn().mockResolvedValue(history),
			};
			await expect(
				runEvaluation(
					{
						dataset: "safety",
						prompt: "safety@candidate",
						baseline: "prod",
						baselineFromHistory: true,
					},
					{ gateway, admin, loadDataset: vi.fn().mockResolvedValue(dataset) },
				),
			).rejects.toThrow("Historical baseline is missing.");
			expect(admin.upsertDataset).not.toHaveBeenCalled();
			expect(admin.createRun).not.toHaveBeenCalled();
			expect(gateway.complete).not.toHaveBeenCalled();
		}
	});

	test("rejects malformed historical rows with a sanitized error before side effects", async () => {
		const gateway = { complete: vi.fn() };
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn(),
			createRun: vi.fn(),
			historicalRuns: vi.fn().mockResolvedValue([
				{
					dataset_hash: DATASET_HASH,
					prompt_ref: "safety@prod",
					model: "deepseek-v4-flash",
					score_avg: null,
					secret: "must-not-appear",
				},
			]),
		};
		await expect(
			runEvaluation(
				{
					dataset: "safety",
					prompt: "safety@candidate",
					baseline: "prod",
					baselineFromHistory: true,
				},
				{ gateway, admin, loadDataset: vi.fn().mockResolvedValue(dataset) },
			),
		).rejects.toThrow("Historical baseline response was invalid.");
		expect(admin.upsertDataset).not.toHaveBeenCalled();
		expect(admin.createRun).not.toHaveBeenCalled();
		expect(gateway.complete).not.toHaveBeenCalled();
	});

	test.each([
		["missing", {}],
		["negative", { cases_passed: -1 }],
		["greater than cases_total", { cases_passed: 2 }],
	] as const)(
		"rejects %s historical cases_passed before side effects",
		async (_name, casesPassed) => {
			const gateway = { complete: vi.fn() };
			const admin = {
				promptSummaries: vi.fn().mockResolvedValue([
					{
						id: 1,
						slug: "safety",
						latest_version: 2,
						labels: [
							{ label: "candidate", version: 2 },
							{ label: "prod", version: 1 },
						],
					},
				]),
				upsertDataset: vi.fn(),
				createRun: vi.fn(),
				historicalRuns: vi.fn().mockResolvedValue([
					{
						id: 9,
						dataset_slug: "safety",
						dataset_hash: DATASET_HASH,
						prompt_id: 1,
						prompt_version: 1,
						prompt_ref: "safety@prod",
						model: "deepseek-v4-flash",
						cases_total: 1,
						score_avg: null,
						...casesPassed,
					},
				]),
			};

			await expect(
				runEvaluation(
					{
						dataset: "safety",
						prompt: "safety@candidate",
						baseline: "prod",
						baselineFromHistory: true,
					},
					{ gateway, admin, loadDataset: vi.fn().mockResolvedValue(dataset) },
				),
			).rejects.toThrow("Historical baseline response was invalid.");
			expect(admin.upsertDataset).not.toHaveBeenCalled();
			expect(admin.createRun).not.toHaveBeenCalled();
			expect(gateway.complete).not.toHaveBeenCalled();
		},
	);

	test("requires the exact DeepSeek-only target set before admin or gateway traffic", async () => {
		const gateway = { complete: vi.fn() };
		const admin = {
			promptSummaries: vi.fn(),
			upsertDataset: vi.fn(),
			createRun: vi.fn(),
			historicalRuns: vi.fn(),
		};
		for (const changed of [
			{ ...dataset, prompts: ["other@candidate"] },
			{ ...dataset, providers: ["gemini-2.5-flash"] },
			{ ...dataset, providers: ["gpt-5.6-terra"] },
			{ ...dataset, providers: ["gemini-2.5-flash", "gemini-2.5-flash"] },
			{ ...dataset, providers: ["deepseek-v4-flash", "gemini-2.5-flash"] },
			{ ...dataset, providers: ["gpt-5.6-luna"] },
			{ ...dataset, providers: ["not-a-model"] },
		]) {
			await expect(
				runEvaluation(
					{ dataset: "safety", prompt: "safety@candidate" },
					{ gateway, admin, loadDataset: vi.fn().mockResolvedValue(changed) },
				),
			).rejects.toThrow();
		}
		expect(gateway.complete).not.toHaveBeenCalled();
		expect(admin.promptSummaries).not.toHaveBeenCalled();
	});

	test("freezes labels once, runs paired baseline first, persists atomic model runs, and prints a table", async () => {
		const gateway = {
			complete: vi.fn().mockResolvedValue({
				content: "safe",
				costMicroUsd: 3,
			}),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};
		const result = await runEvaluation(
			{ dataset: "safety", prompt: "safety@candidate", baseline: "prod" },
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(dataset),
				gitSha: () => "1234567",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.markdown).toContain("| case-a | deepseek-v4-flash | pass |");
		expect(gateway.complete.mock.calls.map(([call]) => call.prompt)).toEqual([
			"safety@1",
			"safety@2",
		]);
		expect(admin.createRun).toHaveBeenCalledTimes(2);
		expect(admin.historicalRuns).not.toHaveBeenCalled();
		expect(admin.createRun.mock.calls[0]?.[0]).toMatchObject({
			prompt_version: 1,
			dataset_id: 4,
			trigger: "manual",
			results: [{ detail_json: expect.any(Object), cost_micro_usd: 3 }],
		});
	});

	test("runs a same-version pair once as the candidate, persists one run, and names both refs", async () => {
		const scoredDataset = {
			...dataset,
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi.fn().mockImplementation(async (call: { prompt: string }) =>
				call.prompt === "judge_rubric_v1@1"
					? {
							content: '{"pass":true,"score":0.9,"rationale":"ok"}',
							costMicroUsd: 1,
						}
					: { content: "candidate", costMicroUsd: 1 },
			),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 1 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};
		const result = await runEvaluation(
			{ dataset: "safety", prompt: "safety@candidate", baseline: "prod" },
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				gitSha: () => "1234567",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(gateway.complete.mock.calls.map(([call]) => call.prompt)).toEqual([
			"safety@1",
			"judge_rubric_v1@1",
		]);
		expect(admin.createRun).toHaveBeenCalledTimes(1);
		expect(admin.createRun.mock.calls[0]?.[0]).toMatchObject({
			prompt_ref: "safety@candidate",
			prompt_version: 1,
		});
		expect(admin.historicalRuns).not.toHaveBeenCalled();
		expect(result.markdown).toContain("| case-a | deepseek-v4-flash | pass |");
		expect(result.markdown).toContain(
			"Baseline safety@prod and candidate safety@candidate resolved to the same prompt version 1; the candidate ran once and the score and pass-rate drops are zero.",
		);
		expect(result.markdown).toContain(
			"deepseek-v4-flash: baseline pass rate 1; candidate pass rate 1; pass-rate drop 0; maximum allowed 0.05.",
		);
		expect(result.markdown).toContain(
			"deepseek-v4-flash: baseline score avg 0.9 over 1 scored cases; candidate score avg 0.9 over 1 scored cases; score drop 0.",
		);
	});

	test("fails a same-version pair below the dataset threshold with one persisted run", async () => {
		const scoredDataset = {
			...dataset,
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi.fn().mockImplementation(async (call: { prompt: string }) =>
				call.prompt === "judge_rubric_v1@1"
					? {
							content: '{"pass":false,"score":0.3,"rationale":"weak"}',
							costMicroUsd: 1,
						}
					: { content: "candidate", costMicroUsd: 1 },
			),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 1,
					labels: [
						{ label: "candidate", version: 1 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};
		const result = await runEvaluation(
			{ dataset: "safety", prompt: "safety@candidate", baseline: "prod" },
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				gitSha: () => "1234567",
			},
		);
		expect(result.exitCode).toBe(1);
		expect(gateway.complete).toHaveBeenCalledTimes(2);
		expect(admin.createRun).toHaveBeenCalledTimes(1);
		expect(result.markdown).toContain("| case-a | deepseek-v4-flash | fail |");
	});

	test.each([
		{
			name: "keeps a distinct-version pair green on the exact drop boundary",
			candidateScore: 0.85,
			expectedExitCode: 0,
		},
		{
			name: "keeps a distinct-version pair red one-billionth past the boundary",
			candidateScore: 0.849999999,
			expectedExitCode: 1,
		},
	] as const)("$name", async ({ candidateScore, expectedExitCode }) => {
		const scoredDataset = {
			...dataset,
			defaultTest: { threshold: 0 },
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi
				.fn()
				.mockImplementation(
					async (call: { prompt: string; vars: Record<string, unknown> }) => {
						if (call.prompt !== "judge_rubric_v1@1")
							return { content: `output ${call.prompt}`, costMicroUsd: 1 };
						const payload = JSON.parse(String(call.vars.payload)) as {
							candidate: string;
						};
						const score = payload.candidate.includes("safety@2")
							? candidateScore
							: 0.9;
						return {
							content: JSON.stringify({ pass: true, score, rationale: "ok" }),
							costMicroUsd: 1,
						};
					},
				),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};
		const result = await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				baseline: "prod",
				maxScoreDrop: 0.05,
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				gitSha: () => "1234567",
			},
		);
		expect(result.exitCode).toBe(expectedExitCode);
		expect(admin.createRun).toHaveBeenCalledTimes(2);
		expect(admin.createRun.mock.calls.map(([body]) => body)).toEqual([
			expect.objectContaining({ prompt_ref: "safety@prod", prompt_version: 1 }),
			expect.objectContaining({
				prompt_ref: "safety@candidate",
				prompt_version: 2,
			}),
		]);
		expect(result.markdown).toContain(
			"baseline score avg 0.9 over 1 scored cases",
		);
		expect(result.markdown).toContain(
			`candidate score avg ${candidateScore} over 1 scored cases`,
		);
		expect(result.markdown).not.toContain(
			"resolved to the same prompt version",
		);
	});

	test.each([
		{
			name: "accepts an exact 0.05 paired pass-rate drop",
			candidateFailures: 1,
			expectedExitCode: 0,
			expectedCandidatePasses: 19,
			expectedDrop: 0.050000000000000044,
		},
		{
			name: "rejects a paired pass-rate drop above 0.05",
			candidateFailures: 2,
			expectedExitCode: 1,
			expectedCandidatePasses: 18,
			expectedDrop: 0.09999999999999998,
		},
	] as const)(
		"$name",
		async ({
			candidateFailures,
			expectedExitCode,
			expectedCandidatePasses,
			expectedDrop,
		}) => {
			const passRateDataset = {
				...dataset,
				defaultTest: { threshold: 0.8 },
				tests: Array.from({ length: 20 }, (_, index) => ({
					id: `case-${index}`,
					description: "deterministic pass-rate probe",
					vars: { note: String(index) },
					assert: [{ type: "equals" as const, value: "safe" }],
				})),
			};
			const gateway = {
				complete: vi
					.fn()
					.mockImplementation(
						async (call: {
							prompt: string;
							vars: Record<string, unknown>;
						}) => ({
							content:
								call.prompt === "safety@2" &&
								Number(call.vars.note) < candidateFailures
									? "blocked"
									: "safe",
							costMicroUsd: 1,
						}),
					),
			};
			const admin = {
				promptSummaries: vi.fn().mockResolvedValue([
					{
						id: 1,
						slug: "safety",
						latest_version: 2,
						labels: [
							{ label: "candidate", version: 2 },
							{ label: "prod", version: 1 },
						],
					},
				]),
				upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
				createRun: vi.fn().mockResolvedValue(undefined),
				historicalRuns: vi.fn(),
			};

			const result = await runEvaluation(
				{
					dataset: "safety",
					prompt: "safety@candidate",
					baseline: "prod",
				},
				{
					gateway,
					admin,
					loadDataset: vi.fn().mockResolvedValue(passRateDataset),
					gitSha: () => "1234567",
				},
			);

			expect(result.exitCode).toBe(expectedExitCode);
			expect(gateway.complete).toHaveBeenCalledTimes(40);
			expect(admin.createRun).toHaveBeenCalledTimes(2);
			expect(admin.createRun.mock.calls.map(([body]) => body)).toEqual([
				expect.objectContaining({
					prompt_ref: "safety@prod",
					cases_passed: 20,
					score_avg: null,
				}),
				expect.objectContaining({
					prompt_ref: "safety@candidate",
					cases_passed: expectedCandidatePasses,
					score_avg: null,
				}),
			]);
			expect(result.markdown).toContain(
				`deepseek-v4-flash: baseline pass rate 1; candidate pass rate ${expectedCandidatePasses / 20}; pass-rate drop ${expectedDrop}; maximum allowed 0.05.`,
			);
		},
	);

	test("rejects the D1 shape when deterministic failures raise candidate score_avg", async () => {
		const d1Dataset = {
			...dataset,
			defaultTest: { threshold: 0.8 },
			tests: Array.from({ length: 50 }, (_, index) => ({
				id: `case-${index}`,
				description: "D1 deterministic-pruning regression",
				vars: { note: String(index) },
				assert: [
					{ type: "contains" as const, value: "safe" },
					{ type: "llm-rubric" as const, value: "useful guidance" },
				],
			})),
		};
		const gateway = {
			complete: vi
				.fn()
				.mockImplementation(
					async (call: { prompt: string; vars: Record<string, unknown> }) => {
						if (call.prompt === "judge_rubric_v1@1") {
							const payload = JSON.parse(String(call.vars.payload)) as {
								candidate: string;
							};
							const index = Number(payload.candidate.split(" ").at(-1));
							const score = index < 5 ? 0.2 : 0.9;
							return {
								content: JSON.stringify({
									pass: true,
									score,
									rationale: "D1 score probe",
								}),
								costMicroUsd: 1,
							};
						}
						const index = Number(call.vars.note);
						return {
							content:
								call.prompt === "safety@2" && index < 5
									? `blocked ${index}`
									: `safe ${index}`,
							costMicroUsd: 1,
						};
					},
				),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};

		const result = await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				baseline: "prod",
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(d1Dataset),
				gitSha: () => "1234567",
			},
		);

		expect(result.exitCode).toBe(1);
		expect(admin.createRun).toHaveBeenCalledTimes(2);
		const baselineRun = admin.createRun.mock.calls[0]?.[0] as {
			cases_passed: number;
			score_avg: number;
		};
		const candidateRun = admin.createRun.mock.calls[1]?.[0] as {
			cases_passed: number;
			score_avg: number;
		};
		expect(baselineRun.cases_passed).toBe(50);
		expect(candidateRun.cases_passed).toBe(45);
		expect(candidateRun.score_avg).toBeGreaterThan(baselineRun.score_avg);
		expect(result.markdown).toContain(
			"baseline pass rate 1; candidate pass rate 0.9; pass-rate drop 0.09999999999999998; maximum allowed 0.05.",
		);
	});

	test("keeps historical comparison unchanged when history resolves to the candidate version", async () => {
		const scoredDataset = {
			...dataset,
			defaultTest: { threshold: 0 },
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi.fn().mockImplementation(async (call: { prompt: string }) =>
				call.prompt === "judge_rubric_v1@1"
					? {
							content: '{"pass":true,"score":0.849999999,"rationale":"probe"}',
							costMicroUsd: 1,
						}
					: { content: "candidate", costMicroUsd: 1 },
			),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 2 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn().mockResolvedValue([
				{
					id: 9,
					dataset_slug: "safety",
					dataset_hash: DATASET_HASH,
					prompt_id: 1,
					prompt_version: 2,
					prompt_ref: "safety@prod",
					model: "deepseek-v4-flash",
					cases_total: 1,
					cases_passed: 1,
					score_avg: 0.9,
				},
			]),
		};
		const result = await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				baseline: "prod",
				baselineFromHistory: true,
				maxScoreDrop: 0.05,
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
			},
		);
		expect(result.exitCode).toBe(1);
		expect(gateway.complete.mock.calls.map(([call]) => call.prompt)).toEqual([
			"safety@2",
			"judge_rubric_v1@1",
		]);
		expect(admin.createRun).toHaveBeenCalledTimes(1);
		expect(result.markdown).not.toContain(
			"resolved to the same prompt version",
		);
	});

	test("applies local cache opt-in to target and judge calls and records their combined cost", async () => {
		const scoredDataset = {
			...dataset,
			tests: [
				{
					...dataset.tests[0],
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi.fn().mockImplementation(async (call: { prompt: string }) =>
				call.prompt === "judge_rubric_v1@1"
					? {
							content: '{"pass":true,"score":1,"rationale":"safe"}',
							costMicroUsd: 2,
						}
					: { content: "safe", costMicroUsd: 3 },
			),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [{ label: "candidate", version: 2 }],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};

		await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				allowCache: true,
				trigger: "ci",
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				gitSha: () => "1234567",
			},
		);

		expect(gateway.complete).toHaveBeenCalledTimes(2);
		expect(gateway.complete.mock.calls.every(([call]) => call.allowCache)).toBe(
			true,
		);
		expect(admin.createRun).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: "manual",
				cost_micro_usd: 5,
				results: [expect.objectContaining({ cost_micro_usd: 5 })],
			}),
		);
	});

	test("paces sole-target and independent-judge calls by model for the full run", async () => {
		let paceNow = 0;
		const callTimes = new Map<string, number[]>();
		const callPrompts = new Map<string, string[]>();
		const scoredDataset = {
			...dataset,
			tests: [
				{
					...dataset.tests[0],
					id: "case-a",
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
				{
					...dataset.tests[0],
					id: "case-b",
					assert: [{ type: "llm-rubric" as const, value: "safe" }],
				},
			],
		};
		const gateway = {
			complete: vi
				.fn()
				.mockImplementation(async (call: { model: string; prompt: string }) => {
					const times = callTimes.get(call.model) ?? [];
					times.push(paceNow);
					callTimes.set(call.model, times);
					const prompts = callPrompts.get(call.model) ?? [];
					prompts.push(call.prompt);
					callPrompts.set(call.model, prompts);
					return call.prompt === "judge_rubric_v1@1"
						? {
								content: '{"pass":true,"score":1,"rationale":"safe"}',
								costMicroUsd: 1,
							}
						: { content: "safe", costMicroUsd: 1 };
				}),
		};
		const admin = {
			promptSummaries: vi.fn().mockResolvedValue([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [
						{ label: "candidate", version: 2 },
						{ label: "prod", version: 1 },
					],
				},
			]),
			upsertDataset: vi.fn().mockResolvedValue({ id: 4 }),
			createRun: vi.fn().mockResolvedValue(undefined),
			historicalRuns: vi.fn(),
		};

		await runEvaluation(
			{
				dataset: "safety",
				prompt: "safety@candidate",
				baseline: "prod",
				minRequestIntervalMs: 15_000,
			},
			{
				gateway,
				admin,
				loadDataset: vi.fn().mockResolvedValue(scoredDataset),
				pacingClock: {
					now: () => paceNow,
					sleep: async (milliseconds) => {
						paceNow += milliseconds;
					},
				},
			},
		);

		for (const times of callTimes.values()) {
			expect(times).toHaveLength(4);
			for (let index = 1; index < times.length; index += 1) {
				const previous = times[index - 1];
				const current = times[index];
				if (previous === undefined || current === undefined)
					throw new Error("Expected paced call timestamps.");
				expect(current - previous).toBeGreaterThanOrEqual(15_000);
			}
		}
		expect(callPrompts.get("deepseek-v4-flash")).toEqual([
			"safety@1",
			"safety@1",
			"safety@2",
			"safety@2",
		]);
		expect(callPrompts.get("gpt-5.6-terra")).toEqual([
			"judge_rubric_v1@1",
			"judge_rubric_v1@1",
			"judge_rubric_v1@1",
			"judge_rubric_v1@1",
		]);
	});
});
