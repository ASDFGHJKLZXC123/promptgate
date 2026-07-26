import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const FIXTURES_DIRECTORY = path.resolve(import.meta.dirname, "fixtures");
const PROVIDERS = ["anthropic", "deepseek", "gemini", "openai"] as const;
const MODES = ["non-streaming", "streaming"] as const;
const EXPECTED_FILES = [
	"anthropic-non-streaming.json",
	"anthropic-streaming.txt",
	"deepseek-non-streaming.json",
	"deepseek-streaming.txt",
	"gemini-non-streaming.json",
	"gemini-streaming.txt",
	"manifest.json",
	"openai-non-streaming.json",
	"openai-streaming.txt",
] as const;
const OFFICIAL_SOURCE_URLS = {
	anthropic: {
		"non-streaming": "https://platform.claude.com/docs/en/api/messages",
		streaming: "https://platform.claude.com/docs/en/api/messages-streaming",
	},
	deepseek: {
		"non-streaming": "https://api-docs.deepseek.com/api/create-chat-completion",
		streaming: "https://api-docs.deepseek.com/api/create-chat-completion",
	},
	gemini: {
		"non-streaming": "https://ai.google.dev/gemini-api/docs/openai",
		streaming: "https://ai.google.dev/gemini-api/docs/openai",
	},
	openai: {
		"non-streaming":
			"https://platform.openai.com/docs/api-reference/chat/create",
		streaming: "https://platform.openai.com/docs/api-reference/chat/create",
	},
} as const satisfies Record<Provider, Record<Mode, string>>;

type Provider = (typeof PROVIDERS)[number];
type Mode = (typeof MODES)[number];
type JsonRecord = Record<string, unknown>;
const COMPATIBLE_STREAM_MODELS = {
	openai: "gpt-5.6-luna",
	gemini: "gemini-2.5-flash",
	deepseek: "deepseek-v4-flash",
} as const satisfies Record<Exclude<Provider, "anthropic">, string>;
const LIVE_CAPTURE_PENDING = {
	anthropic: true,
	openai: true,
	gemini: false,
	deepseek: false,
} as const satisfies Record<Provider, boolean>;

interface FixtureManifestEntry {
	file: string;
	provider: Provider;
	mode: Mode;
	live_capture_pending: boolean;
	source_url: string;
}

function asRecord(value: unknown, description: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${description} must be an object.`);
	}
	return value;
}

function parseJson(contents: string): unknown {
	return JSON.parse(contents) as unknown;
}

function field(record: JsonRecord, name: string): unknown {
	if (!(name in record)) {
		throw new Error(`Missing ${name}.`);
	}
	return record[name];
}

function stringField(record: JsonRecord, name: string): string {
	const value = field(record, name);
	if (typeof value !== "string") {
		throw new Error(`${name} must be a string.`);
	}
	return value;
}

function numberField(record: JsonRecord, name: string): number {
	const value = field(record, name);
	if (typeof value !== "number") {
		throw new Error(`${name} must be a number.`);
	}
	return value;
}

function arrayField(record: JsonRecord, name: string): unknown[] {
	const value = field(record, name);
	if (!Array.isArray(value)) {
		throw new Error(`${name} must be an array.`);
	}
	return value;
}

function parseManifest(value: unknown): FixtureManifestEntry[] {
	const root = asRecord(value, "Fixture manifest");
	return arrayField(root, "fixtures").map((entry): FixtureManifestEntry => {
		const record = asRecord(entry, "Fixture manifest entry");
		const provider = stringField(record, "provider");
		const mode = stringField(record, "mode");
		const pending = field(record, "live_capture_pending");
		if (
			!PROVIDERS.includes(provider as Provider) ||
			!MODES.includes(mode as Mode) ||
			typeof pending !== "boolean"
		) {
			throw new Error("Fixture manifest entry has invalid values.");
		}
		return {
			file: stringField(record, "file"),
			provider: provider as Provider,
			mode: mode as Mode,
			live_capture_pending: pending,
			source_url: stringField(record, "source_url"),
		};
	});
}

function sseEvents(transcript: string): string[][] {
	return transcript
		.trim()
		.split("\n\n")
		.map((event) => event.split("\n"));
}

function compatibleSsePayloads(transcript: string): string[] {
	expect(transcript).not.toContain("\r");
	expect(transcript).toMatch(/^data: [^\n]+\n(?:\ndata: [^\n]+\n)*$/);
	return transcript
		.slice(0, -1)
		.split("\n\n")
		.map((event) => {
			expect(event).toMatch(/^data: [^\n]+$/);
			return event.slice("data: ".length);
		});
}

function assertSanitizedIdentifier(value: string): void {
	expect(value).toMatch(/pgfixture/);
}

function assertUsageTotals(usage: JsonRecord): void {
	expect(numberField(usage, "total_tokens")).toBeGreaterThanOrEqual(
		numberField(usage, "prompt_tokens") +
			numberField(usage, "completion_tokens"),
	);
}

function assertCompatibleResponse(
	provider: Exclude<Provider, "anthropic">,
	record: JsonRecord,
): JsonRecord {
	assertSanitizedIdentifier(stringField(record, "id"));
	expect(stringField(record, "object")).toBe("chat.completion");
	numberField(record, "created");
	expect(stringField(record, "model")).toBe(COMPATIBLE_STREAM_MODELS[provider]);
	const choices = arrayField(record, "choices");
	expect(choices).toHaveLength(1);
	const choice = asRecord(arrayField(record, "choices")[0], "response choice");
	const message = asRecord(field(choice, "message"), "response message");
	expect(stringField(message, "role")).toBe("assistant");
	const content = stringField(message, "content");
	if (provider === "gemini") {
		expect(content).toBe("OK");
	} else if (provider === "deepseek") {
		expect(content).toBe("OK.");
	} else {
		expect(content).toContain("PromptGate contract fixture");
	}
	expect(stringField(choice, "finish_reason")).toBe("stop");
	const usage = asRecord(field(record, "usage"), "response usage");
	assertUsageTotals(usage);
	if ("system_fingerprint" in record) {
		expect(stringField(record, "system_fingerprint")).toBe("fp_pgfixture");
	}
	return usage;
}

function assertCompatibleStream(
	provider: Exclude<Provider, "anthropic">,
	transcript: string,
): void {
	const payloads = compatibleSsePayloads(transcript);
	expect(payloads.filter((payload) => payload === "[DONE]")).toHaveLength(1);
	expect(payloads.at(-1)).toBe("[DONE]");

	const chunks = payloads
		.slice(0, -1)
		.map((line) => asRecord(parseJson(line), "stream chunk"));
	const terminal = chunks.at(-1);
	if (terminal === undefined) {
		throw new Error("Streaming fixture has no JSON chunks.");
	}

	const usageFrameIndexes = chunks.flatMap((chunk, index) =>
		field(chunk, "usage") === null ? [] : [index],
	);
	expect(usageFrameIndexes).toEqual([chunks.length - 1]);
	const usage = asRecord(field(terminal, "usage"), "terminal usage");
	assertUsageTotals(usage);

	const terminalChoices = arrayField(terminal, "choices");
	if (provider === "openai") {
		expect(terminalChoices).toEqual([]);
		const finishChunk = chunks.at(-2);
		if (finishChunk === undefined) {
			throw new Error("OpenAI fixture requires a separate finish chunk.");
		}
		const finishChoices = arrayField(finishChunk, "choices");
		expect(finishChoices.length).toBeGreaterThan(0);
		for (const rawChoice of finishChoices) {
			expect(
				stringField(
					asRecord(rawChoice, "OpenAI finish choice"),
					"finish_reason",
				),
			).toBe("stop");
		}
	} else {
		expect(terminalChoices.length).toBeGreaterThan(0);
		for (const rawChoice of terminalChoices) {
			expect(
				stringField(
					asRecord(rawChoice, `${provider} terminal choice`),
					"finish_reason",
				),
			).toBe("stop");
		}
	}

	let visibleContent = "";
	let sawAssistantRole = false;
	const finishReasons: string[] = [];

	for (const chunk of chunks) {
		assertSanitizedIdentifier(stringField(chunk, "id"));
		expect(stringField(chunk, "object")).toBe("chat.completion.chunk");
		numberField(chunk, "created");
		expect(stringField(chunk, "model")).toBe(
			COMPATIBLE_STREAM_MODELS[provider],
		);
		const choices = arrayField(chunk, "choices");
		for (const rawChoice of choices) {
			const choice = asRecord(rawChoice, "stream choice");
			numberField(choice, "index");
			const delta = asRecord(field(choice, "delta"), "stream delta");
			if ("role" in delta) {
				expect(stringField(delta, "role")).toBe("assistant");
				sawAssistantRole = true;
			}
			const content = delta.content;
			if (typeof content === "string") {
				visibleContent += content;
			} else if (content !== undefined && content !== null) {
				throw new Error("delta.content must be a string, null, or absent.");
			}
			const finishReason = field(choice, "finish_reason");
			if (finishReason !== null) {
				if (typeof finishReason !== "string") {
					throw new Error("finish_reason must be a string or null.");
				}
				finishReasons.push(finishReason);
			}
			if (provider === "deepseek") {
				expect(field(choice, "logprobs")).toBeNull();
			}
		}
		if ("system_fingerprint" in chunk) {
			expect(stringField(chunk, "system_fingerprint")).toBe("fp_pgfixture");
		}
	}
	expect(sawAssistantRole).toBe(true);
	expect(finishReasons).toEqual(["stop"]);
	if (provider === "gemini") {
		expect(visibleContent).toBe("OK");
	} else if (provider === "deepseek") {
		expect(visibleContent).toBe("OK.");
	} else {
		expect(visibleContent).toContain("PromptGate contract fixture");
	}

	if (provider === "deepseek") {
		for (const chunk of chunks) {
			expect(stringField(chunk, "system_fingerprint")).toBe("fp_pgfixture");
		}
		expect(numberField(usage, "prompt_tokens")).toBe(7);
		expect(numberField(usage, "completion_tokens")).toBe(39);
		expect(numberField(usage, "total_tokens")).toBe(46);
		expect(numberField(usage, "prompt_cache_hit_tokens")).toBe(0);
		expect(numberField(usage, "prompt_cache_miss_tokens")).toBe(7);
		expect(
			numberField(usage, "prompt_cache_hit_tokens") +
				numberField(usage, "prompt_cache_miss_tokens"),
		).toBe(numberField(usage, "prompt_tokens"));
		expect(
			numberField(
				asRecord(field(usage, "prompt_tokens_details"), "cache details"),
				"cached_tokens",
			),
		).toBe(0);
		expect(
			numberField(
				asRecord(
					field(usage, "completion_tokens_details"),
					"reasoning details",
				),
				"reasoning_tokens",
			),
		).toBe(36);
	}

	if (provider === "gemini") {
		expect(numberField(usage, "prompt_tokens")).toBe(4);
		expect(numberField(usage, "completion_tokens")).toBe(1);
		expect(numberField(usage, "total_tokens")).toBe(30);
		const hiddenThinkingTokens =
			numberField(usage, "total_tokens") -
			numberField(usage, "prompt_tokens") -
			numberField(usage, "completion_tokens");
		expect(hiddenThinkingTokens).toBe(25);
	}
}

describe("provider contract fixtures", () => {
	test("contains exactly eight provider/mode fixtures", async () => {
		expect((await readdir(FIXTURES_DIRECTORY)).sort()).toEqual(
			[...EXPECTED_FILES].sort(),
		);
		const manifest = parseManifest(
			parseJson(
				await readFile(path.join(FIXTURES_DIRECTORY, "manifest.json"), "utf8"),
			),
		);
		expect(manifest).toHaveLength(8);
		expect(manifest.map((fixture) => fixture.file).sort()).toEqual(
			EXPECTED_FILES.filter((file) => file !== "manifest.json").sort(),
		);
		expect(
			new Set(manifest.map((fixture) => `${fixture.provider}:${fixture.mode}`)),
		).toEqual(
			new Set(
				PROVIDERS.flatMap((provider) =>
					MODES.map((mode) => `${provider}:${mode}`),
				),
			),
		);
	});

	test("validates provider-specific non-streaming payload contracts", async () => {
		const openai = asRecord(
			parseJson(
				await readFile(
					path.join(FIXTURES_DIRECTORY, "openai-non-streaming.json"),
					"utf8",
				),
			),
			"OpenAI response",
		);
		const gemini = asRecord(
			parseJson(
				await readFile(
					path.join(FIXTURES_DIRECTORY, "gemini-non-streaming.json"),
					"utf8",
				),
			),
			"Gemini response",
		);
		const deepseek = asRecord(
			parseJson(
				await readFile(
					path.join(FIXTURES_DIRECTORY, "deepseek-non-streaming.json"),
					"utf8",
				),
			),
			"DeepSeek response",
		);
		const openaiUsage = assertCompatibleResponse("openai", openai);
		expect(
			numberField(
				asRecord(
					field(openaiUsage, "prompt_tokens_details"),
					"OpenAI prompt details",
				),
				"cached_tokens",
			),
		).toBe(0);
		expect(
			numberField(
				asRecord(
					field(openaiUsage, "completion_tokens_details"),
					"OpenAI completion details",
				),
				"reasoning_tokens",
			),
		).toBe(0);
		const geminiUsage = assertCompatibleResponse("gemini", gemini);
		expect(numberField(geminiUsage, "prompt_tokens")).toBe(4);
		expect(numberField(geminiUsage, "completion_tokens")).toBe(1);
		expect(numberField(geminiUsage, "total_tokens")).toBe(30);
		expect(
			numberField(geminiUsage, "total_tokens") -
				numberField(geminiUsage, "prompt_tokens") -
				numberField(geminiUsage, "completion_tokens"),
		).toBe(25);
		const deepseekUsage = assertCompatibleResponse("deepseek", deepseek);
		expect(stringField(deepseek, "system_fingerprint")).toBe("fp_pgfixture");
		expect(numberField(deepseekUsage, "prompt_tokens")).toBe(7);
		expect(numberField(deepseekUsage, "completion_tokens")).toBe(29);
		expect(numberField(deepseekUsage, "total_tokens")).toBe(36);
		expect(numberField(deepseekUsage, "prompt_cache_hit_tokens")).toBe(0);
		expect(numberField(deepseekUsage, "prompt_cache_miss_tokens")).toBe(7);
		expect(
			numberField(deepseekUsage, "prompt_cache_hit_tokens") +
				numberField(deepseekUsage, "prompt_cache_miss_tokens"),
		).toBe(numberField(deepseekUsage, "prompt_tokens"));
		expect(
			numberField(
				asRecord(
					field(deepseekUsage, "prompt_tokens_details"),
					"DeepSeek cache details",
				),
				"cached_tokens",
			),
		).toBe(numberField(deepseekUsage, "prompt_cache_hit_tokens"));
		expect(
			numberField(
				asRecord(
					field(deepseekUsage, "completion_tokens_details"),
					"DeepSeek reasoning details",
				),
				"reasoning_tokens",
			),
		).toBe(26);

		const anthropic = asRecord(
			parseJson(
				await readFile(
					path.join(FIXTURES_DIRECTORY, "anthropic-non-streaming.json"),
					"utf8",
				),
			),
			"Anthropic response",
		);
		assertSanitizedIdentifier(stringField(anthropic, "id"));
		expect(stringField(anthropic, "type")).toBe("message");
		expect(stringField(anthropic, "role")).toBe("assistant");
		expect(stringField(anthropic, "model")).toMatch(/^claude-/);
		expect(
			stringField(
				asRecord(arrayField(anthropic, "content")[0], "Anthropic content"),
				"text",
			),
		).toContain("PromptGate contract fixture");
		expect(stringField(anthropic, "stop_reason")).toBe("end_turn");
		const anthropicUsage = asRecord(
			field(anthropic, "usage"),
			"Anthropic usage",
		);
		numberField(anthropicUsage, "input_tokens");
		numberField(anthropicUsage, "output_tokens");
	});

	test("validates OpenAI-compatible and Anthropic SSE contracts", async () => {
		for (const provider of ["openai", "gemini", "deepseek"] as const) {
			assertCompatibleStream(
				provider,
				await readFile(
					path.join(FIXTURES_DIRECTORY, `${provider}-streaming.txt`),
					"utf8",
				),
			);
		}

		const events = sseEvents(
			await readFile(
				path.join(FIXTURES_DIRECTORY, "anthropic-streaming.txt"),
				"utf8",
			),
		);
		expect(events.map((event) => event[0])).toEqual([
			"event: message_start",
			"event: content_block_start",
			"event: ping",
			"event: content_block_delta",
			"event: content_block_stop",
			"event: message_delta",
			"event: message_stop",
		]);
		for (const event of events) {
			expect(event).toHaveLength(2);
			const eventName = event[0].slice("event: ".length);
			const data = asRecord(
				parseJson(event[1].slice("data: ".length)),
				"Anthropic event data",
			);
			expect(stringField(data, "type")).toBe(eventName);
		}
		const messageStart = asRecord(
			parseJson(events[0][1].slice("data: ".length)),
			"message_start data",
		);
		const message = asRecord(
			field(messageStart, "message"),
			"message_start message",
		);
		assertSanitizedIdentifier(stringField(message, "id"));
		numberField(
			asRecord(field(message, "usage"), "message_start usage"),
			"input_tokens",
		);
		const textDelta = asRecord(
			parseJson(events[3][1].slice("data: ".length)),
			"text delta data",
		);
		expect(
			stringField(asRecord(field(textDelta, "delta"), "text delta"), "text"),
		).toContain("PromptGate contract fixture");
		const messageDelta = asRecord(
			parseJson(events[5][1].slice("data: ".length)),
			"message_delta data",
		);
		expect(
			stringField(
				asRecord(field(messageDelta, "delta"), "message delta"),
				"stop_reason",
			),
		).toBe("end_turn");
		numberField(
			asRecord(field(messageDelta, "usage"), "message_delta usage"),
			"output_tokens",
		);
	});

	test("records the activated live-capture matrix with exact official HTTPS source URLs and no secrets", async () => {
		const manifestContents = await readFile(
			path.join(FIXTURES_DIRECTORY, "manifest.json"),
			"utf8",
		);
		const secretPattern =
			/(?:authorization\s*:|x-api-key\s*:|bearer\s+(?!\[redacted\])|\bsk-[a-z0-9_-]{8,}|\bAIza[a-z0-9_-]{20,})/i;
		for (const fixture of parseManifest(parseJson(manifestContents))) {
			expect(fixture.live_capture_pending).toBe(
				LIVE_CAPTURE_PENDING[fixture.provider],
			);
			expect(fixture.source_url).toBe(
				OFFICIAL_SOURCE_URLS[fixture.provider][fixture.mode],
			);
			const source = new URL(fixture.source_url);
			expect(source.protocol).toBe("https:");
			expect(source.hostname).toBe(
				new URL(OFFICIAL_SOURCE_URLS[fixture.provider][fixture.mode]).hostname,
			);
			expect(
				await readFile(path.join(FIXTURES_DIRECTORY, fixture.file), "utf8"),
			).not.toMatch(secretPattern);
		}
		expect(manifestContents).not.toMatch(secretPattern);
	});
});
