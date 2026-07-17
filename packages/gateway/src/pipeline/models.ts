import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { listCurrentModels } from "../providers/models.dao.js";

interface ModelObject {
	id: string;
	object: "model";
	created: number;
	owned_by: string;
}

interface ModelsListResponse {
	object: "list";
	data: ModelObject[];
}

/**
 * Registers `GET /v1/models` (BUILD_PLAYBOOK.md phase 1 step 8) inside the
 * protected `/v1` plugin — the client-auth hook already installed on the
 * enclosing plugin (`auth.ts`) covers this route too, same as
 * `registerChatCompletionsRoute`. Sourced entirely from `model_pricing` via
 * the DAO (IMPLEMENTATION_GUIDE.md §5.1); never calls a provider.
 */
export function registerModelsRoute(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.get("/models", async (_request, reply) => {
		const rows = listCurrentModels(db);
		const response: ModelsListResponse = {
			object: "list",
			data: rows.map((row) => ({
				id: row.model,
				object: "model",
				created: row.created,
				owned_by: row.provider,
			})),
		};
		return reply.send(response);
	});
}
