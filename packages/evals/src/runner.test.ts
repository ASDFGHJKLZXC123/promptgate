import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { datasetPath, runEvaluation } from "./runner.js";

const dataset = {
	path: "/tmp/safety.yaml",
	datasetHash: "hash",
	description: "Safety",
	prompts: ["safety@candidate"],
	providers: ["gpt-5.6-luna"],
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
			resolve(process.cwd(), "packages/evals/datasets/safety.yaml"),
		);
		expect(datasetPath("missing-suite.yaml")).toBe(
			resolve("missing-suite.yaml"),
		);
		expect(datasetPath("missing-suite.yml")).toBe(resolve("missing-suite.yml"));
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
			complete: vi.fn().mockImplementation(async (call: { model: string }) => ({
				content:
					call.model === "gpt-5.6-terra"
						? '{"pass":true,"score":0.86,"rationale":"ok"}'
						: "candidate",
				costMicroUsd: 1,
			})),
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
				return [
					{
						dataset_hash: "newer-other-hash",
						prompt_ref: "safety@prod",
						model: "gpt-5.6-luna",
						score_avg: 0.99,
					},
					{
						dataset_hash: "hash",
						prompt_ref: "safety@prod",
						model: "gpt-5.6-luna",
						score_avg: 0.9,
					},
					{
						dataset_hash: "hash",
						prompt_ref: "safety@prod",
						model: "gpt-5.6-luna",
						score_avg: 0.99,
					},
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
	});

	test("fails before any mutation or provider call when history has no exact match", async () => {
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
					dataset_hash: "other",
					prompt_ref: "safety@prod",
					model: "gpt-5.6-luna",
					score_avg: null,
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
		).rejects.toThrow("Historical baseline is missing");
		expect(admin.upsertDataset).not.toHaveBeenCalled();
		expect(admin.createRun).not.toHaveBeenCalled();
		expect(gateway.complete).not.toHaveBeenCalled();
	});

	test("rejects an undeclared prompt, duplicate model, or unsupported model before gateway traffic", async () => {
		const gateway = { complete: vi.fn() };
		const admin = {
			promptSummaries: vi.fn(),
			upsertDataset: vi.fn(),
			createRun: vi.fn(),
			historicalRuns: vi.fn(),
		};
		for (const changed of [
			{ ...dataset, prompts: ["other@candidate"] },
			{ ...dataset, providers: ["gpt-5.6-luna", "gpt-5.6-luna"] },
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
		expect(result.markdown).toContain("| case-a | gpt-5.6-luna | pass |");
		expect(gateway.complete.mock.calls.map(([call]) => call.prompt)).toEqual([
			"safety@1",
			"safety@2",
		]);
		expect(admin.createRun).toHaveBeenCalledTimes(2);
		expect(admin.createRun.mock.calls[0]?.[0]).toMatchObject({
			prompt_version: 1,
			dataset_id: 4,
			trigger: "manual",
			results: [{ detail_json: expect.any(Object), cost_micro_usd: 3 }],
		});
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
			complete: vi
				.fn()
				.mockResolvedValueOnce({ content: "safe", costMicroUsd: 3 })
				.mockResolvedValueOnce({
					content: '{"pass":true,"score":1,"rationale":"safe"}',
					costMicroUsd: 2,
				}),
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
});
