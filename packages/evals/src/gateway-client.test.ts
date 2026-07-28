import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
	type FetchLike,
	GatewayAbortError,
	GatewayClient,
	GatewayConfigError,
	GatewayHttpError,
	GatewayNetworkError,
	GatewayProtocolError,
	type PgVars,
	parseCostMicroUsd,
	resolveGatewayConfig,
	temperatureForEvalModel,
} from "./gateway-client.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function responseBody(content = "safe") {
	return {
		id: "chatcmpl-1",
		object: "chat.completion",
		created: 1,
		model: "gpt-5.6-luna",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function successResponse(
	overrides: { body?: unknown; headers?: Record<string, string> } = {},
): Response {
	return new Response(JSON.stringify(overrides.body ?? responseBody()), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-pg-request-id": REQUEST_ID,
			"x-pg-cache": "miss",
			"x-pg-cost-usd": "1.000001",
			...overrides.headers,
		},
	});
}

function client(fetcher: FetchLike): GatewayClient {
	return new GatewayClient(
		resolveGatewayConfig({
			flags: { gateway: "https://gateway.example", key: "pg-test-secret" },
		}),
		fetcher,
	);
}

async function complete(
	fetcher: FetchLike,
	options: { model?: string; allowCache?: boolean; signal?: AbortSignal } = {},
) {
	return client(fetcher).complete({
		model: options.model ?? "gpt-5.6-luna",
		prompt: "safety_screen@candidate",
		vars: { note: "review" },
		allowCache: options.allowCache,
		signal: options.signal,
	});
}

describe("resolveGatewayConfig", () => {
	test("uses CLI flags in preference to the documented environment variables", () => {
		const config = resolveGatewayConfig({
			flags: { gateway: "https://flag.example", key: "flag-key" },
			env: {
				PG_GATEWAY_URL: "https://environment.example",
				PG_EVAL_KEY: "environment-key",
			},
		});
		expect(config.baseUrl.href).toBe("https://flag.example/");
		expect(config.key).toBe("flag-key");
	});

	test("preserves a configured gateway path when building the endpoint", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		const pathClient = new GatewayClient(
			resolveGatewayConfig({
				flags: { gateway: "https://gateway.example/promptgate", key: "key" },
			}),
			fetcher,
		);
		await pathClient.complete({
			model: "gpt-5.6-luna",
			prompt: "safety_screen@candidate",
			vars: {},
		});
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://gateway.example/promptgate/v1/chat/completions",
		);
	});

	test("rejects missing, blank, non-HTTP, credentialed, query, and fragment configuration", () => {
		for (const input of [
			{},
			{ PG_GATEWAY_URL: " ", PG_EVAL_KEY: "key" },
			{ PG_GATEWAY_URL: "ftp://gateway.example", PG_EVAL_KEY: "key" },
			{
				PG_GATEWAY_URL: "https://user:pass@gateway.example",
				PG_EVAL_KEY: "key",
			},
			{ PG_GATEWAY_URL: "https://gateway.example?x=1", PG_EVAL_KEY: "key" },
			{
				PG_GATEWAY_URL: "https://gateway.example#fragment",
				PG_EVAL_KEY: "key",
			},
			{ PG_GATEWAY_URL: "https://gateway.example", PG_EVAL_KEY: " " },
		]) {
			expect(() => resolveGatewayConfig({ env: input })).toThrow(
				GatewayConfigError,
			);
		}
	});
});

describe("GatewayClient", () => {
	test("sends the exact non-streaming evaluation contract through one fetch", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		const result = await complete(fetcher);
		expect(result).toMatchObject({
			content: "safe",
			requestId: REQUEST_ID,
			cache: "miss",
			costMicroUsd: 1_000_001,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://gateway.example/v1/chat/completions");
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer pg-test-secret",
				"Content-Type": "application/json",
			},
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "gpt-5.6-luna",
			messages: [],
			stream: false,
			temperature: 0,
			pg_prompt: "safety_screen@candidate",
			pg_vars: { note: "review" },
			pg_feature: "eval",
			pg_no_cache: true,
		});
	});

	test("uses the approved temperature policy for every supported eval model", async () => {
		for (const [model, expectedTemperature] of [
			["gpt-5.6-luna", 0],
			["gemini-2.5-flash", 0],
			["deepseek-v4-flash", 0],
			["gpt-5.6-terra", 0],
			["claude-sonnet-5", undefined],
		] as const) {
			const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
			await complete(fetcher, { model });
			const [, init] = fetcher.mock.calls[0] ?? [];
			expect(JSON.parse(String(init?.body)).temperature).toBe(
				expectedTemperature,
			);
			expect(temperatureForEvalModel(model)).toBe(expectedTemperature);
		}
	});

	test("rejects unknown models before fetching", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		await expect(
			complete(fetcher, { model: "unapproved-model" }),
		).rejects.toBeInstanceOf(GatewayConfigError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("rejects non-JSON variables before fetching", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const sparse = new Array<unknown>(1);
		const throwingGetter: Record<string, unknown> = {};
		Object.defineProperty(throwingGetter, "secret", {
			enumerable: true,
			get: () => {
				throw new Error("getter-secret");
			},
		});
		const hiddenToJson: Record<string, unknown> = {};
		Object.defineProperty(hiddenToJson, "toJSON", {
			enumerable: false,
			value: () => ({ injected: true }),
		});
		const revoked = Proxy.revocable({ safe: true }, {});
		revoked.revoke();
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());

		for (const vars of [
			{ invalid: Number.NaN },
			{ invalid: () => "not JSON" },
			{ invalid: new Date(0) },
			{ invalid: circular },
			{ invalid: sparse },
			{ invalid: { [Symbol("hidden")]: "value" } },
			throwingGetter,
			hiddenToJson,
			revoked.proxy,
		]) {
			const result = client(fetcher).complete({
				model: "gpt-5.6-luna",
				prompt: "safety_screen@candidate",
				vars: vars as PgVars,
			});
			await expect(result).rejects.toBeInstanceOf(GatewayProtocolError);
			await expect(result).rejects.not.toThrow("getter-secret");
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("preserves an own __proto__ variable without prototype pollution", async () => {
		const vars = Object.create(null) as PgVars;
		Object.defineProperty(vars, "__proto__", {
			enumerable: true,
			value: { safe: true, nested: [1, { value: "kept" }] },
		});
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());

		await client(fetcher).complete({
			model: "gpt-5.6-luna",
			prompt: "safety_screen@candidate",
			vars,
		});

		const [, init] = fetcher.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as {
			pg_vars: Record<string, unknown>;
		};
		expect(Object.hasOwn(body.pg_vars, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(body.pg_vars, "__proto__")?.value,
		).toEqual({ safe: true, nested: [1, { value: "kept" }] });
		expect(Object.hasOwn(Object.prototype, "safe")).toBe(false);
	});

	test("uses global fetch by default while preserving injectable fetch", async () => {
		const globalFetcher = vi
			.fn<FetchLike>()
			.mockResolvedValue(successResponse());
		vi.stubGlobal("fetch", globalFetcher);
		try {
			const defaultClient = new GatewayClient(
				resolveGatewayConfig({
					flags: { gateway: "https://gateway.example", key: "key" },
				}),
			);
			await defaultClient.complete({
				model: "gpt-5.6-luna",
				prompt: "safety_screen@candidate",
				vars: {},
			});
			expect(globalFetcher).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("loads directly from TypeScript source without the shared package dist", () => {
		const sourcePath = resolve(
			process.cwd(),
			"packages/evals/src/gateway-client.ts",
		);
		const runtime = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"--eval",
				"const mod = await import(process.argv[1]); new mod.GatewayClient({ baseUrl: new URL('https://gateway.example'), key: 'key' });",
				sourcePath,
			],
			{ encoding: "utf8" },
		);
		expect(runtime.status, runtime.stderr).toBe(0);
	});

	test("permits cache only through the dedicated local-development option", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		await complete(fetcher, { allowCache: true });
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body)).pg_no_cache).toBe(false);
	});

	test("rejects unexpected cache hits and nonzero costs on allowed cache hits", async () => {
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(
						successResponse({ headers: { "x-pg-cache": "hit" } }),
					),
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(
						successResponse({ headers: { "x-pg-cache": "hit" } }),
					),
				{ allowCache: true },
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		const cached = await complete(
			vi.fn<FetchLike>().mockResolvedValue(
				successResponse({
					headers: { "x-pg-cache": "hit", "x-pg-cost-usd": "0" },
				}),
			),
			{ allowCache: true },
		);
		expect(cached.cache).toBe("hit");
	});

	test("keeps judge options available while retaining the fixed eval extensions", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		await client(fetcher).complete({
			model: "gpt-5.6-terra",
			prompt: "judge_rubric_v1@prod",
			vars: { output: "safe" },
			reasoningEffort: "high",
			responseFormat: { type: "json_object" },
		});
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			temperature: 0,
			reasoning_effort: "high",
			response_format: { type: "json_object" },
			pg_feature: "eval",
			pg_no_cache: true,
		});
	});

	test("serializes both structured eval models at zero temperature without an effort override", async () => {
		for (const model of ["gemini-2.5-flash", "deepseek-v4-flash"] as const) {
			const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
			await client(fetcher).complete({
				model,
				prompt: "judge_rubric_v1@1",
				vars: { payload: "{}" },
				responseFormat: { type: "json_object" },
			});
			const [, init] = fetcher.mock.calls[0] ?? [];
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				model,
				temperature: 0,
				response_format: { type: "json_object" },
				pg_feature: "eval",
				pg_no_cache: true,
			});
			expect(body).not.toHaveProperty("reasoning_effort");
		}
	});

	test("rejects runtime judge options outside the fixed eval schema", async () => {
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		await expect(
			client(fetcher).complete({
				model: "gpt-5.6-terra",
				prompt: "judge_rubric_v1@1",
				vars: {},
				reasoningEffort: "medium" as never,
			}),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		await expect(
			client(fetcher).complete({
				model: "gpt-5.6-terra",
				prompt: "judge_rubric_v1@1",
				vars: {},
				responseFormat: { type: "text" } as never,
			}),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("propagates the caller AbortSignal", async () => {
		const controller = new AbortController();
		const fetcher = vi.fn<FetchLike>().mockResolvedValue(successResponse());
		await complete(fetcher, { signal: controller.signal });
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(init?.signal).toBe(controller.signal);
	});

	test("validates required response headers, response schema, and first choice content", async () => {
		const malformedHeaders = successResponse({
			headers: { "x-pg-request-id": "bad" },
		});
		await expect(
			complete(vi.fn<FetchLike>().mockResolvedValue(malformedHeaders)),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(
						new Response(JSON.stringify(responseBody()), { status: 200 }),
					),
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(
						successResponse({ headers: { "x-pg-cost-usd": "1.0000001" } }),
					),
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(successResponse({ body: { malformed: true } })),
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
		const withoutContent = {
			...responseBody(),
			choices: [
				{
					...responseBody().choices[0],
					message: { role: "assistant", content: null },
				},
			],
		};
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockResolvedValue(successResponse({ body: withoutContent })),
			),
		).rejects.toBeInstanceOf(GatewayProtocolError);
	});

	test("classifies HTTP, network, and abort failures without leaking a gateway key or raw body", async () => {
		const httpFetcher = vi
			.fn<FetchLike>()
			.mockResolvedValue(
				new Response(
					'{"error":{"code":"budget_exceeded","message":"raw-body-secret"}}',
					{ status: 503, headers: { "content-type": "application/json" } },
				),
			);
		try {
			await complete(httpFetcher);
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayHttpError);
			expect(error).toMatchObject({ status: 503, code: "budget_exceeded" });
			expect(String(error)).not.toContain("raw-body-secret");
		}
		const malformedCodeFetcher = vi.fn<FetchLike>().mockResolvedValue(
			new Response('{"error":{"code":"BUDGET-EXCEEDED"}}', {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		);
		try {
			await complete(malformedCodeFetcher);
		} catch (error) {
			expect(error).toMatchObject({ status: 429, code: undefined });
		}
		const networkError = new Error("network raw-body-secret");
		await expect(
			complete(vi.fn<FetchLike>().mockRejectedValue(networkError)),
		).rejects.toBeInstanceOf(GatewayNetworkError);
		const controller = new AbortController();
		controller.abort();
		await expect(
			complete(
				vi
					.fn<FetchLike>()
					.mockRejectedValue(new DOMException("aborted", "AbortError")),
				{ signal: controller.signal },
			),
		).rejects.toBeInstanceOf(GatewayAbortError);
		try {
			await complete(vi.fn<FetchLike>().mockRejectedValue(networkError));
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayNetworkError);
			expect(String(error)).not.toContain("pg-test-secret");
			expect(String(error)).not.toContain("raw-body-secret");
			expect(error).not.toHaveProperty("cause");
		}
	});

	test("classifies aborted and failed successful response-body reads safely", async () => {
		const abortingResponse = successResponse();
		vi.spyOn(abortingResponse, "json").mockRejectedValue(
			new DOMException("aborted", "AbortError"),
		);
		await expect(
			complete(vi.fn<FetchLike>().mockResolvedValue(abortingResponse)),
		).rejects.toBeInstanceOf(GatewayAbortError);
		const networkResponse = successResponse();
		vi.spyOn(networkResponse, "json").mockRejectedValue(
			new TypeError("offline"),
		);
		await expect(
			complete(vi.fn<FetchLike>().mockResolvedValue(networkResponse)),
		).rejects.toBeInstanceOf(GatewayNetworkError);
	});
});

describe("parseCostMicroUsd", () => {
	test("converts exact decimal dollars to integer micro-USD and rejects lossy values", () => {
		expect(parseCostMicroUsd("0")).toBe(0);
		expect(parseCostMicroUsd("0.000001")).toBe(1);
		expect(parseCostMicroUsd("12.34")).toBe(12_340_000);
		for (const invalid of [null, "-1.0", "1e-6", "0.0000001", " 1.0", "1."]) {
			expect(() => parseCostMicroUsd(invalid)).toThrow(GatewayProtocolError);
		}
	});
});
