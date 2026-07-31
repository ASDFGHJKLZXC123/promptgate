import { Chart, type ChartConfiguration } from "chart.js";

import { api } from "./api";
import {
	compactHour,
	escapeHtml,
	type MetricGroup,
	type MetricsPoint,
	type MetricsResponse,
	parseMetricsResponse,
} from "./overview";

export type CostGroup = Extract<MetricGroup, "model" | "key" | "feature">;

const groups: Array<{ value: CostGroup; label: string }> = [
	{ value: "model", label: "Model" },
	{ value: "key", label: "API key" },
	{ value: "feature", label: "Feature" },
];

let activeChart: { destroy: () => void } | undefined;
let activeRequest: AbortController | undefined;
let listenerController: AbortController | undefined;
let loadGeneration = 0;
let selectedGroup: CostGroup = "model";

function invalidResponse(): never {
	throw new Error("The gateway returned an invalid dashboard response.");
}

function sum(
	points: MetricsPoint[],
	field: "exact_value" | "estimated_value",
): number {
	return points.reduce((total, point) => {
		const next = total + (point[field] ?? 0);
		if (!Number.isSafeInteger(next)) invalidResponse();
		return next;
	}, 0);
}

/** Displays every integer micro-USD digit; dashboard cost details never round ledger values to cents. */
export function formatMicroUsdLedger(microUsd: number): string {
	if (!Number.isSafeInteger(microUsd)) invalidResponse();
	const sign = microUsd < 0 ? "-" : "";
	const absolute = Math.abs(microUsd);
	const dollars = Math.floor(absolute / 1_000_000).toLocaleString();
	const micros = String(absolute % 1_000_000).padStart(6, "0");
	return `${sign}$${dollars}.${micros}`;
}

/** Chart scale ticks are illustrative positions, not ledger records, so Chart.js may supply fractional micro-USD values. */
export function formatMicroUsdAxis(value: unknown): string {
	const microUsd = Number(value);
	if (!Number.isFinite(microUsd)) return "";
	if (Number.isSafeInteger(microUsd)) return formatMicroUsdLedger(microUsd);
	return `≈${microUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} μUSD`;
}

export function knownCostSubtotal(points: MetricsPoint[]): number {
	const total = sum(points, "exact_value") + sum(points, "estimated_value");
	if (!Number.isSafeInteger(total)) invalidResponse();
	return total;
}

export function unknownPricingCount(points: MetricsPoint[]): number {
	return points.reduce((total, point) => {
		const next = total + point.unknown_count;
		if (!Number.isSafeInteger(next)) invalidResponse();
		return next;
	}, 0);
}

/** A null raw feature is distinct from a feature literally named "Untagged". */
export function displayCostGroup(
	group: CostGroup,
	value: string | null,
): string {
	const visible = (text: string) => {
		let result = "";
		for (const character of text) {
			const codePoint = character.codePointAt(0);
			if (character === "\\") result += "\\\\";
			else if (codePoint !== undefined && /[\p{Cc}\p{Cf}]/u.test(character)) {
				result +=
					codePoint <= 0xffff
						? `\\u${codePoint.toString(16).padStart(4, "0")}`
						: `\\u{${codePoint.toString(16)}}`;
			} else result += character;
		}
		return result;
	};
	if (group === "feature") {
		return value === null ? "Untagged" : `Feature: ${visible(value)}`;
	}
	return value === null ? "Unknown" : visible(value);
}

export async function requestCostExplorerData(
	signal: AbortSignal,
	group: CostGroup,
	request: typeof api = api,
	nowMs = Date.now(),
): Promise<MetricsResponse> {
	// Request rows have second precision. A shared whole-second exclusive bound
	// prevents a just-written current-second row from straddling a refresh.
	const to = new Date(Math.floor(nowMs / 1_000) * 1_000).toISOString();
	const response = await request(
		`/admin/api/metrics/timeseries?metric=cost&group=${group}&to=${encodeURIComponent(to)}`,
		{ signal },
	);
	if (!response.ok) throw new Error("The gateway could not load cost metrics.");
	return parseMetricsResponse(await response.json(), "cost", group);
}

export function buildCostChartConfig(
	cost: MetricsResponse,
	group: CostGroup,
): ChartConfiguration<"bar"> {
	const labels = cost.points.map(
		(point) =>
			`${compactHour(point.bucket_start)} — ${displayCostGroup(group, point.group_value)}`,
	);
	return {
		type: "bar",
		data: {
			labels,
			datasets: [
				{
					label: "Exact cost",
					data: cost.points.map((point) => point.exact_value ?? 0),
					backgroundColor: "#087e8b",
					borderRadius: 3,
					stack: "cost",
				},
				{
					label: "Estimated cost",
					data: cost.points.map((point) => point.estimated_value ?? 0),
					backgroundColor: "#f2af29",
					borderRadius: 3,
					stack: "cost",
				},
			],
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
						label: (item) =>
							`${item.dataset.label}: ${formatMicroUsdLedger(Number(item.raw))}`,
					},
				},
			},
			scales: {
				x: {
					stacked: true,
					grid: { display: false },
					ticks: { maxRotation: 45, minRotation: 0 },
				},
				y: {
					stacked: true,
					beginAtZero: true,
					ticks: { callback: (value) => formatMicroUsdAxis(value) },
				},
			},
		},
	};
}

function table(rows: string[][]): string {
	if (rows.length === 0) {
		return '<p class="chart-alternative__empty">No cost data is available for this group.</p>';
	}
	return `<div class="table-scroll"><table><thead><tr><th scope="col">Hour (UTC)</th><th scope="col">Group</th><th scope="col">Exact</th><th scope="col">Estimated</th><th scope="col">Known total</th><th scope="col">Unknown pricing</th></tr></thead><tbody>${rows
		.map(
			(row) =>
				`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("")}</tbody></table></div>`;
}

function renderCostResults(cost: MetricsResponse, group: CostGroup): string {
	const exact = sum(cost.points, "exact_value");
	const estimated = sum(cost.points, "estimated_value");
	const unknown = unknownPricingCount(cost.points);
	const rows = cost.points.map((point) => [
		compactHour(point.bucket_start),
		displayCostGroup(group, point.group_value),
		formatMicroUsdLedger(point.exact_value ?? 0),
		formatMicroUsdLedger(point.estimated_value ?? 0),
		formatMicroUsdLedger(point.value ?? 0),
		point.unknown_count === 0
			? "—"
			: `${point.unknown_count.toLocaleString()} request${point.unknown_count === 1 ? "" : "s"}`,
	]);
	const groupLabel =
		groups.find((candidate) => candidate.value === group)?.label ?? "Group";
	return `
			<div class="cost-summary" aria-label="Cost provenance summary"><span><strong>${formatMicroUsdLedger(exact)}</strong> exact</span><span><strong>${formatMicroUsdLedger(estimated)}</strong> estimated</span><span><strong>${unknown.toLocaleString()}</strong> unknown-pricing request${unknown === 1 ? "" : "s"}</span></div>
			<div class="chart-frame chart-frame--cost">${cost.points.length ? '<canvas id="cost-chart" role="img" aria-label="Stacked exact and estimated cost by UTC hour and selected group"></canvas>' : '<p class="empty-state">No cost has been recorded for this group yet.</p>'}</div>
			<p class="panel__caption">Each bar is a UTC hourly bucket and ${escapeHtml(groupLabel.toLowerCase())}. The table keeps the exact ledger amounts, estimated amounts, and missing-pricing count available without relying on the chart.</p>
			<details class="chart-alternative"><summary>View cost data as a table</summary>${table(rows)}</details>`;
}

function explorerChrome(
	group: CostGroup,
	results: string,
	knownTotal: string,
): string {
	return `
		<div class="overview-toolbar">
			<div><p class="eyebrow">FinOps</p><h1 id="cost-title">Cost Explorer</h1><p class="overview-subtitle">Inspect retained raw-request cost by model, API key, or feature.</p></div>
			<button class="button button--secondary" type="button" data-cost-retry>Refresh data</button>
		</div>
		<div class="data-notice" role="note"><strong>Pricing provenance:</strong> exact and estimated charges are shown separately. Missing pricing is never treated as zero; the known total excludes those requests.</div>
		<section class="panel" aria-labelledby="cost-title">
			<div class="cost-controls"><fieldset class="cost-group-fieldset"><legend class="cost-controls__label">Group by</legend><div class="segmented-control">${groups
				.map(
					(candidate) =>
						`<label class="segmented-control__button"><input type="radio" name="cost-group" value="${candidate.value}" data-cost-group="${candidate.value}"${candidate.value === group ? " checked" : ""}>${candidate.label}</label>`,
				)
				.join(
					"",
				)}</div></fieldset><p class="panel__stat" id="cost-known-total">${escapeHtml(knownTotal)}</p></div>
			<div id="cost-results" aria-live="polite">${results}</div>
		</section>`;
}

export function renderCostExplorerData(
	cost: MetricsResponse,
	group: CostGroup,
): string {
	return explorerChrome(
		group,
		renderCostResults(cost, group),
		`${formatMicroUsdLedger(knownCostSubtotal(cost.points))} known`,
	);
}

function shell(content: string): string {
	return `<div class="app-shell"><header class="app-header"><a class="brand" href="#overview" aria-label="PromptGate dashboard home"><span class="brand__mark" aria-hidden="true">P</span><span>PromptGate</span></a><nav aria-label="Dashboard sections"><a class="nav-link" href="#overview">Overview</a><a class="nav-link nav-link--active" href="#cost" aria-current="page">Cost</a><a class="nav-link" href="#prompts">Prompts</a><a class="nav-link" href="#quality">Quality</a></nav></header><main id="dashboard-content" tabindex="-1"><div id="cost-content" aria-labelledby="cost-title">${content}</div></main></div>`;
}

function renderLoading(root: HTMLElement): void {
	const results = root.querySelector<HTMLElement>("#cost-results");
	if (results) {
		root
			.querySelector<HTMLElement>("#cost-known-total")
			?.replaceChildren("Loading…");
		results.innerHTML =
			'<section class="loading-state" aria-live="polite" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading costs</h2><p>Requesting retained raw-request cost metrics.</p></div></section>';
	}
}

function renderError(root: HTMLElement): void {
	const results = root.querySelector<HTMLElement>("#cost-results");
	if (results) {
		root
			.querySelector<HTMLElement>("#cost-known-total")
			?.replaceChildren("Unavailable");
		results.innerHTML =
			'<section class="error-state" role="alert"><h2>Couldn’t load costs</h2><p>Check the gateway connection and admin token, then try again.</p><button class="button" type="button" data-cost-retry>Try again</button></section>';
	}
}

function destroyChart(): void {
	activeChart?.destroy();
	activeChart = undefined;
}

export function disposeCostExplorer(): void {
	loadGeneration += 1;
	activeRequest?.abort();
	activeRequest = undefined;
	listenerController?.abort();
	listenerController = undefined;
	destroyChart();
}

export async function refreshCostExplorer(
	root: HTMLElement,
	requestApi: typeof api = api,
	nowMs = Date.now(),
): Promise<void> {
	const generation = ++loadGeneration;
	activeRequest?.abort();
	const request = new AbortController();
	activeRequest = request;
	destroyChart();
	renderLoading(root);
	try {
		const cost = await requestCostExplorerData(
			request.signal,
			selectedGroup,
			requestApi,
			nowMs,
		);
		if (generation !== loadGeneration || request.signal.aborted) return;
		const results = root.querySelector<HTMLElement>("#cost-results");
		const knownTotal = root.querySelector<HTMLElement>("#cost-known-total");
		if (!results || !knownTotal) return;
		knownTotal.textContent = `${formatMicroUsdLedger(knownCostSubtotal(cost.points))} known`;
		results.innerHTML = renderCostResults(cost, selectedGroup);
		const canvas = root.querySelector<HTMLCanvasElement>("#cost-chart");
		if (canvas)
			activeChart = new Chart(
				canvas,
				buildCostChartConfig(cost, selectedGroup),
			);
	} catch {
		const wasAlreadyAborted = request.signal.aborted;
		request.abort();
		if (generation === loadGeneration && !wasAlreadyAborted) renderError(root);
	} finally {
		if (activeRequest === request) activeRequest = undefined;
	}
}

export function renderCostExplorer(root: HTMLElement): void {
	disposeCostExplorer();
	root.innerHTML = shell(
		explorerChrome(
			selectedGroup,
			'<section class="loading-state" aria-live="polite" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading costs</h2><p>Requesting retained raw-request cost metrics.</p></div></section>',
			"Loading…",
		),
	);
	listenerController = new AbortController();
	root.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-cost-retry]")) {
				void refreshCostExplorer(root);
				return;
			}
		},
		{ signal: listenerController.signal },
	);
	root.addEventListener(
		"change",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) return;
			const group = target.dataset.costGroup;
			if (group === "model" || group === "key" || group === "feature") {
				selectedGroup = group;
				void refreshCostExplorer(root);
			}
		},
		{ signal: listenerController.signal },
	);
	void refreshCostExplorer(root);
}
