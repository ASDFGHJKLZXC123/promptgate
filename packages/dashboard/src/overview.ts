import { Chart, type ChartConfiguration, type ChartType } from "chart.js";

import { api } from "./api";

export type MetricName =
	| "cost"
	| "request_count"
	| "latency_p50"
	| "latency_p95"
	| "cache_rate"
	| "cache_saved";
export type MetricUnit = "micro_usd" | "count" | "ms" | "ratio" | "tokens";
export type MetricGroup = "none" | "model" | "key" | "feature";

export interface MetricsPoint {
	bucket_start: string;
	group_value: string | null;
	value: number | null;
	exact_value: number | null;
	estimated_value: number | null;
	unknown_count: number;
}

export interface MetricsResponse {
	metric: MetricName;
	unit: MetricUnit;
	interval: "hour";
	group_by: MetricGroup;
	points: MetricsPoint[];
}

export interface ApiKey {
	id: number;
	name: string;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	created_at: string;
	month_to_date_spend_micro_usd: number;
}

export interface OverviewData {
	cost: MetricsResponse;
	requestCount: MetricsResponse;
	latencyP50: MetricsResponse;
	latencyP95: MetricsResponse;
	cacheRate: MetricsResponse;
	cacheSaved: MetricsResponse;
	keys: ApiKey[];
}

const palette = [
	"#087e8b",
	"#ff5a5f",
	"#f2af29",
	"#4f6d7a",
	"#7851a9",
	"#2d936c",
];
const units: Record<MetricName, MetricUnit> = {
	cost: "micro_usd",
	request_count: "count",
	latency_p50: "ms",
	latency_p95: "ms",
	cache_rate: "ratio",
	cache_saved: "micro_usd",
};

let activeCharts: Array<{ destroy: () => void }> = [];
let loadGeneration = 0;
let activeRequest: AbortController | undefined;
let listenerController: AbortController | undefined;

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

function isSafeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalUtcSecond(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
	) {
		return false;
	}
	const parsed = new Date(value);
	return (
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString() === `${value.slice(0, -1)}.000Z`
	);
}

function isCanonicalHour(value: unknown): value is string {
	return (
		isCanonicalUtcSecond(value) &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(value)
	);
}

function isKeyCreatedAt(value: unknown): value is string {
	if (isCanonicalUtcSecond(value)) return true;
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
	) {
		return false;
	}
	const canonical = `${value.replace(" ", "T")}Z`;
	const parsed = new Date(canonical);
	return (
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString() === `${canonical.slice(0, -1)}.000Z`
	);
}

function invalidResponse(): never {
	throw new Error("The gateway returned an invalid dashboard response.");
}

function parsePoint(
	value: unknown,
	metric: MetricName,
	group: MetricGroup,
): MetricsPoint {
	if (!isRecord(value)) invalidResponse();
	if (
		!hasExactKeys(value, [
			"bucket_start",
			"estimated_value",
			"exact_value",
			"group_value",
			"unknown_count",
			"value",
		])
	) {
		invalidResponse();
	}
	const {
		bucket_start,
		group_value,
		exact_value,
		estimated_value,
		unknown_count,
	} = value;
	if (
		!isCanonicalHour(bucket_start) ||
		(group_value !== null && typeof group_value !== "string") ||
		(group === "none" && group_value !== null) ||
		((group === "model" || group === "key") &&
			typeof group_value !== "string") ||
		!isSafeNonnegativeInteger(unknown_count) ||
		(exact_value !== null && !isSafeNonnegativeInteger(exact_value)) ||
		(estimated_value !== null && !isSafeNonnegativeInteger(estimated_value))
	) {
		invalidResponse();
	}

	const { value: pointValue } = value;
	if (metric === "cache_rate") {
		if (
			typeof pointValue !== "number" ||
			!Number.isFinite(pointValue) ||
			pointValue < 0 ||
			pointValue > 1 ||
			exact_value !== null ||
			estimated_value !== null
		)
			invalidResponse();
	} else if (metric === "latency_p50" || metric === "latency_p95") {
		if (
			(pointValue !== null && !isSafeNonnegativeInteger(pointValue)) ||
			exact_value !== null ||
			estimated_value !== null
		)
			invalidResponse();
	} else if (metric === "request_count") {
		if (
			!isSafeNonnegativeInteger(pointValue) ||
			exact_value !== null ||
			estimated_value !== null
		)
			invalidResponse();
	} else {
		if (
			!isSafeNonnegativeInteger(exact_value) ||
			!isSafeNonnegativeInteger(estimated_value)
		) {
			invalidResponse();
		}
		const subtotal = exact_value + estimated_value;
		if (!Number.isSafeInteger(subtotal)) invalidResponse();
		if (
			(metric === "cost" && pointValue !== subtotal) ||
			(metric === "cache_saved" &&
				((unknown_count > 0 && pointValue !== null) ||
					(unknown_count === 0 && pointValue !== subtotal)))
		)
			invalidResponse();
	}

	return {
		bucket_start,
		group_value,
		value: pointValue as number | null,
		exact_value: exact_value as number | null,
		estimated_value: estimated_value as number | null,
		unknown_count,
	};
}

export function parseMetricsResponse(
	value: unknown,
	metric: MetricName,
	group: MetricGroup,
): MetricsResponse {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"group_by",
			"interval",
			"metric",
			"points",
			"unit",
		]) ||
		value.metric !== metric ||
		value.unit !== units[metric] ||
		value.interval !== "hour" ||
		value.group_by !== group ||
		!Array.isArray(value.points)
	)
		invalidResponse();
	const points = value.points.map((point) => parsePoint(point, metric, group));
	const pointGroupsByBucket = new Map<string, Set<string | null>>();
	for (let index = 1; index < points.length; index += 1) {
		const previous = points[index - 1];
		const current = points[index];
		if (!previous || !current) invalidResponse();
		if (previous.bucket_start > current.bucket_start) invalidResponse();
	}
	for (const point of points) {
		const groupsForBucket =
			pointGroupsByBucket.get(point.bucket_start) ?? new Set();
		if (groupsForBucket.has(point.group_value)) invalidResponse();
		groupsForBucket.add(point.group_value);
		pointGroupsByBucket.set(point.bucket_start, groupsForBucket);
	}
	return {
		metric,
		unit: units[metric],
		interval: "hour",
		group_by: group,
		points,
	};
}

export function parseKeysResponse(value: unknown): ApiKey[] {
	if (!Array.isArray(value)) invalidResponse();
	return value.map((candidate) => {
		if (!isRecord(candidate)) invalidResponse();
		const {
			id,
			name,
			budget_micro_usd_month,
			rate_limit_rpm,
			disabled,
			created_at,
			month_to_date_spend_micro_usd,
		} = candidate;
		if (
			!isSafeNonnegativeInteger(id) ||
			id < 1 ||
			typeof name !== "string" ||
			!isSafeNonnegativeInteger(budget_micro_usd_month) ||
			!isSafeNonnegativeInteger(rate_limit_rpm) ||
			rate_limit_rpm < 1 ||
			typeof disabled !== "boolean" ||
			!isKeyCreatedAt(created_at) ||
			!isSafeNonnegativeInteger(month_to_date_spend_micro_usd)
		)
			invalidResponse();
		return {
			id,
			name,
			budget_micro_usd_month,
			rate_limit_rpm,
			disabled,
			created_at,
			month_to_date_spend_micro_usd,
		};
	});
}

async function requestMetrics(
	metric: MetricName,
	group: "none" | "model",
	to: string,
	signal: AbortSignal,
	request: typeof api,
): Promise<MetricsResponse> {
	const response = await request(
		`/admin/api/metrics/timeseries?metric=${metric}&group=${group}&to=${encodeURIComponent(to)}`,
		{ signal },
	);
	if (!response.ok)
		throw new Error("The gateway could not load dashboard metrics.");
	return parseMetricsResponse(await response.json(), metric, group);
}

export async function requestOverviewData(
	signal: AbortSignal,
	request: typeof api = api,
	nowMs = Date.now(),
): Promise<OverviewData> {
	// A whole-second exclusive bound excludes every current-second insert, whose
	// durable timestamp has only second precision.
	const to = new Date(Math.floor(nowMs / 1_000) * 1_000).toISOString();
	const [
		cost,
		requestCount,
		latencyP50,
		latencyP95,
		cacheRate,
		cacheSaved,
		keys,
	] = await Promise.all([
		requestMetrics("cost", "model", to, signal, request),
		requestMetrics("request_count", "none", to, signal, request),
		requestMetrics("latency_p50", "none", to, signal, request),
		requestMetrics("latency_p95", "none", to, signal, request),
		requestMetrics("cache_rate", "none", to, signal, request),
		requestMetrics("cache_saved", "none", to, signal, request),
		request("/admin/api/keys", { signal }).then(async (response) => {
			if (!response.ok) throw new Error("The gateway could not load API keys.");
			return parseKeysResponse(await response.json());
		}),
	]);
	assertAlignedMetricBuckets(
		requestCount,
		latencyP50,
		latencyP95,
		cacheRate,
		cacheSaved,
	);
	return {
		cost,
		requestCount,
		latencyP50,
		latencyP95,
		cacheRate,
		cacheSaved,
		keys,
	};
}

/** Rejects a partial mixed snapshot instead of rendering missing series as zero. */
export function assertAlignedMetricBuckets(
	reference: MetricsResponse,
	...series: MetricsResponse[]
): void {
	const signature = (metric: MetricsResponse) =>
		[...new Set(metric.points.map((point) => point.bucket_start))]
			.sort()
			.join("\n");
	const expected = signature(reference);
	if (series.some((metric) => signature(metric) !== expected)) {
		invalidResponse();
	}
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"'": "&#39;",
			'"': "&quot;",
		};
		return entities[character] ?? character;
	});
}

function pointsByBucket(points: MetricsPoint[]): Map<string, MetricsPoint> {
	return new Map(points.map((point) => [point.bucket_start, point]));
}

export function compactHour(timestamp: string): string {
	const formatted = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: false,
		timeZone: "UTC",
	}).format(new Date(timestamp));
	return `${formatted} UTC`;
}

/** Formats integer micro-USD without turning a ledger value into a float. */
export function formatMicroUsd(microUsd: number): string {
	const sign = microUsd < 0 ? "-" : "";
	const absolute = Math.abs(microUsd);
	const cents = Math.floor((absolute + 5_000) / 10_000);
	const dollars = Math.floor(cents / 100).toLocaleString();
	return `${sign}$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatPercent(value: number | null): string {
	return value === null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
}

function formatMilliseconds(value: number | null): string {
	return value === null ? "No known samples" : `${value.toLocaleString()} ms`;
}

function unknownCount(points: MetricsPoint[]): number {
	return points.reduce((total, point) => total + point.unknown_count, 0);
}

function knownCostSubtotal(points: MetricsPoint[]): number {
	const total =
		sumCostField(points, "exact_value") +
		sumCostField(points, "estimated_value");
	if (!Number.isSafeInteger(total)) invalidResponse();
	return total;
}

function sumCostField(
	points: MetricsPoint[],
	field: "exact_value" | "estimated_value",
): number {
	return points.reduce((total, point) => {
		const next = total + (point[field] ?? 0);
		if (!Number.isSafeInteger(next)) invalidResponse();
		return next;
	}, 0);
}

function dataTable(
	headings: string[],
	rows: string[][],
	emptyText: string,
): string {
	if (rows.length === 0) {
		return `<p class="chart-alternative__empty">${escapeHtml(emptyText)}</p>`;
	}
	return `<div class="table-scroll"><table><thead><tr>${headings
		.map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`)
		.join("")}</tr></thead><tbody>${rows
		.map(
			(row) =>
				`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("")}</tbody></table></div>`;
}

function alternative(title: string, content: string): string {
	return `<details class="chart-alternative"><summary>${escapeHtml(title)}</summary>${content}</details>`;
}

export function buildSpendChartConfig(
	cost: MetricsResponse,
): ChartConfiguration<"bar"> {
	const labels = [
		...new Set(cost.points.map((point) => point.bucket_start)),
	].sort();
	const models = [
		...new Set(
			cost.points.map((point) => point.group_value ?? "Unknown model"),
		),
	].sort();
	return {
		type: "bar",
		data: {
			labels: labels.map(compactHour),
			datasets: models.map((model, index) => {
				const byBucket = pointsByBucket(
					cost.points.filter(
						(point) => (point.group_value ?? "Unknown model") === model,
					),
				);
				return {
					label: model,
					data: labels.map((label) => byBucket.get(label)?.value ?? null),
					backgroundColor: palette[index % palette.length],
					borderRadius: 3,
				};
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
						label: (item) =>
							`${item.dataset.label}: ${formatMicroUsd(Number(item.raw))}`,
					},
				},
			},
			scales: {
				x: { stacked: true, grid: { display: false } },
				y: {
					stacked: true,
					beginAtZero: true,
					ticks: { callback: (value) => formatMicroUsd(Number(value)) },
				},
			},
		},
	};
}

function standardChartOptions(
	primaryAxis: string,
	secondaryAxis: string,
	formatPrimary: (value: unknown) => string,
	formatSecondary: (value: unknown) => string,
): NonNullable<ChartConfiguration["options"]> {
	return {
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
					label: (item) => {
						const formatter =
							item.dataset.yAxisID === primaryAxis
								? formatPrimary
								: formatSecondary;
						return `${item.dataset.label}: ${item.raw === null ? "Unknown" : formatter(item.raw)}`;
					},
				},
			},
		},
		scales: {
			x: { grid: { display: false } },
			[primaryAxis]: {
				type: "linear",
				position: "left",
				beginAtZero: true,
				ticks: {
					callback:
						primaryAxis === "saved"
							? (value) => formatMicroUsd(Number(value))
							: undefined,
				},
			},
			[secondaryAxis]: {
				type: "linear",
				position: "right",
				beginAtZero: true,
				grid: { drawOnChartArea: false },
				ticks: { callback: formatSecondary },
			},
		},
	};
}

export function buildRequestLatencyChartConfig(
	requests: MetricsResponse,
	p50: MetricsResponse,
	p95: MetricsResponse,
): ChartConfiguration {
	const labels = [
		...new Set(requests.points.map((point) => point.bucket_start)),
	].sort();
	const requestByBucket = pointsByBucket(requests.points);
	const p50ByBucket = pointsByBucket(p50.points);
	const p95ByBucket = pointsByBucket(p95.points);
	return {
		type: "bar",
		data: {
			labels: labels.map(compactHour),
			datasets: [
				{
					label: "Requests",
					data: labels.map(
						(label) => requestByBucket.get(label)?.value ?? null,
					),
					backgroundColor: "#b8d8d8",
					borderRadius: 3,
					yAxisID: "requests",
				},
				{
					label: "p50 latency",
					type: "line",
					data: labels.map((label) => p50ByBucket.get(label)?.value ?? null),
					borderColor: "#087e8b",
					backgroundColor: "#087e8b",
					tension: 0.25,
					pointRadius: 2,
					yAxisID: "latency",
				},
				{
					label: "p95 latency",
					type: "line",
					data: labels.map((label) => p95ByBucket.get(label)?.value ?? null),
					borderColor: "#ff5a5f",
					backgroundColor: "#ff5a5f",
					tension: 0.25,
					pointRadius: 2,
					yAxisID: "latency",
				},
			],
		},
		options: standardChartOptions(
			"requests",
			"latency",
			(value) => {
				const count = Math.round(Number(value));
				return `${count.toLocaleString()} request${count === 1 ? "" : "s"}`;
			},
			(value) => `${Math.round(Number(value)).toLocaleString()} ms`,
		),
	};
}

export function buildCacheChartConfig(
	rate: MetricsResponse,
	saved: MetricsResponse,
): ChartConfiguration {
	const labels = [
		...new Set(rate.points.map((point) => point.bucket_start)),
	].sort();
	const rateByBucket = pointsByBucket(rate.points);
	const savedByBucket = pointsByBucket(saved.points);
	const options = standardChartOptions(
		"saved",
		"rate",
		(value) => formatMicroUsd(Number(value)),
		(value) => formatPercent(Number(value)),
	);
	if (options.scales?.rate && typeof options.scales.rate === "object") {
		options.scales.rate.min = 0;
		options.scales.rate.max = 1;
	}
	if (options.scales?.saved && typeof options.scales.saved === "object") {
		(options.scales.saved as { stacked?: boolean }).stacked = true;
	}
	return {
		type: "bar",
		data: {
			labels: labels.map(compactHour),
			datasets: [
				{
					label: "Known exact savings",
					data: labels.map(
						(label) => savedByBucket.get(label)?.exact_value ?? 0,
					),
					backgroundColor: "#2d936c",
					borderRadius: 3,
					stack: "savings",
					yAxisID: "saved",
				},
				{
					label: "Known estimated savings",
					data: labels.map(
						(label) => savedByBucket.get(label)?.estimated_value ?? 0,
					),
					backgroundColor: "#b7d9a7",
					borderRadius: 3,
					stack: "savings",
					yAxisID: "saved",
				},
				{
					label: "Cache rate",
					type: "line",
					data: labels.map((label) => rateByBucket.get(label)?.value ?? null),
					borderColor: "#087e8b",
					backgroundColor: "#087e8b",
					tension: 0.25,
					pointRadius: 2,
					yAxisID: "rate",
				},
			],
		},
		options,
	};
}

function chart<TType extends ChartType>(
	root: HTMLElement,
	canvasId: string,
	config: ChartConfiguration<TType>,
): void {
	const canvas = root.querySelector<HTMLCanvasElement>(`#${canvasId}`);
	if (canvas) activeCharts.push(new Chart(canvas, config));
}

function destroyCharts(): void {
	for (const existingChart of activeCharts) existingChart.destroy();
	activeCharts = [];
}

export function summaryText(
	points: MetricsPoint[],
	kind: "cost" | "latency" | "saved",
): string {
	if (kind === "latency") {
		const unknownLatencySamples = unknownCount(points);
		return unknownLatencySamples > 0
			? `${unknownLatencySamples.toLocaleString()} requests had no latency sample.`
			: "All requests have a latency sample.";
	}
	const unknown = unknownCount(points);
	const exact = sumCostField(points, "exact_value");
	const estimated = sumCostField(points, "estimated_value");
	if (kind === "saved" && unknown > 0) {
		return `${formatMicroUsd(knownCostSubtotal(points))} known subtotal (${formatMicroUsd(exact)} exact and ${formatMicroUsd(estimated)} estimated); total savings are unknown for ${unknown.toLocaleString()} request${unknown === 1 ? "" : "s"}.`;
	}
	if (unknown > 0) {
		return `${formatMicroUsd(knownCostSubtotal(points))} known subtotal (${formatMicroUsd(exact)} exact and ${formatMicroUsd(estimated)} estimated); ${unknown.toLocaleString()} request${unknown === 1 ? "" : "s"} had unknown pricing.`;
	}
	return `${formatMicroUsd(knownCostSubtotal(points))} total: ${formatMicroUsd(exact)} exact and ${formatMicroUsd(estimated)} estimated.`;
}

export function renderKeyBurn(key: ApiKey): string {
	const name = escapeHtml(key.name);
	const spend = formatMicroUsd(key.month_to_date_spend_micro_usd);
	const budget = formatMicroUsd(key.budget_micro_usd_month);
	if (key.budget_micro_usd_month === 0) {
		return `<article class="key-burn"><div class="key-burn__label"><strong>${name}</strong><span>${spend} spent</span></div><p class="key-burn__zero">The monthly budget is $0, so this key has no new spend capacity.</p><p class="key-burn__meta">${key.disabled ? "Disabled" : "Active"}</p></article>`;
	}
	const percentage =
		(key.month_to_date_spend_micro_usd / key.budget_micro_usd_month) * 100;
	return `<article class="key-burn"><div class="key-burn__label"><strong>${name}</strong><span>${spend} of ${budget}</span></div><progress value="${key.month_to_date_spend_micro_usd}" max="${key.budget_micro_usd_month}" aria-label="${name} monthly budget burn">${percentage.toFixed(1)}%</progress><p class="key-burn__meta">${key.disabled ? "Disabled" : "Active"} · ${percentage.toFixed(1)}% of monthly budget</p></article>`;
}

function renderData(data: OverviewData): string {
	const spendRows = data.cost.points.map((point) => [
		compactHour(point.bucket_start),
		point.group_value ?? "Unknown model",
		formatMicroUsd(point.exact_value ?? 0),
		formatMicroUsd(point.estimated_value ?? 0),
		formatMicroUsd(point.value ?? knownCostSubtotal([point])),
		point.unknown_count ? `${point.unknown_count} unknown` : "—",
	]);
	const metricBuckets = [
		...new Set(data.requestCount.points.map((point) => point.bucket_start)),
	].sort();
	const requestByBucket = pointsByBucket(data.requestCount.points);
	const p50ByBucket = pointsByBucket(data.latencyP50.points);
	const p95ByBucket = pointsByBucket(data.latencyP95.points);
	const requestRows = metricBuckets.map((bucket) => [
		compactHour(bucket),
		String(requestByBucket.get(bucket)?.value ?? 0),
		formatMilliseconds(p50ByBucket.get(bucket)?.value ?? null),
		formatMilliseconds(p95ByBucket.get(bucket)?.value ?? null),
	]);
	const rateByBucket = pointsByBucket(data.cacheRate.points);
	const savedByBucket = pointsByBucket(data.cacheSaved.points);
	const cacheRows = metricBuckets.map((bucket) => {
		const saved = savedByBucket.get(bucket);
		return [
			compactHour(bucket),
			formatPercent(rateByBucket.get(bucket)?.value ?? null),
			formatMicroUsd(saved?.exact_value ?? 0),
			formatMicroUsd(saved?.estimated_value ?? 0),
			saved?.value === null ? "Unknown" : formatMicroUsd(saved?.value ?? 0),
		];
	});
	const keys = [...data.keys].sort(
		(a, b) => b.month_to_date_spend_micro_usd - a.month_to_date_spend_micro_usd,
	);

	return `
		<div class="overview-toolbar">
			<div><p class="eyebrow">Live administration</p><h1 id="overview-title">Overview</h1><p class="overview-subtitle">Live usage and cost data from your PromptGate gateway.</p></div>
			<button class="button button--secondary" type="button" data-retry>Refresh data</button>
		</div>
		<div class="data-notice" role="note"><strong>Reading the numbers:</strong> Cost is a known subtotal when pricing is missing; latency percentiles use known samples only; cache savings show known exact and estimated subtotals even when a total is unknown.</div>
		<div class="overview-grid">
			<section class="panel panel--wide" aria-labelledby="spend-title"><div class="panel__heading"><div><p class="panel__kicker">Spend</p><h2 id="spend-title">Spend over time by model</h2></div><p class="panel__stat">${formatMicroUsd(knownCostSubtotal(data.cost.points))} known</p></div><div class="chart-frame">${data.cost.points.length ? '<canvas id="spend-chart" role="img" aria-label="Stacked spend over time by model, in US dollars"></canvas>' : '<p class="empty-state">No spend has been recorded yet.</p>'}</div><p class="panel__caption">${summaryText(data.cost.points, "cost")}</p>${alternative("View spend data as a table", dataTable(["Hour (UTC)", "Model", "Exact", "Estimated", "Known total", "Unknown"], spendRows, "No spend data is available."))}</section>
			<section class="panel" aria-labelledby="request-title"><div class="panel__heading"><div><p class="panel__kicker">Performance</p><h2 id="request-title">Requests & latency</h2></div><p class="panel__stat">${data.requestCount.points.reduce((total, point) => total + (point.value ?? 0), 0).toLocaleString()} requests</p></div><div class="chart-frame">${metricBuckets.length ? '<canvas id="request-chart" role="img" aria-label="Request count with p50 and p95 latency over time"></canvas>' : '<p class="empty-state">No requests have been recorded yet.</p>'}</div><p class="panel__caption">${summaryText(data.latencyP50.points, "latency")}</p>${alternative("View requests and latency as a table", dataTable(["Hour (UTC)", "Requests", "p50", "p95"], requestRows, "No request data is available."))}</section>
			<section class="panel" aria-labelledby="cache-title"><div class="panel__heading"><div><p class="panel__kicker">Efficiency</p><h2 id="cache-title">Cache rate & saved amount</h2></div><p class="panel__stat">${formatMicroUsd(knownCostSubtotal(data.cacheSaved.points))} known</p></div><div class="chart-frame">${metricBuckets.length ? '<canvas id="cache-chart" role="img" aria-label="Cache rate with known exact and estimated saved amounts over time"></canvas>' : '<p class="empty-state">No cache data is available yet.</p>'}</div><p class="panel__caption">${summaryText(data.cacheSaved.points, "saved")}</p>${alternative("View cache data as a table", dataTable(["Hour (UTC)", "Cache rate", "Exact saved", "Estimated saved", "Total"], cacheRows, "No cache data is available."))}</section>
			<section class="panel panel--wide" aria-labelledby="key-title"><div class="panel__heading"><div><p class="panel__kicker">Monthly controls</p><h2 id="key-title">Per-key MTD budget burn</h2></div><p class="panel__stat">${keys.length} key${keys.length === 1 ? "" : "s"}</p></div><div class="key-burn-list">${keys.length ? keys.map(renderKeyBurn).join("") : '<p class="empty-state">Create an API key to see monthly budget burn.</p>'}</div>${alternative(
				"View API-key budgets as a table",
				dataTable(
					["Key", "MTD spend", "Monthly budget", "Status"],
					keys.map((key) => [
						key.name,
						formatMicroUsd(key.month_to_date_spend_micro_usd),
						formatMicroUsd(key.budget_micro_usd_month),
						key.disabled ? "Disabled" : "Active",
					]),
					"No API keys are available.",
				),
			)}</section>
		</div>`;
}

function renderLoading(root: HTMLElement): void {
	const content = root.querySelector<HTMLElement>("#overview-content");
	if (content) {
		content.innerHTML =
			'<section class="loading-state" aria-live="polite" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h1>Loading overview</h1><p>Requesting live gateway metrics and API-key budgets.</p></div></section>';
	}
}

function renderError(root: HTMLElement): void {
	const content = root.querySelector<HTMLElement>("#overview-content");
	if (content) {
		content.innerHTML =
			'<section class="error-state" role="alert"><h1>Couldn’t load the overview</h1><p>Check the gateway connection and admin token, then try again.</p><button class="button" type="button" data-retry>Try again</button></section>';
	}
}

export function disposeOverview(): void {
	loadGeneration += 1;
	activeRequest?.abort();
	activeRequest = undefined;
	listenerController?.abort();
	listenerController = undefined;
	destroyCharts();
}

export async function refreshOverview(root: HTMLElement): Promise<void> {
	const generation = ++loadGeneration;
	activeRequest?.abort();
	const request = new AbortController();
	activeRequest = request;
	destroyCharts();
	renderLoading(root);
	try {
		const data = await requestOverviewData(request.signal);
		if (generation !== loadGeneration || request.signal.aborted) return;
		const content = root.querySelector<HTMLElement>("#overview-content");
		if (!content) return;
		content.innerHTML = renderData(data);
		if (data.cost.points.length) {
			chart(root, "spend-chart", buildSpendChartConfig(data.cost));
		}
		if (data.requestCount.points.length) {
			chart(
				root,
				"request-chart",
				buildRequestLatencyChartConfig(
					data.requestCount,
					data.latencyP50,
					data.latencyP95,
				),
			);
		}
		if (data.cacheRate.points.length) {
			chart(
				root,
				"cache-chart",
				buildCacheChartConfig(data.cacheRate, data.cacheSaved),
			);
		}
	} catch {
		const wasAlreadyAborted = request.signal.aborted;
		// Promise.all stops awaiting after one rejection; explicitly stop every
		// sibling before clearing this load's ownership.
		request.abort();
		if (generation === loadGeneration && !wasAlreadyAborted) renderError(root);
	} finally {
		if (activeRequest === request) activeRequest = undefined;
	}
}

export function renderOverview(root: HTMLElement): void {
	disposeOverview();
	root.innerHTML = `
		<div class="app-shell">
			<header class="app-header"><a class="brand" href="#overview" aria-label="PromptGate dashboard home"><span class="brand__mark" aria-hidden="true">P</span><span>PromptGate</span></a><nav aria-label="Dashboard sections"><a class="nav-link nav-link--active" href="#overview" aria-current="page">Overview</a><a class="nav-link" href="#cost">Cost</a><a class="nav-link" href="#prompts">Prompts</a><a class="nav-link" href="#quality">Quality</a></nav></header>
			<main id="dashboard-content" tabindex="-1"><div id="overview-content" aria-labelledby="overview-title"></div></main>
		</div>`;
	listenerController = new AbortController();
	root.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (target instanceof Element && target.closest("[data-retry]")) {
				void refreshOverview(root);
			}
		},
		{ signal: listenerController.signal },
	);
	void refreshOverview(root);
}
