import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
	type ChatRequest,
	ChatRequestSchema,
	type ChatResponse,
	type ChatUsage,
} from "@promptgate/shared";
import type Database from "better-sqlite3";
import type {
	FastifyError,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";

import { config } from "../config.js";
import { sendError } from "../errors.js";
import { readStreamChunk } from "../providers/openai-compatible-stream.js";
import {
	ProviderConfigError,
	ProviderError,
	ProviderRequestError,
} from "../providers/provider-error.js";
import { resolveProvider } from "../providers/routes.js";
import { frameSseData } from "../providers/sse-parse.js";
import type {
	ProviderAdapter,
	ProviderName,
	SseChunk,
} from "../providers/types.js";
import { type CacheHit, findAndRecordCacheHit } from "./cache.dao.js";
import { cacheKeyOf } from "./cache-key.js";
import { meterAbortedStream, meterStreamUsage, meterUsage } from "./meter.js";
import {
	insertRequestLog,
	type RequestLogProvider,
	type RequestLogStatus,
} from "./requests.dao.js";

/** Adapters actually wired for this process; Anthropic joined in phase 2 step 2 (non-streaming). */
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
	cacheHit: boolean;
	streamed: boolean;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costMicroUsd?: number | null;
	costEstimated: boolean;
	firstTokenMs?: number | null;
	status: RequestLogStatus;
	errorCode?: string | null;
	startedAtMs: number;
	loggingStarted: boolean;
}

declare module "fastify" {
	interface FastifyRequest {
		/** Set at pipeline entry, read by the route-level onResponse hook. */
		pgRequestLog?: PendingRequestLog;
	}
}

/**
 * Monotonic millisecond clock. Injectable via `buildServer({ now })` so tests
 * can drive deterministic latency (BUILD_PLAYBOOK.md phase 2 step 3, blocker
 * 3); production uses `performance.now()`, which is monotonic and immune to
 * wall-clock adjustments. Only integer milliseconds are ever persisted.
 */
export type Clock = () => number;
const defaultClock: Clock = () => performance.now();

function elapsedMs(startedAtMs: number, now: Clock): number {
	return Math.round(now() - startedAtMs);
}

/**
 * Runs after the enclosing authentication hook but before body parsing. This
 * gives authenticated parse/body-limit failures the same UUID/header and
 * post-response audit path as handler-level outcomes.
 */
function initializeRequestLog(
	request: FastifyRequest,
	reply: FastifyReply,
	now: Clock,
): void {
	const requestId = randomUUID();
	request.pgRequestLog = {
		requestId,
		apiKeyId: request.ctx.apiKey.id,
		provider: "unknown",
		model: "unknown",
		cacheHit: false,
		streamed: false,
		costEstimated: false,
		status: "rejected_validation",
		startedAtMs: now(),
		loggingStarted: false,
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
	now: Clock,
): Promise<void> {
	const log = request.pgRequestLog;
	if (!log || log.loggingStarted) {
		return;
	}
	// A disconnected socket does not reliably run Fastify's onResponse hook.
	// Mark before insertion so an onResponse race cannot duplicate the row.
	log.loggingStarted = true;

	let totalMs = elapsedMs(log.startedAtMs, now);
	if (log.firstTokenMs != null && totalMs <= log.firstTokenMs) {
		// Guarantee the Phase 2 Verify invariant first_token_ms < total_ms even
		// when both observations round to the same integer millisecond. This is an
		// integer-ms floor, not a claim of sub-ms wall-clock precision (blocker 3).
		totalMs = log.firstTokenMs + 1;
	}

	try {
		insertRequestLog(db, {
			requestId: log.requestId,
			apiKeyId: log.apiKeyId,
			provider: log.provider,
			model: log.model,
			feature: log.feature,
			cacheHit: log.cacheHit,
			streamed: log.streamed,
			inputTokens: log.inputTokens,
			outputTokens: log.outputTokens,
			costMicroUsd: log.costMicroUsd,
			costEstimated: log.costEstimated,
			firstTokenMs: log.firstTokenMs,
			totalMs,
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

/**
 * A cached streaming completion is replayed as an intentionally compact,
 * OpenAI-compatible SSE sequence (§3.3): one complete delta frame, a final
 * usage frame, then `[DONE]`. Copying each stored message into `delta` keeps
 * multiple choices and compatible fields such as `tool_calls` intact.
 */
function cacheReplayFrames(hit: CacheHit): Buffer[] {
	const {
		choices,
		usage: _usage,
		object: _object,
		...responseExtras
	} = hit.response;
	const completionChunk = {
		...responseExtras,
		object: "chat.completion.chunk",
		choices: choices.map((choice) => {
			const { message, ...choiceExtras } = choice;
			return { ...choiceExtras, delta: { ...message } };
		}),
		usage: null,
	};
	const usageChunk = {
		...responseExtras,
		object: "chat.completion.chunk",
		choices: [],
		usage: hit.usage,
	};

	return [completionChunk, usageChunk, "[DONE]"].map((frame) =>
		Buffer.from(
			frameSseData(typeof frame === "string" ? frame : JSON.stringify(frame)),
			"utf8",
		),
	);
}

/** Applies cache-hit accounting and returns the replay without touching an adapter. */
function sendCacheHit(
	db: Database.Database,
	reply: FastifyReply,
	log: PendingRequestLog,
	body: ChatRequest,
	hit: CacheHit,
): FastifyReply {
	log.cacheHit = true;
	log.streamed = body.stream === true;
	const normalizedUsage = meterStreamUsage(db, body.model, hit.usage);
	log.inputTokens = normalizedUsage.inputTokens;
	log.outputTokens = normalizedUsage.outputTokens;
	log.costMicroUsd = 0;
	log.costEstimated = false;
	log.status = "ok";
	reply.header("x-pg-cache", "hit");
	reply.header("x-pg-cost-usd", "0.000000");

	if (body.stream === true) {
		reply.header("content-type", "text/event-stream");
		reply.header("cache-control", "no-cache");
		return reply.send(Readable.from(cacheReplayFrames(hit)));
	}

	return reply.send(hit.response);
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

/**
 * Maps an error thrown while establishing the stream — before any response
 * headers are sent — to a safe OpenAI JSON envelope (BUILD_PLAYBOOK.md phase 2
 * step 3). A provider config/HTTP error keeps its existing mapping; a
 * request-translation error is a 400. None echo an upstream body.
 */
function sendStreamStartError(
	reply: FastifyReply,
	log: PendingRequestLog,
	provider: ProviderName,
	error: unknown,
	signal: AbortSignal,
): FastifyReply {
	if (signal.aborted) {
		log.status = "provider_error";
		log.errorCode = "provider_error";
		return sendError(
			reply,
			504,
			`Upstream ${provider} request timed out.`,
			"provider_error",
			"server_error",
		);
	}
	if (error instanceof ProviderRequestError) {
		log.status = "rejected_validation";
		log.errorCode = "invalid_request_error";
		return sendError(reply, 400, error.message, "invalid_request_error");
	}
	return sendProviderError(reply, log, provider, error);
}

function applyStreamMeter(
	db: Database.Database,
	log: PendingRequestLog,
	body: ChatRequest,
	usage: ChatUsage | undefined,
	emittedVisibleChars: number,
): void {
	const meter =
		usage === undefined
			? meterAbortedStream(db, body.model, body, emittedVisibleChars)
			: meterStreamUsage(db, body.model, usage);
	log.inputTokens = meter.inputTokens;
	log.outputTokens = meter.outputTokens;
	log.costMicroUsd = meter.costMicroUsd;
	log.costEstimated = meter.costEstimated;
}

/**
 * Yields framed SSE bytes to the client for a streamed exchange
 * (IMPLEMENTATION_GUIDE.md §3.3), forwarding each already-validated chunk
 * promptly (no full-response buffering; `Readable.from` honors socket
 * backpressure). Tee-reads each chunk just enough to timestamp the first
 * content delta (`first_token_ms`) and capture the terminal usage, then meters
 * once the stream completes so the route-level `onResponse` hook can persist
 * the row. A contract violation ends the stream without `[DONE]` as a
 * `provider_error`; a client abort is recorded separately without leaking data.
 */
async function* streamFrames(
	db: Database.Database,
	request: FastifyRequest,
	log: PendingRequestLog,
	body: ChatRequest,
	provider: ProviderName,
	iterator: AsyncIterator<SseChunk>,
	firstResult: IteratorResult<SseChunk>,
	timeout: ReturnType<typeof setTimeout>,
	now: Clock,
	wasClientAborted: () => boolean,
	cleanup: () => void,
): AsyncGenerator<Buffer> {
	let firstTokenMs: number | undefined;
	let usage: ChatUsage | undefined;
	let emittedVisibleChars = 0;
	let iteratorCompleted = false;
	let iteratorClosed = false;
	const closeIterator = async (): Promise<void> => {
		if (iteratorCompleted || iteratorClosed || !iterator.return) {
			return;
		}
		iteratorClosed = true;
		try {
			await iterator.return();
		} catch (error) {
			const failureType = error instanceof Error ? error.name : "UnknownError";
			request.log.warn(
				{ provider, requestId: log.requestId, failureType },
				"Failed to close upstream stream after an early exit",
			);
		}
	};
	try {
		let result = firstResult;
		while (result.done !== true) {
			// `iterator.next()` can settle concurrently with a socket reset. Never
			// parse, count, or forward a frame that arrived after the reset.
			if (wasClientAborted()) {
				break;
			}
			const chunk = result.value;
			if (!chunk.done) {
				const reading = readStreamChunk(chunk.data);
				if (firstTokenMs === undefined && reading.contentDelta !== null) {
					firstTokenMs = elapsedMs(log.startedAtMs, now);
				}
				emittedVisibleChars += reading.visibleContentChars;
				if (reading.usage !== null) {
					usage = reading.usage;
				}
			}
			if (wasClientAborted()) {
				break;
			}
			// Reframe each logical payload as one-`data:`-line-per-newline so a
			// standards-compliant client reconstructs the exact payload even when
			// it contains embedded newlines (blocker 1). Provider bytes are
			// preserved semantically; only the SSE line framing is (re)applied.
			yield Buffer.from(frameSseData(chunk.data), "utf8");
			result = await iterator.next();
		}
		iteratorCompleted = result.done === true;

		log.firstTokenMs = firstTokenMs ?? null;
		if (wasClientAborted()) {
			applyStreamMeter(db, log, body, usage, emittedVisibleChars);
			log.status = "client_aborted";
			log.errorCode = null;
			return;
		}
		if (usage === undefined) {
			// Unreachable: the adapter fails closed on a missing terminal usage
			// chunk before [DONE]. Guarded so a future adapter can't log "ok"
			// without usage.
			log.status = "provider_error";
			log.errorCode = "provider_error";
			return;
		}
		applyStreamMeter(db, log, body, usage, emittedVisibleChars);
		log.status = "ok";
	} catch (error) {
		log.firstTokenMs = firstTokenMs ?? null;
		if (wasClientAborted()) {
			applyStreamMeter(db, log, body, usage, emittedVisibleChars);
			log.status = "client_aborted";
			log.errorCode = null;
		} else {
			log.status = "provider_error";
			log.errorCode = "provider_error";
		}
		const failureType = error instanceof Error ? error.name : "UnknownError";
		request.log.error(
			{ provider, requestId: log.requestId, failureType },
			"Streaming failed after response headers were sent",
		);
	} finally {
		clearTimeout(timeout);
		cleanup();
		await closeIterator();
		if (wasClientAborted()) {
			// Fastify does not guarantee onResponse after a client has reset the
			// response socket. Preserve the audit row without blocking the closed
			// connection; normal paths remain onResponse-only.
			void logRequest(db, request, now);
		}
	}
}

/**
 * Establishes the streaming path for OpenAI/Gemini/DeepSeek (BUILD_PLAYBOOK.md
 * phase 2 step 3). It pulls the first frame under the upstream timeout so that
 * a provider config/HTTP failure still maps to a JSON envelope (headers not yet
 * sent); once the first frame is in hand it commits to a `text/event-stream`
 * 200 (preserving `x-pg-request-id`/`x-pg-cache`, omitting `x-pg-cost-usd`) and
 * streams the rest.
 */
async function handleStreamingRequest(
	db: Database.Database,
	request: FastifyRequest,
	reply: FastifyReply,
	log: PendingRequestLog,
	body: ChatRequest,
	provider: ProviderName,
	adapter: ProviderAdapter,
	now: Clock,
): Promise<FastifyReply> {
	const controller = new AbortController();
	let clientAborted = false;
	const abortForClientDisconnect = (): void => {
		if (!clientAborted && !controller.signal.aborted) {
			clientAborted = true;
			controller.abort(new Error("Client disconnected"));
		}
	};
	// Fastify's documented signal is the request raw stream closing with an
	// aborted request. A response-side close catches the usual POST case where
	// the request body was fully received before the streaming response dies.
	const onRequestClose = (): void => {
		if (request.raw.aborted) {
			abortForClientDisconnect();
		}
	};
	const onResponseClose = (): void => {
		if (!reply.raw.writableEnded) {
			abortForClientDisconnect();
		}
	};
	const cleanup = (): void => {
		request.raw.off("close", onRequestClose);
		reply.raw.off("close", onResponseClose);
	};
	request.raw.on("close", onRequestClose);
	reply.raw.on("close", onResponseClose);
	const timeout = setTimeout(() => {
		if (!controller.signal.aborted) {
			controller.abort(new Error("Upstream request timed out"));
		}
	}, config.UPSTREAM_TIMEOUT_MS);
	log.streamed = true;

	let iterator: AsyncIterator<SseChunk> | undefined;
	let firstResult: IteratorResult<SseChunk>;
	try {
		iterator = adapter.stream(body, controller.signal)[Symbol.asyncIterator]();
		firstResult = await iterator.next();
	} catch (error) {
		clearTimeout(timeout);
		cleanup();
		try {
			await iterator?.return?.();
		} catch (returnError) {
			const failureType =
				returnError instanceof Error ? returnError.name : "UnknownError";
			request.log.warn(
				{ provider, requestId: log.requestId, failureType },
				"Failed to close upstream stream after a pre-header failure",
			);
		}
		if (clientAborted) {
			applyStreamMeter(db, log, body, undefined, 0);
			log.status = "client_aborted";
			log.errorCode = null;
			void logRequest(db, request, now);
			return reply;
		}
		return sendStreamStartError(reply, log, provider, error, controller.signal);
	}
	if (clientAborted) {
		clearTimeout(timeout);
		cleanup();
		try {
			await iterator.return?.();
		} catch (error) {
			const failureType = error instanceof Error ? error.name : "UnknownError";
			request.log.warn(
				{ provider, requestId: log.requestId, failureType },
				"Failed to close upstream stream after a pre-header client abort",
			);
		}
		applyStreamMeter(db, log, body, undefined, 0);
		log.status = "client_aborted";
		log.errorCode = null;
		void logRequest(db, request, now);
		return reply;
	}

	// The fetch succeeded and the first frame is in hand: committed to a
	// streamed 200 whose headers can no longer change. x-pg-cost-usd is
	// deliberately omitted — a live stream's usage doesn't exist yet (§5.1).
	reply.header("content-type", "text/event-stream");
	reply.header("cache-control", "no-cache");

	return reply.send(
		Readable.from(
			streamFrames(
				db,
				request,
				log,
				body,
				provider,
				iterator,
				firstResult,
				timeout,
				now,
				() => clientAborted,
				cleanup,
			),
		),
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
	now: Clock = defaultClock,
): void {
	server.decorateRequest("pgRequestLog");
	server.post(
		"/chat/completions",
		{
			bodyLimit: config.BODY_LIMIT_BYTES,
			onRequest: async (request, reply) => {
				initializeRequestLog(request, reply, now);
			},
			errorHandler: sendRouteError,
			onResponse: async (request) => {
				await logRequest(db, request, now);
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

			const routing = resolveProvider(db, body.model);
			if (!routing.ok) {
				log.status = "rejected_unknown_model";
				log.errorCode = "unknown_model";
				return reply.code(routing.statusCode).send(routing.error);
			}
			log.provider = routing.provider;

			// Exact-match cache reads belong after route/pricing resolution (and, in
			// phase 4, after prompt resolution) but before adapter availability or any
			// upstream call. A malformed, expired, or mismatched cache row is a safe
			// miss; `pg_no_cache` bypasses this path entirely (§§3.4, 5.1).
			if (body.pg_no_cache !== true) {
				const hit = findAndRecordCacheHit(db, {
					hash: cacheKeyOf(body),
					model: body.model,
				});
				if (hit) {
					return sendCacheHit(db, reply, log, body, hit);
				}
			}

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

			if (body.stream === true) {
				return await handleStreamingRequest(
					db,
					request,
					reply,
					log,
					body,
					routing.provider,
					adapter,
					now,
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
				// The request couldn't be safely translated into the provider's
				// native contract (e.g. Anthropic tool/content translation, phase 2
				// step 2) — a caller error, not an upstream failure. Surface it as a
				// 400 with the adapter's client-safe message, never as provider_error.
				if (error instanceof ProviderRequestError) {
					log.status = "rejected_validation";
					log.errorCode = "invalid_request_error";
					return sendError(reply, 400, error.message, "invalid_request_error");
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
