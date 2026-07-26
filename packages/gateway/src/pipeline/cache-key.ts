import { createHash } from "node:crypto";
import { type ChatRequest, stripPgFields } from "@promptgate/shared";

function jsonPrimitive(value: null | boolean | number | string): string {
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new TypeError("Cache keys require JSON-serializable values.");
	}

	return JSON.stringify(value);
}

/**
 * Serializes JSON recursively with object keys sorted at every level. Request
 * bodies have already been parsed from JSON at this boundary, so unsupported
 * JavaScript values are rejected rather than silently creating a cache key for
 * a body the provider would receive differently.
 */
export function stableStringify(value: unknown): string {
	if (value === null) {
		return jsonPrimitive(value);
	}

	switch (typeof value) {
		case "boolean":
		case "number":
		case "string":
			return jsonPrimitive(value);
		case "object":
			if (Array.isArray(value)) {
				return `[${value.map(stableStringify).join(",")}]`;
			}

			return `{${Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(
					([key, entry]) => `${jsonPrimitive(key)}:${stableStringify(entry)}`,
				)
				.join(",")}}`;
		default:
			throw new TypeError("Cache keys require JSON-serializable values.");
	}
}

/**
 * Cache entries represent the exact provider-affecting request. PromptGate
 * extensions are stripped through the same helper used for forwarding, while
 * streaming transport controls are deliberately omitted so streaming and
 * non-streaming calls share an entry (IMPLEMENTATION_GUIDE.md §3.4).
 */
export function cacheKeyOf(req: ChatRequest): string {
	const forwarded = stripPgFields(req);
	const {
		stream: _stream,
		stream_options: _streamOptions,
		...keyBody
	} = forwarded;

	return createHash("sha256").update(stableStringify(keyBody)).digest("hex");
}
