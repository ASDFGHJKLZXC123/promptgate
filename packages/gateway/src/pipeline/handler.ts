import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
	type ChatRequest,
	ChatRequestSchema,
	type ChatResponse,
	type ChatUsage,
	PgFeatureSchema,
	PgPromptRefSchema,
	PgVarsSchema,
	stripPgFields,
} from "@promptgate/shared";
import type Database from "better-sqlite3";
import type {
	FastifyError,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import { sendError } from "../errors.js";
import { readStreamChunk } from "../providers/openai-compatible-stream.js";
import { findCurrentPricing } from "../providers/pricing.dao.js";
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
import {
	type BudgetGuard,
	type BudgetReservation,
	estimateBudgetReservation,
} from "./budget.js";
import {
	type CacheHit,
	findAndRecordCacheHit,
	upsertCacheEntry,
} from "./cache.dao.js";
import { cacheKeyOf } from "./cache-key.js";
import { meterAbortedStream, meterStreamUsage, meterUsage } from "./meter.js";
import { resolvePromptRequest } from "./prompt-resolve.js";
import { RateLimiter } from "./ratelimit.js";
import {
	insertRequestLog,
	type RequestLogProvider,
	type RequestLogStatus,
} from "./requests.dao.js";
import { StreamingResponseAssembler } from "./stream-assembler.js";

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
	promptId?: number | null;
	promptVersion?: number | null;
	feature?: string | null;
	cacheHit: boolean;
	streamed: boolean;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costMicroUsd?: number | null;
	costEstimated: boolean;
	cacheSavedMicroUsd?: number | null;
	cacheSavedEstimated?: boolean | null;
	firstTokenMs?: number | null;
	status: RequestLogStatus;
	errorCode?: string | null;
	startedAtMs: number;
	loggingStarted: boolean;
	budgetReservation?: BudgetReservation;
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
const HeaderNoCacheSchema = z.enum(["true", "false"]);

interface EffectiveRequestExtensions {
	feature: string | null;
	noCache: boolean;
	prompt?: string;
	vars?: Record<string, unknown>;
}

type HeaderFallbackResolution =
	| { ok: true; extensions: EffectiveRequestExtensions }
	| { ok: false; message: string };

/**
 * Resolves the Phase 4 body/header extension boundary. Body fields always win,
 * including an explicit `pg_no_cache: false`; header values are parsed only as
 * narrow, exact strings so a proxy/client cannot accidentally coerce a value.
 */
function resolveHeaderFallbacks(
	request: FastifyRequest,
	body: ChatRequest,
): HeaderFallbackResolution {
	let feature = body.pg_feature ?? null;
	if (body.pg_feature === undefined) {
		const headerFeature = request.headers["x-pg-feature"];
		if (headerFeature !== undefined) {
			const parsedFeature = PgFeatureSchema.safeParse(headerFeature);
			if (!parsedFeature.success) {
				return { ok: false, message: "Invalid x-pg-feature header." };
			}
			feature = parsedFeature.data;
		}
	}

	let noCache = body.pg_no_cache ?? false;
	if (body.pg_no_cache === undefined) {
		const headerNoCache = request.headers["x-pg-no-cache"];
		if (headerNoCache !== undefined) {
			const parsedNoCache = HeaderNoCacheSchema.safeParse(headerNoCache);
			if (!parsedNoCache.success) {
				return {
					ok: false,
					message:
						'Invalid x-pg-no-cache header; expected exactly "true" or "false".',
				};
			}
			noCache = parsedNoCache.data === "true";
		}
	}

	let prompt = body.pg_prompt;
	if (prompt === undefined) {
		const headerPrompt = request.headers["x-pg-prompt"];
		if (headerPrompt !== undefined) {
			const parsedPrompt = PgPromptRefSchema.safeParse(headerPrompt);
			if (!parsedPrompt.success) {
				return { ok: false, message: "Invalid x-pg-prompt header." };
			}
			prompt = parsedPrompt.data;
		}
	}

	let vars = body.pg_vars;
	if (vars === undefined) {
		const headerVars = request.headers["x-pg-vars"];
		if (headerVars !== undefined) {
			if (typeof headerVars !== "string") {
				return { ok: false, message: "Invalid x-pg-vars header." };
			}
			let decoded: unknown;
			try {
				decoded = JSON.parse(headerVars);
			} catch {
				return { ok: false, message: "Invalid x-pg-vars header." };
			}
			const parsedVars = PgVarsSchema.safeParse(decoded);
			if (!parsedVars.success) {
				return { ok: false, message: "Invalid x-pg-vars header." };
			}
			vars = parsedVars.data;
		}
	}

	return { ok: true, extensions: { feature, noCache, prompt, vars } };
}

/** Adds header fallbacks to the existing body shape before adapter/cache work. */
function withEffectiveExtensions(
	body: ChatRequest,
	extensions: EffectiveRequestExtensions,
): ChatRequest {
	return {
		...body,
		...(body.pg_feature === undefined && extensions.feature !== null
			? { pg_feature: extensions.feature }
			: {}),
		...(body.pg_no_cache === undefined && extensions.noCache
			? { pg_no_cache: true }
			: {}),
		...(body.pg_prompt === undefined && extensions.prompt !== undefined
			? { pg_prompt: extensions.prompt }
			: {}),
		...(body.pg_vars === undefined && extensions.vars !== undefined
			? { pg_vars: extensions.vars }
			: {}),
	};
}

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
	budgetGuard: BudgetGuard,
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
			promptId: log.promptId,
			promptVersion: log.promptVersion,
			feature: log.feature,
			cacheHit: log.cacheHit,
			streamed: log.streamed,
			inputTokens: log.inputTokens,
			outputTokens: log.outputTokens,
			costMicroUsd: log.costMicroUsd,
			costEstimated: log.costEstimated,
			cacheSavedMicroUsd: log.cacheSavedMicroUsd,
			cacheSavedEstimated: log.cacheSavedEstimated,
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
		if (log.budgetReservation) {
			budgetGuard.retainDebt(log.budgetReservation, log.costMicroUsd ?? 0);
		}
		return;
	}

	// A durable insert is the only condition that releases a reservation. Keep
	// this outside the insert catch so a future finalization bug cannot be
	// mistaken for a failed write and reopen capacity through debt accounting.
	if (log.budgetReservation) {
		budgetGuard.reconcileAfterDurableLog(
			log.budgetReservation,
			log.costMicroUsd ?? 0,
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

	return [completionChunk, usageChunk, "[DONE]"].flatMap((frame) => {
		const encoded = Buffer.from(
			frameSseData(typeof frame === "string" ? frame : JSON.stringify(frame)),
			"utf8",
		);
		// Do not hand a multi-megabyte cached completion to Node as one stream
		// chunk. Splitting only the transport buffers preserves the exact SSE
		// payload while letting Readable apply backpressure between writes, so a
		// client reset can be observed before the replay is marked complete.
		const chunks: Buffer[] = [];
		for (let offset = 0; offset < encoded.length; offset += 16 * 1024) {
			chunks.push(encoded.subarray(offset, offset + 16 * 1024));
		}
		return chunks;
	});
}

/** Applies cache-hit accounting and returns the replay without touching an adapter. */
function sendCacheHit(
	db: Database.Database,
	request: FastifyRequest,
	reply: FastifyReply,
	log: PendingRequestLog,
	body: ChatRequest,
	hit: CacheHit,
	now: Clock,
	budgetGuard: BudgetGuard,
): FastifyReply {
	log.cacheHit = true;
	log.streamed = body.stream === true;
	const normalizedUsage =
		hit.usage === null
			? meterUsage(db, body.model, body, hit.response)
			: meterStreamUsage(db, body.model, hit.usage);
	log.inputTokens = normalizedUsage.inputTokens;
	log.outputTokens = normalizedUsage.outputTokens;
	log.costMicroUsd = 0;
	log.costEstimated = normalizedUsage.costEstimated;
	log.cacheSavedMicroUsd = hit.pricedCostMicroUsd;
	log.cacheSavedEstimated = hit.pricedCostEstimated;
	log.status = "ok";
	reply.header("x-pg-cache", "hit");
	reply.header("x-pg-cost-usd", "0.000000");

	if (body.stream === true) {
		// Route lookup requires usage for a stream, but retain this guard at the
		// response boundary so a future caller cannot synthesize terminal tokens.
		if (hit.usage === null) {
			throw new Error("Streaming cache replay requires exact provider usage.");
		}
		reply.header("content-type", "text/event-stream");
		reply.header("cache-control", "no-cache");
		// Like a live stream, a synthetic cache replay can outlive an abruptly
		// closed response socket and skip Fastify's onResponse hook. Preserve the
		// exact cached usage and zero cost, then use the same idempotent durable
		// log/reconcile path as the live-stream abort handler.
		reply.raw.once("close", () => {
			// writableEnded only means end() was called; queued bytes may still
			// be lost on a reset. Treat the response as complete only after the
			// writable side has actually emitted its successful finish.
			if (!reply.raw.writableFinished) {
				log.status = "client_aborted";
				log.errorCode = null;
				void logRequest(db, request, now, budgetGuard);
			}
		});
		return reply.send(Readable.from(cacheReplayFrames(hit)));
	}

	// A large buffered cache hit can still be reset before Node flushes every
	// byte. Fastify may skip onResponse in that case, so retain the same durable
	// fallback and exactly-once budget reconciliation used by live abort paths.
	const onBufferedCacheFinish = (): void => {
		reply.raw.off("close", onBufferedCacheClose);
	};
	const onBufferedCacheClose = (): void => {
		reply.raw.off("finish", onBufferedCacheFinish);
		if (!reply.raw.writableFinished) {
			log.status = "client_aborted";
			log.errorCode = null;
			void logRequest(db, request, now, budgetGuard);
		}
	};
	reply.raw.once("finish", onBufferedCacheFinish);
	reply.raw.once("close", onBufferedCacheClose);

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
	budgetGuard: BudgetGuard,
	wasClientAborted: () => boolean,
	cleanup: () => void,
): AsyncGenerator<Buffer> {
	let firstTokenMs: number | undefined;
	let usage: ChatUsage | undefined;
	let emittedVisibleChars = 0;
	let iteratorCompleted = false;
	let iteratorClosed = false;
	const assembler =
		body.pg_no_cache === true ? undefined : new StreamingResponseAssembler();
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
				assembler?.observePayload(chunk.data);
				const reading = readStreamChunk(chunk.data);
				if (firstTokenMs === undefined && reading.contentDelta !== null) {
					firstTokenMs = elapsedMs(log.startedAtMs, now);
				}
				emittedVisibleChars += reading.visibleContentChars;
				if (reading.usage !== null) {
					usage = reading.usage;
				}
			} else {
				assembler?.observeDone(chunk.data);
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
			// chunk before [DONE]. A post-header contract failure still accounts for
			// the visible output already sent, so durable budget reconciliation never
			// treats this exchange as a zero-cost request.
			applyStreamMeter(db, log, body, usage, emittedVisibleChars);
			log.status = "provider_error";
			log.errorCode = "provider_error";
			return;
		}
		applyStreamMeter(db, log, body, usage, emittedVisibleChars);
		log.status = "ok";
		const assembled = assembler?.finish();
		const pricedCost = log.costMicroUsd;
		if (assembled && typeof pricedCost === "number" && iteratorCompleted) {
			try {
				upsertCacheEntry(db, {
					hash: cacheKeyOf(body),
					model: body.model,
					response: assembled,
					usage,
					pricedCostMicroUsd: pricedCost,
					pricedCostEstimated: log.costEstimated,
					ttlHours: config.CACHE_TTL_HOURS,
				});
			} catch (error) {
				const failureType =
					error instanceof Error ? error.name : "UnknownError";
				request.log.warn(
					{ provider, requestId: log.requestId, failureType },
					"Failed to cache completed stream",
				);
			}
		}
	} catch (error) {
		log.firstTokenMs = firstTokenMs ?? null;
		if (wasClientAborted()) {
			applyStreamMeter(db, log, body, usage, emittedVisibleChars);
			log.status = "client_aborted";
			log.errorCode = null;
		} else {
			// Headers may already be committed when an adapter/contract failure is
			// discovered. Meter exact terminal usage if it was captured before the
			// failure; otherwise estimate only prompt plus visible emitted content.
			applyStreamMeter(db, log, body, usage, emittedVisibleChars);
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
			void logRequest(db, request, now, budgetGuard);
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
	forwardedBody: ChatRequest,
	provider: ProviderName,
	adapter: ProviderAdapter,
	now: Clock,
	budgetGuard: BudgetGuard,
): Promise<FastifyReply> {
	const controller = new AbortController();
	let clientAborted = false;
	let responseClosed = false;
	let fallbackLogReady = false;
	let preHeaderCauseSettled = false;
	const abortForClientDisconnect = (): void => {
		if (
			!preHeaderCauseSettled &&
			!clientAborted &&
			!controller.signal.aborted
		) {
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
		if (!reply.raw.writableFinished) {
			responseClosed = true;
			abortForClientDisconnect();
			if (fallbackLogReady) {
				void logRequest(db, request, now, budgetGuard);
			}
		}
		cleanup();
	};
	const onResponseFinish = (): void => {
		cleanup();
	};
	const cleanup = (): void => {
		request.raw.off("close", onRequestClose);
		reply.raw.off("close", onResponseClose);
		reply.raw.off("finish", onResponseFinish);
	};
	request.raw.on("close", onRequestClose);
	reply.raw.on("close", onResponseClose);
	reply.raw.on("finish", onResponseFinish);
	const timeout = setTimeout(() => {
		if (!controller.signal.aborted) {
			controller.abort(new Error("Upstream request timed out"));
		}
	}, config.UPSTREAM_TIMEOUT_MS);
	log.streamed = true;

	let iterator: AsyncIterator<SseChunk> | undefined;
	let firstResult: IteratorResult<SseChunk>;
	try {
		iterator = adapter
			.stream(forwardedBody, controller.signal)
			[Symbol.asyncIterator]();
		firstResult = await iterator.next();
	} catch (error) {
		clearTimeout(timeout);
		const failureWasClientAbort = clientAborted;
		const failureWasTimeout =
			!failureWasClientAbort && controller.signal.aborted;
		preHeaderCauseSettled = true;
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
		if (failureWasClientAbort) {
			applyStreamMeter(db, log, body, undefined, 0);
			log.status = "client_aborted";
			log.errorCode = null;
			void logRequest(db, request, now, budgetGuard);
			cleanup();
			return reply;
		}
		if (responseClosed) {
			// The upstream failure or timeout won before the client closed. Fastify
			// may skip onResponse for the dead socket, so preserve that first-cause
			// row and release its reservation here.
			if (failureWasTimeout) {
				log.status = "provider_error";
				log.errorCode = "provider_error";
			} else if (error instanceof ProviderRequestError) {
				log.status = "rejected_validation";
				log.errorCode = "invalid_request_error";
			} else {
				log.status = "provider_error";
				log.errorCode = "provider_error";
			}
			await logRequest(db, request, now, budgetGuard);
			cleanup();
			return reply;
		}
		fallbackLogReady = true;
		return sendStreamStartError(reply, log, provider, error, controller.signal);
	}
	if (clientAborted) {
		clearTimeout(timeout);
		preHeaderCauseSettled = true;
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
		void logRequest(db, request, now, budgetGuard);
		return reply;
	}
	if (controller.signal.aborted) {
		clearTimeout(timeout);
		preHeaderCauseSettled = true;
		try {
			await iterator.return?.();
		} catch (error) {
			const failureType = error instanceof Error ? error.name : "UnknownError";
			request.log.warn(
				{ provider, requestId: log.requestId, failureType },
				"Failed to close upstream stream after a pre-header timeout",
			);
		}
		log.status = "provider_error";
		log.errorCode = "provider_error";
		fallbackLogReady = true;
		if (responseClosed) {
			await logRequest(db, request, now, budgetGuard);
			cleanup();
			return reply;
		}
		return sendError(
			reply,
			504,
			`Upstream ${provider} request timed out.`,
			"provider_error",
			"server_error",
		);
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
				budgetGuard,
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
 * as an explicit, testable chain. Its fixed Phase 4 order is:
 *
 * auth → request-log init → rate limit → validate → resolve provider + pricing
 * → promptResolve → budget reserve → cache read → adapter → meter
 * → cache write → durable log + budget reconcile.
 *
 * Auth runs on the enclosing `/v1` plugin (`auth.ts`); this route's
 * pre-parsing `onRequest` chain starts the log and applies rate limiting.
 * Durable logging remains in `onResponse` so it cannot add response latency.
 */
export function registerChatCompletionsRoute(
	server: FastifyInstance,
	db: Database.Database,
	adapters: ProviderAdapterRegistry,
	now: Clock = defaultClock,
	rateLimiter = new RateLimiter(),
	budgetGuard: BudgetGuard,
): void {
	server.decorateRequest("pgRequestLog");
	server.post(
		"/chat/completions",
		{
			bodyLimit: config.BODY_LIMIT_BYTES,
			onRequest: async (request, reply) => {
				initializeRequestLog(request, reply, now);
				const log = requireRequestLog(request);
				const rateLimit = rateLimiter.take(
					request.ctx.apiKey.id,
					request.ctx.apiKey.rateLimitRpm,
				);
				if (!rateLimit.allowed) {
					log.status = "rejected_rate_limited";
					log.errorCode = "rate_limited";
					reply.header("retry-after", String(rateLimit.retryAfterSeconds));
					return sendError(
						reply,
						429,
						"Rate limit exceeded.",
						"rate_limited",
						"rate_limit_error",
					);
				}
			},
			errorHandler: sendRouteError,
			onResponse: async (request) => {
				await logRequest(db, request, now, budgetGuard);
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
			const headerFallbacks = resolveHeaderFallbacks(request, parsed.data);
			if (!headerFallbacks.ok) {
				log.status = "rejected_validation";
				log.errorCode = "invalid_request_error";
				return sendError(
					reply,
					400,
					headerFallbacks.message,
					"invalid_request_error",
				);
			}
			const requestedBody = withEffectiveExtensions(
				parsed.data,
				headerFallbacks.extensions,
			);
			log.model = requestedBody.model;
			log.feature = headerFallbacks.extensions.feature;

			const routing = resolveProvider(db, requestedBody.model);
			if (!routing.ok) {
				log.status = "rejected_unknown_model";
				log.errorCode = "unknown_model";
				return reply.code(routing.statusCode).send(routing.error);
			}
			log.provider = routing.provider;
			const pricing = findCurrentPricing(db, requestedBody.model);
			if (!pricing) {
				// resolveProvider performed this lookup immediately above; retain a
				// fail-closed guard in case pricing is changed between the steps.
				log.status = "rejected_unknown_model";
				log.errorCode = "unknown_model";
				return sendError(
					reply,
					400,
					`Unknown model: "${requestedBody.model}".`,
					"unknown_model",
				);
			}

			const promptResolution = resolvePromptRequest(db, requestedBody);
			if (promptResolution.promptRef) {
				log.promptId = promptResolution.promptRef.promptId;
				log.promptVersion = promptResolution.promptRef.promptVersion;
			}
			if (!promptResolution.ok) {
				log.status =
					promptResolution.code === "provider_error"
						? "provider_error"
						: "rejected_prompt";
				log.errorCode = promptResolution.code;
				return sendError(
					reply,
					promptResolution.code === "prompt_not_found"
						? 404
						: promptResolution.code === "provider_error"
							? 500
							: 400,
					promptResolution.message,
					promptResolution.code,
					promptResolution.code === "provider_error"
						? "server_error"
						: "invalid_request_error",
				);
			}
			const body = promptResolution.body;

			const estimate = estimateBudgetReservation(
				body,
				pricing,
				config.DEFAULT_MAX_TOKENS,
			);
			const reservation = budgetGuard.reserve(
				request.ctx.apiKey.id,
				request.ctx.apiKey.budgetMicroUsdMonth,
				estimate,
			);
			if (reservation === "over_budget") {
				log.status = "rejected_budget";
				log.errorCode = "budget_exceeded";
				return sendError(
					reply,
					429,
					"Budget exceeded.",
					"budget_exceeded",
					"insufficient_quota",
				);
			}
			log.budgetReservation = reservation;

			// Exact-match cache reads belong after route/pricing resolution (and, in
			// phase 4, after prompt resolution) but before adapter availability or any
			// upstream call. A malformed, expired, or mismatched cache row is a safe
			// miss; `pg_no_cache` bypasses this path entirely (§§3.4, 5.1).
			if (body.pg_no_cache !== true) {
				const hit = findAndRecordCacheHit(db, {
					hash: cacheKeyOf(body),
					model: body.model,
					requireUsage: body.stream === true,
				});
				if (hit) {
					return sendCacheHit(
						db,
						request,
						reply,
						log,
						body,
						hit,
						now,
						budgetGuard,
					);
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
				const forwardedBody = stripPgFields(body) as ChatRequest;
				return await handleStreamingRequest(
					db,
					request,
					reply,
					log,
					body,
					forwardedBody,
					routing.provider,
					adapter,
					now,
					budgetGuard,
				);
			}

			const controller = new AbortController();
			let clientAborted = false;
			let responseClosed = false;
			let fallbackLogReady = false;
			let failureCauseSettled = false;
			const abortForClientDisconnect = (): void => {
				// Preserve a timeout or provider/validation failure once it wins so a
				// later socket close cannot relabel the settled first cause.
				if (failureCauseSettled || clientAborted || controller.signal.aborted) {
					return;
				}
				clientAborted = true;
				log.status = "client_aborted";
				log.errorCode = null;
				if (!controller.signal.aborted) {
					controller.abort(new Error("Client disconnected"));
				}
			};
			// A fully received POST does not set request.raw.aborted when its client
			// disappears while the buffered provider call is pending. Observe the
			// response socket as well, matching the streaming transport boundary.
			const onRequestClose = (): void => {
				if (request.raw.aborted) {
					abortForClientDisconnect();
				}
			};
			const onResponseClose = (): void => {
				if (!reply.raw.writableFinished) {
					responseClosed = true;
					abortForClientDisconnect();
					if (fallbackLogReady) {
						void logRequest(db, request, now, budgetGuard);
					}
				}
				cleanupClientDisconnect();
			};
			const onResponseFinish = (): void => {
				cleanupClientDisconnect();
			};
			const cleanupClientDisconnect = (): void => {
				request.raw.off("close", onRequestClose);
				reply.raw.off("close", onResponseClose);
				reply.raw.off("finish", onResponseFinish);
			};
			const logIfResponseClosed = async (): Promise<boolean> => {
				if (!responseClosed) {
					return false;
				}
				await logRequest(db, request, now, budgetGuard);
				cleanupClientDisconnect();
				return true;
			};
			request.raw.on("close", onRequestClose);
			reply.raw.on("close", onResponseClose);
			reply.raw.on("finish", onResponseFinish);
			const timeout = setTimeout(() => {
				if (!controller.signal.aborted) {
					controller.abort(new Error("Upstream request timed out"));
				}
			}, config.UPSTREAM_TIMEOUT_MS);

			let response: ChatResponse;
			try {
				response = await adapter.complete(
					stripPgFields(body) as ChatRequest,
					controller.signal,
				);
			} catch (error) {
				if (clientAborted) {
					// No buffered completion bytes reached the caller. Reuse the existing
					// aborted-usage rule: estimate prompt input and zero visible output.
					applyStreamMeter(db, log, body, undefined, 0);
					fallbackLogReady = true;
					log.status = "client_aborted";
					log.errorCode = null;
					await logRequest(db, request, now, budgetGuard);
					cleanupClientDisconnect();
					return reply;
				}
				if (controller.signal.aborted) {
					failureCauseSettled = true;
					log.status = "provider_error";
					log.errorCode = "provider_error";
					fallbackLogReady = true;
					if (await logIfResponseClosed()) {
						return reply;
					}
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
					failureCauseSettled = true;
					log.status = "rejected_validation";
					log.errorCode = "invalid_request_error";
					fallbackLogReady = true;
					if (await logIfResponseClosed()) {
						return reply;
					}
					return sendError(reply, 400, error.message, "invalid_request_error");
				}
				failureCauseSettled = true;
				log.status = "provider_error";
				log.errorCode = "provider_error";
				fallbackLogReady = true;
				if (await logIfResponseClosed()) {
					return reply;
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
			fallbackLogReady = true;
			log.status = clientAborted ? "client_aborted" : "ok";
			log.errorCode = null;
			if (body.pg_no_cache !== true) {
				try {
					upsertCacheEntry(db, {
						hash: cacheKeyOf(body),
						model: body.model,
						response,
						usage: response.usage ?? null,
						pricedCostMicroUsd: meter.costMicroUsd,
						pricedCostEstimated: meter.costEstimated,
						ttlHours: config.CACHE_TTL_HOURS,
					});
				} catch (error) {
					const failureType =
						error instanceof Error ? error.name : "UnknownError";
					request.log.warn(
						{
							provider: routing.provider,
							requestId: log.requestId,
							failureType,
						},
						"Failed to cache completed response",
					);
				}
			}
			if (clientAborted) {
				// An adapter may settle concurrently with cancellation. Preserve its
				// exact metering/cache result, but never write it to the closed client.
				await logRequest(db, request, now, budgetGuard);
				cleanupClientDisconnect();
				return reply;
			}

			reply.header(
				"x-pg-cost-usd",
				(meter.costMicroUsd / 1_000_000).toFixed(6),
			);
			return reply.send(response);
		},
	);
}
