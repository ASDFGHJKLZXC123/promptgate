import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const ADMIN_TOKEN = "promptgate-signal-test-admin-token";
const HASH = "b".repeat(64);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const gatewayDirectory = dirname(sourceDirectory);
const tsx = join(gatewayDirectory, "node_modules", ".bin", "tsx");
const entrypoint = join(sourceDirectory, "index.ts");

const children: ChildProcess[] = [];
const directories: string[] = [];

function within<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out`)),
			timeoutMs,
		);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function waitForExit(
	child: ChildProcess,
	label: string,
): Promise<[number | null, NodeJS.Signals | null]> {
	return within(
		once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
		10_000,
		label,
	);
}

function stopAndWait(
	child: ChildProcess,
	signal: NodeJS.Signals,
	label: string,
): Promise<[number | null, NodeJS.Signals | null]> {
	const exited = waitForExit(child, label);
	child.kill(signal);
	return exited;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				await stopAndWait(child, "SIGTERM", "gateway cleanup");
			} catch {
				if (child.exitCode === null && child.signalCode === null) {
					await stopAndWait(child, "SIGKILL", "forced gateway cleanup");
				}
			}
		}
	}
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function availablePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const address = listener.address();
	if (address === null || typeof address === "string") {
		listener.close();
		throw new Error("Could not allocate an IPv4 test port");
	}
	await new Promise<void>((resolve, reject) => {
		listener.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

function startGateway(port: number, dbPath: string): ChildProcess {
	const child = spawn(tsx, [entrypoint], {
		cwd: gatewayDirectory,
		env: {
			PATH: process.env.PATH ?? "",
			PORT: String(port),
			DB_PATH: dbPath,
			ADMIN_TOKEN,
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
			GEMINI_API_KEY: "",
			DEEPSEEK_API_KEY: "",
		},
		stdio: "ignore",
	});
	children.push(child);
	return child;
}

async function waitForHealthy(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (response.ok) return;
		} catch {
			// The child may still be loading TypeScript and SQLite.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Gateway did not become healthy");
}

async function adminRequest(
	port: number,
	path: string,
	method: "GET" | "POST",
	body?: unknown,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: {
			"x-admin-token": ADMIN_TOKEN,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function fiftyResults() {
	const casePrefixes = [
		"zeta",
		"alpha",
		"mu",
		"beta",
		"omega",
		"gamma",
		"delta",
	];
	return Array.from({ length: 50 }, (_, index) => ({
		case_id: `${casePrefixes[index % casePrefixes.length]}-${String(index + 1).padStart(2, "0")}`,
		passed: index % 2 === 0,
		score: 0.5,
		detail_json: { case_number: index + 1 },
		latency_ms: 10 + index,
		cost_micro_usd: 3,
	}));
}

describe("gateway production entrypoint", () => {
	test("checkpoints a fifty-result eval run before SIGTERM and restores it after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "promptgate-signal-test-"));
		directories.push(directory);
		const dbPath = join(directory, "promptgate.db");
		const port = await availablePort();
		const first = startGateway(port, dbPath);
		await waitForHealthy(port);

		const datasetResponse = await adminRequest(
			port,
			"/admin/api/evals/datasets",
			"POST",
			{
				slug: "safety_screening",
				file_path: "packages/evals/datasets/safety_screening.yaml",
				description: "Signal durability test",
			},
		);
		expect(datasetResponse.status).toBe(201);
		const dataset = (await datasetResponse.json()) as { id: number };
		const results = fiftyResults();
		const runResponse = await adminRequest(
			port,
			"/admin/api/evals/runs",
			"POST",
			{
				dataset_id: dataset.id,
				dataset_hash: HASH,
				prompt_id: 1,
				prompt_version: 1,
				prompt_ref: "safety_screen@candidate",
				model: "deepseek-v4-flash",
				git_sha: "abc1234",
				trigger: "manual",
				cases_total: results.length,
				cases_passed: results.filter((result) => result.passed).length,
				score_avg:
					results.reduce((total, result) => total + result.score, 0) /
					results.length,
				cost_micro_usd: results.reduce(
					(total, result) => total + result.cost_micro_usd,
					0,
				),
				duration_ms: results.reduce(
					(total, result) => total + result.latency_ms,
					0,
				),
				results,
			},
		);
		expect(runResponse.status).toBe(201);

		const [exitCode, signal] = await stopAndWait(
			first,
			"SIGTERM",
			"first gateway shutdown",
		);
		expect(signal).toBeNull();
		expect(exitCode).toBe(0);
		if (existsSync(`${dbPath}-wal`)) {
			expect(statSync(`${dbPath}-wal`).size).toBe(0);
		}
		const durableDb = new Database(dbPath, { readonly: true });
		try {
			expect(
				durableDb.prepare("SELECT COUNT(*) AS count FROM eval_runs").get(),
			).toEqual({ count: 1 });
			expect(
				durableDb.prepare("SELECT COUNT(*) AS count FROM eval_results").get(),
			).toEqual({ count: 50 });
		} finally {
			durableDb.close();
		}

		const second = startGateway(port, dbPath);
		await waitForHealthy(port);
		const historyResponse = await adminRequest(
			port,
			"/admin/api/evals/runs?dataset=safety_screening&limit=1",
			"GET",
		);
		expect(historyResponse.status).toBe(200);
		const history = (await historyResponse.json()) as Array<{ id: number }>;
		expect(history).toHaveLength(1);
		const detailResponse = await adminRequest(
			port,
			`/admin/api/evals/runs/${history[0]?.id}`,
			"GET",
		);
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as {
			run: { cases_total: number; cases_passed: number; model: string };
			results: Array<{ case_id: string }>;
		};
		expect(detail).toMatchObject({
			run: {
				cases_total: 50,
				cases_passed: 25,
				model: "deepseek-v4-flash",
			},
			results: expect.arrayContaining([
				expect.objectContaining({ case_id: "alpha-02" }),
			]),
		});
		expect(detail.results).toHaveLength(50);

		const [restartExitCode, restartSignal] = await stopAndWait(
			second,
			"SIGTERM",
			"restarted gateway shutdown",
		);
		expect(restartSignal).toBeNull();
		expect(restartExitCode).toBe(0);
	}, 30_000);
});
