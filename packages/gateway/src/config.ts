import { z } from "zod";

const Env = z.object({
	PORT: z.coerce.number().default(8787),
	DB_PATH: z.string().default("./data/promptgate.db"),
	ADMIN_TOKEN: z.string().min(16),
	ANTHROPIC_API_KEY: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	CACHE_TTL_HOURS: z.coerce.number().default(24),
	DEFAULT_MAX_TOKENS: z.coerce.number().default(1024),
});

export const config = Env.parse(process.env);
