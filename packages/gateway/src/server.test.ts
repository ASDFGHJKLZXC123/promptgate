import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const ADMIN_TOKEN = "test-admin-token-000000";

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

test("GET /healthz returns 200 and ok payload", async () => {
	const { buildServer } = await import("./server.js");
	const server = buildServer();
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
