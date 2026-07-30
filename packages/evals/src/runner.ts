import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AdminClient, PromptSummary } from "./admin-client.js";
import {
	type CaseAssertionResult,
	evaluateCaseAssertions,
} from "./assertions.js";
import { type LoadedDataset, loadDataset } from "./dataset.js";
import type { GatewayClient, GatewayResponse } from "./gateway-client.js";
import {
	createGatewayRubricEvaluator,
	PHASE_5_TARGET_MODELS,
} from "./judge.js";
import { PerModelRequestPacer, type RequestPacingClock } from "./pacing.js";

export class EvalRunError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalRunError";
	}
}
export interface EvalRunnerOptions {
	dataset: string;
	prompt: string;
	baseline?: string;
	baselineFromHistory?: boolean;
	allowCache?: boolean;
	maxScoreDrop?: number;
	minRequestIntervalMs?: number;
	gitSha?: string;
	trigger?: "ci" | "manual";
}
export interface EvalRunDependencies {
	gateway: Pick<GatewayClient, "complete">;
	admin: Pick<
		AdminClient,
		"promptSummaries" | "upsertDataset" | "createRun" | "historicalRuns"
	>;
	loadDataset?: typeof loadDataset;
	now?: () => number;
	pacingClock?: RequestPacingClock;
	gitSha?: () => string | undefined;
}
interface FrozenPrompt {
	id: number;
	ref: string;
	version: number;
}
interface ModelResult {
	model: string;
	passRate: number;
	scoreAvg?: number;
	results: readonly {
		caseId: string;
		pass: boolean;
		score?: number;
		detail: CaseAssertionResult;
		latencyMs: number;
		costMicroUsd: number;
	}[];
	costMicroUsd: number;
	durationMs: number;
}
const HistoricalRunsSchema = z.array(
	z
		.object({
			id: z.number().int().positive().safe(),
			dataset_slug: z.string().min(1),
			model: z.string().min(1),
			dataset_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
			prompt_id: z.number().int().positive().safe(),
			prompt_version: z.number().int().positive().safe(),
			prompt_ref: z.string().min(1),
			cases_total: z.number().int().positive().safe(),
			score_avg: z.number().finite().min(0).max(1).nullable(),
		})
		.passthrough(),
);

export function datasetPath(value: string): string {
	if (existsSync(value)) return value;
	if (/\.ya?ml$/i.test(value)) return resolve(value);
	return fileURLToPath(
		new URL(`../datasets/${datasetSlug(value)}.yaml`, import.meta.url),
	);
}
function datasetSlug(value: string): string {
	const base = value.replaceAll("\\", "/").split("/").pop() ?? value;
	const slug = base.replace(/\.ya?ml$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug))
		throw new EvalRunError("Dataset slug is invalid.");
	return slug;
}
function freezeRef(
	ref: string,
	summaries: readonly PromptSummary[],
): FrozenPrompt {
	const at = ref.lastIndexOf("@");
	if (at <= 0 || at !== ref.indexOf("@") || at === ref.length - 1)
		throw new EvalRunError("Prompt reference is invalid.");
	const slug = ref.slice(0, at);
	const target = ref.slice(at + 1);
	const prompt = summaries.find((item) => item.slug === slug);
	if (!prompt) throw new EvalRunError("Prompt reference was not found.");
	const version = /^\d+$/.test(target)
		? Number(target)
		: prompt.labels.find((label) => label.label === target)?.version;
	if (
		!Number.isSafeInteger(version) ||
		(version as number) < 1 ||
		(/^\d+$/.test(target) && prompt.latest_version === null) ||
		(prompt.latest_version !== null &&
			(version as number) > prompt.latest_version)
	)
		throw new EvalRunError("Prompt label could not be resolved.");
	return { id: prompt.id, ref, version: version as number };
}
function validGitSha(value: string | undefined): string | undefined {
	return value !== undefined && /^[0-9a-f]{7,64}$/i.test(value)
		? value
		: undefined;
}
export function resolveGitSha(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const fromEnv = validGitSha(env.GITHUB_SHA);
	if (fromEnv) return fromEnv;
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? validGitSha(result.stdout.trim()) : undefined;
}
function markdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll(/[\r\n]+/g, " ");
}
function scoredCases(run: ModelResult): number {
	return run.results.filter((item) => item.score !== undefined).length;
}
function comparisonLine(
	baselineRun: ModelResult,
	candidateRun: ModelResult,
	scoreDrop?: number,
): string {
	const drop =
		scoreDrop ??
		(baselineRun.scoreAvg !== undefined && candidateRun.scoreAvg !== undefined
			? baselineRun.scoreAvg - candidateRun.scoreAvg
			: undefined);
	const side = (label: string, run: ModelResult) =>
		`${label} score avg ${run.scoreAvg ?? "none"} over ${scoredCases(run)} scored cases`;
	return `${candidateRun.model}: ${side("baseline", baselineRun)}; ${side("candidate", candidateRun)}; score drop ${drop ?? "unavailable"}.`;
}
function markdown(results: readonly ModelResult[]): string {
	return [
		"| case | model | pass | score | first failed detail |",
		"|---|---|---|---|---|",
		...results.flatMap((run) =>
			run.results.map(
				(item) =>
					`| ${markdownCell(item.caseId)} | ${markdownCell(run.model)} | ${item.pass ? "pass" : "fail"} | ${item.score ?? ""} | ${markdownCell(item.detail.firstFailedAssertion?.detail ?? "")} |`,
			),
		),
	].join("\n");
}

async function runModel(
	dataset: LoadedDataset,
	frozen: FrozenPrompt,
	model: string,
	options: EvalRunnerOptions,
	deps: EvalRunDependencies,
	gateway: EvalRunDependencies["gateway"],
): Promise<ModelResult> {
	const now = deps.now ?? Date.now;
	const started = now();
	const results: Array<ModelResult["results"][number]> = [];
	let totalCost = 0;
	let active: { cost: number } | undefined;
	const meteredGateway = {
		complete: async (
			call: Parameters<EvalRunDependencies["gateway"]["complete"]>[0],
		) => {
			const response = await gateway.complete({
				...call,
				allowCache: options.allowCache,
			});
			totalCost += response.costMicroUsd;
			if (!Number.isSafeInteger(totalCost))
				throw new EvalRunError(
					"Evaluation cost exceeds the safe integer range.",
				);
			if (active) active.cost += response.costMicroUsd;
			return response;
		},
	};
	const rubric = createGatewayRubricEvaluator(meteredGateway, model);
	for (const test of dataset.tests) {
		const caseStarted = now();
		active = { cost: 0 };
		const response: GatewayResponse = await meteredGateway.complete({
			model,
			prompt: `${frozen.ref.slice(0, frozen.ref.lastIndexOf("@"))}@${frozen.version}`,
			vars: test.vars,
			allowCache: options.allowCache,
		});
		const detail = await evaluateCaseAssertions(response.content, test, {
			rubric,
		});
		results.push({
			caseId: test.id,
			pass: detail.pass,
			...(detail.score === undefined ? {} : { score: detail.score }),
			detail,
			latencyMs: Math.max(0, Math.round(now() - caseStarted)),
			costMicroUsd: active.cost,
		});
		active = undefined;
	}
	const scores = results.flatMap((item) =>
		item.score === undefined ? [] : [item.score],
	);
	return {
		model,
		passRate: results.filter((item) => item.pass).length / results.length,
		...(scores.length === 0
			? {}
			: { scoreAvg: scores.reduce((a, b) => a + b, 0) / scores.length }),
		results,
		costMicroUsd: totalCost,
		durationMs: Math.max(0, Math.round(now() - started)),
	};
}

function requestInterval(options: EvalRunnerOptions): number {
	const interval = options.minRequestIntervalMs ?? 0;
	if (!Number.isSafeInteger(interval) || interval < 0)
		throw new EvalRunError(
			"min-request-interval-ms must be a non-negative safe integer.",
		);
	return interval;
}

/**
 * Rejects only score drops materially above the configured boundary.
 *
 * Decimal scores such as 0.9 and 0.85 are not exactly representable in
 * binary floating point, so their mathematically exact 0.05 difference can
 * evaluate to 0.050000000000000044. One scale-adjusted machine epsilon
 * admits only that scalar comparison roundoff.
 */
function scoreDropExceeds(
	baselineScore: number,
	candidateScore: number,
	maximumAllowedDrop: number,
): boolean {
	const scoreDrop = baselineScore - candidateScore;
	const scale = Math.max(
		1,
		Math.abs(baselineScore),
		Math.abs(candidateScore),
		Math.abs(maximumAllowedDrop),
	);
	return scoreDrop > maximumAllowedDrop + Number.EPSILON * scale;
}

export async function runEvaluation(
	options: EvalRunnerOptions,
	deps: EvalRunDependencies,
): Promise<{ exitCode: 0 | 1; markdown: string; warnings: readonly string[] }> {
	const minRequestIntervalMs = requestInterval(options);
	if (options.baselineFromHistory && options.baseline === undefined)
		throw new EvalRunError("--baseline-from-history requires --baseline.");
	if (
		!Number.isFinite(options.maxScoreDrop ?? 0.05) ||
		(options.maxScoreDrop ?? 0.05) < 0 ||
		(options.maxScoreDrop ?? 0.05) > 1
	)
		throw new EvalRunError(
			"max-score-drop must be a finite number between 0 and 1.",
		);
	const suppliedGitSha = options.gitSha ?? deps.gitSha?.();
	if (suppliedGitSha !== undefined && !validGitSha(suppliedGitSha))
		throw new EvalRunError("git SHA is invalid.");
	const dataset = await (deps.loadDataset ?? loadDataset)(
		datasetPath(options.dataset),
	);
	const slug = datasetSlug(options.dataset);
	if (!dataset.prompts.includes(options.prompt))
		throw new EvalRunError("Selected prompt is not declared by the dataset.");
	if (
		dataset.providers.length !== PHASE_5_TARGET_MODELS.length ||
		dataset.providers.some(
			(model, index) => model !== PHASE_5_TARGET_MODELS[index],
		)
	)
		throw new EvalRunError(
			"Phase 5 requires DeepSeek exactly once as the dataset provider.",
		);
	const summaries = await deps.admin.promptSummaries();
	const candidate = freezeRef(options.prompt, summaries);
	const baseline =
		options.baseline === undefined
			? undefined
			: freezeRef(
					`${candidate.ref.slice(0, candidate.ref.lastIndexOf("@"))}@${options.baseline}`,
					summaries,
				);
	if (baseline?.ref === candidate.ref)
		throw new EvalRunError("Baseline ref must differ from candidate ref.");
	// A fresh pair whose refs freeze to one identical version would measure
	// judge nondeterminism, not a prompt change, so it runs once as the
	// candidate with its score drop defined as zero.
	const samePairedVersion =
		baseline !== undefined &&
		!options.baselineFromHistory &&
		baseline.id === candidate.id &&
		baseline.version === candidate.version;
	const historyScores = new Map<string, number | null>();
	if (options.baselineFromHistory && baseline) {
		for (const model of dataset.providers) {
			const history = HistoricalRunsSchema.safeParse(
				await deps.admin.historicalRuns(
					new URLSearchParams({
						dataset: slug,
						prompt_ref: baseline.ref,
						model,
					}),
				),
			);
			if (!history.success)
				throw new EvalRunError("Historical baseline response was invalid.");
			const match = history.data.find(
				(run) =>
					run.dataset_slug === slug &&
					run.dataset_hash === dataset.datasetHash &&
					run.prompt_id === baseline.id &&
					run.prompt_version === baseline.version &&
					run.prompt_ref === baseline.ref &&
					run.model === model &&
					run.cases_total === dataset.tests.length,
			);
			if (!match) throw new EvalRunError("Historical baseline is missing.");
			historyScores.set(model, match.score_avg);
		}
	}
	const datasetRow = await deps.admin.upsertDataset({
		slug,
		file_path: dataset.path,
		description: dataset.description,
	});
	const pacer = new PerModelRequestPacer(
		minRequestIntervalMs,
		deps.pacingClock,
	);
	const gateway: EvalRunDependencies["gateway"] =
		minRequestIntervalMs === 0
			? deps.gateway
			: {
					complete: async (call) => {
						await pacer.wait(call.model);
						return deps.gateway.complete(call);
					},
				};
	const trigger = options.allowCache ? "manual" : (options.trigger ?? "manual");
	const gitSha = suppliedGitSha ?? resolveGitSha();
	const persist = async (frozen: FrozenPrompt, result: ModelResult) =>
		deps.admin.createRun({
			dataset_id: datasetRow.id,
			dataset_hash: dataset.datasetHash,
			prompt_id: frozen.id,
			prompt_version: frozen.version,
			prompt_ref: frozen.ref,
			model: result.model,
			git_sha: gitSha ?? null,
			trigger,
			cases_total: result.results.length,
			cases_passed: result.results.filter((item) => item.pass).length,
			score_avg: result.scoreAvg ?? null,
			cost_micro_usd: result.costMicroUsd,
			duration_ms: result.durationMs,
			results: result.results.map((item) => ({
				case_id: item.caseId,
				passed: item.pass,
				score: item.score ?? null,
				detail_json: item.detail,
				latency_ms: item.latencyMs,
				cost_micro_usd: item.costMicroUsd,
			})),
		});
	const baselineRuns: ModelResult[] = [];
	if (baseline && !options.baselineFromHistory && !samePairedVersion)
		for (const model of dataset.providers) {
			const result = await runModel(
				dataset,
				baseline,
				model,
				options,
				deps,
				gateway,
			);
			await persist(baseline, result);
			baselineRuns.push(result);
		}
	const candidateRuns: ModelResult[] = [];
	for (const model of dataset.providers) {
		const result = await runModel(
			dataset,
			candidate,
			model,
			options,
			deps,
			gateway,
		);
		await persist(candidate, result);
		candidateRuns.push(result);
	}
	let qualityFail = candidateRuns.some(
		(run) => run.passRate < dataset.defaultTest.threshold,
	);
	const summary: string[] = [];
	if (baseline && samePairedVersion) {
		summary.push(
			`Baseline ${baseline.ref} and candidate ${candidate.ref} resolved to the same prompt version ${candidate.version}; the candidate ran once and the score drop is zero.`,
		);
		for (const candidateRun of candidateRuns)
			summary.push(comparisonLine(candidateRun, candidateRun, 0));
	}
	if (baseline && !options.baselineFromHistory && !samePairedVersion)
		for (const candidateRun of candidateRuns) {
			const baselineRun = baselineRuns.find(
				(item) => item.model === candidateRun.model,
			);
			if (!baselineRun)
				throw new EvalRunError("Paired baseline is incomplete.");
			if (
				baselineRun.scoreAvg !== undefined &&
				candidateRun.scoreAvg === undefined
			)
				qualityFail = true;
			if (
				candidateRun.scoreAvg !== undefined &&
				baselineRun.scoreAvg !== undefined &&
				scoreDropExceeds(
					baselineRun.scoreAvg,
					candidateRun.scoreAvg,
					options.maxScoreDrop ?? 0.05,
				)
			)
				qualityFail = true;
			summary.push(comparisonLine(baselineRun, candidateRun));
		}
	if (options.baselineFromHistory) {
		for (const candidateRun of candidateRuns) {
			const baselineScore = historyScores.get(candidateRun.model);
			if (baselineScore === undefined)
				throw new EvalRunError("Historical baseline is missing.");
			if (baselineScore !== null && candidateRun.scoreAvg === undefined)
				qualityFail = true;
			if (
				baselineScore !== null &&
				candidateRun.scoreAvg !== undefined &&
				scoreDropExceeds(
					baselineScore,
					candidateRun.scoreAvg,
					options.maxScoreDrop ?? 0.05,
				)
			)
				qualityFail = true;
		}
	}
	return {
		exitCode: qualityFail ? 1 : 0,
		markdown: [markdown(candidateRuns), ...summary].join("\n"),
		warnings: dataset.warnings,
	};
}
