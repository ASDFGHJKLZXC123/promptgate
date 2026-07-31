import path from "node:path";
import { pathToFileURL } from "node:url";

const providerKeyNames = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"DEEPSEEK_API_KEY",
];
const presentProviderKeys = providerKeyNames.filter(
	(name) => process.env[name] !== undefined,
);
if (presentProviderKeys.length > 0) {
	throw new Error(
		`Provider-free verification refuses provider-key variables: ${presentProviderKeys.join(", ")}`,
	);
}

const repositoryRoot = process.cwd();
const importBuilt = (file) =>
	import(
		pathToFileURL(
			path.join(repositoryRoot, "packages", "gateway", "dist", file),
		).href
	);
const { buildServer } = await importBuilt("server.js");
const { registerSignalShutdown } = await importBuilt("shutdown.js");

let responseSequence = 0;

function messageText(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) =>
			part?.type === "text" && typeof part.text === "string" ? part.text : "",
		)
		.join("\n");
}

function response(model, content, usage) {
	responseSequence += 1;
	return {
		id: `chatcmpl-phase7-${responseSequence}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1_000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		...(usage === undefined ? {} : { usage }),
	};
}

async function boundedDelay(signal) {
	await new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, 25);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});
}

const deepseek = {
	name: "deepseek",
	async complete(request, signal) {
		await boundedDelay(signal);
		const messages = request.messages.map(messageText);
		const isCertifiedV1 = messages.some((text) =>
			text.includes("Classify the note by this policy"),
		);
		const note = messages.at(-1) ?? "";
		const riskLevel =
			isCertifiedV1 && /chest pain/i.test(note) ? "urgent" : "none";
		const guidance =
			riskLevel === "urgent"
				? "Seek immediate emergency help now."
				: "Monitor and seek qualified care if symptoms change.";
		return response(
			request.model,
			JSON.stringify({ risk_level: riskLevel, guidance }),
			{ prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
		);
	},
	async *stream() {
		yield* [];
		throw new Error("Streaming is outside the Phase 7 verification.");
	},
};

const openai = {
	name: "openai",
	async complete(request, signal) {
		await boundedDelay(signal);
		if (request.model === "gpt-5.6-terra") {
			return response(
				request.model,
				JSON.stringify({
					pass: true,
					score: 0.9,
					rationale: "Provider-free Phase 7 verification result.",
				}),
				{ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
			);
		}
		return response(
			request.model,
			"Provider-free estimated-cost verification response.",
			undefined,
		);
	},
	async *stream() {
		yield* [];
		throw new Error("Streaming is outside the Phase 7 verification.");
	},
};

const server = buildServer({ adapters: { deepseek, openai } });
const unregister = registerSignalShutdown(
	process,
	() => server.close(),
	(signal, error) => {
		console.error(
			`Phase 7 verification shutdown failed after ${signal}`,
			error,
		);
	},
);

try {
	await server.listen({
		host: "127.0.0.1",
		port: Number(process.env.PORT ?? "8787"),
	});
	console.log(`Provider-key variables absent: ${providerKeyNames.join(", ")}.`);
	console.log("Phase 7 provider-free verification gateway ready.");
} catch (error) {
	console.error("Phase 7 provider-free verification gateway failed.", error);
	unregister();
	process.exit(1);
}
