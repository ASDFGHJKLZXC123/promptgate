import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import fastify, { type FastifyInstance } from "fastify";

import { registerAdminRoutes } from "./admin/keys.js";
import { config } from "./config.js";
import { openDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { registerClientAuth } from "./pipeline/auth.js";
import {
	type ProviderAdapterRegistry,
	registerChatCompletionsRoute,
} from "./pipeline/handler.js";
import { registerModelsRoute } from "./pipeline/models.js";
import { createOpenAiAdapter } from "./providers/openai.js";

export interface BuildServerOptions {
	/**
	 * Provider adapters to wire into the pipeline. Defaults to the real
	 * OpenAI adapter (keyed by the optional `OPENAI_API_KEY`); tests inject
	 * fakes here instead so no test ever reaches the network
	 * (IMPLEMENTATION_GUIDE.md §11). Anthropic has no adapter until phase 2.
	 */
	adapters?: ProviderAdapterRegistry;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
	const dbPath = config.DB_PATH;
	const dbDir = dirname(dbPath);

	mkdirSync(dbDir, { recursive: true });

	const db = openDatabase(dbPath);
	migrate(db);

	const adapters: ProviderAdapterRegistry = options.adapters ?? {
		openai: createOpenAiAdapter({ apiKey: config.OPENAI_API_KEY }),
	};

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

	// Protected seam for /v1 routes: every route registered inside this
	// encapsulated plugin runs the client-auth hook first. Each body-bearing
	// route applies the configured /v1 body limit in its route options
	// (IMPLEMENTATION_GUIDE.md §12).
	server.register(
		(v1Server) => {
			registerClientAuth(v1Server, db);
			registerChatCompletionsRoute(v1Server, db, adapters);
			registerModelsRoute(v1Server, db);
		},
		{ prefix: "/v1" },
	);

	server.addHook("onClose", async () => {
		db.close();
	});

	return server;
}
