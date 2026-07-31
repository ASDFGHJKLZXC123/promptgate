import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import fastifyStatic from "@fastify/static";
import fastify, { type FastifyInstance } from "fastify";
import { registerEvalAdminRoutes } from "./admin/evals.js";
import { registerAdminRoutes } from "./admin/keys.js";
import { registerAdminMetricsRoutes } from "./admin/metrics.js";
import { registerPromptAdminRoutes } from "./admin/prompts.js";
import { config } from "./config.js";
import { openDatabase } from "./db/index.js";
import { closeDatabaseAfterWalCheckpoint } from "./db/lifecycle.js";
import { migrate } from "./db/migrate.js";
import { registerClientAuth } from "./pipeline/auth.js";
import { sumCurrentMonthSettledSpend } from "./pipeline/budget.dao.js";
import { BudgetGuard, type BudgetMemoClock } from "./pipeline/budget.js";
import { deleteExpiredCacheEntries } from "./pipeline/cache.dao.js";
import {
	type Clock,
	type ProviderAdapterRegistry,
	registerChatCompletionsRoute,
} from "./pipeline/handler.js";
import { registerModelsRoute } from "./pipeline/models.js";
import { type RateLimitClock, RateLimiter } from "./pipeline/ratelimit.js";
import { registerRequestUsageRoute } from "./pipeline/usage.js";
import { createAnthropicAdapter } from "./providers/anthropic.js";
import { createDeepSeekAdapter } from "./providers/deepseek.js";
import { createGeminiAdapter } from "./providers/gemini.js";
import { createOpenAiAdapter } from "./providers/openai.js";

export interface BuildServerOptions {
	/**
	 * Provider adapters to wire into the pipeline. Defaults to the real
	 * Anthropic, OpenAI, Gemini, and DeepSeek adapters (each keyed by its
	 * optional `*_API_KEY`); tests inject fakes here instead so no test ever
	 * reaches the network (IMPLEMENTATION_GUIDE.md §11). Anthropic joined the
	 * default wiring in phase 2 step 2 (non-streaming).
	 */
	adapters?: ProviderAdapterRegistry;
	/**
	 * Monotonic millisecond clock for request latency, injected so tests can
	 * drive deterministic `first_token_ms`/`total_ms` (BUILD_PLAYBOOK.md phase 2
	 * step 3). Defaults to `performance.now()`.
	 */
	now?: Clock;
	/**
	 * Separate monotonic clock for rate-limit tests. It intentionally does not
	 * share `now`, whose scripted values drive request-latency assertions.
	 */
	rateLimitNow?: RateLimitClock;
	/** Separate monotonic clock for the short-lived settled-spend memo. */
	budgetNow?: BudgetMemoClock;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
	const dbPath = config.DB_PATH;
	const dbDir = dirname(dbPath);

	mkdirSync(dbDir, { recursive: true });

	const db = openDatabase(dbPath);
	migrate(db);
	const cacheSweep = setInterval(
		() => {
			try {
				deleteExpiredCacheEntries(db);
			} catch {
				// Cache cleanup is opportunistic; an operational failure must not take
				// down the gateway or interfere with otherwise valid requests.
			}
		},
		60 * 60 * 1_000,
	);
	cacheSweep.unref();

	const adapters: ProviderAdapterRegistry = options.adapters ?? {
		anthropic: createAnthropicAdapter({
			apiKey: config.ANTHROPIC_API_KEY,
			defaultMaxTokens: config.DEFAULT_MAX_TOKENS,
		}),
		openai: createOpenAiAdapter({ apiKey: config.OPENAI_API_KEY }),
		gemini: createGeminiAdapter({ apiKey: config.GEMINI_API_KEY }),
		deepseek: createDeepSeekAdapter({ apiKey: config.DEEPSEEK_API_KEY }),
	};
	const rateLimiter = new RateLimiter(options.rateLimitNow);
	const budgetGuard = new BudgetGuard({
		settledSpend: (keyId) => sumCurrentMonthSettledSpend(db, keyId),
		now: options.budgetNow,
	});

	const server = fastify();

	server.get("/healthz", () => ({
		ok: true,
	}));

	server.register(
		(adminServer) => {
			registerAdminRoutes(adminServer, db, budgetGuard);
			registerAdminMetricsRoutes(adminServer, db);
			registerPromptAdminRoutes(adminServer, db);
			registerEvalAdminRoutes(adminServer, db);
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
			registerChatCompletionsRoute(
				v1Server,
				db,
				adapters,
				options.now,
				rateLimiter,
				budgetGuard,
			);
			registerModelsRoute(v1Server, db);
			registerRequestUsageRoute(v1Server, db);
		},
		{ prefix: "/v1" },
	);

	// Register after the API routes so their exact paths always take precedence
	// over dashboard files with the same names.
	server.register(fastifyStatic, {
		root: config.DASHBOARD_DIST_PATH,
		prefix: "/",
		dotfiles: "ignore",
	});

	server.addHook("onClose", async () => {
		clearInterval(cacheSweep);
		closeDatabaseAfterWalCheckpoint(db);
	});

	return server;
}
