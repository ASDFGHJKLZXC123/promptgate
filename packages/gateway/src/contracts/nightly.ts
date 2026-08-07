import {
	ChatCompletionChunkSchema,
	type ChatRequest,
	ChatRequestSchema,
	ChatResponseSchema,
} from "@promptgate/shared";

import { createAnthropicAdapter } from "../providers/anthropic.js";
import { createDeepSeekAdapter } from "../providers/deepseek.js";
import { createGeminiAdapter } from "../providers/gemini.js";
import { createOpenAiAdapter } from "../providers/openai.js";
import type { ProviderAdapter, ProviderName } from "../providers/types.js";

const CONTRACT_MAX_TOKENS = 64;
const CONTRACT_TIMEOUT_MS = 120_000;
const CONTRACT_PROMPT = "Reply with exactly OK.";

export interface ContractProviderDefinition {
	name: ProviderName;
	displayName: string;
	credentialEnv: string;
	model: string;
	createAdapter(apiKey: string): ProviderAdapter;
}

/**
 * Pinned to the approved build-time contract model for each provider.
 * Updating a model is an intentional source change, never an ambient alias.
 */
export const CONTRACT_PROVIDER_DEFINITIONS = [
	{
		name: "openai",
		displayName: "OpenAI",
		credentialEnv: "OPENAI_API_KEY",
		model: "gpt-5.6-luna",
		createAdapter: (apiKey: string) => createOpenAiAdapter({ apiKey }),
	},
	{
		name: "anthropic",
		displayName: "Anthropic",
		credentialEnv: "ANTHROPIC_API_KEY",
		model: "claude-sonnet-5",
		createAdapter: (apiKey: string) => createAnthropicAdapter({ apiKey }),
	},
	{
		name: "gemini",
		displayName: "Gemini",
		credentialEnv: "GEMINI_API_KEY",
		model: "gemini-2.5-flash",
		createAdapter: (apiKey: string) => createGeminiAdapter({ apiKey }),
	},
	{
		name: "deepseek",
		displayName: "DeepSeek",
		credentialEnv: "DEEPSEEK_API_KEY",
		model: "deepseek-v4-flash",
		createAdapter: (apiKey: string) => createDeepSeekAdapter({ apiKey }),
	},
] as const satisfies readonly ContractProviderDefinition[];

export type ContractModeResult =
	| { status: "PASSED"; detail: string }
	| { status: "FAILED"; detail: string };

export type ProviderContractResult =
	| {
			name: ProviderName;
			displayName: string;
			model: string;
			status: "SKIPPED";
			detail: string;
	  }
	| {
			name: ProviderName;
			displayName: string;
			model: string;
			status: "PASSED" | "FAILED";
			nonStreaming: ContractModeResult;
			streaming: ContractModeResult;
	  };

export interface ContractSuiteResult {
	results: ProviderContractResult[];
	configuredCount: number;
	passedCount: number;
	failedCount: number;
	skippedCount: number;
	ok: boolean;
}

export interface RunNightlyContractsOptions {
	environment: Readonly<Record<string, string | undefined>>;
	definitions?: readonly ContractProviderDefinition[];
	report?: (line: string) => void;
	createSignal?: () => AbortSignal;
}

function buildRequest(model: string): ChatRequest {
	return ChatRequestSchema.parse({
		model,
		messages: [{ role: "user", content: CONTRACT_PROMPT }],
		max_tokens: CONTRACT_MAX_TOKENS,
	});
}

function redact(value: string, secrets: readonly string[]): string {
	let result = value;
	for (const secret of secrets) {
		if (secret.length > 0) {
			result = result.replaceAll(secret, "[REDACTED]");
		}
	}
	return result;
}

function safeError(error: unknown, secrets: readonly string[]): string {
	const raw =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: "Unknown contract failure.";
	return redact(raw, secrets).slice(0, 1_000);
}

async function runNonStreaming(
	adapter: ProviderAdapter,
	model: string,
	signal: AbortSignal,
): Promise<string> {
	// Exactly one logical adapter invocation. The adapter's existing bounded
	// transport retries remain intact underneath this call.
	const response = await adapter.complete(buildRequest(model), signal);
	const parsed = ChatResponseSchema.parse(response);
	const visibleChoices = parsed.choices.filter(
		(choice) =>
			typeof choice.message.content === "string" &&
			choice.message.content.trim().length > 0,
	).length;
	if (visibleChoices === 0) {
		throw new Error("Non-streaming adapter emitted no visible text choice.");
	}
	return `${parsed.choices.length} validated choice(s), ${visibleChoices} with visible text`;
}

async function runStreaming(
	adapter: ProviderAdapter,
	model: string,
	signal: AbortSignal,
): Promise<string> {
	let parsedChunks = 0;
	let usageChunks = 0;
	let sawDone = false;
	let visibleText = "";

	// Exactly one logical adapter invocation. Consuming this one iterable lets
	// the adapter preserve its own bounded pre-stream retry behavior.
	const stream = adapter.stream(buildRequest(model), signal);
	for await (const frame of stream) {
		if (sawDone) {
			throw new Error("Streaming adapter emitted a frame after [DONE].");
		}
		if (frame.done) {
			if (frame.data !== "[DONE]") {
				throw new Error("Streaming adapter emitted an invalid terminal frame.");
			}
			sawDone = true;
			continue;
		}
		if (usageChunks > 0) {
			throw new Error(
				"Streaming adapter emitted a data frame after terminal usage.",
			);
		}

		let value: unknown;
		try {
			value = JSON.parse(frame.data) as unknown;
		} catch {
			throw new Error("Streaming adapter emitted malformed JSON.");
		}
		const chunk = ChatCompletionChunkSchema.parse(value);
		parsedChunks += 1;
		for (const choice of chunk.choices) {
			if (typeof choice.delta.content === "string") {
				visibleText += choice.delta.content;
			}
		}
		if (chunk.usage != null) {
			usageChunks += 1;
		}
	}

	if (!sawDone) {
		throw new Error("Streaming adapter ended without [DONE].");
	}
	if (parsedChunks === 0) {
		throw new Error("Streaming adapter emitted no validated chunks.");
	}
	if (visibleText.trim().length === 0) {
		throw new Error("Streaming adapter emitted no visible text.");
	}
	if (usageChunks !== 1) {
		throw new Error(
			`Streaming adapter emitted ${usageChunks} usage chunks; expected exactly one.`,
		);
	}

	return `${parsedChunks} validated chunk(s), one terminal usage chunk`;
}

async function captureMode(
	operation: () => Promise<string>,
	secrets: readonly string[],
): Promise<ContractModeResult> {
	try {
		return { status: "PASSED", detail: await operation() };
	} catch (error) {
		return { status: "FAILED", detail: safeError(error, secrets) };
	}
}

export async function runNightlyContracts({
	environment,
	definitions = CONTRACT_PROVIDER_DEFINITIONS,
	report = () => {},
	createSignal = () => AbortSignal.timeout(CONTRACT_TIMEOUT_MS),
}: RunNightlyContractsOptions): Promise<ContractSuiteResult> {
	const results: ProviderContractResult[] = [];
	const configuredSecrets = definitions
		.map((definition) => environment[definition.credentialEnv])
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);

	for (const definition of definitions) {
		const apiKey = environment[definition.credentialEnv];
		if (!apiKey) {
			const detail = `${definition.credentialEnv} is not configured; both live modes were not run.`;
			results.push({
				name: definition.name,
				displayName: definition.displayName,
				model: definition.model,
				status: "SKIPPED",
				detail,
			});
			report(`${definition.displayName}: SKIPPED — ${detail}`);
			continue;
		}

		let adapter: ProviderAdapter;
		try {
			adapter = definition.createAdapter(apiKey);
		} catch (error) {
			const detail = `Adapter setup failed: ${safeError(error, configuredSecrets)}`;
			const nonStreaming: ContractModeResult = { status: "FAILED", detail };
			const streaming: ContractModeResult = { status: "FAILED", detail };
			report(
				`${definition.displayName} non-streaming: FAILED — ${nonStreaming.detail}`,
			);
			report(
				`${definition.displayName} streaming: FAILED — ${streaming.detail}`,
			);
			results.push({
				name: definition.name,
				displayName: definition.displayName,
				model: definition.model,
				status: "FAILED",
				nonStreaming,
				streaming,
			});
			continue;
		}
		const nonStreaming = await captureMode(
			() => runNonStreaming(adapter, definition.model, createSignal()),
			configuredSecrets,
		);
		report(
			`${definition.displayName} non-streaming: ${nonStreaming.status} — ${nonStreaming.detail}`,
		);

		// A non-streaming failure does not suppress the one required streaming
		// invocation; both contract surfaces are independently reported.
		const streaming = await captureMode(
			() => runStreaming(adapter, definition.model, createSignal()),
			configuredSecrets,
		);
		report(
			`${definition.displayName} streaming: ${streaming.status} — ${streaming.detail}`,
		);

		results.push({
			name: definition.name,
			displayName: definition.displayName,
			model: definition.model,
			status:
				nonStreaming.status === "PASSED" && streaming.status === "PASSED"
					? "PASSED"
					: "FAILED",
			nonStreaming,
			streaming,
		});
	}

	const configuredCount = results.filter(
		(result) => result.status !== "SKIPPED",
	).length;
	const passedCount = results.filter(
		(result) => result.status === "PASSED",
	).length;
	const failedCount = results.filter(
		(result) => result.status === "FAILED",
	).length;
	const skippedCount = results.filter(
		(result) => result.status === "SKIPPED",
	).length;

	return {
		results,
		configuredCount,
		passedCount,
		failedCount,
		skippedCount,
		ok: configuredCount > 0 && failedCount === 0,
	};
}

function escapeTableCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function modeCell(result: ContractModeResult): string {
	return `${result.status}: ${escapeTableCell(result.detail)}`;
}

export function renderContractSummary(result: ContractSuiteResult): string {
	const lines = [
		"## Nightly live provider contracts",
		"",
		"| Provider | Pinned model | Non-streaming | Streaming | Result |",
		"|---|---|---|---|---|",
	];

	for (const provider of result.results) {
		if (provider.status === "SKIPPED") {
			const detail = escapeTableCell(provider.detail);
			lines.push(
				`| ${provider.displayName} | \`${provider.model}\` | SKIPPED | SKIPPED | SKIPPED: ${detail} |`,
			);
			continue;
		}
		lines.push(
			`| ${provider.displayName} | \`${provider.model}\` | ${modeCell(provider.nonStreaming)} | ${modeCell(provider.streaming)} | ${provider.status} |`,
		);
	}

	lines.push(
		"",
		`Configured: **${result.configuredCount}** · Passed: **${result.passedCount}** · Failed: **${result.failedCount}** · Skipped: **${result.skippedCount}**`,
		"",
		result.configuredCount === 0
			? "**FAILED:** zero provider credentials were configured."
			: result.ok
				? "**PASSED:** every configured provider passed both live modes."
				: "**FAILED:** at least one configured provider contract failed.",
		"",
	);
	return lines.join("\n");
}
