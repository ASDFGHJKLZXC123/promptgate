import { Chart, type ChartConfiguration, type Plugin } from "chart.js";

import { api } from "./api";
import { escapeHtml } from "./overview";

export interface EvalRun {
	id: number;
	ts: string;
	dataset_id: number;
	dataset_slug: string;
	dataset_hash: string;
	prompt_id: number | null;
	prompt_version: number | null;
	prompt_ref: string | null;
	model: string;
	git_sha: string | null;
	trigger: "ci" | "manual";
	cases_total: number;
	cases_passed: number;
	score_avg: number | null;
	cost_micro_usd: number;
	duration_ms: number;
}

export interface QualityPartition {
	dataset_hash: string;
	runs: EvalRun[];
}

export interface QualityAnnotation {
	dataset_hash: string;
	run_id: number;
	index: number;
	changes: string[];
}

export interface QualityPoint {
	x: number;
	y: number | null;
}

export type QualityChartFactory = (
	canvas: HTMLCanvasElement,
	runs: readonly EvalRun[],
) => { destroy: () => void };

let activeChart: { destroy: () => void } | undefined;
let activeRequest: AbortController | undefined;
let listenerController: AbortController | undefined;
let loadGeneration = 0;

function invalidResponse(): never {
	throw new Error("The gateway returned an invalid quality-drift response.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonblankText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Eval rows use SQLite UTC seconds, so browser-local timestamp parsing is never accepted. */
function isCanonicalSqliteSecond(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
	)
		return false;
	const canonical = `${value.replace(" ", "T")}Z`;
	const parsed = new Date(canonical);
	return (
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString() === `${canonical.slice(0, -1)}.000Z`
	);
}

function parseRun(value: unknown): EvalRun {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"cases_passed",
			"cases_total",
			"cost_micro_usd",
			"dataset_hash",
			"dataset_id",
			"dataset_slug",
			"duration_ms",
			"git_sha",
			"id",
			"model",
			"prompt_id",
			"prompt_ref",
			"prompt_version",
			"score_avg",
			"trigger",
			"ts",
		]) ||
		!isPositiveSafeInteger(value.id) ||
		!isCanonicalSqliteSecond(value.ts) ||
		!isPositiveSafeInteger(value.dataset_id) ||
		!isNonblankText(value.dataset_slug) ||
		typeof value.dataset_hash !== "string" ||
		!/^[a-fA-F0-9]{64}$/.test(value.dataset_hash) ||
		!isNonblankText(value.model) ||
		(value.git_sha !== null &&
			(typeof value.git_sha !== "string" ||
				!/^[a-fA-F0-9]{7,64}$/.test(value.git_sha))) ||
		(value.trigger !== "ci" && value.trigger !== "manual") ||
		!isPositiveSafeInteger(value.cases_total) ||
		!isNonnegativeSafeInteger(value.cases_passed) ||
		value.cases_passed > value.cases_total ||
		(value.score_avg !== null &&
			(typeof value.score_avg !== "number" ||
				!Number.isFinite(value.score_avg) ||
				value.score_avg < 0 ||
				value.score_avg > 1)) ||
		!isNonnegativeSafeInteger(value.cost_micro_usd) ||
		!isNonnegativeSafeInteger(value.duration_ms)
	) {
		invalidResponse();
	}

	const hasPromptId = value.prompt_id !== null;
	const hasPromptVersion = value.prompt_version !== null;
	const hasPromptRef = value.prompt_ref !== null;
	if (
		hasPromptId !== hasPromptVersion ||
		hasPromptId !== hasPromptRef ||
		(hasPromptId && !isPositiveSafeInteger(value.prompt_id)) ||
		(hasPromptVersion && !isPositiveSafeInteger(value.prompt_version)) ||
		(hasPromptRef && !isNonblankText(value.prompt_ref))
	) {
		invalidResponse();
	}

	return {
		id: value.id,
		ts: value.ts,
		dataset_id: value.dataset_id,
		dataset_slug: value.dataset_slug,
		dataset_hash: value.dataset_hash,
		prompt_id: value.prompt_id as number | null,
		prompt_version: value.prompt_version as number | null,
		prompt_ref: value.prompt_ref as string | null,
		model: value.model,
		git_sha: value.git_sha as string | null,
		trigger: value.trigger,
		cases_total: value.cases_total,
		cases_passed: value.cases_passed,
		score_avg: value.score_avg as number | null,
		cost_micro_usd: value.cost_micro_usd,
		duration_ms: value.duration_ms,
	};
}

/** The endpoint returns newest-first; reject any ambiguous or stale ordering. */
export function parseEvalRuns(value: unknown): EvalRun[] {
	if (!Array.isArray(value)) invalidResponse();
	const runs = value.map(parseRun);
	const ids = new Set<number>();
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index];
		const previous = runs[index - 1];
		if (!run || ids.has(run.id)) invalidResponse();
		ids.add(run.id);
		if (
			previous &&
			(previous.ts < run.ts ||
				(previous.ts === run.ts && previous.id <= run.id))
		) {
			invalidResponse();
		}
	}
	return runs;
}

export async function requestQualityDriftData(
	signal: AbortSignal,
	request: typeof api = api,
): Promise<EvalRun[]> {
	const response = await request("/admin/api/evals/runs", {
		signal,
		cache: "no-store",
	});
	if (!response.ok)
		throw new Error("The gateway could not load evaluation runs.");
	return parseEvalRuns(await response.json());
}

/** Keeps literal backslashes distinct from hidden control/bidi characters in identity fields. */
export function displayQualityIdentity(value: string): string {
	let rendered = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (character === "\\") rendered += "\\\\";
		else if (codePoint !== undefined && /[\p{Cc}\p{Cf}]/u.test(character)) {
			rendered +=
				codePoint <= 0xffff
					? `\\u${codePoint.toString(16).padStart(4, "0")}`
					: `\\u{${codePoint.toString(16)}}`;
		} else rendered += character;
	}
	return rendered;
}

function safeIdentity(value: string): string {
	return escapeHtml(displayQualityIdentity(value));
}

export function chronologicalRuns(runs: readonly EvalRun[]): EvalRun[] {
	return [...runs].sort((left, right) =>
		left.ts === right.ts ? left.id - right.id : left.ts.localeCompare(right.ts),
	);
}

/** Partition before charting or comparing so incompatible datasets can never be joined. */
export function partitionByDatasetHash(
	runs: readonly EvalRun[],
): QualityPartition[] {
	const byHash = new Map<string, EvalRun[]>();
	for (const run of chronologicalRuns(runs)) {
		const partition = byHash.get(run.dataset_hash) ?? [];
		partition.push(run);
		byHash.set(run.dataset_hash, partition);
	}
	return [...byHash.entries()]
		.map(([dataset_hash, partitionRuns]) => ({
			dataset_hash,
			runs: partitionRuns,
		}))
		.sort((left, right) => left.dataset_hash.localeCompare(right.dataset_hash));
}

function promptVersionText(run: EvalRun): string {
	return run.prompt_version === null
		? "unattributed"
		: `v${run.prompt_version}`;
}

export function qualityAnnotations(
	partitions: readonly QualityPartition[],
	chronological: readonly EvalRun[],
): QualityAnnotation[] {
	const chartIndex = new Map(
		chronological.map((run, index) => [run.id, index]),
	);
	const annotations: QualityAnnotation[] = [];
	for (const partition of partitions) {
		for (let index = 1; index < partition.runs.length; index += 1) {
			const previous = partition.runs[index - 1];
			const current = partition.runs[index];
			if (!previous || !current) continue;
			const changes: string[] = [];
			if (previous.prompt_version !== current.prompt_version) {
				changes.push(
					`Prompt ${promptVersionText(previous)} → ${promptVersionText(current)}`,
				);
			}
			if (previous.model !== current.model) {
				changes.push(
					`Model ${displayQualityIdentity(previous.model)} → ${displayQualityIdentity(current.model)}`,
				);
			}
			if (changes.length > 0) {
				const chartPosition = chartIndex.get(current.id);
				if (chartPosition === undefined) invalidResponse();
				annotations.push({
					dataset_hash: partition.dataset_hash,
					run_id: current.id,
					index: chartPosition,
					changes,
				});
			}
		}
	}
	return annotations;
}

export function passRate(run: EvalRun): number {
	return run.cases_passed / run.cases_total;
}

function timestampLabel(timestamp: string): string {
	return `${timestamp} UTC`;
}

function hashLabel(hash: string): string {
	return `Dataset ${displayQualityIdentity(hash.slice(0, 12))}…`;
}

export function buildQualityChartConfig(
	runs: readonly EvalRun[],
	partitions = partitionByDatasetHash(runs),
): ChartConfiguration<"line", QualityPoint[]> {
	const chronological = chronologicalRuns(runs);
	const indexByRunId = new Map(
		chronological.map((run, index) => [run.id, index]),
	);
	const timestampByIndex = new Map(
		chronological.map((run, index) => [index, timestampLabel(run.ts)]),
	);
	return {
		type: "line",
		data: {
			datasets: partitions.flatMap((partition, index) => {
				const color =
					["#087e8b", "#7851a9", "#d95d39", "#2d936c"][index % 4] ?? "#087e8b";
				return [
					{
						label: `Score — ${hashLabel(partition.dataset_hash)}`,
						data: partition.runs.map((run) => ({
							x: indexByRunId.get(run.id) ?? invalidResponse(),
							y: run.score_avg,
						})),
						borderColor: color,
						backgroundColor: color,
						borderWidth: 2,
						pointRadius: 3,
						spanGaps: false,
						yAxisID: "quality",
					},
					{
						label: `Pass rate — ${hashLabel(partition.dataset_hash)}`,
						data: partition.runs.map((run) => ({
							x: indexByRunId.get(run.id) ?? invalidResponse(),
							y: passRate(run),
						})),
						borderColor: color,
						backgroundColor: color,
						borderDash: [6, 4],
						borderWidth: 2,
						pointRadius: 3,
						spanGaps: false,
						yAxisID: "quality",
					},
				];
			}),
		},
		options: {
			animation: false,
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					position: "bottom",
					labels: { usePointStyle: true, boxWidth: 8 },
				},
				tooltip: {
					callbacks: {
						title: (items) => {
							const position = items[0]?.parsed.x;
							return position === undefined || position === null
								? ""
								: (timestampByIndex.get(position) ?? "");
						},
						label: (item) =>
							`${item.dataset.label}: ${item.parsed.y === null ? "Unavailable" : `${(item.parsed.y * 100).toFixed(1)}%`}`,
					},
				},
			},
			scales: {
				x: {
					type: "linear",
					min: 0,
					max: Math.max(chronological.length - 1, 1),
					grid: { display: false },
					ticks: {
						maxRotation: 45,
						minRotation: 0,
						stepSize: 1,
						callback: (value) =>
							Number.isSafeInteger(Number(value))
								? (timestampByIndex.get(Number(value)) ?? "")
								: "",
					},
				},
				quality: {
					type: "linear",
					position: "left",
					min: 0,
					max: 1,
					ticks: {
						callback: (value) => `${(Number(value) * 100).toFixed(0)}%`,
					},
				},
			},
		},
	};
}

function annotationPlugin(
	annotations: readonly QualityAnnotation[],
): Plugin<"line"> {
	return {
		id: "quality-change-annotations",
		afterDatasetsDraw(chart) {
			const x = chart.scales.x;
			if (!x) return;
			const { ctx, chartArea } = chart;
			ctx.save();
			ctx.strokeStyle = "#64727c";
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 3]);
			for (const annotation of annotations) {
				const pixel = x.getPixelForValue(annotation.index);
				ctx.beginPath();
				ctx.moveTo(pixel, chartArea.top);
				ctx.lineTo(pixel, chartArea.bottom);
				ctx.stroke();
			}
			ctx.restore();
		},
	};
}

function createQualityChart(
	canvas: HTMLCanvasElement,
	runs: readonly EvalRun[],
): { destroy: () => void } {
	const chronological = chronologicalRuns(runs);
	const partitions = partitionByDatasetHash(chronological);
	return new Chart(canvas, {
		...buildQualityChartConfig(chronological, partitions),
		plugins: [annotationPlugin(qualityAnnotations(partitions, chronological))],
	});
}

function table(
	runs: readonly EvalRun[],
	annotations: readonly QualityAnnotation[],
): string {
	const annotationByRun = new Map(
		annotations.map((annotation) => [annotation.run_id, annotation]),
	);
	return `<div class="table-scroll" tabindex="0" role="region" aria-label="Complete evaluation history table"><table><thead><tr><th scope="col">Dataset hash</th><th scope="col">Timestamp (UTC)</th><th scope="col">Prompt</th><th scope="col">Model</th><th scope="col">Pass rate</th><th scope="col">Score</th><th scope="col">Trigger</th><th scope="col">Git SHA</th><th scope="col">Change</th></tr></thead><tbody>${runs
		.map((run) => {
			const annotation = annotationByRun.get(run.id);
			const prompt =
				run.prompt_ref === null
					? "Unavailable"
					: `${displayQualityIdentity(run.prompt_ref)} @ v${run.prompt_version}`;
			return `<tr><td><code>${safeIdentity(run.dataset_hash)}</code></td><td>${escapeHtml(timestampLabel(run.ts))}</td><td>${escapeHtml(prompt)}</td><td>${safeIdentity(run.model)}</td><td>${(passRate(run) * 100).toFixed(1)}%</td><td>${run.score_avg === null ? "Unavailable" : `${(run.score_avg * 100).toFixed(1)}%`}</td><td>${escapeHtml(run.trigger)}</td><td>${run.git_sha === null ? "—" : `<code>${safeIdentity(run.git_sha)}</code>`}</td><td>${annotation ? annotation.changes.map(escapeHtml).join("; ") : "—"}</td></tr>`;
		})
		.join("")}</tbody></table></div>`;
}

export function renderQualityDriftData(runs: readonly EvalRun[]): string {
	const chronological = chronologicalRuns(runs);
	const partitions = partitionByDatasetHash(chronological);
	const annotations = qualityAnnotations(partitions, chronological);
	if (chronological.length === 0) {
		return '<section class="panel quality-empty"><p class="empty-state">No evaluation runs have been recorded yet. Run an evaluation to establish a quality history.</p></section>';
	}
	return `<section class="panel quality-panel" aria-labelledby="quality-chart-title"><div class="panel__heading"><div><p class="panel__kicker">Historical evaluation</p><h2 id="quality-chart-title">Score and pass rate over time</h2></div><p class="panel__stat">${chronological.length} run${chronological.length === 1 ? "" : "s"} · ${partitions.length} dataset hash${partitions.length === 1 ? "" : "es"}</p></div><div class="chart-frame chart-frame--quality"><canvas id="quality-chart" role="img" aria-label="Score and pass rate by evaluation run, separated by dataset hash. Solid lines show score; dashed lines show pass rate; vertical dashed markers indicate adjacent prompt-version or model changes within one dataset hash."></canvas></div><p class="panel__caption">Pass rate is the share of cases where all assertions pass. Score is the arithmetic mean over scored rubric cases only; unscored cases do not enter it. Solid lines show score and dashed lines show pass rate. A score of Unavailable is a gap, never zero. Dataset hashes are separate series and are never connected. Vertical markers identify adjacent prompt-version or model changes only.</p><details class="chart-alternative"><summary>View the complete evaluation history as a table</summary>${table(chronological, annotations)}</details></section><section class="panel quality-annotations" aria-labelledby="quality-annotations-title"><h2 id="quality-annotations-title">Comparable-run change markers</h2>${annotations.length === 0 ? '<p class="prompt-muted">No adjacent prompt-version or model changes were found within the same dataset hash.</p>' : `<ul>${annotations.map((annotation) => `<li><code>${safeIdentity(annotation.dataset_hash.slice(0, 12))}…</code> · ${annotation.changes.map(escapeHtml).join("; ")}</li>`).join("")}</ul>`}</section>`;
}

function shell(content: string): string {
	return `<div class="app-shell"><header class="app-header"><a class="brand" href="#overview" aria-label="PromptGate dashboard home"><span class="brand__mark" aria-hidden="true">P</span><span>PromptGate</span></a><nav aria-label="Dashboard sections"><a class="nav-link" href="#overview">Overview</a><a class="nav-link" href="#cost">Cost</a><a class="nav-link" href="#prompts">Prompts</a><a class="nav-link nav-link--active" href="#quality" aria-current="page">Quality</a></nav></header><main id="dashboard-content" tabindex="-1"><div class="overview-toolbar"><div><p class="eyebrow">Evaluation history</p><h1 id="quality-title">Quality Drift</h1><p class="overview-subtitle">Track all-assertions case pass rates and rubric-only score averages without crossing dataset versions.</p></div><button class="button button--secondary" type="button" data-quality-retry>Refresh data</button></div><div class="data-notice quality-disclosure" role="note"><strong>Interpretation limit:</strong> historical judge identity was not persisted. Change markers are context, not causation: a judge change may explain score movement, so this screen does not attribute movement to a prompt or model.</div><p id="quality-status" class="quality-status" role="status" aria-live="polite" hidden></p><div id="quality-results">${content}</div></main></div>`;
}

function renderLoading(root: HTMLElement): void {
	const results = root.querySelector<HTMLElement>("#quality-results");
	if (results) {
		results.innerHTML =
			'<section class="loading-state" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading quality history</h2><p>Requesting retained evaluation runs.</p></div></section>';
	}
}

function renderError(root: HTMLElement): void {
	const results = root.querySelector<HTMLElement>("#quality-results");
	if (results) {
		results.innerHTML =
			'<section class="error-state" role="alert"><h2>Couldn’t load quality history</h2><p>Check the gateway connection and admin token, then try again.</p><button class="button" type="button" data-quality-retry>Try again</button></section>';
	}
}

function updateStatus(root: HTMLElement, message: string | undefined): void {
	const status = root.querySelector<HTMLElement>("#quality-status");
	if (!status) return;
	status.textContent = message ?? "";
	status.hidden = message === undefined;
}

function destroyChart(): void {
	activeChart?.destroy();
	activeChart = undefined;
}

export function disposeQualityDrift(): void {
	loadGeneration += 1;
	activeRequest?.abort();
	activeRequest = undefined;
	listenerController?.abort();
	listenerController = undefined;
	destroyChart();
}

export async function refreshQualityDrift(
	root: HTMLElement,
	requestApi: typeof api = api,
	chartFactory: QualityChartFactory = createQualityChart,
): Promise<void> {
	const generation = ++loadGeneration;
	activeRequest?.abort();
	const request = new AbortController();
	activeRequest = request;
	destroyChart();
	renderLoading(root);
	updateStatus(root, "Loading quality history.");
	try {
		const runs = await requestQualityDriftData(request.signal, requestApi);
		if (generation !== loadGeneration || request.signal.aborted) return;
		const results = root.querySelector<HTMLElement>("#quality-results");
		if (!results) return;
		results.innerHTML = renderQualityDriftData(runs);
		const canvas = root.querySelector<HTMLCanvasElement>("#quality-chart");
		if (canvas && runs.length > 0) {
			activeChart = chartFactory(canvas, runs);
		}
		updateStatus(
			root,
			`Loaded ${runs.length} evaluation run${runs.length === 1 ? "" : "s"}.`,
		);
	} catch {
		const wasAlreadyAborted = request.signal.aborted;
		request.abort();
		if (generation === loadGeneration && !wasAlreadyAborted) {
			renderError(root);
			updateStatus(root, "Quality history could not be loaded.");
		}
	} finally {
		if (activeRequest === request) activeRequest = undefined;
	}
}

export function renderQualityDrift(
	root: HTMLElement,
	requestApi: typeof api = api,
	chartFactory: QualityChartFactory = createQualityChart,
): void {
	disposeQualityDrift();
	root.innerHTML = shell(
		'<section class="loading-state" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading quality history</h2><p>Requesting retained evaluation runs.</p></div></section>',
	);
	listenerController = new AbortController();
	root.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (target instanceof Element && target.closest("[data-quality-retry]")) {
				void refreshQualityDrift(root, requestApi, chartFactory);
			}
		},
		{ signal: listenerController.signal },
	);
	void refreshQualityDrift(root, requestApi, chartFactory);
}
