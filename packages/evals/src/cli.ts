#!/usr/bin/env node

import { existsSync } from "node:fs";
import type { AdminConfig } from "./admin-client.js";
import type { GatewayConfig } from "./gateway-client.js";
import type { EvalRunDependencies, EvalRunnerOptions } from "./runner.js";

const COMMANDS = ["run", "seed-ci", "comment"] as const;

export type EvalCommand = (typeof COMMANDS)[number];

export interface ParsedCli {
	command: EvalCommand;
	options: Readonly<Record<string, string | boolean>>;
}

export interface CliIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

export interface RunCliModules {
	resolveGatewayConfig(input: {
		flags: { gateway?: string; key?: string };
		env: Readonly<Record<string, string | undefined>>;
	}): GatewayConfig;
	resolveAdminConfig(input: {
		flags: { gateway?: string; adminToken?: string };
		env: Readonly<Record<string, string | undefined>>;
	}): AdminConfig;
	GatewayClient: new (config: GatewayConfig) => EvalRunDependencies["gateway"];
	AdminClient: new (config: AdminConfig) => EvalRunDependencies["admin"];
	runEvaluation(
		options: EvalRunnerOptions,
		deps: EvalRunDependencies,
	): Promise<{
		exitCode: 0 | 1;
		markdown: string;
		warnings: readonly string[];
	}>;
}

/** Dependency seam for offline CLI integration tests. */
export interface CliRuntime {
	loadRunModules(): Promise<RunCliModules>;
}

const defaultIo: CliIo = {
	stdout: (message) => console.log(message),
	stderr: (message) => console.error(message),
};

const optionDefinitions = {
	"admin-token": "string",
	"allow-cache": "boolean",
	baseline: "string",
	"baseline-from-history": "boolean",
	dataset: "string",
	gateway: "string",
	help: "boolean",
	key: "string",
	"max-score-drop": "string",
	prompt: "string",
} as const;

const optionsByCommand: Readonly<Record<EvalCommand, readonly string[]>> = {
	run: [
		"admin-token",
		"allow-cache",
		"baseline",
		"baseline-from-history",
		"dataset",
		"gateway",
		"key",
		"max-score-drop",
		"prompt",
	],
	"seed-ci": ["admin-token", "gateway"],
	comment: [],
};

export const usage = `Usage: pg-eval <command> [options]

Commands:
  run       Execute an evaluation dataset
  seed-ci   Seed the CI evaluation fixtures (implemented in Phase 6)
  comment   Post an evaluation summary (implemented in Phase 6)

Run options:
  --dataset <slug>              Dataset slug or path
  --prompt <registry-ref>       Prompt registry reference
  --baseline <label>            Paired baseline label
  --baseline-from-history       Compare with a persisted baseline run
  --gateway <url>               Gateway base URL
  --key <api-key>               PromptGate evaluation key
  --admin-token <token>         Admin API token
  --allow-cache                 Allow cache during local development
  --max-score-drop <number>     Maximum acceptable baseline score drop
  -h, --help                    Show this help`;

function isCommand(value: string): value is EvalCommand {
	return (COMMANDS as readonly string[]).includes(value);
}

function assertNoUnsupportedOptions(parsed: ParsedCli): void {
	const supported = new Set(optionsByCommand[parsed.command]);
	for (const option of Object.keys(parsed.options)) {
		if (option !== "help" && !supported.has(option)) {
			throw new Error(
				`Option --${option} is not supported by pg-eval ${parsed.command}.`,
			);
		}
	}
}

function parseArguments(argv: readonly string[]): {
	positionals: string[];
	values: Record<string, string | boolean>;
} {
	const positionals: string[] = [];
	const values: Record<string, string | boolean> = {};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith("-")) {
			positionals.push(argument);
			continue;
		}

		const normalized = argument === "-h" ? "--help" : argument;
		if (!normalized.startsWith("--") || normalized === "--") {
			throw new Error(`Unknown option: ${argument}.`);
		}

		const [name, inlineValue] = normalized.slice(2).split("=", 2);
		const kind = optionDefinitions[name as keyof typeof optionDefinitions];
		if (kind === undefined) {
			throw new Error(`Unknown option: --${name}.`);
		}
		if (Object.hasOwn(values, name)) {
			throw new Error(`Option --${name} may only be provided once.`);
		}

		if (kind === "boolean") {
			if (inlineValue !== undefined) {
				throw new Error(`Boolean option --${name} does not take a value.`);
			}
			values[name] = true;
			continue;
		}

		const value = inlineValue ?? argv[index + 1];
		if (value === undefined || value.startsWith("-")) {
			throw new Error(`Option --${name} requires a value.`);
		}
		values[name] = value;
		if (inlineValue === undefined) {
			index += 1;
		}
	}

	return { positionals, values };
}

export function parseCli(argv: readonly string[]): ParsedCli | { help: true } {
	const { positionals, values } = parseArguments(argv);

	if (values.help === true && positionals.length === 0) {
		return { help: true };
	}

	const [command, ...extraPositionals] = positionals;
	if (command === undefined) {
		throw new Error("A pg-eval command is required.");
	}
	if (!isCommand(command)) {
		throw new Error(`Unknown pg-eval command: ${command}.`);
	}
	if (extraPositionals.length > 0) {
		throw new Error(`Unexpected positional argument: ${extraPositionals[0]}.`);
	}

	const parsed: ParsedCli = { command, options: values };
	assertNoUnsupportedOptions(parsed);
	return values.help === true ? { help: true } : parsed;
}

/** Executes only the implemented run command; seed-ci/comment stay Phase 6 work. */
export async function runCli(
	argv: readonly string[],
	io: CliIo = defaultIo,
	env: Readonly<Record<string, string | undefined>> = process.env,
	runtime: CliRuntime = { loadRunModules },
): Promise<number> {
	try {
		const parsed = parseCli(argv);
		if ("help" in parsed) {
			io.stdout(usage);
			return 0;
		}
		if (parsed.command !== "run") {
			io.stderr(
				`pg-eval ${parsed.command} is scaffolded but not implemented yet.`,
			);
			return 2;
		}
		const dataset = parsed.options.dataset;
		const prompt = parsed.options.prompt;
		if (typeof dataset !== "string" || typeof prompt !== "string") {
			throw new Error("pg-eval run requires --dataset and --prompt.");
		}
		const maxScoreDrop = parsed.options["max-score-drop"];
		const parsedDrop =
			typeof maxScoreDrop === "string" ? Number(maxScoreDrop) : undefined;
		if (parsedDrop !== undefined && !Number.isFinite(parsedDrop)) {
			throw new Error("--max-score-drop must be a finite number.");
		}
		const modules = await runtime.loadRunModules();
		const gatewayConfig = modules.resolveGatewayConfig({
			flags: {
				gateway:
					typeof parsed.options.gateway === "string"
						? parsed.options.gateway
						: undefined,
				key:
					typeof parsed.options.key === "string"
						? parsed.options.key
						: undefined,
			},
			env,
		});
		const adminConfig = modules.resolveAdminConfig({
			flags: {
				gateway:
					typeof parsed.options.gateway === "string"
						? parsed.options.gateway
						: undefined,
				adminToken:
					typeof parsed.options["admin-token"] === "string"
						? parsed.options["admin-token"]
						: undefined,
			},
			env,
		});
		const result = await modules.runEvaluation(
			{
				dataset,
				prompt,
				baseline:
					typeof parsed.options.baseline === "string"
						? parsed.options.baseline
						: undefined,
				baselineFromHistory: parsed.options["baseline-from-history"] === true,
				allowCache: parsed.options["allow-cache"] === true,
				maxScoreDrop: parsedDrop,
				gitSha: env.GITHUB_SHA,
				trigger: env.GITHUB_ACTIONS === "true" ? "ci" : "manual",
			},
			{
				gateway: new modules.GatewayClient(gatewayConfig),
				admin: new modules.AdminClient(adminConfig),
			},
		);
		for (const warning of result.warnings) io.stderr(`Warning: ${warning}`);
		io.stdout(result.markdown);
		return result.exitCode;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : "Evaluation failed.");
		return 2;
	}
}

/** @deprecated Use runCli; retained while callers migrate to the async entrypoint. */
export const runCliAsync = runCli;

async function loadRunModules(): Promise<RunCliModules> {
	const source =
		import.meta.url.endsWith(".ts") &&
		existsSync(new URL("./runner.ts", import.meta.url));
	const [runner, gateway, admin] = source
		? await Promise.all([
				import(new URL("./runner.ts", import.meta.url).href),
				import(new URL("./gateway-client.ts", import.meta.url).href),
				import(new URL("./admin-client.ts", import.meta.url).href),
			])
		: await Promise.all([
				import("./runner.js"),
				import("./gateway-client.js"),
				import("./admin-client.js"),
			]);
	return {
		resolveGatewayConfig: gateway.resolveGatewayConfig,
		resolveAdminConfig: admin.resolveAdminConfig,
		GatewayClient: gateway.GatewayClient,
		AdminClient: admin.AdminClient,
		runEvaluation: runner.runEvaluation,
	};
}

const runtime = globalThis as {
	process?: { argv?: string[]; exitCode?: number };
};

if (
	runtime.process?.argv?.[1] !== undefined &&
	/(?:^|[/\\])cli\.(?:js|ts)$/.test(runtime.process.argv[1])
) {
	const processRuntime = runtime.process;
	void runCli((processRuntime.argv ?? []).slice(2)).then((exitCode) => {
		processRuntime.exitCode = exitCode;
	});
}
