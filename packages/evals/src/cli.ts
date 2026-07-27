#!/usr/bin/env node

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
  run       Execute an evaluation dataset (scaffolded in Phase 5 step 1)
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

export function runCli(argv: readonly string[], io: CliIo = defaultIo): number {
	try {
		const parsed = parseCli(argv);
		if ("help" in parsed) {
			io.stdout(usage);
			return 0;
		}

		io.stderr(
			`pg-eval ${parsed.command} is scaffolded but not implemented yet.`,
		);
		return 2;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Invalid pg-eval arguments.";
		io.stderr(`${message}\n\n${usage}`);
		return 2;
	}
}

const runtime = globalThis as {
	process?: { argv?: string[]; exitCode?: number };
};

if (
	runtime.process?.argv?.[1] !== undefined &&
	/(?:^|[/\\])cli\.(?:js|ts)$/.test(runtime.process.argv[1])
) {
	runtime.process.exitCode = runCli(runtime.process.argv.slice(2));
}
