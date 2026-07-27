import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type CliIo, parseCli, runCli, usage } from "./cli.js";

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
				"--max-score-drop",
				"0.05",
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
				"max-score-drop": "0.05",
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

	test("prints help without selecting a command", () => {
		const { io, stderr, stdout } = createIo();
		expect(runCli(["--help"], io)).toBe(0);
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

	test("returns infrastructure exit code until command logic exists", () => {
		const { io, stderr } = createIo();
		expect(runCli(["run"], io)).toBe(2);
		expect(stderr).toHaveBeenCalledWith(
			"pg-eval run is scaffolded but not implemented yet.",
		);
	});

	test("exposes a clean-checkout source executable without requiring dist", () => {
		const packageRoot = resolve(process.cwd(), "packages/evals");
		const packageJson = JSON.parse(
			readFileSync(resolve(packageRoot, "package.json"), "utf8"),
		) as { bin?: Record<string, string> };
		expect(packageJson.bin).toEqual({ "pg-eval": "./src/cli.ts" });

		const result = spawnSync(
			"pnpm",
			["--filter", "@promptgate/evals", "exec", "pg-eval", "--help"],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(`${usage}\n`);
		expect(result.stderr).toBe("");
	});
});
