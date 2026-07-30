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
				"--gateway",
				"http://localhost:8787",
				"--key",
				"pg-test",
				"--admin-token",
				"admin-test",
				"--allow-cache",
				"--max-pass-rate-drop",
				"0.05",
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
				dataset: "safety_screening",
				gateway: "http://localhost:8787",
				key: "pg-test",
				"max-pass-rate-drop": "0.05",
				"max-score-drop": "0.05",
				"min-request-interval-ms": "15000",
				prompt: "safety_screen@candidate",
			},
		});
	});

	test("retains explicit historical-baseline parsing for non-gate callers", () => {
		expect(
			parseCli([
				"run",
				"--dataset",
				"fixture",
				"--prompt",
				"safety@candidate",
				"--baseline",
				"prod",
				"--baseline-from-history",
			]),
		).toEqual({
			command: "run",
			options: {
				baseline: "prod",
				"baseline-from-history": true,
				dataset: "fixture",
				prompt: "safety@candidate",
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

	test("runs seed-ci through its dedicated runtime without printing credentials", async () => {
		const { io, stderr, stdout } = createIo();
		const seedCi = vi.fn().mockResolvedValue({
			key: "created",
			safetyPrompt: "created",
			judgePrompt: "created",
			datasetId: 7,
		});
		const loadRunModules = vi.fn();
		const adminToken = "admin-token-that-must-stay-private";
		const runtime = {
			loadRunModules,
			loadSeedModules: async () => ({
				resolveAdminConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					adminToken,
				}),
				seedCi,
			}),
		} satisfies CliRuntime;

		await expect(
			runCli(
				[
					"seed-ci",
					"--gateway",
					"https://gateway.example",
					"--admin-token",
					adminToken,
				],
				io,
				{ PG_EVAL_KEY_FILE: "/secure/ci-eval.key" },
				runtime,
			),
		).resolves.toBe(0);
		expect(loadRunModules).not.toHaveBeenCalled();
		expect(seedCi).toHaveBeenCalledWith({
			admin: {
				baseUrl: new URL("https://gateway.example"),
				adminToken,
			},
			keyFile: "/secure/ci-eval.key",
		});
		expect(stdout).toHaveBeenCalledWith(
			"CI seed ready: key created; safety prompt created; judge prompt created; dataset 7.",
		);
		expect(JSON.stringify(stdout.mock.calls)).not.toContain(adminToken);
		expect(stderr).not.toHaveBeenCalled();
	});

	test("requires a secure key handoff file before invoking the CI seeder", async () => {
		const { io, stderr } = createIo();
		const seedCi = vi.fn();
		const runtime = {
			loadRunModules: vi.fn(),
			loadSeedModules: async () => ({
				resolveAdminConfig: () => ({
					baseUrl: new URL("https://gateway.example"),
					adminToken: "admin-token-123456",
				}),
				seedCi,
			}),
		} satisfies CliRuntime;

		await expect(runCli(["seed-ci"], io, {}, runtime)).resolves.toBe(2);
		expect(stderr).toHaveBeenCalledWith(
			"PG_EVAL_KEY_FILE is required for pg-eval seed-ci.",
		);
		expect(seedCi).not.toHaveBeenCalled();
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

	test("forwards the paired Verify baseline and request pace without historical reuse", async () => {
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
				baselineFromHistory: false,
				minRequestIntervalMs: 15_000,
			}),
			expect.any(Object),
		);
	});

	test("rejects a non-finite pass-rate drop before runtime resolution", async () => {
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
					"--max-pass-rate-drop",
					"Infinity",
				],
				io,
				{},
				{ loadRunModules },
			),
		).resolves.toBe(2);
		expect(stderr).toHaveBeenCalledWith(
			"--max-pass-rate-drop must be a finite number.",
		);
		expect(loadRunModules).not.toHaveBeenCalled();
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

	test("source executable loads the CI seeder before missing-config failure", () => {
		const result = spawnSync(sourceBin, ["seed-ci"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				PG_ADMIN_TOKEN: "",
				PG_EVAL_KEY_FILE: "",
				PG_GATEWAY_URL: "",
			},
		});
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

	test("built CLI loads its compiled CI seeder", () => {
		const result = spawnSync(
			process.execPath,
			[resolve(process.cwd(), "packages/evals/dist/cli.js"), "seed-ci"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					PG_ADMIN_TOKEN: "",
					PG_EVAL_KEY_FILE: "",
					PG_GATEWAY_URL: "",
				},
			},
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
