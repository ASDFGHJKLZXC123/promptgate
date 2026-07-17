import { randomUUID } from "node:crypto";
import { ChatRequestSchema, type ChatResponse } from "@promptgate/shared";
import type Database from "better-sqlite3";
import type {
	FastifyError,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";

import { config } from "../config.js";
import { sendError } from "../errors.js";
import {
	ProviderConfigError,
	ProviderError,
} from "../providers/provider-error.js";
import { resolveProvider } from "../providers/routes.js";
import type { ProviderAdapter, ProviderName } from "../providers/types.js";
import { meterUsage } from "./meter.js";
import {
	insertRequestLog,
	type RequestLogProvider,
	type RequestLogStatus,
} from "./requests.dao.js";

/** Adapters actually wired up for this process — phase 1 only populates `openai`. */
export type ProviderAdapterRegistry = Partial<
	Record<ProviderName, ProviderAdapter>
>;

/**
 * Accumulated across the pipeline chain as each step resolves, then written
 * to `requests` in the route-level `onResponse` hook (BUILD_PLAYBOOK.md
 * phase 1 step 7) — never inline in the handler, so logging can never add
 * response latency and a logging failure can never touch the sent response.
 */
interface PendingRequestLog {
	requestId: string;
	apiKeyId: number;
	provider: RequestLogProvider;
	model: string;
	feature?: string | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costMicroUsd?: number | null;
	costEstimated: boolean;
	status: RequestLogStatus;
	errorCode?: string | null;
	startedAtMs: number;
}

declare module "fastify" {
	interface FastifyRequest {
		/** Set at pipeline entry, read by the route-level onResponse hook. */
		pgRequestLog?: PendingRequestLog;
	}
}

function elapsedMs(startedAtMs: number): number {
	return Math.round(performance.now() - startedAtMs);
}

/**
 * Runs after the enclosing authentication hook but before body parsing. This
 * gives authenticated parse/body-limit failures the same UUID/header and
 * post-response audit path as handler-level outcomes.
 */
function initializeRequestLog(
	request: FastifyRequest,
	reply: FastifyReply,
): void {
	const requestId = randomUUID();
	request.pgRequestLog = {
		requestId,
		apiKeyId: request.ctx.apiKey.id,
		provider: "unknown",
		model: "unknown",
		costEstimated: false,
		status: "rejected_validation",
		startedAtMs: performance.now(),
	};
	reply.header("x-pg-request-id", requestId);
	reply.header("x-pg-cache", "miss");
}

function requireRequestLog(request: FastifyRequest): PendingRequestLog {
	if (!request.pgRequestLog) {
		throw new Error("PromptGate request log was not initialized.");
	}
	return request.pgRequestLog;
}

/**
 * Writes the `requests` row for this exchange after the response has
 * already been sent. Any DAO failure is caught and logged — it must never
 * surface to the client or alter what was already sent.
 */
async function logRequest(
	db: Database.Database,
	request: FastifyRequest,
): Promise<void> {
	const log = request.pgRequestLog;
	if (!log) {
		return;
	}

	try {
		insertRequestLog(db, {
			requestId: log.requestId,
			apiKeyId: log.apiKeyId,
			provider: log.provider,
			model: log.model,
			feature: log.feature,
			cacheHit: false,
			streamed: false,
			inputTokens: log.inputTokens,
			outputTokens: log.outputTokens,
			costMicroUsd: log.costMicroUsd,
			costEstimated: log.costEstimated,
			totalMs: elapsedMs(log.startedAtMs),
			status: log.status,
			errorCode: log.errorCode,
		});
	} catch (error) {
		const failureType = error instanceof Error ? error.name : "UnknownError";
		request.log.error(
			{ failureType, requestId: log.requestId },
			"Failed to persist requests row",
		);
	}
}

/** Maps a thrown adapter error to the shared OpenAI `provider_error` envelope (§3.6), never echoing upstream bodies. */
function sendProviderError(
	reply: FastifyReply,
	log: PendingRequestLog,
	provider: ProviderName,
	error: unknown,
): FastifyReply {
	log.status = "provider_error";
	log.errorCode = "provider_error";

	if (error instanceof ProviderConfigError) {
		return sendError(
			reply,
			503,
			`The ${provider} provider is not configured.`,
			"provider_error",
			"server_error",
		);
	}

	if (error instanceof ProviderError) {
		const status =
			error.status >= 400 && error.status < 600 ? error.status : 502;
		return sendError(
			reply,
			status,
			`Upstream ${provider} request failed with status ${error.status}.`,
			"provider_error",
			"server_error",
		);
	}

	return sendError(
		reply,
		502,
		`Upstream ${provider} request failed.`,
		"provider_error",
		"server_error",
	);
}

/** Maps Fastify body/parser and unexpected route failures to safe OpenAI envelopes. */
function sendRouteError(
	error: FastifyError,
	request: FastifyRequest,
	reply: FastifyReply,
): FastifyReply {
	const statusCode =
		typeof error.statusCode === "number" &&
		error.statusCode >= 400 &&
		error.statusCode < 600
			? error.statusCode
			: 500;
	const isClientError = statusCode < 500;
	const log = request.pgRequestLog;

	if (log) {
		log.status = isClientError ? "rejected_validation" : "provider_error";
		log.errorCode = isClientError ? "invalid_request_error" : "provider_error";
	}

	if (!isClientError) {
		request.log.error(
			{ code: error.code, requestId: log?.requestId },
			"Unhandled chat-completions route failure",
		);
	}

	return sendError(
		reply,
		statusCode,
		statusCode === 413
			? "Request body is too large."
			: isClientError
				? "Invalid request body."
				: "The gateway could not complete the request.",
		isClientError ? "invalid_request_error" : "provider_error",
		isClientError ? "invalid_request_error" : "server_error",
	);
}

/**
 * Registers `POST /v1/chat/completions` (BUILD_PLAYBOOK.md phase 1 step 7)
 * as an explicit, testable chain: the client-auth hook already ran on the
 * enclosing `/v1` plugin (`auth.ts`) — this route only adds body validation,
 * provider resolution, the adapter call, metering, and the reply. Logging is
 * a route-level `onResponse` hook so it can never add response latency.
 */
export function registerChatCompletionsRoute(
	server: FastifyInstance,
	db: Database.Database,
	adapters: ProviderAdapterRegistry,
): void {
	server.decorateRequest("pgRequestLog");
	server.post(
		"/chat/completions",
		{
			bodyLimit: config.BODY_LIMIT_BYTES,
			onRequest: async (request, reply) => {
				initializeRequestLog(request, reply);
			},
			errorHandler: sendRouteError,
			onResponse: async (request) => {
				await logRequest(db, request);
			},
		},
		async (request, reply) => {
			const log = requireRequestLog(request);

			const parsed = ChatRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				log.errorCode = "invalid_request_error";
				return sendError(
					reply,
					400,
					"Invalid request body.",
					"invalid_request_error",
				);
			}
			const body = parsed.data;
			log.model = body.model;
			log.feature = body.pg_feature ?? null;

			if (body.stream === true) {
				log.status = "rejected_stream_unsupported";
				log.errorCode = "invalid_request_error";
				return sendError(
					reply,
					400,
					"Streaming is not supported until Phase 2.",
					"invalid_request_error",
				);
			}

			const routing = resolveProvider(db, body.model);
			if (!routing.ok) {
				log.status = "rejected_unknown_model";
				log.errorCode = "unknown_model";
				return reply.code(routing.statusCode).send(routing.error);
			}
			log.provider = routing.provider;

			const adapter = adapters[routing.provider];
			if (!adapter) {
				log.status = "rejected_provider_unavailable";
				log.errorCode = "provider_error";
				return sendError(
					reply,
					501,
					`The ${routing.provider} provider is not implemented yet.`,
					"provider_error",
					"server_error",
				);
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => {
				controller.abort(new Error("Upstream request timed out"));
			}, config.UPSTREAM_TIMEOUT_MS);

			let response: ChatResponse;
			try {
				response = await adapter.complete(body, controller.signal);
			} catch (error) {
				if (controller.signal.aborted) {
					log.status = "provider_error";
					log.errorCode = "provider_error";
					return sendError(
						reply,
						504,
						`Upstream ${routing.provider} request timed out.`,
						"provider_error",
						"server_error",
					);
				}
				return sendProviderError(reply, log, routing.provider, error);
			} finally {
				clearTimeout(timeout);
			}

			const meter = meterUsage(db, body.model, body, response);
			log.inputTokens = meter.inputTokens;
			log.outputTokens = meter.outputTokens;
			log.costMicroUsd = meter.costMicroUsd;
			log.costEstimated = meter.costEstimated;
			log.status = "ok";

			reply.header(
				"x-pg-cost-usd",
				(meter.costMicroUsd / 1_000_000).toFixed(6),
			);
			return reply.send(response);
		},
	);
}
