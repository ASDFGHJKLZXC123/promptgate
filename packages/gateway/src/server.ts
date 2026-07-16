import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import fastify, { type FastifyInstance } from "fastify";

import { config } from "./config.js";
import { openDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";

export function buildServer(): FastifyInstance {
	const dbPath = config.DB_PATH;
	const dbDir = dirname(dbPath);

	mkdirSync(dbDir, { recursive: true });

	const db = openDatabase(dbPath);
	migrate(db);

	const server = fastify();

	server.get("/healthz", () => ({
		ok: true,
	}));

	server.addHook("onClose", async () => {
		db.close();
	});

	return server;
}
