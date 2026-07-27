import { describe, expect, test, vi } from "vitest";

import type { AdminConfig } from "./admin-client.js";
import { type CliIo, type CliRuntime, runCli } from "./cli.js";
import type { LoadedDataset } from "./dataset.js";
import type {
	GatewayCall,
	GatewayConfig,
	GatewayResponse,
} from "./gateway-client.js";
import { JUDGE_PROMPT_REF } from "./judge.js";
import type { EvalRunDependencies, EvalRunnerOptions } from "./runner.js";
import { runEvaluation } from "./runner.js";

const fixture: LoadedDataset = {
	path: "/tmp/meta-eval.yaml",
	datasetHash: "meta-hash",
	description: "Fixture eval of evals",
	prompts: ["safety@candidate"],
	providers: ["gemini-2.5-flash", "deepseek-v4-flash"],
	defaultTest: { threshold: 1 },
	tests: [
		{
			id: "safe-case",
			description: "returns the safe answer",
			vars: { case: "safe" },
			assert: [
				{ type: "contains", value: "safe" },
				{ type: "llm-rubric", value: "safe rubric" },
			],
		},
		{
			id: "risk-case",
			description: "handles elevated risk",
			vars: { case: "risk" },
			assert: [{ type: "llm-rubric", value: "risk rubric" }],
		},
	],
	warnings: ["fixture warning"],
};

type PersistedRun = {
	model: string;
	prompt_ref: string;
	score_avg: number | null;
	cost_micro_usd: number;
	results: readonly { case_id: string; cost_micro_usd: number }[];
};

function fakeResponse(content: string, costMicroUsd: number): GatewayResponse {
	return { content, costMicroUsd } as GatewayResponse;
}

function createFakeDependencies(
	options: { candidateRiskScore?: number; malformedJudge?: boolean } = {},
): {
	deps: EvalRunDependencies;
	calls: ReturnType<
		typeof vi.fn<(call: GatewayCall) => Promise<GatewayResponse>>
	>;
	persisted: PersistedRun[];
} {
	const persisted: PersistedRun[] = [];
	const calls = vi.fn(async (call: GatewayCall): Promise<GatewayResponse> => {
		if (call.prompt !== JUDGE_PROMPT_REF) {
			return fakeResponse(
				`safe ${call.model} ${call.prompt} ${String(call.vars.case)}`,
				10,
			);
		}
		if (options.malformedJudge) return fakeResponse("not JSON", 2);
		const payload = JSON.parse(String(call.vars.payload)) as {
			candidate: string;
		};
		const candidate = payload.candidate;
		const candidateRun = candidate.includes("safety@2");
		const riskCase = candidate.endsWith(" risk");
		const score =
			candidateRun && riskCase
				? (options.candidateRiskScore ?? 0.25)
				: riskCase
					? 0.75
					: 0.75;
		return fakeResponse(
			JSON.stringify({
				pass: score >= 0.5,
				score,
				rationale: score >= 0.5 ? "rubric passed" : "rubric failed",
			}),
			2,
		);
	});
	const admin: EvalRunDependencies["admin"] = {
		promptSummaries: async () => [
			{
				id: 42,
				slug: "safety",
				latest_version: 2,
				labels: [
					{ label: "prod", version: 1 },
					{ label: "candidate", version: 2 },
				],
			},
		],
		upsertDataset: async () => ({ id: 7 }),
		createRun: async (body: unknown) => {
			persisted.push(body as PersistedRun);
		},
		historicalRuns: async () => [],
	};
	return {
		deps: {
			gateway: { complete: calls },
			admin,
			loadDataset: async () => fixture,
			gitSha: () => "1234567",
		},
		calls,
		persisted,
	};
}

function io(): {
	io: CliIo;
	stdout: ReturnType<typeof vi.fn>;
	stderr: ReturnType<typeof vi.fn>;
} {
	const stdout = vi.fn();
	const stderr = vi.fn();
	return { io: { stdout, stderr }, stdout, stderr };
}

function cliRuntime(
	exitCode: 0 | 1,
	failure?: Error,
): {
	runtime: CliRuntime;
	runOptions: EvalRunnerOptions[];
} {
	const gatewayConfig = {
		baseUrl: new URL("http://offline.test"),
		key: "key",
	} satisfies GatewayConfig;
	const adminConfig = {
		baseUrl: new URL("http://offline.test"),
		adminToken: "1234567890123456",
	} satisfies AdminConfig;
	const runOptions: EvalRunnerOptions[] = [];
	return {
		runOptions,
		runtime: {
			loadRunModules: async () => ({
				resolveGatewayConfig: () => gatewayConfig,
				resolveAdminConfig: () => adminConfig,
				GatewayClient: class {
					private readonly config: GatewayConfig;

					constructor(config: GatewayConfig) {
						this.config = config;
					}
					async complete(): Promise<GatewayResponse> {
						void this.config;
						throw new Error("offline fake client must not be called");
					}
				},
				AdminClient: class {
					private readonly config: AdminConfig;

					constructor(config: AdminConfig) {
						this.config = config;
					}
					async promptSummaries() {
						return [];
					}
					async upsertDataset() {
						return { id: this.config.adminToken.length };
					}
					async createRun() {}
					async historicalRuns() {
						return [];
					}
				},
				runEvaluation: async (options) => {
					runOptions.push(options);
					if (failure) throw failure;
					return {
						exitCode,
						markdown: "| fixture |",
						warnings: ["offline warning"],
					};
				},
			}),
		},
	};
}

describe("Phase 5 eval-of-evals regression", () => {
	test("persists exact multi-model target and judge results, costs, markdown, and warnings", async () => {
		const { deps, calls, persisted } = createFakeDependencies();
		const result = await runEvaluation(
			{ dataset: "meta-eval", prompt: "safety@candidate", baseline: "prod" },
			deps,
		);

		expect(result).toEqual({
			exitCode: 1,
			markdown: [
				"| case | model | pass | score | first failed detail |",
				"|---|---|---|---|---|",
				"| safe-case | gemini-2.5-flash | pass | 0.75 |  |",
				"| risk-case | gemini-2.5-flash | fail | 0.25 | rubric failed |",
				"| safe-case | deepseek-v4-flash | pass | 0.75 |  |",
				"| risk-case | deepseek-v4-flash | fail | 0.25 | rubric failed |",
			].join("\n"),
			warnings: ["fixture warning"],
		});
		expect(calls).toHaveBeenCalledTimes(16);
		expect(calls.mock.calls.map(([call]) => [call.model, call.prompt])).toEqual(
			[
				["gemini-2.5-flash", "safety@1"],
				["deepseek-v4-flash", JUDGE_PROMPT_REF],
				["gemini-2.5-flash", "safety@1"],
				["deepseek-v4-flash", JUDGE_PROMPT_REF],
				["deepseek-v4-flash", "safety@1"],
				["gemini-2.5-flash", JUDGE_PROMPT_REF],
				["deepseek-v4-flash", "safety@1"],
				["gemini-2.5-flash", JUDGE_PROMPT_REF],
				["gemini-2.5-flash", "safety@2"],
				["deepseek-v4-flash", JUDGE_PROMPT_REF],
				["gemini-2.5-flash", "safety@2"],
				["deepseek-v4-flash", JUDGE_PROMPT_REF],
				["deepseek-v4-flash", "safety@2"],
				["gemini-2.5-flash", JUDGE_PROMPT_REF],
				["deepseek-v4-flash", "safety@2"],
				["gemini-2.5-flash", JUDGE_PROMPT_REF],
			],
		);
		expect(persisted).toHaveLength(4);
		expect(
			persisted.map((run) => ({
				prompt_ref: run.prompt_ref,
				model: run.model,
				score_avg: run.score_avg,
				cost_micro_usd: run.cost_micro_usd,
				resultCosts: run.results.map((item) => item.cost_micro_usd),
			})),
		).toEqual([
			{
				prompt_ref: "safety@prod",
				model: "gemini-2.5-flash",
				score_avg: 0.75,
				cost_micro_usd: 24,
				resultCosts: [12, 12],
			},
			{
				prompt_ref: "safety@prod",
				model: "deepseek-v4-flash",
				score_avg: 0.75,
				cost_micro_usd: 24,
				resultCosts: [12, 12],
			},
			{
				prompt_ref: "safety@candidate",
				model: "gemini-2.5-flash",
				score_avg: 0.5,
				cost_micro_usd: 24,
				resultCosts: [12, 12],
			},
			{
				prompt_ref: "safety@candidate",
				model: "deepseek-v4-flash",
				score_avg: 0.5,
				cost_micro_usd: 24,
				resultCosts: [12, 12],
			},
		]);
	});

	test("returns exit 1 for a paired score drop even when every case passes", async () => {
		const { deps } = createFakeDependencies({ candidateRiskScore: 0.5 });
		const result = await runEvaluation(
			{
				dataset: "meta-eval",
				prompt: "safety@candidate",
				baseline: "prod",
				maxScoreDrop: 0.1,
			},
			{
				...deps,
				loadDataset: async () => ({
					...fixture,
					defaultTest: { threshold: 0 },
				}),
			},
		);
		expect(result.exitCode).toBe(1);
	});

	test("returns exit 1 solely when pass rate is below the dataset threshold", async () => {
		const { deps } = createFakeDependencies();
		const result = await runEvaluation(
			{ dataset: "meta-eval", prompt: "safety@candidate" },
			deps,
		);
		expect(result.exitCode).toBe(1);
	});

	test("treats malformed judge output as infrastructure failure", async () => {
		const { deps } = createFakeDependencies({ malformedJudge: true });
		await expect(
			runEvaluation({ dataset: "meta-eval", prompt: "safety@candidate" }, deps),
		).rejects.toMatchObject({
			name: "AssertionInfrastructureError",
			message: "Rubric evaluator failed.",
			cause: expect.objectContaining({
				message: "Judge returned malformed JSON.",
			}),
		});
	});

	test.each([
		[0, undefined],
		[1, undefined],
		[2, new Error("Judge returned malformed JSON.")],
	] as const)(
		"maps async CLI result %i without network traffic",
		async (expected, failure) => {
			const output = io();
			const fakeRuntime = cliRuntime(expected === 2 ? 0 : expected, failure);
			await expect(
				runCli(
					["run", "--dataset", "fixture", "--prompt", "safety@candidate"],
					output.io,
					{},
					fakeRuntime.runtime,
				),
			).resolves.toBe(expected);
			if (failure) expect(output.stderr).toHaveBeenCalledWith(failure.message);
			else {
				expect(output.stdout).toHaveBeenCalledWith("| fixture |");
				expect(output.stderr).toHaveBeenCalledWith("Warning: offline warning");
			}
		},
	);

	test("passes the CI git SHA to the runner rather than silently replacing it", async () => {
		const output = io();
		const fakeRuntime = cliRuntime(0);
		await expect(
			runCli(
				["run", "--dataset", "fixture", "--prompt", "safety@candidate"],
				output.io,
				{ GITHUB_SHA: "abcdef1" },
				fakeRuntime.runtime,
			),
		).resolves.toBe(0);
		expect(fakeRuntime.runOptions).toEqual([
			expect.objectContaining({ gitSha: "abcdef1" }),
		]);
	});
});
