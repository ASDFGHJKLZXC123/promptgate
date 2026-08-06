import type { ChatRequest, ChatResponse } from "@promptgate/shared";
import { describe, expect, test } from "vitest";

import type {
	ProviderAdapter,
	ProviderName,
	SseChunk,
} from "../providers/types.js";
import {
	CONTRACT_PROVIDER_DEFINITIONS,
	type ContractProviderDefinition,
	renderContractSummary,
	runNightlyContracts,
} from "./nightly.js";

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
					max_tokens: 64,
				});
			}
		}
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
