import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { openDatabase } from "./db/index.js";

const ADMIN_TOKEN = "test-admin-token-000000";

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
let previousAdminToken: string | undefined;
let tempDbDir: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-gateway-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	await vi.resetModules();
});

afterEach(() => {
	if (previousDbPath === undefined) {
		delete process.env.DB_PATH;
	} else {
		process.env.DB_PATH = previousDbPath;
	}

	if (previousAdminToken === undefined) {
		delete process.env.ADMIN_TOKEN;
	} else {
		process.env.ADMIN_TOKEN = previousAdminToken;
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

async function buildServer() {
	const { buildServer } = await import("./server.js");
	return buildServer();
}

test("GET /healthz returns 200 and ok payload", async () => {
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
