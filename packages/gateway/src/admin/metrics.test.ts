import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { readMetricsTimeseries } from "./metrics.dao.js";

const ADMIN_TOKEN = "promptgate-metrics-admin-token";

let tempDbDir: string | undefined;
let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-admin-metrics-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	await vi.resetModules();
});

afterEach(() => {
	if (previousDbPath === undefined) delete process.env.DB_PATH;
	else process.env.DB_PATH = previousDbPath;
	if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
	else process.env.ADMIN_TOKEN = previousAdminToken;
	if (tempDbDir) rmSync(tempDbDir, { recursive: true, force: true });
	tempDbDir = undefined;
});

function headers(): Record<string, string> {
	return { "x-admin-token": ADMIN_TOKEN };
}

async function buildTestServer() {
	const { buildServer } = await import("../server.js");
	return buildServer();
}

async function seedMetricsData(
	server: Awaited<ReturnType<typeof buildTestServer>>,
): Promise<void> {
	const { config } = await import("../config.js");
	const { openDatabase } = await import("../db/index.js");
	const db = openDatabase(config.DB_PATH);
	try {
		const alpha = db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES ('alpha', 'alpha-hash') RETURNING id",
			)
			.get() as { id: number };
		const beta = db
			.prepare(
				"INSERT INTO api_keys (name, key_hash) VALUES ('beta', 'beta-hash') RETURNING id",
			)
			.get() as { id: number };
		const insert = db.prepare(`INSERT INTO requests (
			request_id, ts, api_key_id, provider, model, feature, cache_hit,
			input_tokens, output_tokens, cost_micro_usd, cost_estimated,
			cache_saved_micro_usd, cache_saved_estimated, total_ms, status
		) VALUES (
			@request_id, @ts, @api_key_id, 'openai', @model, @feature, @cache_hit,
			@input_tokens, @output_tokens, @cost_micro_usd, @cost_estimated,
			@cache_saved_micro_usd, @cache_saved_estimated, @total_ms, 'ok'
		)`);
		const rows = [
			{
				request_id: "00000000-0000-4000-8000-000000000001",
				ts: "2026-07-01 10:01:00",
				api_key_id: alpha.id,
				model: "model-a",
				feature: "summary",
				cache_hit: 0,
				input_tokens: 1,
				output_tokens: 2,
				cost_micro_usd: 100,
				cost_estimated: 0,
				cache_saved_micro_usd: 0,
				cache_saved_estimated: 0,
				total_ms: 10,
			},
			{
				request_id: "00000000-0000-4000-8000-000000000002",
				ts: "2026-07-01 10:02:00",
				api_key_id: alpha.id,
				model: "model-a",
				feature: "summary",
				cache_hit: 1,
				input_tokens: 3,
				output_tokens: 4,
				cost_micro_usd: 200,
				cost_estimated: 1,
				cache_saved_micro_usd: 100,
				cache_saved_estimated: 0,
				total_ms: 20,
			},
			{
				request_id: "00000000-0000-4000-8000-000000000003",
				ts: "2026-07-01 10:03:00",
				api_key_id: beta.id,
				model: "model-b",
				feature: null,
				cache_hit: 1,
				input_tokens: null,
				output_tokens: 5,
				cost_micro_usd: null,
				cost_estimated: 0,
				cache_saved_micro_usd: 200,
				cache_saved_estimated: 1,
				total_ms: null,
			},
			{
				request_id: "00000000-0000-4000-8000-000000000004",
				ts: "2026-07-01 11:00:00",
				api_key_id: alpha.id,
				model: "model-a",
				feature: "summary",
				cache_hit: 1,
				input_tokens: 2,
				output_tokens: 2,
				cost_micro_usd: 40,
				cost_estimated: 0,
				cache_saved_micro_usd: null,
				cache_saved_estimated: null,
				total_ms: 30,
			},
		];
		const transaction = db.transaction(() => {
			for (const row of rows) insert.run(row);
		});
		transaction();
	} finally {
		db.close();
	}
	void server;
}

describe("GET /admin/api/metrics/timeseries", () => {
	test("streams timestamp preflight instead of materializing retained history", () => {
		let iterated = false;
		const db = {
			prepare(sql: string) {
				if (sql === "SELECT id, ts FROM requests") {
					return {
						iterate() {
							iterated = true;
							return [{ id: 1, ts: "2026-07-01 10:00:00" }][Symbol.iterator]();
						},
						all() {
							throw new Error("Preflight must not materialize history.");
						},
					};
				}
				return { all: () => [] };
			},
		};

		expect(
			readMetricsTimeseries(db as never, {
				metric: "request_count",
				group: "none",
			}),
		).toMatchObject({ points: [] });
		expect(iterated).toBe(true);
	});

	test("requires the existing admin token", async () => {
		const server = await buildTestServer();
		try {
			const response = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=cost",
			});
			expect(response.statusCode).toBe(401);
			expect(response.json()).toMatchObject({
				error: { code: "invalid_admin_token" },
			});
		} finally {
			await server.close();
		}
	});

	test("validates metric, groups, UTC bounds, and bound order in the OpenAI envelope", async () => {
		const server = await buildTestServer();
		try {
			for (const query of [
				"",
				"metric=nope",
				"metric=cost&group=table_name",
				"metric=cost&from=not-a-timestamp",
				"metric=cost&from=2026-07-01T11:00:00Z&to=2026-07-01T10:00:00Z",
			]) {
				const response = await server.inject({
					method: "GET",
					url: `/admin/api/metrics/timeseries?${query}`,
					headers: headers(),
				});
				expect(response.statusCode).toBe(400);
				expect(response.json()).toEqual({
					error: {
						message: "Invalid metrics query.",
						type: "invalid_request_error",
						code: "invalid_request_error",
					},
				});
			}
		} finally {
			await server.close();
		}
	});

	test("returns raw-request hourly metrics with provenance and [from,to) bounds", async () => {
		const server = await buildTestServer();
		try {
			await seedMetricsData(server);
			const get = async (metric: string, group = "none") =>
				server.inject({
					method: "GET",
					url: `/admin/api/metrics/timeseries?metric=${metric}&group=${group}`,
					headers: headers(),
				});

			expect((await get("cost")).json()).toEqual({
				metric: "cost",
				unit: "micro_usd",
				interval: "hour",
				group_by: "none",
				points: [
					{
						bucket_start: "2026-07-01T10:00:00Z",
						group_value: null,
						value: 300,
						exact_value: 100,
						estimated_value: 200,
						unknown_count: 1,
					},
					{
						bucket_start: "2026-07-01T11:00:00Z",
						group_value: null,
						value: 40,
						exact_value: 40,
						estimated_value: 0,
						unknown_count: 0,
					},
				],
			});
			expect((await get("request_count")).json().points[0]).toEqual({
				bucket_start: "2026-07-01T10:00:00Z",
				group_value: null,
				value: 3,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			});
			expect((await get("latency_p50")).json().points[0]).toEqual({
				bucket_start: "2026-07-01T10:00:00Z",
				group_value: null,
				value: 10,
				exact_value: null,
				estimated_value: null,
				unknown_count: 1,
			});
			expect((await get("latency_p95")).json().points[0]).toMatchObject({
				value: 20,
				unknown_count: 1,
			});
			expect((await get("cache_rate")).json().points[0]).toMatchObject({
				value: 2 / 3,
				exact_value: null,
				estimated_value: null,
				unknown_count: 0,
			});
			expect((await get("tokens")).json().points[0]).toMatchObject({
				value: 10,
				exact_value: null,
				estimated_value: null,
				unknown_count: 1,
			});
			expect((await get("cache_saved")).json()).toMatchObject({
				unit: "micro_usd",
				points: [
					{
						value: 300,
						exact_value: 100,
						estimated_value: 200,
						unknown_count: 0,
					},
					{ value: null, exact_value: 0, estimated_value: 0, unknown_count: 1 },
				],
			});

			const bounded = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=request_count&group=key&from=2026-07-01T03:00:00-07:00&to=2026-07-01T04:00:00-07:00",
				headers: headers(),
			});
			expect(bounded.json()).toMatchObject({
				group_by: "key",
				points: [
					{
						bucket_start: "2026-07-01T10:00:00Z",
						group_value: "alpha",
						value: 2,
					},
					{
						bucket_start: "2026-07-01T10:00:00Z",
						group_value: "beta",
						value: 1,
					},
				],
			});
			const oneNanosecondUpper = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=request_count&from=2026-07-01T10:01:00Z&to=2026-07-01T10:01:00.000000001Z",
				headers: headers(),
			});
			expect(oneNanosecondUpper.json()).toMatchObject({
				points: [{ bucket_start: "2026-07-01T10:00:00Z", value: 1 }],
			});
			const oneNanosecondLower = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=request_count&from=2026-07-01T10:01:00.000000001Z&to=2026-07-01T10:02:00Z",
				headers: headers(),
			});
			expect(oneNanosecondLower.json()).toMatchObject({ points: [] });
			const offsetFractionRollover = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=request_count&from=2026-07-01T03:00:59.999999999-07:00&to=2026-07-01T03:01:00.000000001-07:00",
				headers: headers(),
			});
			expect(offsetFractionRollover.json()).toMatchObject({
				points: [{ bucket_start: "2026-07-01T10:00:00Z", value: 1 }],
			});
			const { config } = await import("../config.js");
			const { openDatabase } = await import("../db/index.js");
			const featureDb = openDatabase(config.DB_PATH);
			try {
				const alpha = featureDb
					.prepare("SELECT id FROM api_keys WHERE name = 'alpha'")
					.get() as { id: number };
				featureDb
					.prepare(`INSERT INTO requests (
						request_id, ts, api_key_id, provider, model, feature, cache_hit,
						cost_estimated, cache_saved_micro_usd, cache_saved_estimated, status
					) VALUES (?, '2026-07-01 10:04:00', ?, 'openai', 'model-a', ?, 0, 0, 0, 0, 'ok')`)
					.run("00000000-0000-4000-8000-000000000005", alpha.id, "\u0000");
			} finally {
				featureDb.close();
			}
			const feature = await get("request_count", "feature");
			expect(
				feature
					.json()
					.points.map(
						(point: { group_value: string | null }) => point.group_value,
					),
			).toEqual([null, "\u0000", "summary", "summary"]);
			const empty = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=cost&from=2026-07-01T12:00:00Z&to=2026-07-01T13:00:00Z",
				headers: headers(),
			});
			expect(empty.json()).toMatchObject({ points: [] });
		} finally {
			await server.close();
		}
	});

	test("fails closed on an invalid raw timestamp even behind bounded predicates", async () => {
		const server = await buildTestServer();
		try {
			const { config } = await import("../config.js");
			const { openDatabase } = await import("../db/index.js");
			const { readMetricsTimeseries } = await import("./metrics.dao.js");
			const db = openDatabase(config.DB_PATH);
			try {
				const key = db
					.prepare(
						"INSERT INTO api_keys (name, key_hash) VALUES ('corrupt', 'corrupt-hash') RETURNING id",
					)
					.get() as { id: number };
				db.prepare(`INSERT INTO requests (
					request_id, ts, api_key_id, provider, model, cache_hit, cost_estimated,
					cache_saved_micro_usd, cache_saved_estimated, status
				) VALUES (?, 'not-a-timestamp', ?, 'openai', 'model', 0, 0, 0, 0, 'ok')`).run(
					"00000000-0000-4000-8000-000000000006",
					key.id,
				);
				expect(() =>
					readMetricsTimeseries(db, { metric: "cost", group: "none" }),
				).toThrow("Invalid metrics database row.");
			} finally {
				db.close();
			}

			const response = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=cost&from=2026-07-01T10:00:00Z&to=2026-07-01T11:00:00Z",
				headers: headers(),
			});
			expect(response.statusCode).toBe(500);
			expect(response.json()).toEqual({
				error: {
					message: "Internal server error.",
					type: "server_error",
					code: "internal_error",
				},
			});
		} finally {
			await server.close();
		}
	});

	test("fails closed on an invalid selected cost estimate bit", async () => {
		const server = await buildTestServer();
		try {
			const { config } = await import("../config.js");
			const { openDatabase } = await import("../db/index.js");
			const db = openDatabase(config.DB_PATH);
			try {
				const key = db
					.prepare(
						"INSERT INTO api_keys (name, key_hash) VALUES ('invalid-bit', 'invalid-bit-hash') RETURNING id",
					)
					.get() as { id: number };
				db.prepare(`INSERT INTO requests (
					request_id, ts, api_key_id, provider, model, cache_hit, cost_micro_usd,
					cost_estimated, cache_saved_micro_usd, cache_saved_estimated, status
				) VALUES (?, '2026-07-01 10:00:00', ?, 'openai', 'model', 0, 1, 2, 0, 0, 'ok')`).run(
					"00000000-0000-4000-8000-000000000007",
					key.id,
				);
			} finally {
				db.close();
			}
			const response = await server.inject({
				method: "GET",
				url: "/admin/api/metrics/timeseries?metric=cost&from=2026-07-01T10:00:00Z&to=2026-07-01T11:00:00Z",
				headers: headers(),
			});
			expect(response.statusCode).toBe(500);
			expect(response.json()).toMatchObject({
				error: { code: "internal_error", type: "server_error" },
			});
		} finally {
			await server.close();
		}
	});

	test("fails closed rather than rounding unsafe financial or token subtotals", async () => {
		const server = await buildTestServer();
		try {
			const { config } = await import("../config.js");
			const { openDatabase } = await import("../db/index.js");
			const { readMetricsTimeseries } = await import("./metrics.dao.js");
			const db = openDatabase(config.DB_PATH);
			try {
				const key = db
					.prepare(
						"INSERT INTO api_keys (name, key_hash) VALUES ('overflow', 'overflow-hash') RETURNING id",
					)
					.get() as { id: number };
				const insert = db.prepare(`INSERT INTO requests (
					request_id, ts, api_key_id, provider, model, cache_hit, input_tokens,
					output_tokens, cost_micro_usd, cost_estimated, cache_saved_micro_usd,
					cache_saved_estimated, status
				) VALUES (?, '2026-07-01 10:00:00', ?, 'openai', 'model', 0, ?, ?, ?, ?, 0, 0, 'ok')`);
				insert.run(
					"00000000-0000-4000-8000-000000000008",
					key.id,
					null,
					null,
					Number.MAX_SAFE_INTEGER,
					0,
				);
				insert.run(
					"00000000-0000-4000-8000-000000000009",
					key.id,
					null,
					null,
					1,
					1,
				);
				expect(() =>
					readMetricsTimeseries(db, { metric: "cost", group: "none" }),
				).toThrow("safe integer range");

				db.prepare("DELETE FROM requests").run();
				insert.run(
					"00000000-0000-4000-8000-000000000010",
					key.id,
					Number.MAX_SAFE_INTEGER,
					1,
					0,
					0,
				);
				expect(() =>
					readMetricsTimeseries(db, { metric: "tokens", group: "none" }),
				).toThrow("safe integer range");
			} finally {
				db.close();
			}
		} finally {
			await server.close();
		}
	});
});
