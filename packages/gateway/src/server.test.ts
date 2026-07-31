import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { openDatabase } from "./db/index.js";

const ADMIN_TOKEN = "test-admin-token-000000";
const PROVIDER_KEY_NAMES = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"DEEPSEEK_API_KEY",
] as const;

interface AdminErrorResponse {
	error: {
		message: string;
		type: string;
		code: string;
	};
}

interface AdminApiKey {
	name: string;
	id: number;
	budget_micro_usd_month: number;
	rate_limit_rpm: number;
	disabled: boolean;
	created_at: string;
}

interface AdminApiKeyWithSpend extends AdminApiKey {
	month_to_date_spend_micro_usd: number;
}

let previousDbPath: string | undefined;
let previousDashboardDistPath: string | undefined;
let previousAdminToken: string | undefined;
let previousProviderKeys: Partial<
	Record<(typeof PROVIDER_KEY_NAMES)[number], string>
>;
let tempDbDir: string | undefined;

function restoreEnvironmentVariable(
	name: string,
	value: string | undefined,
): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousDashboardDistPath = process.env.DASHBOARD_DIST_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	delete process.env.DASHBOARD_DIST_PATH;
	previousProviderKeys = {};
	for (const keyName of PROVIDER_KEY_NAMES) {
		const previous = process.env[keyName];
		if (previous !== undefined) {
			previousProviderKeys[keyName] = previous;
		}
		delete process.env[keyName];
	}
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-gateway-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();
});

afterEach(() => {
	restoreEnvironmentVariable("DB_PATH", previousDbPath);
	restoreEnvironmentVariable("DASHBOARD_DIST_PATH", previousDashboardDistPath);
	restoreEnvironmentVariable("ADMIN_TOKEN", previousAdminToken);

	for (const keyName of PROVIDER_KEY_NAMES) {
		const previous = previousProviderKeys[keyName];
		if (previous === undefined) {
			delete process.env[keyName];
		} else {
			process.env[keyName] = previous;
		}
	}

	if (tempDbDir) {
		rmSync(tempDbDir, { recursive: true, force: true });
		tempDbDir = undefined;
	}
});

function adminHeaders(token = ADMIN_TOKEN): Record<string, string> {
	return {
		"x-admin-token": token,
		"content-type": "application/json",
	};
}

function openTestDb(): Database.Database {
	const dbPath = process.env.DB_PATH;
	if (!dbPath) {
		throw new Error("DB_PATH is not configured");
	}
	return openDatabase(dbPath);
}

function createDashboardDist(): string {
	if (!tempDbDir) {
		throw new Error("Temporary test directory is not configured");
	}
	const dashboardDistPath = join(tempDbDir, "dashboard");
	mkdirSync(dashboardDistPath);
	process.env.DASHBOARD_DIST_PATH = dashboardDistPath;
	return dashboardDistPath;
}

async function buildServer() {
	const { buildServer } = await import("./server.js");
	return buildServer();
}

function fakeUpstreamResponse(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-wiring-test",
			object: "chat.completion",
			created: 0,
			model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hello" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

test("boots with all four provider keys absent and returns a healthy response", async () => {
	for (const keyName of PROVIDER_KEY_NAMES) {
		expect(process.env[keyName]).toBeUndefined();
	}

	const server = await buildServer();
	try {
		const response = await server.inject({
			method: "GET",
			url: "/healthz",
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });
	} finally {
		await server.close();
	}
});

test("serves an explicit dashboard root and its JavaScript asset", async () => {
	const dashboardDistPath = createDashboardDist();
	mkdirSync(join(dashboardDistPath, "assets"));
	writeFileSync(join(dashboardDistPath, "index.html"), "<h1>PromptGate</h1>");
	writeFileSync(
		join(dashboardDistPath, "assets", "dashboard.js"),
		"console.log('PromptGate');",
	);

	const server = await buildServer();
	try {
		const [index, asset] = await Promise.all([
			server.inject({ method: "GET", url: "/" }),
			server.inject({ method: "GET", url: "/assets/dashboard.js" }),
		]);

		expect(index.statusCode).toBe(200);
		expect(index.headers["content-type"]).toMatch(/^text\/html/);
		expect(index.body).toBe("<h1>PromptGate</h1>");
		expect(asset.statusCode).toBe(200);
		expect(asset.headers["content-type"]).toMatch(/^application\/javascript/);
		expect(asset.body).toBe("console.log('PromptGate');");
	} finally {
		await server.close();
	}
});

test("dashboard files cannot shadow health or admin API routes", async () => {
	const dashboardDistPath = createDashboardDist();
	mkdirSync(join(dashboardDistPath, "admin", "api"), { recursive: true });
	mkdirSync(join(dashboardDistPath, "v1"), { recursive: true });
	writeFileSync(join(dashboardDistPath, "healthz"), "not a health check");
	writeFileSync(join(dashboardDistPath, "admin", "api", "keys"), "not an API");
	writeFileSync(join(dashboardDistPath, "v1", "models"), "not an API");

	const server = await buildServer();
	try {
		const health = await server.inject({ method: "GET", url: "/healthz" });
		const [admin, models] = await Promise.all([
			server.inject({
				method: "GET",
				url: "/admin/api/keys",
			}),
			server.inject({
				method: "GET",
				url: "/v1/models",
			}),
		]);

		expect(health.statusCode).toBe(200);
		expect(health.json()).toEqual({ ok: true });
		expect(admin.statusCode).toBe(401);
		expect(admin.json()).toMatchObject({
			error: { code: "invalid_admin_token" },
		});
		expect(models.statusCode).toBe(401);
		expect(models.json()).toMatchObject({
			error: { code: "invalid_pg_key" },
		});
	} finally {
		await server.close();
	}
});

test("dashboard serving ignores dotfiles and encoded traversal attempts", async () => {
	const dashboardDistPath = createDashboardDist();
	if (!tempDbDir) {
		throw new Error("Temporary test directory is not configured");
	}
	writeFileSync(join(dashboardDistPath, ".secret"), "DASHBOARD_SECRET");
	writeFileSync(join(tempDbDir, "outside-secret.txt"), "OUTSIDE_SECRET");

	const server = await buildServer();
	try {
		const responses = await Promise.all([
			server.inject({ method: "GET", url: "/.secret" }),
			server.inject({
				method: "GET",
				url: "/%2e%2e/outside-secret.txt",
			}),
			server.inject({
				method: "GET",
				url: "/%252e%252e/outside-secret.txt",
			}),
		]);

		for (const response of responses) {
			expect(response.statusCode).toBe(404);
			expect(response.body).not.toContain("DASHBOARD_SECRET");
			expect(response.body).not.toContain("OUTSIDE_SECRET");
		}
	} finally {
		await server.close();
	}
});

test("uses the package dashboard dist root by default", async () => {
	const { config } = await import("./config.js");

	expect(isAbsolute(config.DASHBOARD_DIST_PATH)).toBe(true);
	expect(
		config.DASHBOARD_DIST_PATH.endsWith(join("packages", "dashboard", "dist")),
	).toBe(true);
});

test("rejects a relative dashboard root override", async () => {
	process.env.DASHBOARD_DIST_PATH = "packages/dashboard/dist";

	await expect(import("./config.js")).rejects.toThrow("DASHBOARD_DIST_PATH");
});

test("admin API rejects missing or incorrect admin token", async () => {
	const server = await buildServer();
	try {
		const missing = await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "admin-missing-token" }),
		});
		const bodyMissing = missing.json() as AdminErrorResponse;

		expect(missing.statusCode).toBe(401);
		expect(bodyMissing).toEqual({
			error: {
				message: "Invalid admin token.",
				type: "authentication_error",
				code: "invalid_admin_token",
			},
		});

		const wrong = await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: {
				...adminHeaders("not-the-token"),
			},
			body: JSON.stringify({ name: "admin-wrong-token" }),
		});
		const bodyWrong = wrong.json() as AdminErrorResponse;

		expect(wrong.statusCode).toBe(401);
		expect(bodyWrong.error.code).toBe("invalid_admin_token");
	} finally {
		await server.close();
	}
});

test("POST /admin/api/keys returns exact key shape and stores only hash", async () => {
	const server = await buildServer();
	const db = openTestDb();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "exact-key-shape" }),
		});
		const body = response.json() as { plaintext_key: string };

		expect(response.statusCode).toBe(200);
		expect(Object.keys(body)).toEqual(["plaintext_key"]);
		expect(body.plaintext_key).toMatch(/^pg-[0-9a-f]{48}$/);

		const row = db
			.prepare("SELECT id, name, key_hash FROM api_keys WHERE name = ?")
			.get("exact-key-shape") as {
			id: number;
			name: string;
			key_hash: string;
		};

		expect(row).toEqual({
			id: 1,
			name: "exact-key-shape",
			key_hash: createHash("sha256").update(body.plaintext_key).digest("hex"),
		});
	} finally {
		db.close();
		await server.close();
	}
});

test("GET /admin/api/keys includes month-to-date spend and never exposes key_hash or plaintext", async () => {
	const server = await buildServer();
	const db = openTestDb();

	try {
		await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "spend-key" }),
		});

		const keyIdRow = db
			.prepare("SELECT id FROM api_keys WHERE name = ?")
			.get("spend-key") as { id: number } | undefined;
		if (!keyIdRow) {
			throw new Error("Expected key row to exist");
		}
		const keyId = keyIdRow.id;

		const insertCurrentMonth = db.prepare(`
			INSERT INTO requests(api_key_id, provider, model, status, cost_micro_usd)
			VALUES (?, ?, ?, ?, ?)
		`);
		const insertPast = db.prepare(
			"INSERT INTO requests(api_key_id, provider, model, status, cost_micro_usd, ts) VALUES (?, ?, ?, ?, ?, ?)",
		);
		insertCurrentMonth.run(keyId, "openai", "gpt-5", "ok", 111);
		insertCurrentMonth.run(keyId, "openai", "gpt-5", "ok", 222);
		insertPast.run(
			keyId,
			"openai",
			"gpt-5",
			"ok",
			999,
			"2000-01-01T00:00:00.000Z",
		);

		const response = await server.inject({
			method: "GET",
			url: "/admin/api/keys",
			headers: adminHeaders(),
		});
		const body = response.json() as AdminApiKeyWithSpend[];
		const key = body.find((entry) => entry.name === "spend-key");

		expect(response.statusCode).toBe(200);
		expect(key?.month_to_date_spend_micro_usd).toBe(333);
		expect("key_hash" in (key ?? {})).toBe(false);
		expect("plaintext_key" in (key ?? {})).toBe(false);
	} finally {
		db.close();
		await server.close();
	}
});

test("PATCH /admin/api/keys/:id updates budget, rate limit, and disabled", async () => {
	const server = await buildServer();
	const db = openTestDb();

	try {
		await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "patchable" }),
		});

		const keyIdRow = db
			.prepare("SELECT id FROM api_keys WHERE name = ?")
			.get("patchable") as { id: number } | undefined;
		if (!keyIdRow) {
			throw new Error("Expected key row to exist");
		}

		const patch = await server.inject({
			method: "PATCH",
			url: `/admin/api/keys/${keyIdRow.id}`,
			headers: adminHeaders(),
			body: JSON.stringify({
				budget_micro_usd_month: 200,
				rate_limit_rpm: 25,
				disabled: true,
			}),
		});
		const body = patch.json() as AdminApiKey;

		expect(patch.statusCode).toBe(200);
		expect(body.budget_micro_usd_month).toBe(200);
		expect(body.rate_limit_rpm).toBe(25);
		expect(body.disabled).toBe(true);
	} finally {
		db.close();
		await server.close();
	}
});

test("PATCH /admin/api/keys/:id validates request body and id", async () => {
	const server = await buildServer();
	const db = openTestDb();

	try {
		await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "validation-key" }),
		});

		const invalidPatch = await server.inject({
			method: "PATCH",
			url: "/admin/api/keys/1",
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const invalidBody = invalidPatch.json() as AdminErrorResponse;

		expect(invalidPatch.statusCode).toBe(400);
		expect(invalidBody.error.code).toBe("invalid_request_error");

		const invalidId = await server.inject({
			method: "PATCH",
			url: "/admin/api/keys/not-a-number",
			headers: adminHeaders(),
			body: JSON.stringify({ disabled: false }),
		});
		const invalidIdBody = invalidId.json() as AdminErrorResponse;

		expect(invalidId.statusCode).toBe(400);
		expect(invalidIdBody.error.code).toBe("invalid_request_error");

		const invalidBoolean = await server.inject({
			method: "PATCH",
			url: "/admin/api/keys/1",
			headers: adminHeaders(),
			body: JSON.stringify({ disabled: "false" }),
		});

		expect(invalidBoolean.statusCode).toBe(400);
	} finally {
		db.close();
		await server.close();
	}
});

test("POST /admin/api/keys rejects duplicate names in the OpenAI error envelope", async () => {
	const server = await buildServer();

	try {
		const request = {
			method: "POST" as const,
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "duplicate" }),
		};
		const first = await server.inject(request);
		const duplicate = await server.inject(request);

		expect(first.statusCode).toBe(200);
		expect(duplicate.statusCode).toBe(409);
		expect(duplicate.json()).toEqual({
			error: {
				message: "An API key with that name already exists.",
				type: "invalid_request_error",
				code: "key_name_conflict",
			},
		});
	} finally {
		await server.close();
	}
});

test("POST /admin/api/keys wraps malformed JSON in the OpenAI error envelope", async () => {
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			payload: '{"name":',
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: {
				message: "Invalid request payload.",
				type: "invalid_request_error",
				code: "invalid_request_error",
			},
		});
	} finally {
		await server.close();
	}
});

test("default adapter wiring selects Gemini and DeepSeek adapters, calling only a stubbed global fetch (BUILD_PLAYBOOK.md phase 1 step 12)", async () => {
	process.env.GEMINI_API_KEY = "test-gemini-key";
	process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
	await vi.resetModules();

	const fetchMock = vi.fn(
		async (url: string | URL | Request, _init?: RequestInit) => {
			const href =
				typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (
				href ===
				"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
			) {
				return fakeUpstreamResponse("gemini-2.5-flash");
			}
			if (href === "https://api.deepseek.com/v1/chat/completions") {
				return fakeUpstreamResponse("deepseek-v4-flash");
			}
			throw new Error(`unexpected fetch to ${href}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);

	const server = await buildServer();
	const db = openTestDb();

	try {
		db.prepare(
			`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
			 VALUES ('gemini', 'gemini-2.5-flash', 300000, 30000, 2500000, '2020-01-01')`,
		).run();
		db.prepare(
			`INSERT INTO model_pricing (provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
			 VALUES ('deepseek', 'deepseek-v4-flash', 140000, 280000, '2020-01-01')`,
		).run();

		const keyResponse = await server.inject({
			method: "POST",
			url: "/admin/api/keys",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "wiring-test-key" }),
		});
		const { plaintext_key } = keyResponse.json() as { plaintext_key: string };
		const clientHeaders = {
			authorization: `Bearer ${plaintext_key}`,
			"content-type": "application/json",
		};

		const geminiResponse = await server.inject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: clientHeaders,
			body: JSON.stringify({
				model: "gemini-2.5-flash",
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const deepseekResponse = await server.inject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: clientHeaders,
			body: JSON.stringify({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(geminiResponse.statusCode).toBe(200);
		expect(deepseekResponse.statusCode).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const [geminiUrl, geminiInit] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(geminiUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
		);
		expect(geminiInit.headers).toMatchObject({
			authorization: "Bearer test-gemini-key",
		});

		const [deepseekUrl, deepseekInit] = fetchMock.mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(deepseekUrl).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(deepseekInit.headers).toMatchObject({
			authorization: "Bearer test-deepseek-key",
		});
	} finally {
		db.close();
		await server.close();
		vi.unstubAllGlobals();
	}
});

test("PATCH /admin/api/keys/:id returns not found for missing keys", async () => {
	const server = await buildServer();
	const db = openTestDb();

	try {
		const patch = await server.inject({
			method: "PATCH",
			url: "/admin/api/keys/99999",
			headers: adminHeaders(),
			body: JSON.stringify({ disabled: false }),
		});
		const body = patch.json() as AdminErrorResponse;

		expect(patch.statusCode).toBe(404);
		expect(body).toEqual({
			error: {
				message: "API key not found.",
				type: "invalid_request_error",
				code: "not_found",
			},
		});
	} finally {
		db.close();
		await server.close();
	}
});
