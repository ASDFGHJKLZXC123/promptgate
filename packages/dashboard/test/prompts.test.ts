import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { api } from "../src/api";
import {
	displayPromptText,
	disposePrompts,
	movePromptLabel,
	parsePromptDetail,
	parsePromptList,
	promptDiffPath,
	promptLabelPath,
	promptPath,
	refreshPrompts,
	reloadPromptAfterMove,
	renderPromptsData,
	renderUnifiedDiff,
	requestPromptDetail,
	requestPromptDiff,
	requestPromptList,
	toggleVersionSelection,
} from "../src/prompts";

const createdAt = "2026-07-30 12:34:56";

function detail(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 7,
		slug: "safety_screen",
		description: "Escalates urgent safety risks.",
		created_at: createdAt,
		labels: [{ label: "prod", version: 2, updated_at: createdAt }],
		versions: [
			{
				version: 1,
				messages_json: [{ role: "system", content: "v1" }],
				variables_json: [],
				notes: null,
				created_at: createdAt,
			},
			{
				version: 2,
				messages_json: [{ role: "system", content: "v2" }],
				variables_json: [],
				notes: "candidate",
				created_at: createdAt,
			},
		],
		...overrides,
	};
}

function summary(): Record<string, unknown> {
	return {
		id: 7,
		slug: "safety_screen",
		description: "Escalates urgent safety risks.",
		created_at: createdAt,
		latest_version: 2,
		labels: [{ label: "prod", version: 2 }],
	};
}

function promptRoot(): HTMLElement {
	const results = {
		innerHTML: "",
		replaceChildren: vi.fn(),
	};
	const status = {
		className: "",
		hidden: true,
		textContent: "",
		setAttribute: vi.fn(),
	};
	const focusTarget = { focus: vi.fn() };
	return {
		querySelector: vi.fn((selector: string) => {
			if (selector === "#prompts-results") return results;
			if (selector === "#prompts-status") return status;
			if (selector.startsWith("[data-prompts-select=")) return focusTarget;
			return null;
		}),
	} as unknown as HTMLElement;
}

describe("Prompts screen", () => {
	afterEach(() => disposePrompts());

	test("encodes every slug and label path segment, including built round-trip edge identities", async () => {
		const slug = "a/b? #%雪";
		const label = "prod/x? #%雪";
		expect(promptPath(slug)).toBe(
			`/admin/api/prompts/${encodeURIComponent(slug)}`,
		);
		expect(promptLabelPath(slug, label)).toBe(
			`/admin/api/prompts/${encodeURIComponent(slug)}/labels/${encodeURIComponent(label)}`,
		);
		expect(promptDiffPath(slug, 1, 2)).toBe(
			`/admin/api/prompts/${encodeURIComponent(slug)}/versions/1/diff/2`,
		);
		const request = vi.fn(async () => Response.json(detail({ slug })));
		const loaded = await requestPromptDetail(
			slug,
			new AbortController().signal,
			request as typeof api,
		);
		expect(loaded.slug).toBe(slug);
		expect(request).toHaveBeenCalledWith(
			promptPath(slug),
			expect.objectContaining({ cache: "no-store" }),
		);
		const listRequest = vi.fn(async () => Response.json([]));
		const diffRequest = vi.fn(async () => new Response("--- a\n+++ b\n"));
		await requestPromptList(
			new AbortController().signal,
			listRequest as typeof api,
		);
		await requestPromptDiff(
			slug,
			[1, 2],
			new AbortController().signal,
			diffRequest as typeof api,
		);
		expect(listRequest.mock.calls[0]?.[1]).toMatchObject({
			cache: "no-store",
		});
		expect(diffRequest.mock.calls[0]?.[1]).toMatchObject({
			cache: "no-store",
		});
	});

	test("fails closed on extra fields, malformed timestamps, duplicate labels, and invalid version references", () => {
		expect(() =>
			parsePromptList([{ ...detail(), latest_version: 2, extra: true }]),
		).toThrow("invalid prompt response");
		expect(() =>
			parsePromptDetail(detail({ created_at: "2026-07-30T12:34:56Z" })),
		).toThrow("invalid prompt response");
		expect(() =>
			parsePromptDetail(
				detail({
					labels: [{ label: "prod", version: 9, updated_at: createdAt }],
				}),
			),
		).toThrow("invalid prompt response");
		expect(() =>
			parsePromptDetail(
				detail({
					versions: [
						{ ...(detail().versions as unknown as unknown[]), version: 2 },
					],
				}),
			),
		).toThrow();
		expect(() =>
			parsePromptDetail(
				detail({
					labels: [
						{ label: "prod", version: 1, updated_at: createdAt },
						{ label: "prod", version: 2, updated_at: createdAt },
					],
				}),
			),
		).toThrow("invalid prompt response");
		expect(() =>
			parsePromptList([
				{
					id: 1,
					slug: "first",
					description: null,
					created_at: createdAt,
					latest_version: null,
					labels: [],
				},
				{
					id: 1,
					slug: "second",
					description: null,
					created_at: createdAt,
					latest_version: null,
					labels: [],
				},
			]),
		).toThrow("invalid prompt response");
	});

	test("keeps raw identity visible while escaping XSS and control text in details and diffs", () => {
		expect(displayPromptText("a\\b\u0000\u202e")).toBe("a\\\\b\\u0000\\u202e");
		expect(displayPromptText(String.raw`a\u0000`)).toBe(String.raw`a\\u0000`);
		const diff = renderUnifiedDiff(
			"--- old\n+++ new\n-<img src=x onerror=1>\n+\u202e<script>alert(1)</script>",
		);
		expect(diff).toContain("prompt-diff__line--removed");
		expect(diff).toContain("prompt-diff__line--added");
		expect(diff).toContain("&lt;img src=x onerror=1&gt;");
		expect(diff).toContain("\\u202e&lt;script&gt;");
		expect(diff).not.toContain("<script>");
		const rendered = renderPromptsData(
			[
				{
					id: 1,
					slug: "<img src=x onerror=1>",
					description: null,
					created_at: createdAt,
					latest_version: null,
					labels: [],
				},
			],
			undefined,
			undefined,
		);
		expect(rendered).toContain("&lt;img src=x onerror=1&gt;");
		expect(rendered).not.toContain("<img src=x onerror=1>");
	});

	test("rejects a successful non-patch response instead of presenting it as no changes", async () => {
		const request = vi.fn(async () => Response.json({ note: "not a patch" }));
		await expect(
			requestPromptDiff(
				"safety_screen",
				[1, 2],
				new AbortController().signal,
				request as typeof api,
			),
		).rejects.toThrow("invalid prompt response");
	});

	test("enforces exactly two distinct ascending version selections", () => {
		expect(toggleVersionSelection([], 2)).toEqual([2]);
		expect(toggleVersionSelection([2], 1)).toEqual([1, 2]);
		expect(toggleVersionSelection([1, 2], 3)).toEqual([1, 2]);
		expect(toggleVersionSelection([1, 2], 1)).toEqual([2]);
	});

	test("does not PUT when the label move confirmation is cancelled", async () => {
		const request = vi.fn();
		await expect(
			movePromptLabel(
				7,
				"safety_screen",
				"prod",
				1,
				2,
				new AbortController().signal,
				request as typeof api,
				() => false,
			),
		).resolves.toBe(false);
		expect(request).not.toHaveBeenCalled();
	});

	test("confirms a truthful move, sends the exact PUT payload, and validates the response before refresh", async () => {
		const request = vi.fn(async () =>
			Response.json({
				prompt_id: 7,
				label: "prod",
				from_version: 4,
				to_version: 2,
			}),
		);
		const confirm = vi.fn(() => true);
		await expect(
			movePromptLabel(
				7,
				"safety_screen",
				"prod",
				1,
				2,
				new AbortController().signal,
				request as typeof api,
				confirm,
			),
		).resolves.toBe(4);
		expect(confirm).toHaveBeenCalledWith(
			expect.stringContaining("Promote @prod from safety_screen@1 to @2"),
		);
		expect(request).toHaveBeenCalledWith(
			"/admin/api/prompts/safety_screen/labels/prod",
			expect.objectContaining({
				method: "PUT",
				body: JSON.stringify({ version: 2 }),
			}),
		);
	});

	test("reports post-write list or detail reload failures instead of claiming confirmation", async () => {
		const put = vi.fn(async () =>
			Response.json({
				prompt_id: 7,
				label: "prod",
				from_version: 1,
				to_version: 2,
			}),
		);
		await expect(
			movePromptLabel(
				7,
				"safety_screen",
				"prod",
				1,
				2,
				new AbortController().signal,
				put as typeof api,
				() => true,
			),
		).resolves.toBe(1);

		const failedList = vi.fn(async () => new Response(null, { status: 503 }));
		await expect(
			reloadPromptAfterMove(
				promptRoot(),
				"safety_screen",
				failedList as typeof api,
			),
		).resolves.toBe(false);

		const failedDetail = vi
			.fn()
			.mockResolvedValueOnce(Response.json([summary()]))
			.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(
			reloadPromptAfterMove(
				promptRoot(),
				"safety_screen",
				failedDetail as typeof api,
			),
		).resolves.toBe(false);
	});

	test("fails closed on a non-successful label PUT", async () => {
		const request = vi.fn(async () => new Response(null, { status: 500 }));
		await expect(
			movePromptLabel(
				7,
				"safety_screen",
				"prod",
				1,
				2,
				new AbortController().signal,
				request as typeof api,
				() => true,
			),
		).rejects.toThrow("could not move this label");
	});

	test("aborts stale list ownership and disposal before a response can update the view", async () => {
		const signals: AbortSignal[] = [];
		const resolvers: Array<(response: Response) => void> = [];
		const request = vi.fn(
			(_path: string, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					signals.push(init?.signal as AbortSignal);
					resolvers.push(resolve);
				}),
		);
		const root = { querySelector: vi.fn(() => null) } as unknown as HTMLElement;
		const first = refreshPrompts(root, request as typeof api);
		await Promise.resolve();
		const second = refreshPrompts(root, request as typeof api);
		await Promise.resolve();
		expect(signals[0]?.aborted).toBe(true);
		disposePrompts();
		expect(signals[1]?.aborted).toBe(true);
		for (const resolve of resolvers) resolve(Response.json([]));
		await Promise.all([first, second]);
	});

	test("routes the prompts hash to the real authenticated screen", async () => {
		const source = await readFile(
			new URL("../src/main.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			'import { disposePrompts, renderPrompts } from "./prompts"',
		);
		expect(source).toContain('} else if (route === "prompts") {');
		expect(source).toContain("renderPrompts(root)");
	});
});
