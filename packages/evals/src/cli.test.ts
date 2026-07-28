import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type CliIo, type CliRuntime, parseCli, runCli, usage } from "./cli.js";

const sourceBin = resolve(process.cwd(), "node_modules/.bin/pg-eval");

function createIo(): {
	io: CliIo;
	stderr: ReturnType<typeof vi.fn>;
	stdout: ReturnType<typeof vi.fn>;
} {
	const stdout = vi.fn();
	const stderr = vi.fn();
	return { io: { stdout, stderr }, stderr, stdout };
}

describe("pg-eval CLI scaffold", () => {
	test("accepts the documented run options without starting evaluation work", () => {
		expect(
			parseCli([
				"run",
				"--dataset",
				"safety_screening",
				"--prompt",
				"safety_screen@candidate",
				"--baseline",
				"prod",
				"--baseline-from-history",
				"--gateway",
				"http://localhost:8787",
				"--key",
				"pg-test",
				"--admin-token",
				"admin-test",
				"--allow-cache",
				"--max-score-drop",
				"0.05",
				"--min-request-interval-ms",
				"15000",
			]),
		).toEqual({
			command: "run",
			options: {
				"admin-token": "admin-test",
				"allow-cache": true,
				baseline: "prod",
				"baseline-from-history": true,
				dataset: "safety_screening",
				gateway: "http://localhost:8787",
				key: "pg-test",
				"max-score-drop": "0.05",
				"min-request-interval-ms": "15000",
				prompt: "safety_screen@candidate",
			},
		});
	});

	test.each(["run", "seed-ci", "comment"] as const)(
		"recognizes %s as an exact supported command",
		(command) => {
			expect(parseCli([command])).toEqual({ command, options: {} });
		},
	);

	test("prints help without selecting a command", async () => {
		const { io, stderr, stdout } = createIo();
		await expect(runCli(["--help"], io)).resolves.toBe(0);
		expect(stdout).toHaveBeenCalledWith(usage);
		expect(stderr).not.toHaveBeenCalled();
	});

	test("rejects unknown commands and command-incompatible options", () => {
		expect(() => parseCli(["inspect"])).toThrow(
			"Unknown pg-eval command: inspect.",
		);
		expect(() =>
			parseCli(["comment", "--dataset", "safety_screening"]),
		).toThrow("Option --dataset is not supported by pg-eval comment.");
	});

	test("returns infrastructure exit code for invalid run input", async () => {
		const { io, stderr } = createIo();
		await expect(runCli(["run"], io)).resolves.toBe(2);
		expect(stderr).toHaveBeenCalledWith(
			"pg-eval run requires --dataset and --prompt.",
		);
	});

	test("ignores ambient request-pacing values unless the CLI flag is supplied", async () => {
		const { io } = createIo();
		const runEvaluation = vi.fn().mockResolvedValue({
			exitCode: 0,
			markdown: "",
			warnings: [],
		});
		const runtime = {
			loadRunModules: async () => ({
				resolveGatewayConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					key: "eval-key",
				}),
				resolveAdminConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					adminToken: "admin-token",
				}),
				GatewayClient: class {} as never,
				AdminClient: class {} as never,
				runEvaluation,
			}),
		} satisfies CliRuntime;
		await expect(
			runCli(
				[
					"run",
					"--dataset",
					"safety_screening",
					"--prompt",
					"safety_screen@candidate",
				],
				io,
				{
					PG_ADMIN_TOKEN: "admin-token",
					PG_EVAL_KEY: "eval-key",
					PG_EVAL_MIN_REQUEST_INTERVAL_MS: "6500",
					PG_GATEWAY_URL: "https://gateway.example",
				},
				runtime,
			),
		).resolves.toBe(0);
		expect(runEvaluation).toHaveBeenCalledWith(
			expect.objectContaining({ minRequestIntervalMs: 0 }),
			expect.any(Object),
		);
	});

	test("forwards an explicit request-pace flag to the runner", async () => {
		const { io } = createIo();
		const runEvaluation = vi.fn().mockResolvedValue({
			exitCode: 0,
			markdown: "",
			warnings: [],
		});
		const runtime = {
			loadRunModules: async () => ({
				resolveGatewayConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					key: "eval-key",
				}),
				resolveAdminConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					adminToken: "admin-token",
				}),
				GatewayClient: class {} as never,
				AdminClient: class {} as never,
				runEvaluation,
			}),
		} satisfies CliRuntime;
		await expect(
			runCli(
				[
					"run",
					"--dataset",
					"safety_screening",
					"--prompt",
					"safety_screen@candidate",
					"--baseline",
					"prod",
					"--baseline-from-history",
					"--min-request-interval-ms",
					"15000",
				],
				io,
				{},
				runtime,
			),
		).resolves.toBe(0);
		expect(runEvaluation).toHaveBeenCalledWith(
			expect.objectContaining({
				baseline: "prod",
				baselineFromHistory: true,
				minRequestIntervalMs: 15_000,
			}),
			expect.any(Object),
		);
	});

	test.each(["", " ", "+1", "-1", "1.5", "1e3", "01", "9007199254740992"])(
		"rejects invalid request-pace value %s before runtime resolution",
		async (value) => {
			const { io, stderr } = createIo();
			const loadRunModules = vi.fn();
			await expect(
				runCli(
					[
						"run",
						"--dataset",
						"safety_screening",
						"--prompt",
						"safety_screen@candidate",
						`--min-request-interval-ms=${value}`,
					],
					io,
					{},
					{ loadRunModules } as CliRuntime,
				),
			).resolves.toBe(2);
			expect(stderr).toHaveBeenCalledWith(
				"min-request-interval-ms must be a non-negative safe integer.",
			);
			expect(loadRunModules).not.toHaveBeenCalled();
		},
	);

	test("source executable reaches argument validation without resolving compiled-only modules", () => {
		const result = spawnSync(sourceBin, ["run"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires --dataset and --prompt");
		expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
	}, 15_000);

	test("source executable loads runtime modules on a valid command before missing-config failure", () => {
		const result = spawnSync(
			sourceBin,
			["run", "--dataset", "fixture", "--prompt", "safety@1"],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Gateway URL");
		expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
	}, 15_000);

	test("built CLI loads its compiled runtime modules", () => {
		const result = spawnSync(
			process.execPath,
			[
				resolve(process.cwd(), "packages/evals/dist/cli.js"),
				"run",
				"--dataset",
				"fixture",
				"--prompt",
				"safety@1",
			],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Gateway URL");
		expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
	});

	test("exposes a clean-checkout source executable without requiring dist", () => {
		const packageRoot = resolve(process.cwd(), "packages/evals");
		const packageJson = JSON.parse(
			readFileSync(resolve(packageRoot, "package.json"), "utf8"),
		) as { bin?: Record<string, string> };
		expect(packageJson.bin).toEqual({ "pg-eval": "./src/cli.ts" });

		const result = spawnSync(sourceBin, ["--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(`${usage}\n`);
		expect(result.stderr).toBe("");
	}, 15_000);
});
