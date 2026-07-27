import { describe, expect, test, vi } from "vitest";

import {
	AdminClient,
	EvalAdminError,
	resolveAdminConfig,
} from "./admin-client.js";
import type { FetchLike } from "./gateway-client.js";

const token = " admin-token-123456 ";
const config = resolveAdminConfig({
	flags: { gateway: "https://gateway.example/base", adminToken: token },
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

describe("admin config", () => {
	test("uses CLI over env and preserves the supplied secret", () => {
		const resolved = resolveAdminConfig({
			flags: { gateway: "https://flag.example", adminToken: token },
			env: {
				PG_GATEWAY_URL: "https://env.example",
				PG_ADMIN_TOKEN: "x".repeat(16),
			},
		});
		expect(resolved.baseUrl.href).toBe("https://flag.example/");
		expect(resolved.adminToken).toBe(token);
	});

	test("rejects unsafe URLs and short tokens", () => {
		for (const gateway of [
			"ftp://gateway.example",
			"https://user:pass@gateway.example",
			"https://gateway.example?q=1",
			"https://gateway.example#x",
		]) {
			expect(() =>
				resolveAdminConfig({ flags: { gateway, adminToken: "x".repeat(16) } }),
			).toThrow(EvalAdminError);
		}
		expect(() =>
			resolveAdminConfig({
				flags: { gateway: "https://gateway.example", adminToken: "short" },
			}),
		).toThrow(EvalAdminError);
	});
});

describe("AdminClient", () => {
	test("preserves gateway paths and validates prompt summaries", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(
			json([
				{
					id: 1,
					slug: "safety",
					latest_version: 2,
					labels: [{ label: "prod", version: 2 }],
				},
			]),
		);
		const client = new AdminClient(config, fetcher);
		await expect(client.promptSummaries()).resolves.toEqual([
			{
				id: 1,
				slug: "safety",
				latest_version: 2,
				labels: [{ label: "prod", version: 2 }],
			},
		]);
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://gateway.example/base/admin/api/prompts",
		);
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(
			(init?.headers as Record<string, string> | undefined)?.["x-admin-token"],
		).toBe(token);
	});

	test("fails loud for HTTP, non-JSON, malformed, and invalid success bodies", async () => {
		for (const response of [
			new Response("hidden", {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
			new Response("{}", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
			new Response("not-json", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			json({ bad: true }),
		]) {
			await expect(
				new AdminClient(
					config,
					vi.fn<FetchLike>().mockResolvedValue(response),
				).promptSummaries(),
			).rejects.toBeInstanceOf(EvalAdminError);
		}
	});

	test("accepts a dataset row and order-independent run confirmation, rejecting partial success", async () => {
		const fetcher = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce(json({ id: 7, slug: "safety" }))
			.mockResolvedValueOnce(
				json({ run: { id: 3 }, results: [{ case_id: "b" }, { case_id: "a" }] }),
			);
		const client = new AdminClient(config, fetcher);
		await expect(client.upsertDataset({ slug: "safety" })).resolves.toEqual({
			id: 7,
			slug: "safety",
		});
		await expect(
			client.createRun({ results: [{ case_id: "a" }, { case_id: "b" }] }),
		).resolves.toBeUndefined();
		await expect(
			new AdminClient(
				config,
				vi
					.fn<FetchLike>()
					.mockResolvedValue(
						json({ run: { id: 3 }, results: [{ case_id: "a" }] }),
					),
			).createRun({ results: [{ case_id: "a" }, { case_id: "b" }] }),
		).rejects.toBeInstanceOf(EvalAdminError);

		await expect(
			new AdminClient(
				config,
				vi.fn<FetchLike>().mockResolvedValue(
					json({
						run: { id: 3 },
						results: [{ case_id: "a" }, { case_id: "a" }],
					}),
				),
			).createRun({ results: [{ case_id: "a" }, { case_id: "b" }] }),
		).rejects.toBeInstanceOf(EvalAdminError);
	});
});
