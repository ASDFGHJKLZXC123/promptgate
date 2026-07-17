const PG_FIELD_PREFIX = "pg_";

/**
 * Strips every `pg_*` extension field (IMPLEMENTATION_GUIDE.md §5.1) from a
 * forwarded request body by key prefix rather than an explicit allowlist, so
 * it doesn't drift when new `pg_*` fields are added. Every other field,
 * known or unknown, passes through untouched — used both for OpenAI-routed
 * passthrough (§3.2) and, later, cache-key canonicalization (§3.4).
 */
export function stripPgFields(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const stripped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (!key.startsWith(PG_FIELD_PREFIX)) {
			stripped[key] = value;
		}
	}
	return stripped;
}
