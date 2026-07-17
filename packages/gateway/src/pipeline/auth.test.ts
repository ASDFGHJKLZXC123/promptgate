import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { type PipelineRequestContext, registerClientAuth } from "./auth.js";

interface OpenAIErrorResponse {
	error: {
		message: string;
		type: string;
		code: string;
	};
}

let tempDbDir: string;
let db: Database.Database;
let server: FastifyInstance;

const PLAINTEXT_KEY = "pg-test-client-key";
const KEY_HASH = createHash("sha256").update(PLAINTEXT_KEY).digest("hex");

const DISABLED_PLAINTEXT_KEY = "pg-test-disabled-key";
const DISABLED_KEY_HASH = createHash("sha256")
	.update(DISABLED_PLAINTEXT_KEY)
	.digest("hex");

beforeEach(() => {
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-auth-test-"));
	db = openDatabase(join(tempDbDir, "promptgate.db"));
	migrate(db);

	db.prepare(
		`INSERT INTO api_keys (name, key_hash, disabled) VALUES (@name, @key_hash, @disabled)`,
	).run({ name: "active-key", key_hash: KEY_HASH, disabled: 0 });
	db.prepare(
		`INSERT INTO api_keys (name, key_hash, disabled) VALUES (@name, @key_hash, @disabled)`,
	).run({ name: "disabled-key", key_hash: DISABLED_KEY_HASH, disabled: 1 });

	// Test-only probe route, registered under the same protected /v1 seam
	// server.ts wires up — this is not the phase-2+ chat route.
	server = fastify();
	server.register(
		(v1Server) => {
			registerClientAuth(v1Server, db);
			v1Server.get(
				"/probe",
				async (request): Promise<PipelineRequestContext> => request.ctx,
			);
		},
		{ prefix: "/v1" },
	);
});

afterEach(async () => {
	await server.close();
	db.close();
	rmSync(tempDbDir, { recursive: true, force: true });
});

function expectInvalidPgKey(body: unknown): void {
	expect(body).toEqual({
		error: {
			message: "Invalid API key.",
			type: "authentication_error",
			code: "invalid_pg_key",
		},
	} satisfies OpenAIErrorResponse);
}

test("rejects a missing Authorization header", async () => {
	const response = await server.inject({ method: "GET", url: "/v1/probe" });

	expect(response.statusCode).toBe(401);
	expectInvalidPgKey(response.json());
});

test("rejects a malformed Authorization header", async () => {
	const noBearerPrefix = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: PLAINTEXT_KEY },
	});
	expect(noBearerPrefix.statusCode).toBe(401);
	expectInvalidPgKey(noBearerPrefix.json());

	const emptyToken = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: "Bearer " },
	});
	expect(emptyToken.statusCode).toBe(401);
	expectInvalidPgKey(emptyToken.json());

	const wrongScheme = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: `Basic ${PLAINTEXT_KEY}` },
	});
	expect(wrongScheme.statusCode).toBe(401);
	expectInvalidPgKey(wrongScheme.json());
});

test("rejects a well-formed but unknown key", async () => {
	const response = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: "Bearer pg-does-not-exist" },
	});

	expect(response.statusCode).toBe(401);
	expectInvalidPgKey(response.json());
});

test("rejects a disabled key", async () => {
	const response = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: `Bearer ${DISABLED_PLAINTEXT_KEY}` },
	});

	expect(response.statusCode).toBe(401);
	expectInvalidPgKey(response.json());
});

test("accepts a valid key and attaches only safe fields to request.ctx", async () => {
	const response = await server.inject({
		method: "GET",
		url: "/v1/probe",
		headers: { authorization: `bearer ${PLAINTEXT_KEY}` },
	});
	const body = response.json() as PipelineRequestContext;

	expect(response.statusCode).toBe(200);
	expect(body).toEqual({
		apiKey: {
			id: 1,
			name: "active-key",
			budgetMicroUsdMonth: 10_000_000,
			rateLimitRpm: 60,
		},
	});

	const responseText = JSON.stringify(body);
	expect(responseText).not.toContain(KEY_HASH);
	expect(responseText).not.toContain(PLAINTEXT_KEY);
});
