import { z } from "zod";

const Env = z.object({
	PORT: z.coerce.number().default(8787),
	DB_PATH: z.string().default("./data/promptgate.db"),
	ADMIN_TOKEN: z.string().min(16),
	ANTHROPIC_API_KEY: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	GEMINI_API_KEY: z.string().optional(), // optional at boot, per §3.1's step 9 foundation — Gemini routing/adapter land in step 11
	DEEPSEEK_API_KEY: z.string().optional(), // optional at boot — DeepSeek routing/adapter land in step 10
	CACHE_TTL_HOURS: z.coerce.number().finite().positive().default(24),
	DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
	// Request body hardening (IMPLEMENTATION_GUIDE.md §12): /v1 body size cap
	// and the upstream non-streaming AbortController timeout.
	BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
	UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export const config = Env.parse(process.env);
