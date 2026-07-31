import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dashboardOrigin = "http://dashboard.test";

function response(status: number): Response {
	return new Response(null, { status });
}

describe("dashboard admin-token flow", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal("window", {
			location: { origin: dashboardOrigin },
			prompt: vi.fn(),
		});
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("prompts once on load and sends the exact in-memory token", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValue("  exact token\t");
		fetch.mockResolvedValue(response(200));

		const { api, initializeAdminToken } = await import("../src/api");
		initializeAdminToken();
		initializeAdminToken();
		await api("/admin/api/keys", {
			headers: {
				"content-type": "application/json",
				"x-admin-token": "untrusted caller value",
			},
		});

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			"/admin/api/keys",
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-admin-token": "  exact token\t",
				}),
			}),
		);
		const request = fetch.mock.calls[0]?.[1];
		expect(request?.headers).toMatchObject({
			"x-admin-token": "  exact token\t",
		});
		expect(new Headers(request?.headers).get("content-type")).toBe(
			"application/json",
		);
	});

	test("does not trim or persist the prompted token", async () => {
		const source = await readFile(
			new URL("../src/api.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain(".trim(");
		expect(source).not.toMatch(
			/localStorage|sessionStorage|document\.cookie|console\./,
		);
	});

	test("rejects non-admin, cross-origin, and normalized traversal paths before fetching", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValue("admin-token");

		const { api } = await import("../src/api");

		for (const unsafePath of [
			"/v1/models",
			"https://example.test/admin/api/keys",
			"/\\example.test/admin/api/keys",
			"/admin/api/../keys",
			"/admin/api/%2e%2e/keys",
		]) {
			await expect(api(unsafePath)).rejects.toThrow("/admin/api");
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	test("preserves method, body, and caller headers across a 401 retry", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce("replacement");
		fetch
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(200));

		const { api } = await import("../src/api");
		const body = JSON.stringify({ version: 2 });
		await api("/admin/api/prompts/example/labels/prod", {
			method: "PUT",
			body,
			headers: {
				"content-type": "application/json",
				"x-request-marker": "preserved",
			},
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		for (const [, request] of fetch.mock.calls) {
			expect(request).toMatchObject({ method: "PUT", body });
			expect(new Headers(request?.headers).get("content-type")).toBe(
				"application/json",
			);
			expect(new Headers(request?.headers).get("x-request-marker")).toBe(
				"preserved",
			);
		}
	});

	test("re-prompts after one unauthorized response and retries exactly once", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce("replacement");
		fetch
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(200));

		const { api } = await import("../src/api");
		const result = await api("/admin/api/keys");

		expect(result.status).toBe(200);
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-admin-token"),
		).toBe("expired");
		expect(
			new Headers(fetch.mock.calls[1]?.[1]?.headers).get("x-admin-token"),
		).toBe("replacement");
	});

	test("preserves a Cost Explorer group's fixed snapshot URL across its 401 retry", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce("replacement");
		fetch
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(200));
		const { api } = await import("../src/api");
		const path =
			"/admin/api/metrics/timeseries?metric=cost&group=feature&to=2026-07-01T09%3A00%3A00.000Z";
		await api(path);
		expect(fetch.mock.calls.map(([requestedPath]) => requestedPath)).toEqual([
			path,
			path,
		]);
	});

	test("returns a second unauthorized response without another prompt or retry", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce("replacement");
		fetch
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(401));

		const { api } = await import("../src/api");
		const result = await api("/admin/api/keys");

		expect(result.status).toBe(401);
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test.each([null, ""])(
		"does not retry or erase the prior token after a %p refresh",
		async (nextToken) => {
			const prompt = vi.mocked(window.prompt);
			const fetch = vi.mocked(globalThis.fetch);
			prompt
				.mockReturnValueOnce("expired")
				.mockReturnValueOnce(nextToken)
				.mockReturnValueOnce("replacement");
			fetch
				.mockResolvedValueOnce(response(401))
				.mockResolvedValueOnce(response(401))
				.mockResolvedValueOnce(response(200));

			const { api } = await import("../src/api");
			const firstResult = await api("/admin/api/keys");
			const secondResult = await api("/admin/api/keys");

			expect(firstResult.status).toBe(401);
			expect(secondResult.status).toBe(200);
			expect(prompt).toHaveBeenCalledTimes(3);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(
				new Headers(fetch.mock.calls[1]?.[1]?.headers).get("x-admin-token"),
			).toBe("expired");
			expect(
				new Headers(fetch.mock.calls[2]?.[1]?.headers).get("x-admin-token"),
			).toBe("replacement");
		},
	);

	test("shares a single re-prompt across concurrent stale unauthorized responses", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce("replacement");
		fetch
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(response(200))
			.mockResolvedValueOnce(response(200));

		const { api } = await import("../src/api");
		const results = await Promise.all([
			api("/admin/api/keys"),
			api("/admin/api/prompts"),
		]);

		expect(results.map(({ status }) => status)).toEqual([200, 200]);
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(
			new Headers(fetch.mock.calls[2]?.[1]?.headers).get("x-admin-token"),
		).toBe("replacement");
		expect(
			new Headers(fetch.mock.calls[3]?.[1]?.headers).get("x-admin-token"),
		).toBe("replacement");
	});

	test("shares a cancelled refresh across concurrent unauthorized responses", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		prompt.mockReturnValueOnce("expired").mockReturnValueOnce(null);
		fetch.mockResolvedValue(response(401));

		const { api } = await import("../src/api");
		const results = await Promise.all([
			api("/admin/api/keys"),
			api("/admin/api/prompts"),
		]);

		expect(results.map(({ status }) => status)).toEqual([401, 401]);
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("returns non-401 responses and fetch failures unchanged", async () => {
		const prompt = vi.mocked(window.prompt);
		const fetch = vi.mocked(globalThis.fetch);
		const failure = new TypeError("offline");
		prompt.mockReturnValue("admin-token");
		fetch.mockResolvedValueOnce(response(503)).mockRejectedValueOnce(failure);

		const { api } = await import("../src/api");

		await expect(api("/admin/api/keys")).resolves.toHaveProperty("status", 503);
		await expect(api("/admin/api/keys")).rejects.toBe(failure);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("the dashboard entry explicitly initializes the token after rendering", async () => {
		const source = await readFile(
			new URL("../src/main.ts", import.meta.url),
			"utf8",
		);
		const renderIndex = source.indexOf("app.innerHTML =");
		const initializeIndex = source.indexOf("initializeAdminToken();");

		expect(renderIndex).toBeGreaterThan(-1);
		expect(initializeIndex).toBeGreaterThan(renderIndex);
	});

	test("the hash router disposes exactly the active screen before back-forward navigation and moves focus", async () => {
		const source = await readFile(
			new URL("../src/main.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("let disposeActiveScreen");
		expect(source).toContain("disposeActiveScreen();");
		expect(source).toContain(
			'window.addEventListener("hashchange", () => renderRoute(true))',
		);
		expect(source).toContain(
			'querySelector<HTMLElement>("#dashboard-content")?.focus()',
		);
	});
});
