import { z } from "zod";

const Env = z.object({
	PORT: z.coerce.number().default(8787),
	DB_PATH: z.string().default("./data/promptgate.db"),
	ADMIN_TOKEN: z.string().min(16),
	ANTHROPIC_API_KEY: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	CACHE_TTL_HOURS: z.coerce.number().default(24),
	DEFAULT_MAX_TOKENS: z.coerce.number().default(1024),
	// Request body hardening (IMPLEMENTATION_GUIDE.md §12): /v1 body size cap
	// and the upstream non-streaming AbortController timeout.
	BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
	UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export const config = Env.parse(process.env);
