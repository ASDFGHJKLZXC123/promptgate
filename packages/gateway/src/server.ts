import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import fastify, { type FastifyInstance } from "fastify";

import { registerAdminRoutes } from "./admin/keys.js";
import { config } from "./config.js";
import { openDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { registerClientAuth } from "./pipeline/auth.js";

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

	server.register(
		(adminServer) => {
			registerAdminRoutes(adminServer, db);
		},
		{ prefix: "/admin" },
	);

	// Protected seam for future /v1 routes (phase 1 steps 5-7 and beyond):
	// every route registered inside this encapsulated plugin runs the
	// client-auth hook first.
	server.register(
		(v1Server) => {
			registerClientAuth(v1Server, db);
		},
		{ prefix: "/v1" },
	);

	server.addHook("onClose", async () => {
		db.close();
	});

	return server;
}
