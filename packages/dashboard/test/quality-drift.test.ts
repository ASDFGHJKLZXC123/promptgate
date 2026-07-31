import { afterEach, describe, expect, test, vi } from "vitest";

import type { api } from "../src/api";
import {
	buildQualityChartConfig,
	chronologicalRuns,
	displayQualityIdentity,
	disposeQualityDrift,
	parseEvalRuns,
	partitionByDatasetHash,
	qualityAnnotations,
	refreshQualityDrift,
	renderQualityDrift,
	renderQualityDriftData,
	requestQualityDriftData,
} from "../src/quality-drift";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 3,
		ts: "2026-07-30 12:34:56",
		dataset_id: 4,
		dataset_slug: "safety_screening",
		dataset_hash: hashA,
		prompt_id: 7,
		prompt_version: 2,
		prompt_ref: "safety_screen@candidate",
		model: "deepseek-v4-flash",
		git_sha: "abc1234",
		trigger: "ci",
		cases_total: 50,
		cases_passed: 45,
		score_avg: 0.86,
		cost_micro_usd: 1_000,
		duration_ms: 500,
		...overrides,
	};
}

function qualityRoot(canvas?: HTMLCanvasElement): HTMLElement {
	const results = { innerHTML: "" };
	const status = { textContent: "", hidden: true };
	return {
		innerHTML: "",
		addEventListener: vi.fn(),
		querySelector: vi.fn((selector: string) => {
			if (selector === "#quality-results") return results;
			if (selector === "#quality-status") return status;
			if (selector === "#quality-chart") return canvas ?? null;
			return null;
		}),
	} as unknown as HTMLElement;
}

describe("Quality Drift", () => {
	afterEach(() => disposeQualityDrift());

	test("strictly accepts only complete, newest-first evaluation DTOs", () => {
		const runs = parseEvalRuns([
			run(),
			run({ id: 2, ts: "2026-07-30 12:34:55", score_avg: null }),
		]);
		expect(runs).toHaveLength(2);
		expect(() => parseEvalRuns([{ ...run(), unexpected: true }])).toThrow(
			"invalid quality-drift response",
		);
		expect(() => parseEvalRuns([run({ prompt_ref: null })])).toThrow(
			"invalid quality-drift response",
		);
		expect(
			parseEvalRuns([
				run({
					prompt_id: null,
					prompt_version: null,
					prompt_ref: null,
				}),
			])[0],
		).toMatchObject({
			prompt_id: null,
			prompt_version: null,
			prompt_ref: null,
		});
		expect(() => parseEvalRuns([run({ ts: "2026-02-30 12:34:56" })])).toThrow(
			"invalid quality-drift response",
		);
		expect(() => parseEvalRuns([run({ git_sha: "not-a-sha" })])).toThrow(
			"invalid quality-drift response",
		);
		expect(() => parseEvalRuns([run({ cases_passed: 51 })])).toThrow(
			"invalid quality-drift response",
		);
		expect(() => parseEvalRuns([run(), run()])).toThrow(
			"invalid quality-drift response",
		);
		expect(() =>
			parseEvalRuns([
				run({ id: 2, ts: "2026-07-30 12:34:55" }),
				run({ id: 3, ts: "2026-07-30 12:34:55" }),
			]),
		).toThrow("invalid quality-drift response");
	});

	test("requests every run without a limit, a cache, or a dropped abort signal", async () => {
		const request = vi.fn(async () => Response.json([]));
		const signal = new AbortController().signal;
		await requestQualityDriftData(signal, request as typeof api);
		expect(request).toHaveBeenCalledWith(
			"/admin/api/evals/runs",
			expect.objectContaining({ signal, cache: "no-store" }),
		);
	});

	test("connects interleaved same-hash points without crossing hashes, while a real null score remains a gap", () => {
		const runs = parseEvalRuns([
			run({
				id: 4,
				ts: "2026-07-30 12:34:59",
				prompt_version: 3,
				score_avg: null,
			}),
			run({
				id: 3,
				ts: "2026-07-30 12:34:58",
				prompt_version: 2,
			}),
			run({
				id: 2,
				ts: "2026-07-30 12:34:57",
				dataset_hash: hashB,
				model: "model-b",
			}),
			run({ id: 1, ts: "2026-07-30 12:34:56", prompt_version: 1 }),
		]);
		const chronological = chronologicalRuns(runs);
		const partitions = partitionByDatasetHash(chronological);
		const annotations = qualityAnnotations(partitions, chronological);
		expect(partitions.map((partition) => partition.runs.length).sort()).toEqual(
			[1, 3],
		);
		expect(annotations).toEqual([
			expect.objectContaining({ run_id: 3, changes: ["Prompt v1 → v2"] }),
			expect.objectContaining({ run_id: 4, changes: ["Prompt v2 → v3"] }),
		]);
		const config = buildQualityChartConfig(chronological, partitions);
		expect(config.options?.animation).toBe(false);
		expect(config.data.datasets).toHaveLength(4);
		const scoreA = config.data.datasets[0];
		const passA = config.data.datasets[1];
		const scoreB = config.data.datasets[2];
		expect(scoreA).toMatchObject({
			label: expect.stringContaining("Score"),
			spanGaps: false,
			data: [
				{ x: 0, y: 0.86 },
				{ x: 2, y: 0.86 },
				{ x: 3, y: null },
			],
		});
		expect(passA).toMatchObject({
			label: expect.stringContaining("Pass rate"),
			borderDash: [6, 4],
			data: [
				{ x: 0, y: 0.9 },
				{ x: 2, y: 0.9 },
				{ x: 3, y: 0.9 },
			],
		});
		expect(scoreB).toMatchObject({
			data: [{ x: 1, y: 0.86 }],
		});
		expect(scoreA?.data).not.toContainEqual({ x: 1, y: null });
	});

	test("makes identities visible and keeps table markup inert", () => {
		expect(displayQualityIdentity("a\\b\u0000\u202e")).toBe(
			"a\\\\b\\u0000\\u202e",
		);
		const rendered = renderQualityDriftData(
			parseEvalRuns([
				run({
					model: "<img src=x onerror=1>\u202e",
					prompt_ref: "a\\b",
				}),
			]),
		);
		expect(rendered).toContain("&lt;img src=x onerror=1&gt;\\u202e");
		expect(rendered).toContain("a\\\\b @ v2");
		expect(rendered).not.toContain("<img src=x onerror=1>");
		expect(rendered).toContain(
			"Pass rate is the share of cases where all assertions pass.",
		);
		expect(rendered).toContain("arithmetic mean over scored rubric cases only");
		expect(rendered).toContain(
			'class="table-scroll" tabindex="0" role="region" aria-label="Complete evaluation history table"',
		);
	});

	test("aborts stale reads and disposed views before they can own the screen", async () => {
		const resolvers: Array<(response: Response) => void> = [];
		const signals: AbortSignal[] = [];
		const request = vi.fn(
			(_path: string, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					signals.push(init?.signal as AbortSignal);
					resolvers.push(resolve);
				}),
		);
		const root = qualityRoot();
		const first = refreshQualityDrift(root, request as typeof api);
		await Promise.resolve();
		const second = refreshQualityDrift(root, request as typeof api);
		await Promise.resolve();
		expect(signals[0]?.aborted).toBe(true);
		disposeQualityDrift();
		expect(signals[1]?.aborted).toBe(true);
		for (const resolve of resolvers) resolve(Response.json([]));
		await Promise.all([first, second]);
	});

	test("destroys exactly one owned chart on rerender and disposal, and aborts replaced listeners", async () => {
		const firstDestroy = vi.fn();
		const secondDestroy = vi.fn();
		const charts = [{ destroy: firstDestroy }, { destroy: secondDestroy }];
		const factory = vi.fn(() => charts.shift() ?? { destroy: vi.fn() });
		const request = vi.fn(async () => Response.json([run()]));
		const canvas = {} as HTMLCanvasElement;
		const root = qualityRoot(canvas);

		await refreshQualityDrift(root, request as typeof api, factory);
		expect(factory).toHaveBeenCalledTimes(1);
		await refreshQualityDrift(root, request as typeof api, factory);
		expect(firstDestroy).toHaveBeenCalledTimes(1);
		expect(secondDestroy).not.toHaveBeenCalled();
		disposeQualityDrift();
		expect(secondDestroy).toHaveBeenCalledTimes(1);

		const firstScreen = qualityRoot();
		renderQualityDrift(
			firstScreen,
			vi.fn(async () => Response.json([])) as typeof api,
			factory,
		);
		const firstSignal = (
			firstScreen.addEventListener as unknown as ReturnType<typeof vi.fn>
		).mock.calls[0]?.[2]?.signal as AbortSignal;
		expect(firstSignal.aborted).toBe(false);
		renderQualityDrift(
			qualityRoot(),
			vi.fn(async () => Response.json([])) as typeof api,
			factory,
		);
		expect(firstSignal.aborted).toBe(true);
	});

	test("routes the real #quality entry before token prompting and disposes it on navigation", async () => {
		let markup = "";
		const results = { innerHTML: "" };
		const status = { textContent: "", hidden: true };
		const content = { focus: vi.fn() };
		const root = {
			get innerHTML() {
				return markup;
			},
			set innerHTML(value: string) {
				markup = value;
			},
			addEventListener: vi.fn(),
			querySelector: vi.fn((selector: string) => {
				if (selector === "#quality-results") return results;
				if (selector === "#quality-status") return status;
				if (selector === "#dashboard-content") return content;
				return null;
			}),
		};
		let hashHandler: (() => void) | undefined;
		const fakeWindow = {
			location: { hash: "#quality", origin: "http://dashboard.test" },
			prompt: vi.fn(() => "admin-token"),
			addEventListener: vi.fn((name: string, handler: () => void) => {
				if (name === "hashchange") hashHandler = handler;
			}),
		};
		const fetchMock = vi.fn(async () => Response.json([]));
		vi.stubGlobal("document", {
			querySelector: vi.fn(() => root),
		});
		vi.stubGlobal("window", fakeWindow);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await import("../src/main");
			await vi.waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith(
					"/admin/api/evals/runs",
					expect.objectContaining({ cache: "no-store" }),
				),
			);
			expect(markup).toContain('<h1 id="quality-title">Quality Drift</h1>');
			expect(markup).toContain(
				'class="nav-link nav-link--active" href="#quality"',
			);
			expect(hashHandler).toEqual(expect.any(Function));

			fakeWindow.location.hash = "#overview";
			hashHandler?.();
			expect(markup).toContain('id="overview-content"');
			expect(markup).toContain(
				'class="nav-link nav-link--active" href="#overview"',
			);
			expect(content.focus).toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
