import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openDatabase } from "../db/index.js";

const ADMIN_TOKEN = "prompt-admin-test-token";

interface ErrorResponse {
	error: { message: string; type: string; code: string };
}

interface PromptResponse {
	id: number;
	slug: string;
	description: string | null;
}

interface PromptSummaryResponse extends PromptResponse {
	created_at: string;
	latest_version: number | null;
	labels: Array<{ label: string; version: number }>;
}

interface VersionResponse {
	prompt_id: number;
	version: number;
	messages_json: string;
	variables_json: string;
	notes: string | null;
}

let tempDbDir: string | undefined;
let previousDbPath: string | undefined;
let previousAdminToken: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.DB_PATH;
	previousAdminToken = process.env.ADMIN_TOKEN;
	tempDbDir = mkdtempSync(join(tmpdir(), "promptgate-admin-prompts-test-"));
	process.env.DB_PATH = join(tempDbDir, "promptgate.db");
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
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
	return { "x-admin-token": token, "content-type": "application/json" };
}

async function buildTestServer() {
	const { buildServer } = await import("../server.js");
	return buildServer();
}

function openTestDb(): Database.Database {
	if (!process.env.DB_PATH) {
		throw new Error("Expected test database path");
	}
	return openDatabase(process.env.DB_PATH);
}

const versionBody = {
	messages_json: [{ role: "system", content: "Hello {{name}}" }],
	variables_json: [
		{ name: "name", required: true, description: "Recipient name" },
	],
	notes: "Initial version",
};

async function createPrompt(
	server: Awaited<ReturnType<typeof buildTestServer>>,
	slug: string,
) {
	return server.inject({
		method: "POST",
		url: "/admin/api/prompts",
		headers: adminHeaders(),
		body: JSON.stringify({ slug, description: `${slug} description` }),
	});
}

describe("admin prompt registry API", () => {
	test("inherits admin authentication for prompt routes", async () => {
		const server = await buildTestServer();
		try {
			const missing = await server.inject({
				method: "GET",
				url: "/admin/api/prompts",
			});
			const wrong = await server.inject({
				method: "POST",
				url: "/admin/api/prompts",
				headers: adminHeaders("wrong-token"),
				body: JSON.stringify({ slug: "greet" }),
			});

			expect(missing.statusCode).toBe(401);
			expect(missing.json()).toMatchObject({
				error: { code: "invalid_admin_token", type: "authentication_error" },
			});
			expect(wrong.statusCode).toBe(401);
			expect(wrong.json()).toMatchObject({
				error: { code: "invalid_admin_token" },
			});
		} finally {
			await server.close();
		}
	});

	test("creates, lists, and rejects duplicate prompts", async () => {
		const server = await buildTestServer();
		try {
			const created = await createPrompt(server, "zebra");
			const second = await createPrompt(server, "alpha");
			const duplicate = await createPrompt(server, "zebra");
			const listed = await server.inject({
				method: "GET",
				url: "/admin/api/prompts",
				headers: adminHeaders(),
			});

			expect(created.statusCode).toBe(200);
			expect(created.json()).toMatchObject({
				slug: "zebra",
				description: "zebra description",
			});
			expect(second.statusCode).toBe(200);
			expect(duplicate.statusCode).toBe(409);
			expect(duplicate.json()).toEqual({
				error: {
					message: "A prompt with that slug already exists.",
					type: "invalid_request_error",
					code: "prompt_slug_conflict",
				},
			});
			const prompts = listed.json() as PromptSummaryResponse[];
			expect(listed.statusCode).toBe(200);
			expect(prompts.map((prompt) => prompt.slug)).toEqual(["alpha", "zebra"]);
			expect(prompts[0]).toMatchObject({ latest_version: null, labels: [] });
			expect(prompts[0]?.created_at).toEqual(expect.any(String));
		} finally {
			await server.close();
		}
	});

	test("creates immutable incrementing versions after strict OpenAI-message and variable validation", async () => {
		const server = await buildTestServer();
		try {
			await createPrompt(server, "greet");
			const first = await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify(versionBody),
			});
			const second = await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify({ ...versionBody, notes: "Second version" }),
			});
			const badRole = await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify({
					...versionBody,
					messages_json: [{ role: "narrator", content: "Nope" }],
				}),
			});
			const duplicateVariable = await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify({
					...versionBody,
					variables_json: [
						{ name: "name", required: true },
						{ name: "name", required: false },
					],
				}),
			});

			expect(first.statusCode).toBe(200);
			expect((first.json() as VersionResponse).version).toBe(1);
			expect(second.statusCode).toBe(200);
			expect((second.json() as VersionResponse).version).toBe(2);
			expect(badRole.statusCode).toBe(400);
			expect((badRole.json() as ErrorResponse).error.code).toBe(
				"invalid_request_error",
			);
			expect(duplicateVariable.statusCode).toBe(400);
		} finally {
			await server.close();
		}
	});

	test("deploys and rolls a label back while preserving label history", async () => {
		const server = await buildTestServer();
		const db = openTestDb();
		try {
			const created = await createPrompt(server, "greet");
			const prompt = created.json() as PromptResponse;
			await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify(versionBody),
			});
			await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify({ ...versionBody, notes: "v2" }),
			});
			const deploy = await server.inject({
				method: "PUT",
				url: "/admin/api/prompts/greet/labels/prod",
				headers: adminHeaders(),
				body: JSON.stringify({ version: 2 }),
			});
			const rollback = await server.inject({
				method: "PUT",
				url: "/admin/api/prompts/greet/labels/prod",
				headers: adminHeaders(),
				body: JSON.stringify({ version: 1 }),
			});
			const listed = await server.inject({
				method: "GET",
				url: "/admin/api/prompts",
				headers: adminHeaders(),
			});

			expect(deploy.json()).toEqual({
				prompt_id: prompt.id,
				label: "prod",
				from_version: null,
				to_version: 2,
			});
			expect(rollback.json()).toEqual({
				prompt_id: prompt.id,
				label: "prod",
				from_version: 2,
				to_version: 1,
			});
			expect(listed.json()).toEqual([
				expect.objectContaining({
					id: prompt.id,
					slug: "greet",
					latest_version: 2,
					labels: [{ label: "prod", version: 1 }],
				}),
			]);
			expect(
				db
					.prepare(
						"SELECT from_version, to_version FROM label_history WHERE prompt_id = ? ORDER BY id",
					)
					.all(prompt.id),
			).toEqual([
				{ from_version: null, to_version: 2 },
				{ from_version: 2, to_version: 1 },
			]);
		} finally {
			db.close();
			await server.close();
		}
	});

	test("uses stable, sorted pretty JSON in a plain-text unified diff", async () => {
		const server = await buildTestServer();
		try {
			await createPrompt(server, "sorted");
			for (const messages_json of [
				[
					{
						role: "system",
						content: "Hello",
						metadata: { zebra: 1, alpha: 2 },
					},
				],
				[
					{
						metadata: { alpha: 3, zebra: 1 },
						content: "Goodbye",
						role: "system",
					},
				],
				[
					{
						role: "system",
						content: "Goodbye",
						metadata: { zebra: 1, alpha: 3 },
					},
				],
			]) {
				const response = await server.inject({
					method: "POST",
					url: "/admin/api/prompts/sorted/versions",
					headers: adminHeaders(),
					body: JSON.stringify({ ...versionBody, messages_json }),
				});
				expect(response.statusCode).toBe(200);
			}
			const diff = await server.inject({
				method: "GET",
				url: "/admin/api/prompts/sorted/versions/1/diff/2",
				headers: adminHeaders(),
			});

			expect(diff.statusCode).toBe(200);
			expect(diff.headers["content-type"]).toContain("text/plain");
			expect(diff.body).toContain("--- sorted@1.messages.json");
			expect(diff.body).toContain("+++ sorted@2.messages.json");
			expect(diff.body).toContain('-    "content": "Hello",');
			expect(diff.body).toContain('+    "content": "Goodbye",');
			expect(diff.body).toContain('-      "alpha": 2,');
			expect(diff.body).toContain('+      "alpha": 3,');
			expect(diff.body.indexOf('"alpha"')).toBeLessThan(
				diff.body.indexOf('"zebra"'),
			);

			const reorderedOnly = await server.inject({
				method: "GET",
				url: "/admin/api/prompts/sorted/versions/2/diff/3",
				headers: adminHeaders(),
			});
			expect(reorderedOnly.statusCode).toBe(200);
			expect(reorderedOnly.body).not.toContain("@@");
		} finally {
			await server.close();
		}
	});

	test("returns safe 404s and 400s for missing resources and malformed input", async () => {
		const server = await buildTestServer();
		try {
			const missingPrompt = await server.inject({
				method: "POST",
				url: "/admin/api/prompts/missing/versions",
				headers: adminHeaders(),
				body: JSON.stringify(versionBody),
			});
			const created = await createPrompt(server, "greet");
			expect(created.statusCode).toBe(200);
			await server.inject({
				method: "POST",
				url: "/admin/api/prompts/greet/versions",
				headers: adminHeaders(),
				body: JSON.stringify(versionBody),
			});
			const missingVersion = await server.inject({
				method: "PUT",
				url: "/admin/api/prompts/greet/labels/prod",
				headers: adminHeaders(),
				body: JSON.stringify({ version: 99 }),
			});
			const missingDiffBefore = await server.inject({
				method: "GET",
				url: "/admin/api/prompts/greet/versions/99/diff/1",
				headers: adminHeaders(),
			});
			const missingDiffAfter = await server.inject({
				method: "GET",
				url: "/admin/api/prompts/greet/versions/1/diff/99",
				headers: adminHeaders(),
			});
			const malformed = await server.inject({
				method: "POST",
				url: "/admin/api/prompts",
				headers: adminHeaders(),
				payload: '{"slug":',
			});
			const unknownField = await server.inject({
				method: "POST",
				url: "/admin/api/prompts",
				headers: adminHeaders(),
				body: JSON.stringify({ slug: "strict", unexpected: true }),
			});
			const invalidVersionParam = await server.inject({
				method: "GET",
				url: "/admin/api/prompts/greet/versions/nope/diff/1",
				headers: adminHeaders(),
			});

			expect(missingPrompt.statusCode).toBe(404);
			expect((missingPrompt.json() as ErrorResponse).error.code).toBe(
				"prompt_not_found",
			);
			expect(missingVersion.statusCode).toBe(404);
			expect((missingVersion.json() as ErrorResponse).error.code).toBe(
				"prompt_version_not_found",
			);
			for (const response of [missingDiffBefore, missingDiffAfter]) {
				expect(response.statusCode).toBe(404);
				expect((response.json() as ErrorResponse).error.code).toBe(
					"prompt_version_not_found",
				);
			}
			for (const response of [malformed, unknownField, invalidVersionParam]) {
				expect(response.statusCode).toBe(400);
				expect((response.json() as ErrorResponse).error).toEqual({
					message: "Invalid request payload.",
					type: "invalid_request_error",
					code: "invalid_request_error",
				});
			}
		} finally {
			await server.close();
		}
	});
});
