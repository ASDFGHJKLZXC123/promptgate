import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { ChatResponseSchema } from "../../../packages/shared/dist/index.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const ENV_PATH = resolve(ROOT, ".env");
const KEY_PATH = resolve(ROOT, "data/phase8-latency.key");
const ADMIN_BASE_URL = "http://127.0.0.1:8787/admin/api";
const DIRECT_URL = "https://api.deepseek.com/v1/chat/completions";
const PROXIED_URL = "http://127.0.0.1:8787/v1/chat/completions";
const KEY_NAME = "phase8-latency-20260806";
const SAMPLE_COUNT = 20;
const REQUEST_TIMEOUT_MS = 150_000;

const requestBody = {
	model: "deepseek-v4-flash",
	messages: [{ role: "user", content: "Reply with exactly OK." }],
	temperature: 0,
	max_tokens: 8,
	stream: false,
	thinking: { type: "disabled" },
	user_id: "phase8_latency_20260806",
};
const canonicalBody = JSON.stringify(requestBody);

function parseDotenv(source) {
	const values = new Map();
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const equals = line.indexOf("=");
		if (equals < 1) continue;
		const name = line.slice(0, equals).trim();
		let value = line.slice(equals + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values.set(name, value);
	}
	return values;
}

function requireValue(values, name) {
	const value = values.get(name);
	if (!value) throw new Error(`${name} is not configured.`);
	return value;
}

async function readJsonResponse(response, label) {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`${label} returned HTTP ${response.status}.`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} returned invalid JSON.`);
	}
}

async function adminRequest(adminToken, path, init = {}) {
	const response = await fetch(`${ADMIN_BASE_URL}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-admin-token": adminToken,
			...init.headers,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	return readJsonResponse(response, `Admin ${init.method ?? "GET"} ${path}`);
}

function requireCacheMissUsage(parsed, label) {
	const usage = parsed.usage;
	if (!usage) throw new Error(`${label} omitted usage.`);
	const cached =
		usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
	if (cached !== 0) {
		throw new Error(`${label} did not prove zero provider-cache tokens.`);
	}
	if (
		usage.prompt_cache_miss_tokens !== undefined &&
		usage.prompt_cache_miss_tokens !== usage.prompt_tokens
	) {
		throw new Error(`${label} reported inconsistent provider-cache misses.`);
	}
	return usage;
}

async function callProvider({
	label,
	url,
	authorization,
	proxied,
	feature = "phase8_latency",
}) {
	const started = performance.now();
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${authorization}`,
			"content-type": "application/json",
			...(proxied
				? {
						"x-pg-feature": feature,
						"x-pg-no-cache": "true",
					}
				: {}),
		},
		body: canonicalBody,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const payload = await readJsonResponse(response, label);
	const elapsedMs = performance.now() - started;
	const parsed = ChatResponseSchema.parse(payload);
	if (parsed.choices.length === 0) {
		throw new Error(`${label} returned no choices.`);
	}
	const usage = requireCacheMissUsage(parsed, label);
	const cacheHeader = response.headers.get("x-pg-cache");
	const requestId = response.headers.get("x-pg-request-id");
	if (proxied && cacheHeader !== "miss") {
		throw new Error(`${label} did not return x-pg-cache: miss.`);
	}
	if (proxied && !requestId) {
		throw new Error(`${label} omitted x-pg-request-id.`);
	}
	return {
		elapsed_ms: Number(elapsedMs.toFixed(3)),
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		provider_cache_hit_tokens:
			usage.prompt_cache_hit_tokens ??
			usage.prompt_tokens_details?.cached_tokens ??
			null,
		provider_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? null,
		...(proxied ? { request_id: requestId } : {}),
	};
}

function nearestRankP95(samples) {
	if (samples.length !== SAMPLE_COUNT) {
		throw new Error(`Expected exactly ${SAMPLE_COUNT} measured samples.`);
	}
	const sorted = samples
		.map((sample) => sample.elapsed_ms)
		.sort((a, b) => a - b);
	return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function usageTotals(samples) {
	return samples.reduce(
		(totals, sample) => ({
			prompt_tokens: totals.prompt_tokens + sample.prompt_tokens,
			completion_tokens: totals.completion_tokens + sample.completion_tokens,
			total_tokens: totals.total_tokens + sample.total_tokens,
			provider_cache_hit_tokens:
				totals.provider_cache_hit_tokens +
				(sample.provider_cache_hit_tokens ?? 0),
			provider_cache_miss_tokens:
				totals.provider_cache_miss_tokens +
				(sample.provider_cache_miss_tokens ?? 0),
		}),
		{
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			provider_cache_hit_tokens: 0,
			provider_cache_miss_tokens: 0,
		},
	);
}

async function main() {
	const values = parseDotenv(await readFile(ENV_PATH, "utf8"));
	const adminToken = requireValue(values, "ADMIN_TOKEN");
	const deepSeekKey = requireValue(values, "DEEPSEEK_API_KEY");
	let keyId;
	let keyFileCreated = false;
	let result;
	let primaryError;

	try {
		const before = await adminRequest(adminToken, "/keys");
		if (before.some((key) => key.name === KEY_NAME)) {
			throw new Error(`${KEY_NAME} already exists; refuse ambiguous reuse.`);
		}
		const created = await adminRequest(adminToken, "/keys", {
			method: "POST",
			body: JSON.stringify({
				name: KEY_NAME,
				budget_micro_usd_month: 10_000,
				rate_limit_rpm: 60,
			}),
		});
		if (typeof created.plaintext_key !== "string") {
			throw new Error("Key creation omitted the plaintext handoff.");
		}
		const after = await adminRequest(adminToken, "/keys");
		const keyRow = after.find((key) => key.name === KEY_NAME);
		if (!keyRow || keyRow.disabled) {
			throw new Error("Created latency key metadata is missing or disabled.");
		}
		keyId = keyRow.id;

		const keyFile = await open(KEY_PATH, "wx", 0o600);
		keyFileCreated = true;
		try {
			await keyFile.writeFile(created.plaintext_key, "utf8");
		} finally {
			await keyFile.close();
		}
		if (((await stat(KEY_PATH)).mode & 0o777) !== 0o600) {
			throw new Error("Latency key handoff is not mode 0600.");
		}

		const startedAt = new Date().toISOString();
		const warmupDirect = await callProvider({
			label: "Direct warm-up",
			url: DIRECT_URL,
			authorization: deepSeekKey,
			proxied: false,
		});
		const warmupProxied = await callProvider({
			label: "Proxied warm-up",
			url: PROXIED_URL,
			authorization: created.plaintext_key,
			proxied: true,
			feature: "phase8_latency_warmup",
		});
		const direct = [];
		const proxied = [];
		const order = [];
		for (let index = 0; index < SAMPLE_COUNT; index += 1) {
			const directFirst = index % 2 === 0;
			order.push(directFirst ? "direct-proxied" : "proxied-direct");
			if (directFirst) {
				direct.push(
					await callProvider({
						label: `Direct sample ${index + 1}`,
						url: DIRECT_URL,
						authorization: deepSeekKey,
						proxied: false,
					}),
				);
				proxied.push(
					await callProvider({
						label: `Proxied sample ${index + 1}`,
						url: PROXIED_URL,
						authorization: created.plaintext_key,
						proxied: true,
					}),
				);
			} else {
				proxied.push(
					await callProvider({
						label: `Proxied sample ${index + 1}`,
						url: PROXIED_URL,
						authorization: created.plaintext_key,
						proxied: true,
					}),
				);
				direct.push(
					await callProvider({
						label: `Direct sample ${index + 1}`,
						url: DIRECT_URL,
						authorization: deepSeekKey,
						proxied: false,
					}),
				);
			}
		}
		const endedAt = new Date().toISOString();
		const directP95 = nearestRankP95(direct);
		const proxiedP95 = nearestRankP95(proxied);
		result = {
			method: {
				model: requestBody.model,
				prompt: requestBody.messages[0].content,
				sample_count_per_arm: SAMPLE_COUNT,
				excluded_warmups_per_arm: 1,
				interleaving: "10 direct-proxied blocks and 10 proxied-direct blocks",
				measurement: "client elapsed through complete buffered JSON body",
				p95: "nearest rank ceil(0.95 * N)",
				cache_rule:
					"PromptGate miss and zero provider-cache tokens for every call; invalidate rather than filter",
				canonical_body_sha256: createHash("sha256")
					.update(canonicalBody)
					.digest("hex"),
				canonical_body: requestBody,
				started_at: startedAt,
				ended_at: endedAt,
			},
			disposable_key: {
				id: keyId,
				name: KEY_NAME,
				budget_micro_usd_month: 10_000,
				rate_limit_rpm: 60,
			},
			warmups: {
				direct_ms: warmupDirect.elapsed_ms,
				proxied_ms: warmupProxied.elapsed_ms,
				proxied_request_id: warmupProxied.request_id,
			},
			order,
			direct,
			proxied,
			direct_usage_totals: usageTotals(direct),
			proxied_usage_totals: usageTotals(proxied),
			direct_p95_ms: directP95,
			proxied_p95_ms: proxiedP95,
			gateway_p95_delta_ms: Number((proxiedP95 - directP95).toFixed(3)),
		};
	} catch (error) {
		primaryError = error;
	}

	const cleanupErrors = [];
	if (keyId !== undefined) {
		try {
			await adminRequest(adminToken, `/keys/${keyId}`, {
				method: "PATCH",
				body: JSON.stringify({ disabled: true }),
			});
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (keyFileCreated) {
		try {
			await unlink(KEY_PATH);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (primaryError) throw primaryError;
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "Latency-key cleanup failed.");
	}
	result.disposable_key.disabled_after = true;
	console.log(JSON.stringify(result, null, 2));
}

await main();
