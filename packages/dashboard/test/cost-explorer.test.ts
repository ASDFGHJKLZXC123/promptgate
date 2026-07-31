import { afterEach, describe, expect, test, vi } from "vitest";

import type { api } from "../src/api";
import {
	buildCostChartConfig,
	displayCostGroup,
	disposeCostExplorer,
	formatMicroUsdAxis,
	formatMicroUsdLedger,
	knownCostSubtotal,
	refreshCostExplorer,
	renderCostExplorerData,
	requestCostExplorerData,
	unknownPricingCount,
} from "../src/cost-explorer";
import type { MetricsResponse } from "../src/overview";

const hour = "2026-07-01T09:00:00Z";

function cost(
	points: MetricsResponse["points"],
	group: "model" | "key" | "feature" = "model",
): MetricsResponse {
	return {
		metric: "cost",
		unit: "micro_usd",
		interval: "hour",
		group_by: group,
		points,
	};
}

describe("Cost Explorer", () => {
	afterEach(() => disposeCostExplorer());
	test("keeps exact, estimated, and unknown pricing visibly distinct", () => {
		const response = cost([
			{
				bucket_start: hour,
				group_value: "model-a",
				value: 300_000,
				exact_value: 100_000,
				estimated_value: 200_000,
				unknown_count: 2,
			},
		]);
		expect(knownCostSubtotal(response.points)).toBe(300_000);
		expect(unknownPricingCount(response.points)).toBe(2);
		const rendered = renderCostExplorerData(response, "model");
		expect(rendered).toContain("$0.100000</strong> exact");
		expect(rendered).toContain("$0.200000</strong> estimated");
		expect(rendered).toContain("2</strong> unknown-pricing requests");
		expect(rendered).toContain("Hour (UTC)");
		expect(rendered).toContain('id="cost-known-total">$0.300000 known');
		expect(rendered.indexOf("data-cost-group")).toBeLessThan(
			rendered.indexOf('id="cost-results"'),
		);
	});

	test("labels null feature as Untagged without conflating a literal feature name", () => {
		expect(displayCostGroup("feature", null)).toBe("Untagged");
		expect(displayCostGroup("feature", "Untagged")).toBe("Feature: Untagged");
		expect(displayCostGroup("feature", "a\u0000b")).toBe("Feature: a\\u0000b");
		expect(displayCostGroup("feature", "a\\u0000b")).toBe(
			"Feature: a\\\\u0000b",
		);
		expect(displayCostGroup("feature", "a\u0085b\u200db\u202eb")).toBe(
			"Feature: a\\u0085b\\u200db\\u202eb",
		);
		expect(displayCostGroup("feature", "a\\u202eb")).toBe(
			"Feature: a\\\\u202eb",
		);
		expect(displayCostGroup("feature", "__proto__")).toBe("Feature: __proto__");
		const response = cost(
			[
				{
					bucket_start: hour,
					group_value: null,
					value: 1,
					exact_value: 1,
					estimated_value: 0,
					unknown_count: 0,
				},
				{
					bucket_start: hour,
					group_value: "<img src=x onerror=alert(1)>",
					value: 1,
					exact_value: 1,
					estimated_value: 0,
					unknown_count: 0,
				},
			],
			"feature",
		);
		const rendered = renderCostExplorerData(response, "feature");
		expect(rendered).toContain("Untagged");
		expect(rendered).not.toContain("<img src=x onerror=alert(1)>");
		expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	test("retains a one micro-USD ledger amount instead of rounding it to zero", () => {
		expect(formatMicroUsdLedger(1)).toBe("$0.000001");
		expect(formatMicroUsdLedger(1_234_567)).toBe("$1.234567");
	});

	test("builds an exact-versus-estimated stacked chart with formatted financial tooltips", () => {
		const response = cost([
			{
				bucket_start: hour,
				group_value: "model-a",
				value: 10_000,
				exact_value: 4_000,
				estimated_value: 6_000,
				unknown_count: 0,
			},
		]);
		const config = buildCostChartConfig(response, "model");
		expect(config.options?.scales?.x).toMatchObject({ stacked: true });
		expect(config.options?.scales?.y).toMatchObject({ stacked: true });
		expect(config.data.datasets.map((dataset) => dataset.label)).toEqual([
			"Exact cost",
			"Estimated cost",
		]);
		const yAxis = config.options?.scales?.y;
		const tickCallback =
			typeof yAxis === "object" && yAxis !== null
				? (yAxis as { ticks?: { callback?: unknown } }).ticks?.callback
				: undefined;
		expect(typeof tickCallback).toBe("function");
		expect(() =>
			(tickCallback as (value: number) => string)(0.1),
		).not.toThrow();
		expect((tickCallback as (value: number) => string)(0.1)).toBe("≈0.1 μUSD");
		expect(formatMicroUsdAxis(1)).toBe("$0.000001");
	});

	test("uses the selected group and a whole-second exclusive bound", async () => {
		const request = vi.fn(async () =>
			Response.json({
				metric: "cost",
				unit: "micro_usd",
				interval: "hour",
				group_by: "feature",
				points: [],
			}),
		);
		await requestCostExplorerData(
			new AbortController().signal,
			"feature",
			request as typeof api,
			Date.parse("2026-07-01T09:00:00.999Z"),
		);
		const path = request.mock.calls[0]?.[0] as string;
		const url = new URL(path, "http://dashboard.test");
		expect(url.searchParams.get("metric")).toBe("cost");
		expect(url.searchParams.get("group")).toBe("feature");
		expect(url.searchParams.get("to")).toBe("2026-07-01T09:00:00.000Z");
	});

	test("fails closed on malformed cost provenance", async () => {
		const request = vi.fn(async () =>
			Response.json({
				metric: "cost",
				unit: "micro_usd",
				interval: "hour",
				group_by: "key",
				points: [
					{
						bucket_start: hour,
						group_value: "key",
						value: 50,
						exact_value: 40,
						estimated_value: 20,
						unknown_count: 0,
					},
				],
			}),
		);
		await expect(
			requestCostExplorerData(
				new AbortController().signal,
				"key",
				request as typeof api,
			),
		).rejects.toThrow("invalid dashboard response");
	});

	test("aborts a stale refresh and a disposed screen before either response can own the view", async () => {
		const resolvers: Array<(response: Response) => void> = [];
		const signals: AbortSignal[] = [];
		const request = vi.fn(
			(_path: string, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					signals.push(init?.signal as AbortSignal);
					resolvers.push(resolve);
				}),
		);
		const root = { querySelector: vi.fn(() => null) } as unknown as HTMLElement;
		const first = refreshCostExplorer(root, request as typeof api);
		await Promise.resolve();
		const second = refreshCostExplorer(root, request as typeof api);
		await Promise.resolve();
		expect(signals[0]?.aborted).toBe(true);
		disposeCostExplorer();
		expect(signals[1]?.aborted).toBe(true);
		for (const resolve of resolvers) {
			resolve(
				Response.json({
					metric: "cost",
					unit: "micro_usd",
					interval: "hour",
					group_by: "model",
					points: [],
				}),
			);
		}
		await Promise.all([first, second]);
	});
});
