import { describe, expect, test, vi } from "vitest";

import type { api } from "../src/api";
import {
	assertAlignedMetricBuckets,
	buildCacheChartConfig,
	buildRequestLatencyChartConfig,
	buildSpendChartConfig,
	compactHour,
	escapeHtml,
	formatMicroUsd,
	type MetricsResponse,
	parseKeysResponse,
	parseMetricsResponse,
	renderKeyBurn,
	requestOverviewData,
	summaryText,
} from "../src/overview";

const hours = ["2026-07-01T09:00:00Z", "2026-07-01T10:00:00Z"];

function metric(
	name: string,
	unit: MetricsResponse["unit"],
	points: MetricsResponse["points"],
): MetricsResponse {
	return { metric: name, unit, interval: "hour", group_by: "none", points };
}

describe("overview data helpers", () => {
	test("keeps micro-USD inputs integral until display formatting", () => {
		expect(formatMicroUsd(1_234_567)).toBe("$1.23");
		expect(formatMicroUsd(9_995)).toBe("$0.01");
		expect(formatMicroUsd(9_994)).toBe("$0.01");
		expect(formatMicroUsd(0)).toBe("$0.00");
		expect(compactHour(hours[0])).toMatch(/ UTC$/);
	});

	test("makes deterministic stacked spend datasets without a network request", () => {
		const cost = metric("cost", "micro_usd", [
			{
				bucket_start: hours[0],
				group_value: "z-model",
				value: 100_000,
				exact_value: 100_000,
				estimated_value: 0,
				unknown_count: 0,
			},
			{
				bucket_start: hours[0],
				group_value: "a-model",
				value: 200_000,
				exact_value: 0,
				estimated_value: 200_000,
				unknown_count: 0,
			},
			{
				bucket_start: hours[1],
				group_value: "a-model",
				value: 300_000,
				exact_value: 300_000,
				estimated_value: 0,
				unknown_count: 0,
			},
		]);
		cost.group_by = "model";

		const config = buildSpendChartConfig(cost);

		expect(config.options?.scales?.x).toMatchObject({ stacked: true });
		expect(config.options?.scales?.y).toMatchObject({ stacked: true });
		expect(
			config.data.datasets.map(({ label, data }) => ({ label, data })),
		).toEqual([
			{ label: "a-model", data: [200_000, 300_000] },
			{ label: "z-model", data: [100_000, null] },
		]);
	});

	test("retains null unknown savings and known-sample latency in chart data", () => {
		const requests = metric(
			"request_count",
			"count",
			hours.map((bucket_start, index) => ({
				bucket_start,
				group_value: null,
				value: index + 1,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			})),
		);
		const p50 = metric(
			"latency_p50",
			"ms",
			hours.map((bucket_start) => ({
				bucket_start,
				group_value: null,
				value: 45,
				exact_value: null,
				estimated_value: null,
				unknown_count: 2,
			})),
		);
		const p95 = metric(
			"latency_p95",
			"ms",
			hours.map((bucket_start) => ({
				bucket_start,
				group_value: null,
				value: 120,
				exact_value: null,
				estimated_value: null,
				unknown_count: 2,
			})),
		);
		const cacheRate = metric(
			"cache_rate",
			"ratio",
			hours.map((bucket_start) => ({
				bucket_start,
				group_value: null,
				value: 0.5,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			})),
		);
		const cacheSaved = metric("cache_saved", "micro_usd", [
			{
				bucket_start: hours[0],
				group_value: null,
				value: null,
				exact_value: 400_000,
				estimated_value: 0,
				unknown_count: 1,
			},
			{
				bucket_start: hours[1],
				group_value: null,
				value: 500_000,
				exact_value: 500_000,
				estimated_value: 0,
				unknown_count: 0,
			},
		]);

		expect(
			buildRequestLatencyChartConfig(requests, p50, p95).data.datasets[1]?.data,
		).toEqual([45, 45]);
		const cacheConfig = buildCacheChartConfig(cacheRate, cacheSaved);
		expect(cacheConfig.data.datasets[0]?.data).toEqual([400_000, 500_000]);
		expect(cacheConfig.data.datasets[1]?.data).toEqual([0, 0]);
		expect(cacheConfig.options?.scales?.rate).toMatchObject({ min: 0, max: 1 });
	});

	test("fails closed on malformed gateway data and safely escapes key labels", () => {
		expect(() =>
			parseMetricsResponse(
				{
					metric: "cost",
					unit: "micro_usd",
					interval: "hour",
					group_by: "model",
					points: [
						{
							bucket_start: hours[0],
							group_value: "model",
							value: 2.5,
							exact_value: 0,
							estimated_value: 0,
							unknown_count: 0,
						},
					],
				},
				"cost",
				"model",
			),
		).toThrow("invalid dashboard response");
		expect(() =>
			parseKeysResponse([{ id: 1, name: "key", budget_micro_usd_month: -1 }]),
		).toThrow("invalid dashboard response");
		expect(() =>
			parseMetricsResponse(
				{
					metric: "cost",
					unit: "micro_usd",
					interval: "hour",
					group_by: "model",
					points: [
						{
							bucket_start: hours[0],
							group_value: "model",
							value: 50,
							exact_value: 40,
							estimated_value: 20,
							unknown_count: 0,
						},
					],
				},
				"cost",
				"model",
			),
		).toThrow("invalid dashboard response");
		for (const malformedPoint of [
			{
				bucket_start: hours[0],
				group_value: null,
				value: 60,
				exact_value: 40,
				estimated_value: 20,
				unknown_count: 1,
			},
			{
				bucket_start: "2026-02-30T10:00:00Z",
				group_value: "model",
				value: 60,
				exact_value: 40,
				estimated_value: 20,
				unknown_count: 0,
			},
		]) {
			expect(() =>
				parseMetricsResponse(
					{
						metric: "cache_saved",
						unit: "micro_usd",
						interval: "hour",
						group_by: "model",
						points: [malformedPoint],
					},
					"cache_saved",
					"model",
				),
			).toThrow("invalid dashboard response");
		}
		expect(() =>
			parseMetricsResponse(
				{
					metric: "cost",
					unit: "micro_usd",
					interval: "hour",
					group_by: "model",
					points: [
						{
							bucket_start: hours[0],
							group_value: null,
							value: 60,
							exact_value: 40,
							estimated_value: 20,
							unknown_count: 0,
						},
					],
				},
				"cost",
				"model",
			),
		).toThrow("invalid dashboard response");
		const dangerousName = '<img src=x onerror="alert(1)">';
		expect(escapeHtml(dangerousName)).toBe(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		);
		expect(
			renderKeyBurn({
				id: 2,
				name: dangerousName,
				budget_micro_usd_month: 10_000,
				rate_limit_rpm: 60,
				disabled: false,
				created_at: hours[0],
				month_to_date_spend_micro_usd: 1,
			}),
		).not.toContain(dangerousName);
	});

	test("rejects extra fields, duplicate points, and unordered metric points", () => {
		const base = {
			metric: "cost",
			unit: "micro_usd",
			interval: "hour",
			group_by: "model",
			points: [
				{
					bucket_start: hours[0],
					group_value: "a",
					value: 1,
					exact_value: 1,
					estimated_value: 0,
					unknown_count: 0,
				},
			],
		};
		expect(() =>
			parseMetricsResponse({ ...base, ignored: true }, "cost", "model"),
		).toThrow("invalid dashboard response");
		expect(() =>
			parseMetricsResponse(
				{ ...base, points: [...base.points, { ...base.points[0] }] },
				"cost",
				"model",
			),
		).toThrow("invalid dashboard response");
		expect(() =>
			parseMetricsResponse(
				{
					...base,
					points: [
						{ ...base.points[0], bucket_start: hours[1] },
						base.points[0],
					],
				},
				"cost",
				"model",
			),
		).toThrow("invalid dashboard response");
	});

	test("accepts a zero-budget key without inventing a progress range", () => {
		const [zeroBudgetKey] = parseKeysResponse([
			{
				id: 1,
				name: "unlimited",
				budget_micro_usd_month: 0,
				rate_limit_rpm: 60,
				disabled: false,
				created_at: "2026-07-01 09:00:00",
				month_to_date_spend_micro_usd: 1_500_000,
			},
		]);
		expect(zeroBudgetKey).toMatchObject({
			budget_micro_usd_month: 0,
			month_to_date_spend_micro_usd: 1_500_000,
		});
		expect(renderKeyBurn(zeroBudgetKey)).toContain("no new spend capacity");
		expect(renderKeyBurn(zeroBudgetKey)).not.toContain("<progress");
	});

	test("counts missing latency samples across sparse hours exactly once", () => {
		expect(
			summaryText(
				[
					{
						bucket_start: hours[0],
						group_value: null,
						value: 30,
						exact_value: null,
						estimated_value: null,
						unknown_count: 2,
					},
					{
						bucket_start: hours[1],
						group_value: null,
						value: 40,
						exact_value: null,
						estimated_value: null,
						unknown_count: 3,
					},
				],
				"latency",
			),
		).toContain("5 requests");
	});

	test("discloses exact and estimated cost provenance in summaries", () => {
		expect(
			summaryText(
				[
					{
						bucket_start: hours[0],
						group_value: "model",
						value: 300_000,
						exact_value: 100_000,
						estimated_value: 200_000,
						unknown_count: 0,
					},
				],
				"cost",
			),
		).toBe("$0.30 total: $0.10 exact and $0.20 estimated.");
	});

	test("rejects mixed-snapshot metric buckets instead of inventing zeroes", () => {
		const reference = metric("request_count", "count", [
			{
				bucket_start: hours[0],
				group_value: null,
				value: 1,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			},
		]);
		const newer = metric("cache_rate", "ratio", [
			{
				bucket_start: hours[0],
				group_value: null,
				value: 0,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			},
			{
				bucket_start: hours[1],
				group_value: null,
				value: 1,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			},
		]);

		expect(() => assertAlignedMetricBuckets(reference, newer)).toThrow(
			"invalid dashboard response",
		);
		expect(() =>
			assertAlignedMetricBuckets(reference, reference),
		).not.toThrow();
	});

	test("shares one whole-second exclusive bound across the metric fan-out", async () => {
		const paths: string[] = [];
		const request = vi.fn(async (path: string) => {
			paths.push(path);
			if (path === "/admin/api/keys") {
				return Response.json([]);
			}
			const url = new URL(path, "http://dashboard.test");
			const name = url.searchParams.get("metric");
			const group = url.searchParams.get("group");
			const unit =
				name === "cost" || name === "cache_saved"
					? "micro_usd"
					: name === "request_count"
						? "count"
						: name === "cache_rate"
							? "ratio"
							: "ms";
			return Response.json({
				metric: name,
				unit,
				interval: "hour",
				group_by: group,
				points: [],
			});
		});

		await requestOverviewData(
			new AbortController().signal,
			request as typeof api,
			Date.parse("2026-07-01T09:00:00.999Z"),
		);

		const metricPaths = paths.filter((path) =>
			path.startsWith("/admin/api/metrics/timeseries?"),
		);
		expect(metricPaths).toHaveLength(6);
		expect(
			new Set(
				metricPaths.map((path) =>
					new URL(path, "http://dashboard.test").searchParams.get("to"),
				),
			),
		).toEqual(new Set(["2026-07-01T09:00:00.000Z"]));
	});
});
