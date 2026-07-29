import { existsSync } from "node:fs";
import type {
	EvalJsonRecord,
	ChatResponse as SharedChatResponse,
} from "@promptgate/shared/eval";
import { z } from "zod";

export type { EvalJsonValue } from "@promptgate/shared/eval";

type SharedEvalModule = typeof import("@promptgate/shared/eval");

const workspaceSharedEvalUrl = new URL(
	"../../shared/src/eval.ts",
	import.meta.url,
);
const sharedEvalSpecifier =
	import.meta.url.endsWith(".ts") && existsSync(workspaceSharedEvalUrl)
		? workspaceSharedEvalUrl.href
		: "@promptgate/shared/eval";
const {
	EVAL_MODELS,
	EvalGatewayRequestSchema,
	EvalGatewayResponseSchema,
	EvalJsonRecordSchema,
	EvalModelSchema,
} = (await import(sharedEvalSpecifier)) as SharedEvalModule;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COST_USD_PATTERN =
	/^(?<dollars>0|[1-9][0-9]*)(?:\.(?<fraction>[0-9]{1,6}))?$/;

export const EVAL_TEMPERATURE_MODELS = [
	"gpt-5.6-luna",
	"gemini-2.5-flash",
	"deepseek-v4-flash",
] as const;

export { EVAL_MODELS };

export type EvalTemperatureModel = (typeof EVAL_TEMPERATURE_MODELS)[number];

export interface GatewayConfigInput {
	flags?: Readonly<{ gateway?: string; key?: string }>;
	env?: Readonly<Record<string, string | undefined>>;
}

export interface GatewayConfig {
	baseUrl: URL;
	key: string;
}

const SafeHttpErrorEnvelopeSchema = z.object({
	error: z.object({
		code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	}),
});

export type PgVars = EvalJsonRecord;
export type ChatResponse = SharedChatResponse;

export interface GatewayCall {
	model: string;
	prompt: string;
	vars: PgVars;
	allowCache?: boolean;
	reasoningEffort?: "high";
	responseFormat?: { type: "json_object" };
	signal?: AbortSignal;
}

export interface GatewayResponse {
	content: string;
	response: ChatResponse;
	requestId: string;
	cache: "hit" | "miss";
	costMicroUsd: number;
}

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export class GatewayClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayClientError";
	}
}

export class GatewayConfigError extends GatewayClientError {
	constructor(message: string) {
		super(message);
		this.name = "GatewayConfigError";
	}
}

export class GatewayNetworkError extends GatewayClientError {
	constructor(message: string) {
		super(message);
		this.name = "GatewayNetworkError";
	}
}

export class GatewayAbortError extends GatewayClientError {
	constructor() {
		super("Gateway request was aborted.");
		this.name = "GatewayAbortError";
	}
}

export class GatewayHttpError extends GatewayClientError {
	readonly status: number;
	readonly code?: string;

	constructor(status: number, code?: string) {
		super(`Gateway request failed with HTTP status ${status}.`);
		this.name = "GatewayHttpError";
		this.status = status;
		this.code = code;
	}
}

export class GatewayProtocolError extends GatewayClientError {
	constructor(message: string) {
		super(message);
		this.name = "GatewayProtocolError";
	}
}

function configuredValue(
	flag: string | undefined,
	environment: string | undefined,
): string | undefined {
	return flag === undefined ? environment : flag;
}

function requireNonBlank(value: string | undefined, name: string): string {
	if (value === undefined || value.trim().length === 0) {
		throw new GatewayConfigError(`${name} is required.`);
	}
	return value.trim();
}

/** Resolve the documented CLI > environment configuration precedence. */
export function resolveGatewayConfig(
	input: GatewayConfigInput = {},
): GatewayConfig {
	const flags = input.flags ?? {};
	const environment = input.env ?? process.env;
	const rawBaseUrl = requireNonBlank(
		configuredValue(flags.gateway, environment.PG_GATEWAY_URL),
		"Gateway URL (--gateway or PG_GATEWAY_URL)",
	);
	const key = requireNonBlank(
		configuredValue(flags.key, environment.PG_EVAL_KEY),
		"Gateway key (--key or PG_EVAL_KEY)",
	);

	let baseUrl: URL;
	try {
		baseUrl = new URL(rawBaseUrl);
	} catch {
		throw new GatewayConfigError("Gateway URL must be a valid HTTP(S) URL.");
	}
	if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
		throw new GatewayConfigError("Gateway URL must use HTTP or HTTPS.");
	}
	if (
		baseUrl.username.length > 0 ||
		baseUrl.password.length > 0 ||
		baseUrl.search.length > 0 ||
		baseUrl.hash.length > 0
	) {
		throw new GatewayConfigError(
			"Gateway URL must not contain credentials, a query string, or a fragment.",
		);
	}

	return { baseUrl, key };
}

export function temperatureForEvalModel(model: string): 0 | undefined {
	const parsedModel = EvalModelSchema.safeParse(model);
	if (!parsedModel.success) {
		throw new GatewayConfigError(`Unsupported eval model: ${model}.`);
	}
	return parsedModel.data === "claude-sonnet-5" ||
		parsedModel.data === "gpt-5.6-terra"
		? undefined
		: 0;
}

/** Convert a gateway decimal-dollar header to exact, safe integer micro-USD. */
export function parseCostMicroUsd(value: string | null): number {
	if (value === null) {
		throw new GatewayProtocolError(
			"Gateway response is missing x-pg-cost-usd.",
		);
	}
	const matched = COST_USD_PATTERN.exec(value);
	if (matched?.groups?.dollars === undefined) {
		throw new GatewayProtocolError(
			"Gateway x-pg-cost-usd must be a decimal USD value.",
		);
	}
	const dollars = BigInt(matched.groups.dollars);
	const fraction = (matched.groups.fraction ?? "").padEnd(6, "0");
	const microUsd = dollars * 1_000_000n + BigInt(fraction || "0");
	if (microUsd > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new GatewayProtocolError(
			"Gateway x-pg-cost-usd exceeds the safe integer range.",
		);
	}
	return Number(microUsd);
}

function requireHeader(response: Response, name: string): string {
	const value = response.headers.get(name);
	if (value === null || value.length === 0) {
		throw new GatewayProtocolError(`Gateway response is missing ${name}.`);
	}
	return value;
}

function parseNonStreamingHeaders(
	response: Response,
	allowCache: boolean,
): {
	requestId: string;
	cache: "hit" | "miss";
	costMicroUsd: number;
} {
	const requestId = requireHeader(response, "x-pg-request-id");
	if (!UUID_PATTERN.test(requestId)) {
		throw new GatewayProtocolError("Gateway x-pg-request-id must be a UUID.");
	}
	const cache = requireHeader(response, "x-pg-cache");
	if (cache !== "hit" && cache !== "miss") {
		throw new GatewayProtocolError("Gateway x-pg-cache must be hit or miss.");
	}
	const costMicroUsd = parseCostMicroUsd(response.headers.get("x-pg-cost-usd"));
	if (cache === "hit" && !allowCache) {
		throw new GatewayProtocolError(
			"Eval gateway response unexpectedly came from cache.",
		);
	}
	if (cache === "hit" && costMicroUsd !== 0) {
		throw new GatewayProtocolError(
			"Cached eval gateway response must have zero cost.",
		);
	}
	return {
		requestId,
		cache,
		costMicroUsd,
	};
}

function evalEndpoint(baseUrl: URL): URL {
	const pathBase = baseUrl.href.endsWith("/")
		? baseUrl
		: new URL(`${baseUrl.href}/`);
	return new URL("v1/chat/completions", pathBase);
}

function hasJsonContentType(response: Response): boolean {
	return (
		response.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() === "application/json"
	);
}

function safeGatewayErrorCode(payload: unknown): string | undefined {
	const parsed = SafeHttpErrorEnvelopeSchema.safeParse(payload);
	return parsed.success ? parsed.data.error.code : undefined;
}

export class GatewayClient {
	private readonly config: GatewayConfig;
	private readonly fetcher: FetchLike;

	constructor(
		config: GatewayConfig,
		fetcher: FetchLike = globalThis.fetch.bind(globalThis),
	) {
		this.config = config;
		this.fetcher = fetcher;
	}

	async complete(call: GatewayCall): Promise<GatewayResponse> {
		const parsedVars = EvalJsonRecordSchema.safeParse(call.vars);
		if (!parsedVars.success) {
			throw new GatewayProtocolError(
				"Eval gateway variables failed schema validation.",
			);
		}
		const request = {
			model: call.model,
			// Registry prompts define the conversation; evals never append caller turns.
			messages: [],
			stream: false,
			pg_prompt: call.prompt,
			pg_vars: parsedVars.data,
			pg_feature: "eval",
			pg_no_cache: call.allowCache !== true,
			...(temperatureForEvalModel(call.model) === 0 ? { temperature: 0 } : {}),
			...(call.reasoningEffort === undefined
				? {}
				: { reasoning_effort: call.reasoningEffort }),
			...(call.responseFormat === undefined
				? {}
				: { response_format: call.responseFormat }),
		};
		const parsedRequest = EvalGatewayRequestSchema.safeParse(request);
		if (!parsedRequest.success) {
			throw new GatewayProtocolError(
				"Eval gateway request failed schema validation.",
			);
		}

		let response: Response;
		try {
			response = await this.fetcher(evalEndpoint(this.config.baseUrl), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(parsedRequest.data),
				signal: call.signal,
			});
		} catch (error) {
			if (call.signal?.aborted || isAbortError(error)) {
				throw new GatewayAbortError();
			}
			throw new GatewayNetworkError("Gateway request could not be completed.");
		}
		if (!response.ok) {
			throw new GatewayHttpError(
				response.status,
				await this.readSafeHttpErrorCode(response, call.signal),
			);
		}

		if (!hasJsonContentType(response)) {
			throw new GatewayProtocolError(
				"Gateway response must have application/json content type.",
			);
		}
		const headers = parseNonStreamingHeaders(
			response,
			call.allowCache === true,
		);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			if (call.signal?.aborted || isAbortError(error)) {
				throw new GatewayAbortError();
			}
			if (!(error instanceof SyntaxError)) {
				throw new GatewayNetworkError(
					"Gateway response body could not be read.",
				);
			}
			throw new GatewayProtocolError("Gateway response is not valid JSON.");
		}
		const parsedResponse = EvalGatewayResponseSchema.safeParse(payload);
		if (!parsedResponse.success) {
			throw new GatewayProtocolError(
				"Gateway response failed schema validation.",
			);
		}
		return { ...headers, ...parsedResponse.data };
	}

	private async readSafeHttpErrorCode(
		response: Response,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> {
		try {
			const payload: unknown = await response.json();
			return safeGatewayErrorCode(payload);
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) {
				throw new GatewayAbortError();
			}
			if (error instanceof SyntaxError) {
				return undefined;
			}
			throw new GatewayNetworkError("Gateway response body could not be read.");
		}
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && error.name === "AbortError";
}
