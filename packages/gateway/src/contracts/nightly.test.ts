import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import { describe, expect, test } from "vitest";

import { ProviderError } from "../providers/provider-error.js";
import type {
	ProviderAdapter,
	ProviderName,
	SseChunk,
} from "../providers/types.js";
import {
	CONTRACT_PROVIDER_DEFINITIONS,
	type ContractProviderDefinition,
	type ContractSuiteResult,
	renderContractSummary,
	runNightlyContracts,
} from "./nightly.js";

function detailOf(
	suite: ContractSuiteResult,
	mode: "nonStreaming" | "streaming" = "nonStreaming",
): string {
	const first = suite.results[0];
	if (first === undefined || first.status === "SKIPPED") return "";
	return first[mode].detail;
}

const signal = new AbortController().signal;

function response(model: string): ChatResponse {
	return {
		id: "contract-response",
		object: "chat.completion",
		created: 1,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "OK" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
	};
}

function streamFrames(model: string): SseChunk[] {
	return [
		{
			data: JSON.stringify({
				id: "contract-stream",
				object: "chat.completion.chunk",
				created: 1,
				model,
				choices: [{ index: 0, delta: { role: "assistant" } }],
				usage: null,
			}),
			done: false,
		},
		{
			data: JSON.stringify({
				id: "contract-stream",
				object: "chat.completion.chunk",
				created: 1,
				model,
				choices: [
					{ index: 0, delta: { content: "OK" }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
			}),
			done: false,
		},
		{ data: "[DONE]", done: true },
	];
}

interface FakeControls {
	completeError?: unknown;
	completeResponse?: ChatResponse;
	streamError?: unknown;
	streamFrames?: SseChunk[];
}

function fakeDefinition(
	name: ProviderName,
	controls: FakeControls = {},
	observed?: { complete: ChatRequest[]; stream: ChatRequest[] },
): ContractProviderDefinition {
	const model = `${name}-contract-model`;
	return {
		name,
		displayName: name[0]?.toUpperCase() + name.slice(1),
		credentialEnv: `${name.toUpperCase()}_API_KEY`,
		model,
		createAdapter: () => {
			const adapter: ProviderAdapter = {
				name,
				async complete(req) {
					observed?.complete.push(req);
					if (controls.completeError !== undefined) {
						throw controls.completeError;
					}
					return controls.completeResponse ?? response(model);
				},
				async *stream(req) {
					observed?.stream.push(req);
					if (controls.streamError !== undefined) {
						throw controls.streamError;
					}
					for (const frame of controls.streamFrames ?? streamFrames(model)) {
						yield frame;
					}
				},
			};
			return adapter;
		},
	};
}

function fakeDefinitions(
	controls: Partial<Record<ProviderName, FakeControls>> = {},
	observed?: Record<
		ProviderName,
		{ complete: ChatRequest[]; stream: ChatRequest[] }
	>,
): ContractProviderDefinition[] {
	return (["openai", "anthropic", "gemini", "deepseek"] as const).map((name) =>
		fakeDefinition(name, controls[name], observed?.[name]),
	);
}

describe("nightly live contract runner", () => {
	test("pins the approved low-cost model and credential for all four providers", () => {
		expect(
			CONTRACT_PROVIDER_DEFINITIONS.map(({ name, credentialEnv, model }) => ({
				name,
				credentialEnv,
				model,
			})),
		).toEqual([
			{
				name: "openai",
				credentialEnv: "OPENAI_API_KEY",
				model: "gpt-5.6-luna",
			},
			{
				name: "anthropic",
				credentialEnv: "ANTHROPIC_API_KEY",
				model: "claude-sonnet-5",
			},
			{
				name: "gemini",
				credentialEnv: "GEMINI_API_KEY",
				model: "gemini-2.5-flash",
			},
			{
				name: "deepseek",
				credentialEnv: "DEEPSEEK_API_KEY",
				model: "deepseek-v4-flash",
			},
		]);
	});

	test("makes exactly one logical call per mode for every configured provider", async () => {
		const observed: Record<
			ProviderName,
			{ complete: ChatRequest[]; stream: ChatRequest[] }
		> = {
			openai: { complete: [], stream: [] },
			anthropic: { complete: [], stream: [] },
			gemini: { complete: [], stream: [] },
			deepseek: { complete: [], stream: [] },
		};
		const environment = Object.fromEntries(
			(["openai", "anthropic", "gemini", "deepseek"] as const).map((name) => [
				`${name.toUpperCase()}_API_KEY`,
				`${name}-secret`,
			]),
		);

		const result = await runNightlyContracts({
			environment,
			definitions: fakeDefinitions({}, observed),
			createSignal: () => signal,
		});

		expect(result).toMatchObject({
			configuredCount: 4,
			passedCount: 4,
			failedCount: 0,
			skippedCount: 0,
			ok: true,
		});
		for (const name of ["openai", "anthropic", "gemini", "deepseek"] as const) {
			expect(observed[name].complete).toHaveLength(1);
			expect(observed[name].stream).toHaveLength(1);
			for (const request of [
				...observed[name].complete,
				...observed[name].stream,
			]) {
				expect(request).toEqual({
					model: `${name}-contract-model`,
					messages: [{ role: "user", content: "Reply with exactly OK." }],
					...(name === "openai"
						? { max_completion_tokens: 64 }
						: { max_tokens: 64 }),
				});
				if (name === "openai") {
					expect(request).not.toHaveProperty("max_tokens");
				} else {
					expect(request).not.toHaveProperty("max_completion_tokens");
				}
			}
		}
	});

	test("runs one safe Gemini model-list diagnostic only for manual dispatch", async () => {
		const observed = {
			complete: [] as ChatRequest[],
			stream: [] as ChatRequest[],
		};
		const reports: string[] = [];
		const secret = "gemini-manual-secret";
		let fetchCalls = 0;
		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: secret,
				GITHUB_EVENT_NAME: "workflow_dispatch",
			},
			definitions: [fakeDefinition("gemini", {}, observed)],
			report: (line) => reports.push(line),
			createSignal: () => signal,
			diagnosticFetch: async (input, init) => {
				fetchCalls += 1;
				expect(input).toBe(
					"https://generativelanguage.googleapis.com/v1beta/openai/models",
				);
				expect(init.method).toBe("GET");
				expect(init.redirect).toBe("error");
				const headers = new Headers(init.headers);
				expect(headers.get("accept")).toBe("application/json");
				expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
				expect(init.body).toBeUndefined();
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "another-model" }, { id: "gemini-contract-model" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});

		expect(fetchCalls).toBe(1);
		expect(observed.complete).toHaveLength(1);
		expect(observed.stream).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			status: "PASSED",
			diagnostic: "http_status=200 model_count=2 target_present=true",
		});
		const rendered = `${reports.join("\n")}\n${renderContractSummary(result)}`;
		expect(rendered).toContain("Gemini model-list diagnostic");
		expect(rendered).toContain(
			"http_status=200 model_count=2 target_present=true",
		);
		expect(rendered).toContain(
			"do not substitute for scheduled contract evidence",
		);
		expect(rendered).not.toContain(secret);
		expect(rendered).not.toContain("another-model");
		expect(rendered).not.toContain("gemini-contract-model | http_status");
	});

	test("never runs the Gemini model-list diagnostic on a schedule event", async () => {
		let fetchCalls = 0;
		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: "configured",
				GITHUB_EVENT_NAME: "schedule",
			},
			definitions: [fakeDefinition("gemini")],
			createSignal: () => signal,
			diagnosticFetch: async () => {
				fetchCalls += 1;
				throw new Error("must not run");
			},
		});

		expect(fetchCalls).toBe(0);
		expect(result.results[0]).not.toHaveProperty("diagnostic");
		expect(renderContractSummary(result)).not.toContain(
			"Manual-dispatch diagnostics",
		);
	});

	test("snapshots and validates hostile Gemini diagnostic response status once", async () => {
		const leakedUrl = "https://status-leak.invalid";
		const cases = [
			{ kind: "throwing", expectedStatus: "unknown" },
			{ kind: "arbitrary", expectedStatus: "unknown" },
			{ kind: "changing", expectedStatus: "200" },
		] as const;

		for (const testCase of cases) {
			let statusReads = 0;
			const response = {
				get status() {
					statusReads += 1;
					if (testCase.kind === "throwing") {
						throw new Error(leakedUrl);
					}
					if (testCase.kind === "arbitrary") return leakedUrl;
					return statusReads === 1 ? 200 : leakedUrl;
				},
				json: async () => ({ data: [{ id: "gemini-contract-model" }] }),
			} as unknown as Response;
			const reports: string[] = [];
			const result = await runNightlyContracts({
				environment: {
					GEMINI_API_KEY: "configured",
					GITHUB_EVENT_NAME: "workflow_dispatch",
				},
				definitions: [fakeDefinition("gemini")],
				report: (line) => reports.push(line),
				createSignal: () => signal,
				diagnosticFetch: async () => response,
			});

			expect(statusReads).toBe(1);
			expect(result).toMatchObject({
				configuredCount: 1,
				passedCount: 1,
				failedCount: 0,
				ok: true,
			});
			const first = result.results[0];
			if (first === undefined || first.status === "SKIPPED") {
				throw new Error("expected configured Gemini result");
			}
			expect(first.status).toBe("PASSED");
			expect(first.diagnostic).toBe(
				`http_status=${testCase.expectedStatus} model_count=1 target_present=true`,
			);
			const surfaces = `${JSON.stringify(result)}\n${reports.join("\n")}\n${renderContractSummary(result)}`;
			expect(surfaces).not.toContain(leakedUrl);
		}
	});

	test("snapshots and validates hostile Gemini model-list length once without suite interference", async () => {
		const leakedUrl = "https://length-or-iteration-leak.invalid";
		const cases = [
			{
				kind: "throwing-length",
				expected: "model_count=unknown target_present=unknown",
			},
			{
				kind: "arbitrary-length",
				expected: "model_count=unknown target_present=unknown",
			},
			{
				kind: "changing-length",
				expected: "model_count=1 target_present=true",
			},
			{
				kind: "throwing-iteration",
				expected: "model_count=1 target_present=unknown",
			},
		] as const;

		for (const testCase of cases) {
			let lengthReads = 0;
			const data = new Proxy([{ id: "gemini-contract-model" }], {
				get(target, property, receiver) {
					if (property === "length") {
						lengthReads += 1;
						if (testCase.kind === "throwing-length") {
							throw new Error(leakedUrl);
						}
						if (testCase.kind === "arbitrary-length") return leakedUrl;
						if (testCase.kind === "changing-length") {
							return lengthReads === 1 ? 1 : leakedUrl;
						}
					}
					return Reflect.get(target, property, receiver) as unknown;
				},
				ownKeys(target) {
					if (testCase.kind === "throwing-iteration") {
						throw new Error(leakedUrl);
					}
					return Reflect.ownKeys(target);
				},
			});
			const reports: string[] = [];
			const result = await runNightlyContracts({
				environment: {
					GEMINI_API_KEY: "configured",
					GITHUB_EVENT_NAME: "workflow_dispatch",
				},
				definitions: [fakeDefinition("gemini")],
				report: (line) => reports.push(line),
				createSignal: () => signal,
				diagnosticFetch: async () =>
					({ status: 200, json: async () => ({ data }) }) as Response,
			});

			expect(lengthReads).toBe(1);
			expect(result).toMatchObject({
				configuredCount: 1,
				passedCount: 1,
				failedCount: 0,
				ok: true,
			});
			const first = result.results[0];
			if (first === undefined || first.status === "SKIPPED") {
				throw new Error("expected configured Gemini result");
			}
			expect(first.status).toBe("PASSED");
			expect(first.diagnostic).toBe(`http_status=200 ${testCase.expected}`);
			const surfaces = `${JSON.stringify(result)}\n${reports.join("\n")}\n${renderContractSummary(result)}`;
			expect(surfaces).not.toContain(leakedUrl);
		}
	});

	test("contains a revoked Gemini model-list Array Proxy without suite interference", async () => {
		const observed = {
			complete: [] as ChatRequest[],
			stream: [] as ChatRequest[],
		};
		const reports: string[] = [];
		const { proxy, revoke } = Proxy.revocable(
			[{ id: "gemini-contract-model" }],
			{},
		);
		revoke();

		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: "configured",
				GITHUB_EVENT_NAME: "workflow_dispatch",
			},
			definitions: [fakeDefinition("gemini", {}, observed)],
			report: (line) => reports.push(line),
			createSignal: () => signal,
			diagnosticFetch: async () =>
				({ status: 200, json: async () => ({ data: proxy }) }) as Response,
		});

		expect(observed.complete).toHaveLength(1);
		expect(observed.stream).toHaveLength(1);
		expect(result).toMatchObject({
			configuredCount: 1,
			passedCount: 1,
			failedCount: 0,
			skippedCount: 0,
			ok: true,
		});
		const first = result.results[0];
		if (first === undefined || first.status === "SKIPPED") {
			throw new Error("expected configured Gemini result");
		}
		expect(first.status).toBe("PASSED");
		expect(first.diagnostic).toBe(
			"http_status=200 model_count=unknown target_present=unknown",
		);
		const surfaces = `${JSON.stringify(result)}\n${reports.join("\n")}\n${renderContractSummary(result)}`;
		expect(surfaces).not.toContain("IsArray");
		expect(surfaces).not.toContain("proxy that has been revoked");
	});

	test("reports an absent Gemini target without printing any model id", async () => {
		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: "configured",
				GITHUB_EVENT_NAME: "workflow_dispatch",
			},
			definitions: [fakeDefinition("gemini")],
			createSignal: () => signal,
			diagnosticFetch: async () =>
				new Response(
					JSON.stringify({ data: [{ id: "sensitive-model-list-entry" }] }),
					{ status: 200 },
				),
		});

		const first = result.results[0];
		expect(first).toMatchObject({
			diagnostic: "http_status=200 model_count=1 target_present=false",
		});
		expect(JSON.stringify(first)).not.toContain("sensitive-model-list-entry");
	});

	test("allowlists and redacts Gemini model-list error fields", async () => {
		const secret = "gemini-diagnostic-secret";
		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: secret,
				GITHUB_EVENT_NAME: "workflow_dispatch",
			},
			definitions: [fakeDefinition("gemini")],
			createSignal: () => signal,
			diagnosticFetch: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 403,
							status: "PERMISSION_DENIED",
							message: `blocked key ${secret}`,
							details: [{ reason: "must-not-print" }],
						},
					}),
					{ status: 403 },
				),
		});

		const first = result.results[0];
		if (first === undefined || first.status === "SKIPPED") {
			throw new Error("expected configured Gemini result");
		}
		expect(first.diagnostic).toContain(
			"http_status=403 model_count=unknown target_present=unknown",
		);
		expect(first.diagnostic).toContain("code=403");
		expect(first.diagnostic).toContain("status=PERMISSION_DENIED");
		expect(first.diagnostic).toContain("message=blocked key [REDACTED]");
		expect(first.diagnostic).not.toContain(secret);
		expect(first.diagnostic).not.toContain("details");
		expect(first.diagnostic).not.toContain("must-not-print");
	});

	test("handles non-JSON, cyclic, and hostile Gemini model-list bodies safely", async () => {
		const cyclic: Record<string, unknown> = { message: "safe cyclic message" };
		cyclic.data = cyclic;
		cyclic.error = cyclic;
		const hostile: Record<string, unknown> = {};
		for (const field of ["data", "error"] as const) {
			Object.defineProperty(hostile, field, {
				get() {
					throw new Error("hostile raw body must not print");
				},
			});
		}
		const cases: Array<{
			response: Response;
			expected: string;
			forbidden?: string;
		}> = [
			{
				response: new Response("raw not found body", { status: 404 }),
				expected: "http_status=404 model_count=unknown target_present=unknown",
				forbidden: "raw not found body",
			},
			{
				response: {
					status: 404,
					json: async () => cyclic,
				} as Response,
				expected:
					"http_status=404 model_count=unknown target_present=unknown upstream message=safe cyclic message",
			},
			{
				response: {
					status: 404,
					json: async () => hostile,
				} as Response,
				expected: "http_status=404 model_count=unknown target_present=unknown",
				forbidden: "hostile raw body must not print",
			},
		];

		for (const testCase of cases) {
			const result = await runNightlyContracts({
				environment: {
					GEMINI_API_KEY: "configured",
					GITHUB_EVENT_NAME: "workflow_dispatch",
				},
				definitions: [fakeDefinition("gemini")],
				createSignal: () => signal,
				diagnosticFetch: async () => testCase.response,
			});
			const first = result.results[0];
			if (first === undefined || first.status === "SKIPPED") {
				throw new Error("expected configured Gemini result");
			}
			expect(first.diagnostic).toBe(testCase.expected);
			if (testCase.forbidden !== undefined) {
				expect(first.diagnostic).not.toContain(testCase.forbidden);
			}
		}
	});

	test("uses a fixed safe result when the Gemini diagnostic fetch rejects", async () => {
		const secret = "gemini-rejected-fetch-secret";
		const result = await runNightlyContracts({
			environment: {
				GEMINI_API_KEY: secret,
				GITHUB_EVENT_NAME: "workflow_dispatch",
			},
			definitions: [fakeDefinition("gemini")],
			createSignal: () => signal,
			diagnosticFetch: async () => {
				throw new Error(`raw rejection ${secret}`);
			},
		});

		const first = result.results[0];
		if (first === undefined || first.status === "SKIPPED") {
			throw new Error("expected configured Gemini result");
		}
		expect(first.diagnostic).toBe(
			"http_status=unavailable model_count=unknown target_present=unknown",
		);
		expect(first.diagnostic).not.toContain(secret);
		expect(first.diagnostic).not.toContain("raw rejection");
	});

	test("names every missing credential as SKIPPED and rejects zero configured providers", async () => {
		const reports: string[] = [];
		const result = await runNightlyContracts({
			environment: {},
			definitions: fakeDefinitions(),
			report: (line) => reports.push(line),
			createSignal: () => signal,
		});

		expect(result).toMatchObject({
			configuredCount: 0,
			passedCount: 0,
			failedCount: 0,
			skippedCount: 4,
			ok: false,
		});
		expect(
			result.results.map(({ name, status }) => ({ name, status })),
		).toEqual([
			{ name: "openai", status: "SKIPPED" },
			{ name: "anthropic", status: "SKIPPED" },
			{ name: "gemini", status: "SKIPPED" },
			{ name: "deepseek", status: "SKIPPED" },
		]);
		expect(reports).toHaveLength(4);
		expect(reports.every((line) => line.includes("SKIPPED"))).toBe(true);
		expect(renderContractSummary(result)).toContain(
			"FAILED:** zero provider credentials were configured",
		);
	});

	test("allows named skips only when at least one configured provider passes both modes", async () => {
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: fakeDefinitions(),
			createSignal: () => signal,
		});

		expect(result).toMatchObject({
			configuredCount: 1,
			passedCount: 1,
			failedCount: 0,
			skippedCount: 3,
			ok: true,
		});
		const summary = renderContractSummary(result);
		expect(summary).toContain(
			"| Anthropic | `anthropic-contract-model` | SKIPPED | SKIPPED | SKIPPED:",
		);
		expect(summary).toContain(
			"PASSED:** every configured provider passed both live modes",
		);
	});

	test("runs streaming once even when non-streaming fails and makes the suite red", async () => {
		const observed = {
			complete: [] as ChatRequest[],
			stream: [] as ChatRequest[],
		};
		const secret = "must-not-appear";
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: secret },
			definitions: [
				fakeDefinition(
					"openai",
					{ completeError: new Error(`upstream rejected ${secret}`) },
					observed,
				),
			],
			createSignal: () => signal,
		});

		expect(observed.complete).toHaveLength(1);
		expect(observed.stream).toHaveLength(1);
		expect(result).toMatchObject({
			configuredCount: 1,
			passedCount: 0,
			failedCount: 1,
			ok: false,
		});
		const summary = renderContractSummary(result);
		expect(summary).toContain("[REDACTED]");
		expect(summary).not.toContain(secret);
	});

	test("reports later providers even if one configured adapter cannot be constructed", async () => {
		const broken = fakeDefinition("openai");
		broken.createAdapter = () => {
			throw new Error("setup exploded");
		};
		const result = await runNightlyContracts({
			environment: {
				OPENAI_API_KEY: "configured-openai",
				ANTHROPIC_API_KEY: "configured-anthropic",
			},
			definitions: [broken, fakeDefinition("anthropic")],
			createSignal: () => signal,
		});

		expect(result).toMatchObject({
			configuredCount: 2,
			passedCount: 1,
			failedCount: 1,
			ok: false,
		});
		expect(result.results).toMatchObject([
			{
				name: "openai",
				status: "FAILED",
				nonStreaming: { status: "FAILED" },
				streaming: { status: "FAILED" },
			},
			{ name: "anthropic", status: "PASSED" },
		]);
	});

	test("fails configured providers when either shared response schema is violated", async () => {
		const invalidResponse = {
			...response("openai-contract-model"),
			created: -1,
		} as ChatResponse;
		const invalidFrames = streamFrames("gemini-contract-model");
		invalidFrames[0] = {
			data: JSON.stringify({ object: "not-a-chat-chunk" }),
			done: false,
		};

		const result = await runNightlyContracts({
			environment: {
				OPENAI_API_KEY: "configured-openai",
				GEMINI_API_KEY: "configured-gemini",
			},
			definitions: [
				fakeDefinition("openai", { completeResponse: invalidResponse }),
				fakeDefinition("gemini", { streamFrames: invalidFrames }),
			],
			createSignal: () => signal,
		});

		expect(result.failedCount).toBe(2);
		expect(result.ok).toBe(false);
		expect(result.results).toMatchObject([
			{
				status: "FAILED",
				nonStreaming: { status: "FAILED" },
				streaming: { status: "PASSED" },
			},
			{
				status: "FAILED",
				nonStreaming: { status: "PASSED" },
				streaming: { status: "FAILED" },
			},
		]);
	});

	test("fails schema-valid responses that contain no visible text", async () => {
		const noTextResponse = {
			...response("openai-contract-model"),
			choices: [],
		};
		const usageOnlyFrames: SseChunk[] = [
			{
				data: JSON.stringify({
					id: "contract-stream",
					object: "chat.completion.chunk",
					created: 1,
					model: "openai-contract-model",
					choices: [],
					usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
				}),
				done: false,
			},
			{ data: "[DONE]", done: true },
		];
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeResponse: noTextResponse,
					streamFrames: usageOnlyFrames,
				}),
			],
			createSignal: () => signal,
		});

		expect(result).toMatchObject({
			configuredCount: 1,
			passedCount: 0,
			failedCount: 1,
			ok: false,
		});
		expect(result.results[0]).toMatchObject({
			status: "FAILED",
			nonStreaming: {
				status: "FAILED",
				detail: expect.stringContaining("no visible text choice"),
			},
			streaming: {
				status: "FAILED",
				detail: expect.stringContaining("no visible text"),
			},
		});
	});

	test("requires exactly one terminal usage chunk", async () => {
		const noUsageFrames: SseChunk[] = [
			{
				data: JSON.stringify({
					id: "contract-stream",
					object: "chat.completion.chunk",
					created: 1,
					model: "openai-contract-model",
					choices: [{ index: 0, delta: { content: "OK" } }],
				}),
				done: false,
			},
			{ data: "[DONE]", done: true },
		];
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [fakeDefinition("openai", { streamFrames: noUsageFrames })],
			createSignal: () => signal,
		});

		expect(result.results[0]).toMatchObject({
			status: "FAILED",
			streaming: {
				status: "FAILED",
				detail: expect.stringContaining("0 usage chunks"),
			},
		});
	});

	test("rejects a data frame after the terminal usage chunk", async () => {
		const earlyUsageFrames: SseChunk[] = [
			{
				data: JSON.stringify({
					id: "contract-stream",
					object: "chat.completion.chunk",
					created: 1,
					model: "openai-contract-model",
					choices: [{ index: 0, delta: { content: "OK" } }],
					usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
				}),
				done: false,
			},
			{
				data: JSON.stringify({
					id: "contract-stream",
					object: "chat.completion.chunk",
					created: 1,
					model: "openai-contract-model",
					choices: [{ index: 0, delta: { content: " later" } }],
					usage: null,
				}),
				done: false,
			},
			{ data: "[DONE]", done: true },
		];
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", { streamFrames: earlyUsageFrames }),
			],
			createSignal: () => signal,
		});

		expect(result.results[0]).toMatchObject({
			status: "FAILED",
			streaming: {
				status: "FAILED",
				detail: expect.stringContaining("after terminal usage"),
			},
		});
	});

	test("requires one terminal DONE frame", async () => {
		const frames = streamFrames("openai-contract-model").filter(
			(frame) => !frame.done,
		);
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [fakeDefinition("openai", { streamFrames: frames })],
			createSignal: () => signal,
		});

		expect(result.results[0]).toMatchObject({
			status: "FAILED",
			streaming: {
				status: "FAILED",
				detail: expect.stringContaining("without [DONE]"),
			},
		});
	});
});

describe("nightly ProviderError diagnostic formatting", () => {
	test("extracts allowlisted fields from an OpenAI-shaped error envelope nested under error", async () => {
		const body = {
			error: {
				message:
					"The model gpt-5.6-luna does not exist or you do not have access to it.",
				type: "invalid_request_error",
				param: "model",
				code: "model_not_found",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError(
						"openai",
						400,
						body,
						"OpenAI request failed with status 400.",
					),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("type=invalid_request_error");
		expect(detail).toContain("code=model_not_found");
		expect(detail).toContain("param=model");
		expect(detail).toContain(
			"message=The model gpt-5.6-luna does not exist or you do not have access to it.",
		);
	});

	test("prefers the nested Anthropic error.type over the generic top-level type discriminator", async () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "messages.0.content: Input should be a valid string.",
			},
		};
		const result = await runNightlyContracts({
			environment: { ANTHROPIC_API_KEY: "configured" },
			definitions: [
				fakeDefinition("anthropic", {
					completeError: new ProviderError(
						"anthropic",
						400,
						body,
						"Anthropic request failed with status 400.",
					),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("type=invalid_request_error");
		expect(detail).not.toContain("type=error");
		expect(detail).toContain(
			"message=messages.0.content: Input should be a valid string.",
		);
	});

	test("extracts a numeric code and string status from a Google/Gemini-shaped error envelope", async () => {
		const body = {
			error: {
				code: 404,
				message: "models/gemini-2.5-flash is not found for API version v1beta.",
				status: "NOT_FOUND",
			},
		};
		const result = await runNightlyContracts({
			environment: { GEMINI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("gemini", {
					completeError: new ProviderError(
						"gemini",
						404,
						body,
						"Gemini request failed with status 404.",
					),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("code=404");
		expect(detail).toContain("status=NOT_FOUND");
		expect(detail).toContain(
			"message=models/gemini-2.5-flash is not found for API version v1beta.",
		);
	});

	test("prefers nested body.error fields over same-named top-level body fields", async () => {
		const body = {
			message: "top-level-message",
			type: "top-level-type",
			error: {
				message: "nested-message",
				type: "nested-type",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("type=nested-type");
		expect(detail).toContain("message=nested-message");
		expect(detail).not.toContain("top-level-message");
		expect(detail).not.toContain("top-level-type");
	});

	test("falls back to top-level body fields when no nested error object is present", async () => {
		const body = { code: "TIMEOUT", message: "Upstream timed out." };
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 504, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("code=TIMEOUT");
		expect(detail).toContain("message=Upstream timed out.");
	});

	test("captures the same diagnostic fields for a streaming-mode ProviderError", async () => {
		const body = {
			error: { type: "invalid_request_error", message: "bad request" },
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					streamError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result, "streaming");
		expect(detail).toContain("type=invalid_request_error");
		expect(detail).toContain("message=bad request");
	});

	test("redacts every configured provider secret from diagnostic fields", async () => {
		const secret = "sk-must-not-appear-1234567890";
		const body = {
			error: {
				message: `Invalid API key: ${secret}`,
				type: "authentication_error",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: secret },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 401, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("type=authentication_error");
		expect(detail).toContain("[REDACTED]");
		expect(detail).not.toContain(secret);
	});

	test("redacts a longer configured secret without leaking the suffix past a shorter contained secret", async () => {
		const shorterSecret = "sk-overlap";
		const longerSecret = "sk-overlap-extended";
		const body = {
			error: {
				message: `upstream message: ${longerSecret}`,
				type: "authentication_error",
			},
		};
		const result = await runNightlyContracts({
			environment: {
				OPENAI_API_KEY: shorterSecret,
				ANTHROPIC_API_KEY: longerSecret,
			},
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 401, body, "failed."),
				}),
				fakeDefinition("anthropic"),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("[REDACTED]");
		expect(detail).not.toContain(longerSecret);
		expect(detail).not.toContain(shorterSecret);
		expect(detail).not.toContain("-extended");
	});

	test("merges arbitrary overlapping configured secrets into one redaction with no fragment surviving", async () => {
		const secretA = "abc123def";
		const secretB = "123def456";
		const body = {
			error: {
				message: "session token abc123def456 leaked",
				type: "authentication_error",
			},
		};
		const result = await runNightlyContracts({
			environment: {
				OPENAI_API_KEY: secretA,
				GEMINI_API_KEY: secretB,
			},
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 401, body, "failed."),
				}),
				fakeDefinition("gemini"),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("[REDACTED]");
		expect(detail).not.toContain(secretA);
		expect(detail).not.toContain(secretB);
		expect(detail).not.toContain("abc123");
		expect(detail).not.toContain("def456");
	});

	test("omits fields outside the fixed allowlist and drops a literal null param", async () => {
		const body = {
			error: {
				message: "bad",
				type: "invalid_request_error",
				param: null,
				details: [{ big: "object", nested: { a: 1 } }],
				stack: "at foo (bar.js:1:1)",
				requestId: "abc-123",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("type=invalid_request_error");
		expect(detail).toContain("message=bad");
		expect(detail).not.toContain("param=");
		expect(detail).not.toContain("details");
		expect(detail).not.toContain("stack");
		expect(detail).not.toContain("requestId");
		expect(detail).not.toContain("abc-123");
		expect(detail).not.toContain("bar.js");
	});

	test("normalizes embedded control characters and line breaks in diagnostic fields", async () => {
		const body = {
			error: {
				message: "Line one\nLine two\tTabbed\r\nWindows",
				type: "invalid_request_error",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(/[\n\r\t]/.test(detail)).toBe(false);
		expect(detail).toContain("message=Line one Line two Tabbed Windows");
	});

	test("normalizes the full C1 control range (U+0080-U+009F) without embedding raw control bytes in source", async () => {
		const c1RangeStart = 128;
		const c1RangeEnd = 159;
		const c1Chars = Array.from(
			{ length: c1RangeEnd - c1RangeStart + 1 },
			(_, i) => String.fromCharCode(c1RangeStart + i),
		);
		const body = {
			error: {
				message: `left${c1Chars.join("")}right`,
				type: "invalid_request_error",
			},
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("message=left right");
		for (const char of c1Chars) {
			expect(detail.includes(char)).toBe(false);
		}
	});

	test("bounds an oversized field and the total diagnostic message", async () => {
		const hugeMessage = "a".repeat(5_000);
		const body = {
			error: { message: hugeMessage, type: "invalid_request_error" },
		};
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail.length).toBeLessThanOrEqual(1_000);
		expect(detail).toContain("type=invalid_request_error");
		expect(detail).not.toContain("a".repeat(300));
	});

	test("handles string, number, boolean, and null bodies without throwing", async () => {
		for (const primitiveBody of ["Bad Request", 42, true, null]) {
			const result = await runNightlyContracts({
				environment: { OPENAI_API_KEY: "configured" },
				definitions: [
					fakeDefinition("openai", {
						completeError: new ProviderError(
							"openai",
							400,
							primitiveBody,
							"OpenAI request failed with status 400.",
						),
					}),
				],
				createSignal: () => signal,
			});

			const detail = detailOf(result);
			expect(detail).toBe(
				"ProviderError: OpenAI request failed with status 400.",
			);
		}
	});

	test("handles a cyclic body by reading the one available scalar field without infinite recursion", async () => {
		const body: Record<string, unknown> = { message: "cyclic base" };
		body.error = body;
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toContain("message=cyclic base");
	});

	test("falls back to the base message when reading the body throws", async () => {
		const body: Record<string, unknown> = {};
		Object.defineProperty(body, "error", {
			enumerable: true,
			get() {
				throw new Error("hostile getter");
			},
		});
		const result = await runNightlyContracts({
			environment: { OPENAI_API_KEY: "configured" },
			definitions: [
				fakeDefinition("openai", {
					completeError: new ProviderError("openai", 400, body, "failed."),
				}),
			],
			createSignal: () => signal,
		});

		const detail = detailOf(result);
		expect(detail).toBe("ProviderError: failed.");
	});
});
