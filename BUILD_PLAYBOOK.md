# PromptGate — Build Playbook

Begin-to-end build order, split out of `IMPLEMENTATION_GUIDE.md` (which holds the spec this executes). All `§n` references below point to sections of `IMPLEMENTATION_GUIDE.md`.

Ordered so every phase ends with something demoable; each is roughly a focused weekend. Deliverable mapping: D1 = phases 1–3, D2 = phase 4, D3 = phases 5–6, D4 = phase 7, D5 = phase 8.

| # | Phase | Scope | Acceptance criteria |
|---|---|---|---|
| 0 | Scaffold | monorepo, Biome/Vitest/tsconfig, migration runner, docker-compose, `ci.yml` (lint+unit) | `docker compose up` → `GET /healthz` 200; CI green on empty test |
| 1 | OpenAI-compatible non-streaming | auth keys, four-provider taxonomy/pricing, OpenAI + Gemini + DeepSeek adapters, routing, non-streaming proxy, metering, `requests` logging | the same OpenAI SDK client reaches each configured phase-1 provider; every live row has tokens + persisted micro-USD cost matching the provider's official published rates; unavailable activation checks are named as deferred |
| 2 | Anthropic + four-provider streaming | Anthropic adapter (§3.2 incl. `response_format` translation), SSE streaming parity across all four providers, first-token latency, abort handling | the same client streams through every configured provider; usage/cost is exact when reported; unavailable live checks are deferred explicitly; `TODO(verify)` on tools resolved |
| 3 | Cache, limits, budgets | exact-match cache (incl. stream replay), token bucket, budget check, error taxonomy | identical request twice → second is `x-pg-cache: hit`, cost 0, no provider call; key over budget → 429 `budget_exceeded`; over rpm → 429 `rate_limited` |
| 4 | Prompt registry | schema `004_registry.sql`, immutability trigger, `pg_prompt`/`pg_vars` resolution, admin endpoints, diff + labels | create v1/v2, point `prod` at v1, request via `pg_prompt: x@prod` uses v1; move label → next request uses v2 with no client change; diff endpoint returns sane unified diff |
| 5 | Eval harness | `pg-eval` CLI, YAML loader, deterministic asserts, judge via gateway, baseline compare, run persistence | seeded regression (deliberately worsen candidate prompt) → exit 1 with readable failure table; good prompt → exit 0; runs visible in DB |
| 6 | CI gate | `eval-gate.yml`, ci fixtures/seeding, budget-capped CI key, PR summary output | a PR that degrades `safety_screen@candidate` fails the check; the failure message names the failing cases |
| 7 | Dashboard | Vite app, 4 screens (§8), admin-token flow | all panels render from real local traffic; label rollback works from the UI; drift chart shows ≥2 eval runs with a version-change annotation |
| 8 | Dogfood + writeup | §9 plan, README case study, screenshots | web_builder_llm serving real usage through PromptGate for a week; README shows the money/quality charts |
| S | Stretch (explicitly not v1) | semantic cache, Ollama fifth provider, git export of registry, tool-call translation (unless promoted in phase 2), chunked cache replay | — |

Sequencing rule: **do not start phase 7 before 5** — the drift chart is only meaningful with eval runs in the DB, and building dashboards against empty tables invites fake-data drift.

The table above is the index; the playbook below is the actual begin-to-end build order. Conventions: every numbered step ends with tests green and a commit; `verify` blocks are literal commands with expected outcomes; file paths are relative to repo root; code blocks show interfaces and the tricky parts — routine glue is yours to write, but every connection point between components is spelled out here so none is left to interpretation.

### Phase 0 — Scaffold

1. **Create the workspace — in place.** The repo root is this existing `PromptGate/` folder (the planning docs become the repo's docs; do **not** `mkdir` a nested project):
   ```bash
   cd <this folder>   # the one containing IMPLEMENTATION_GUIDE.md
   git init
   corepack enable
   pnpm init
   echo "22" > .nvmrc
   ```
   Create `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - packages/*
   ```
   Root `package.json` scripts: `"dev": "pnpm --filter @promptgate/gateway dev"`, `"test": "vitest run"`, `"lint": "biome check ."`, `"build": "pnpm -r build"`. (Always filter by the full package name — `--filter gateway` doesn't match `@promptgate/gateway`.)

2. **Shared TS/lint config.** `tsconfig.base.json` with `"strict": true, "module": "NodeNext", "moduleResolution": "NodeNext", "target": "ES2022"`; `biome.json` defaults. Each package gets a 3-line `tsconfig.json` extending base.

3. **Stub the four packages.** `packages/{shared,gateway,evals,dashboard}` each with `package.json` (`"name": "@promptgate/shared"` etc., `"type": "module"`) and empty `src/index.ts`. gateway deps: `fastify better-sqlite3 zod`; dev: `tsx vitest @types/better-sqlite3`.

4. **Config loader.** `packages/gateway/src/config.ts` — Zod-parse `process.env` once at boot, crash loudly on missing keys:
   ```ts
   const Env = z.object({
     PORT: z.coerce.number().default(8787),
     DB_PATH: z.string().default("./data/promptgate.db"),
     ADMIN_TOKEN: z.string().min(16),
     ANTHROPIC_API_KEY: z.string().optional(),  // optional at boot — phase 0 must run without provider keys;
     OPENAI_API_KEY: z.string().optional(),     // adapters throw provider_error at call time if theirs is missing
     GEMINI_API_KEY: z.string().optional(),
     DEEPSEEK_API_KEY: z.string().optional(),
     CACHE_TTL_HOURS: z.coerce.number().default(24),
     DEFAULT_MAX_TOKENS: z.coerce.number().default(1024),
   });
   export const config = Env.parse(process.env);
   ```
   Add `.env.example` with every key; `.env` gitignored.

5. **DB + migration runner.** `packages/gateway/src/db/index.ts` opens better-sqlite3 with `db.pragma("journal_mode = WAL")` **and `db.pragma("foreign_keys = ON")`** (SQLite doesn't enforce FKs otherwise — §4). `src/db/migrate.ts`:
   ```ts
   export function migrate(db: Database) {
     db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
     const done = new Set(db.prepare(`SELECT name FROM _migrations`).all().map((r: any) => r.name));
     for (const f of readdirSync(MIGRATIONS_DIR).sort()) {
       if (done.has(f)) continue;
       db.transaction(() => {
         db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
         db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(f);
       })();
     }
   }
   ```
   Copy §4's `001_core.sql` into `src/db/migrations/`.

6. **Server skeleton.** `src/server.ts` exports `buildServer(): FastifyInstance` (registers routes, runs `migrate`) — tests import this; `src/index.ts` calls `buildServer().listen({ port: config.PORT, host: "0.0.0.0" })`. Only route so far: `GET /healthz → { ok: true }`. First Vitest test: inject `GET /healthz`, expect 200.

7. **Docker.** Multi-stage `Dockerfile` (pnpm build → node:22-slim runtime; better-sqlite3 is native, so build deps in stage 1 only). `docker-compose.yml`:
   ```yaml
   services:
     gateway:
       build: .
       ports: ["127.0.0.1:8787:8787"]
       env_file: .env
       environment: { DB_PATH: /data/promptgate.db }
       volumes: ["./data:/data"]
       healthcheck:
         # node:22-slim has no wget/curl — use node's own fetch
         test: ["CMD", "node", "-e", "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
         interval: 5s
         retries: 10
   ```

8. **CI.** `.github/workflows/ci.yml`: checkout → pnpm install → `pnpm lint` → `pnpm test` → `pnpm build`. Push, confirm green.

**Verify phase 0:**
```bash
pnpm test                      # healthz test passes
docker compose up -d --wait && curl -s localhost:8787/healthz   # {"ok":true}
```

### Phase 1 — OpenAI-compatible passthrough (non-streaming)

Build order matters here: types → pricing → keys → auth → adapter → route → metering. Each step is testable before the next.

1. **Wire types in `shared`.** Zod schemas for the OpenAI chat request/response (only fields we touch: `model, messages, temperature, top_p, max_tokens, stream, stop, response_format, reasoning_effort, usage, choices`) plus the `pg_*` extension fields (§5.1). Export inferred TS types. Everything downstream imports these — never redefine wire shapes locally.

2. **Pricing seed.** `packages/gateway/scripts/seed-pricing.ts` upserts rows into `model_pricing` from a checked-in `pricing.json`. `TODO(build-time)`: fill `pricing.json` from every approved provider's current pricing page; include only models the gateway will actually route, including the then-locked `gpt-5.6-terra` eval judge. The later Phase 5 judge amendment does not delete an already supported/priced route.

3. **Key management (admin).** `src/admin/keys.ts`:
   - keygen: `"pg-" + randomBytes(24).toString("hex")`, store `sha256(key)`, return plaintext **once** in the POST response.
   - `POST /admin/api/keys`, `GET /admin/api/keys`, `PATCH /admin/api/keys/:id` per §5.2.
   - Admin auth = Fastify `onRequest` hook on the `/admin` prefix comparing `x-admin-token` with `config.ADMIN_TOKEN` (timing-safe compare).

4. **Client auth hook.** `src/pipeline/auth.ts`: extract Bearer token, hash, look up `api_keys` (reject `disabled`), attach row to `request.ctx`. Wrong/missing key → 401 `invalid_pg_key` in OpenAI error format (§3.6) — write the error-formatter helper now, everything uses it.

5. **Provider seam.** `src/providers/types.ts` — this interface is the contract phase 2 fills in; get it right now:
   ```ts
   export type ProviderName = "openai" | "anthropic" | "gemini" | "deepseek";
   export interface ProviderAdapter {
     name: ProviderName;
     complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
     stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk>;  // phase 2
   }
   ```
   `src/providers/routes.ts` = the §3.1 prefix map + "model must exist in model_pricing" check (reject with `unknown_model`).

6. **OpenAI adapter (non-streaming).** `src/providers/openai.ts`: `fetch` to `https://api.openai.com/v1/chat/completions`, swap auth header, forward body **minus all `pg_*` fields** (strip via one shared `stripPgFields()` — used by cache-keying later too). Wrap in the retry helper (2 retries on 429/5xx, jittered 250ms/1s).

7. **Migration 002 + the route.** Copy `002_request_identity.sql` in first (§4): `ALTER TABLE requests ADD COLUMN request_id TEXT` plus a partial unique index (`WHERE request_id IS NOT NULL`) — nullable at the schema level for legacy-row compatibility, but the pipeline DAO must reject an absent/non-UUID `request_id` before any SQL runs, so every gateway-created row still gets one. `POST /v1/chat/completions` in `src/pipeline/handler.ts` — the pipeline is an explicit function chain, not middleware magic:
   ```ts
   // auth (hook) → validate body → resolveProvider → [cache: phase 3] → adapter.complete
   //   → meter(usage) → reply … then logRequest(ctx) in reply's onSend/after
   ```
   Generate `crypto.randomUUID()` exactly once, at pipeline entry — that same value is both the `x-pg-request-id` header and the persisted `requests.request_id`, never two separately derived ids. Metering (integer micro-USD, §3.5): `cost_micro_usd = Math.round(usage.prompt_tokens * in_micro_rate / 1e6) + Math.round(usage.completion_tokens * out_micro_rate / 1e6)` with rates from the date-effective pricing lookup (`WHERE model = ? AND effective_from <= date('now') ORDER BY effective_from DESC LIMIT 1`). Insert the `requests` row after the response is sent (a route-level Fastify `onResponse` hook) so logging never adds latency; a logging failure is caught/logged and must never alter the already-sent response. Set response headers `x-pg-request-id`, `x-pg-cache: miss`, and `x-pg-cost-usd` (non-streaming only, §5.1).

8. **`GET /v1/models`** from `model_pricing` distinct models, OpenAI list format.

9. **Four-provider foundation (human-approved scope amendment, 2026-07-25 — supersedes decision #2's original 2-provider lock; no new routing or adapter code).** Add optional `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` to `config.ts` and `.env.example`. Widen `ProviderAdapter["name"]` / `ProviderName` (`src/providers/types.ts`) and every `provider` union copied from it (`ModelPricingRow`, `CurrentModelRow`, the pricing seed's `z.enum`) to `"openai" | "anthropic" | "gemini" | "deepseek"`. Add `003_provider_pricing.sql`: nullable `model_pricing.cached_input_micro_usd_per_mtok` (same nullable-ALTER-TABLE reasoning as `002_request_identity.sql`). Seed the human-approved rows, `effective_from: "2026-07-25"`: `gemini-2.5-flash-lite` (input 100000 / output 400000 micro-USD per Mtok, no cached rate) and `deepseek-v4-flash` (cache-miss input 140000 / cached input 2800 / output 280000). Extend `ChatUsageSchema` (`@promptgate/shared`) with the optional paired `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` — both present or both absent, and when both present they must sum to `prompt_tokens` (Zod `.refine`, §3.5). Extend `meterUsage` to price the cache-hit/cache-miss input split exactly when both usage fields and a `cached_input_micro_usd_per_mtok` rate exist for the model, rounding cache-hit input, cache-miss input, and output as three independent billing components before summing; otherwise price all input tokens at the ordinary rate — never a silent partial split. The pricing JSON parser must default an omitted cached rate to `null` so older custom files still seed. Renumber the still-uncommitted, documented-only registry/eval migrations from `003_registry.sql`/`004_evals.sql` to `004_registry.sql`/`005_evals.sql` (IMPLEMENTATION_GUIDE.md §4, this file's phase 4 step 1) since `003` is now taken by pricing. No live provider calls.

10. **DeepSeek non-streaming adapter.** `src/providers/deepseek.ts` calls the official OpenAI-compatible `https://api.deepseek.com/v1/chat/completions` endpoint with Bearer `DEEPSEEK_API_KEY`, which remains optional until adapter invocation. Reuse `stripPgFields`, bounded retry/abort behavior, and the shared OpenAI response schema; retain caller-supplied fields including `thinking` instead of silently changing semantics. Normalize and preserve `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` so step 9's meter can apply the approved split rates. Tests use an injected fake fetch only: URL/auth/body, `pg_*` stripping, schema failure, missing-key error, retry, abort, and cache-usage parsing. No live call.

11. **Gemini non-streaming adapter.** `src/providers/gemini.ts` calls the official OpenAI-compatible `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` endpoint with Bearer `GEMINI_API_KEY`, optional until invocation. Reuse the compatible request/response core only where the official contract matches; keep a provider-specific wrapper for endpoint, credential, errors, and future translation. Gemini opts HTTP 408 into the same bounded jittered retry schedule used for 429/5xx; OpenAI and DeepSeek retain the shared default. Tests use an injected fake fetch only and cover the same boundary/error cases as step 10 plus the documented `extra_body.google` passthrough and 408 isolation. No live call.

12. **Four-provider integration.** Add `^deepseek-` and `^gemini-` routes, wire both adapters into the server's `ProviderAdapterRegistry`, and reject `unknown_model` when the model's current pricing row names a provider different from the prefix-selected provider. Keep `/v1/models` as the deterministic list of currently priced models regardless of key availability; an unavailable key fails only when that model is called. Add `openai` to the root dev dependencies so the literal SDK verify has a repository-pinned client rather than relying on a global install. Add offline pipeline coverage for both new routes, provider/pricing mismatch, adapter selection, exact metering/logging, and no-network model listing.

**Human-approved pre-verify correction (2026-07-25; not a new numbered step).** Keep `gemini-2.5-flash-lite` supported and add `gemini-2.5-flash` as the Gemini verification/eval target at the official standard text/image/video rates: input 300000, cached input 30000, output 2500000 micro-USD per Mtok, effective 2026-07-25. Extend `ChatUsageSchema` to validate `usage.prompt_tokens_details.cached_tokens <= prompt_tokens`; when DeepSeek supplies both that compatible field and its explicit hit/miss pair, the cache-hit counts must agree. Validate `total_tokens >= prompt_tokens + completion_tokens`. Extend `meterUsage` to derive Gemini cache misses as `prompt_tokens - cached_tokens`, normalize Gemini's billable output (visible candidates plus hidden thinking) as `total_tokens - prompt_tokens`, and apply the same independently rounded cached-input/ordinary-input/output formula; leave the provider response forwarded to clients unchanged. The approved Phase 1 activation check is text-only; audio and nonstandard service tiers have different prices and remain outside this row.

**Verify phase 1 (amended 2026-07-25 for steps 9–12):** run the OpenAI-compatible client below for each configured phase-1 provider. Gemini and DeepSeek are the intended live targets for the current build; run OpenAI too if its key is configured. Anthropic remains explicitly deferred until its phase-2 adapter exists. A missing key is an explicit deferred activation check, not a false pass; record the live/deferred matrix and reason in `PROGRESS.md`:
```bash
set -a
. ./.env
set +a
docker compose up -d --wait
KEY=$(curl -s -X POST localhost:8787/admin/api/keys -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"phase1-verify-$(date +%s)\"}" | jq -r .plaintext_key)
verify_model() {
  ENV_NAME="$1"
  MODEL="$2"
  if [ -z "$(printenv "$ENV_NAME")" ]; then
    echo "DEFERRED $MODEL: $ENV_NAME is not configured"
    return
  fi
  KEY="$KEY" MODEL="$MODEL" node --input-type=module -e '
    import OpenAI from "openai";
    const c = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: process.env.KEY });
    const r = await c.chat.completions.create({
      model: process.env.MODEL,
      messages: [{ role: "user", content: "say hi" }]
    });
    console.log(process.env.MODEL, r.choices[0].message.content, r.usage);
  '
}
verify_model GEMINI_API_KEY gemini-2.5-flash
verify_model DEEPSEEK_API_KEY deepseek-v4-flash
verify_model OPENAI_API_KEY gpt-5.6-luna
echo "DEFERRED claude-sonnet-5: Anthropic adapter is Phase 2"
sqlite3 data/promptgate.db "SELECT model, input_tokens, output_tokens, cost_micro_usd, status FROM requests ORDER BY id DESC LIMIT 3;"
```
Every executed call must return a correct response. Its row must be `status='ok'`, contain non-null tokens/cost, and its persisted micro-USD cost (÷1e6 for USD) must match an independently recorded calculation from the provider's official published rates to the 4th decimal. **Human-approved Phase 1 evidence amendment (2026-07-25):** this published-rate reconciliation plus the persisted row is the required Phase 1 cost evidence in place of a provider account-dashboard artifact.

### Phase 2 — Anthropic adapter + four-provider streaming

1. **Author contract fixtures first — no network (human-approved fixture-timing amendment, 2026-07-25).** Before implementation, create one upstream provider-specific fixture per provider per mode (non-streaming JSON and a raw streaming SSE transcript saved as `.txt`) from each provider's current official contract and write them to `packages/gateway/test/fixtures/`. Mark every fixture `live_capture_pending` regardless of local key availability: `ORCHESTRATOR.md` permits live calls only during the phase Verify window, so step 1 itself must remain offline. All adapter unit tests run against fixtures — no network in tests, ever (§11). During the final Phase 2 Verify window, replace the pending fixtures for configured providers with sanitized bounded live captures and clear only those providers' markers; unavailable providers retain their official-contract fixtures and explicit pending markers.

2. **Anthropic non-streaming.** `src/providers/anthropic.ts` — request translation table (§3.2): extract/concat `system` messages → `system` param; `max_tokens ??= config.DEFAULT_MAX_TOKENS`; **`response_format` → Anthropic structured outputs via `output_config.format`** (confirm the current param name in Anthropic's structured-outputs docs); map response: `content[0].text` → message, `stop_reason` (`end_turn→stop`, `max_tokens→length`) → `finish_reason`, `usage.{input,output}_tokens` → `{prompt,completion}_tokens`. Reject `tools` with 400 (per §3.2) — and **resolve the `TODO(verify)` now**: grep web_builder_llm for `tools:`; if present, build tool translation in this phase.

3. **OpenAI-compatible streaming (OpenAI, Gemini, DeepSeek).** Forward with `stream: true` **and inject `stream_options: { include_usage: true }`**. Pipe SSE bytes to the client unbuffered; tee-parse each `data:` line just enough to (a) timestamp the first content delta → `first_token_ms`, and (b) capture usage from the terminal/final usage-bearing chunk. Preserve DeepSeek's cache-hit/cache-miss token fields. Validate every provider's transcript separately; compatibility is a tested contract, not an assumption.

4. **Anthropic streaming.** Translate the event stream into OpenAI chunk frames:
   | Anthropic event | Emit |
   |---|---|
   | `message_start` | role chunk; stash `usage.input_tokens` |
   | `content_block_delta` (`text_delta`) | content delta chunk |
   | `message_delta` | stash `stop_reason` + `usage.output_tokens` |
   | `message_stop` | finish chunk + usage chunk (combined stash) + `data: [DONE]` |

5. **Abort handling.** One `AbortController` per request; `request.raw.on("close", ...)` aborts upstream; log row with `status='client_aborted'` and `cost_estimated=1` if no usage arrived (§3.5's estimator: `chars/4` is fine, it's flagged).

6. **`GET /v1/requests/:request_id/usage`** (§5.1): authenticated with the same pg key that made the original request (a key can only read its own rows — look up by `request_id` **and** `api_key_id`, 404 otherwise so key ownership never leaks via a distinguishable error). This belongs in phase 2, not phase 1, because it exists specifically to serve the cost a live stream's headers can't carry (headers are sent before usage exists); a non-streaming response already has `x-pg-cost-usd`.

**Verify phase 2:** run the same SDK snippet with `stream: true` for every implemented provider whose key is configured (`claude-*`, `gpt-*`, `gemini-*`, `deepseek-*`) — chunks print incrementally. Record unavailable-provider activation checks as deferred with the missing key named; do not mark them live-green. Then:
```bash
sqlite3 data/promptgate.db "SELECT model, streamed, first_token_ms, total_ms, cost_micro_usd FROM requests ORDER BY id DESC LIMIT 4;"
```
Every executed provider row: `streamed=1`, non-null tokens/cost, `first_token_ms < total_ms`. Checkpoint A audits code parity across all four plus the explicit live/deferred matrix.

Fixture activation is part of this Verify window and is the only Phase 2 point at which direct provider capture is allowed: make exactly one bounded non-streaming request and one bounded streaming request to each configured provider, strip credentials and provider-generated identifiers, replace that provider's official-contract fixtures, and clear its `live_capture_pending` markers. Providers without keys remain explicitly pending. If a live capture differs from the authored contract fixture, reconcile the fixture or code, rerun the complete offline suite, commit the correction, rebuild the final code state, and rerun the literal gateway Verify above from the start.

### Phase 3 — Cache, rate limits, budgets

1. **Canonical cache key — hash the whole forwarded body, not an allowlist** (§3.4: any param that reaches the provider can change the output):
   ```ts
   export function cacheKeyOf(req: ChatRequest): string {
     const { stream, stream_options, ...c } = stripPgFields(req);  // exclude ONLY transport + pg_* fields
     return createHash("sha256").update(stableStringify(c)).digest("hex");
   }
   ```
   `stableStringify` = recursive sorted-key JSON. Property tests: shuffling key insertion order never changes the hash; changing ANY forwarded field (`seed`, `n`, `logit_bias`, …) always does.

2. **Read path.** After provider resolution, before the adapter call (and **after** prompt resolution once phase 4 lands — the key must hash resolved messages): if `!pg_no_cache`, look up unexpired entry → on hit, bump `hit_count`/`last_hit_at`, log row with `cache_hit=1, cost_micro_usd=0`, respond with stored JSON (`x-pg-cache: hit`, and `x-pg-cost-usd: 0` is fine here — the response isn't streamed live). Streaming request + hit → synthetic replay: one content chunk, one usage chunk, `[DONE]`.

3. **Write path.** On successful completion (streaming: after assembly in the tee-parser), insert `{hash, model, response_json, usage_json, priced_cost_micro_usd, expires_at = now + CACHE_TTL_HOURS}` — the priced cost feeds "$ saved" (§3.4). Hourly `setInterval` sweep deletes expired rows.

4. **Rate limiter.** `src/pipeline/ratelimit.ts` — token bucket per key id, in-memory `Map`:
   ```ts
   class TokenBucket { constructor(private rpm: number) {...}
     take(): boolean  // refill = rpm/60 per second, cap = rpm
   }
   ```
   Over limit → 429 `rate_limited` + `retry-after` header. (In-memory is correct here: single process by design, §3.)

5. **Budget: reserve-then-reconcile circuit breaker** (§3.5 — a plain spend-sum lets concurrent requests outrun rows already being written; provider-side spend limits remain the absolute monetary wall). `src/pipeline/budget.ts`:
   ```ts
   class BudgetGuard {
     // settled(keyId): SUM(cost_micro_usd) this month from DB, memoized briefly;
     //   invalidate(keyId) called on admin PATCH and on every reconcile
     reserve(keyId, budgetMicroUsdMonth, estMicroUsd): Reservation | "over_budget"
     //   admits iff settled + inFlight + est <= budget; est = ceil(chars/4) input tokens
     //   × input rate + (max_tokens ?? DEFAULT_MAX_TOKENS) × output rate
     reconcileAfterDurableLog(r: Reservation, actualMicroUsd): void
     retainDebt(r: Reservation, knownActualMicroUsd: number): void
   }
   ```
   Compute the estimate only after validation, provider/pricing resolution, and future prompt resolution. `chars/4` is an estimate, not a tokenizer upper bound, so describe this as a concurrency-safe in-process circuit breaker rather than an absolute provider-billing cap. Over budget → 429 with `code: budget_exceeded, type: insufficient_quota`. Keep each reservation active through every outcome, including cache hits and aborts, until the `requests` row is durably written; then reconcile and invalidate the memo. If that insert fails, retain at least `max(reserved, known_actual)` as in-memory debt and fail closed for the key. Admin PATCH invalidates settled/budget memo state but never active reservations.

6. **Pipeline order — now fixed for good:** auth → request-log init → rate limit → validate → resolveProvider + pricing → [promptResolve: phase 4] → budget reserve → cache read → adapter → meter → cache write → durable log + budget reconcile.

**Verify phase 3** (settings changes go through the admin API — it invalidates the budget memo; direct sqlite UPDATEs don't and will appear not to work):
```bash
# cache: identical request twice
curl -s ... -D - | grep x-pg-cache     # miss, then hit; second row cost_micro_usd = 0
sqlite3 data/promptgate.db "SELECT cache_hit, cost_micro_usd FROM requests ORDER BY id DESC LIMIT 2;"
# budget: floor it via the admin API (memo invalidated server-side), expect immediate refusal
curl -s -X PATCH localhost:8787/admin/api/keys/1 -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"budget_micro_usd_month": 1}'
curl -s ... | jq .error.code           # "budget_exceeded" on the very next call (reservation admits nothing)
# rate limit: PATCH rate_limit_rpm=2, fire 5 requests in a loop → "rate_limited" on 3rd+
# burst-overspend regression test: restore budget to a value < 2 reservation estimates, fire 10 in parallel →
#   exactly the reservation-affordable number reach the provider; the rest are 429s (the in-process concurrency proof)
```

### Phase 4 — Prompt registry

1. **Migration + immutability trigger.** Copy §4's `004_registry.sql` in (renumbered from `003` on 2026-07-25 — phase 1 step 9 took `003_provider_pricing.sql`), appending:
   ```sql
   CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE ON prompt_versions
   BEGIN SELECT RAISE(ABORT, 'prompt_versions is immutable'); END;
   CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions
   BEGIN SELECT RAISE(ABORT, 'prompt_versions is immutable'); END;
   ```

2. **Template engine** in `shared` (§1: ~30 lines, no deps): replace `{{name}}`, collect misses:
   ```ts
   export function renderTemplate(tpl: string, vars: Record<string, string>):
     { text: string; missing: string[] }
   ```
   Unit tests: missing var, extra var (ignored), `{{` literal escape (`\{{`).

3. **Registry DAO.** `src/registry/dao.ts`: `createPrompt(slug, desc)`, `addVersion(promptId, messages, variables, notes)` (version = `1 + COALESCE(MAX(version),0)`, single transaction), `setLabel(promptId, label, version)` (transaction: upsert `prompt_labels` + insert `label_history` with old version), `resolveRef("slug@prod" | "slug@3")` → `{promptId, version, messages_json, variables_json}` or null.

4. **Admin endpoints** from §5.2 (prompts CRUD-ish, versions, labels, diff). Diff endpoint: pretty-print both versions' messages (2-space JSON, stable key order), `createTwoFilesPatch` from the `diff` package, return as `text/plain`.

5. **Pipeline `promptResolve` step.** If `pg_prompt` present: `resolveRef` (404 `prompt_not_found`), check every `required` var is in `pg_vars` (400 `prompt_var_missing`, naming the vars), render each template message, **prepend** rendered messages to the request's `messages` (§5.1), set `ctx.promptRef` so the log row records `(prompt_id, prompt_version)`.

**Verify phase 4** (the rollback demo — this is deliverable 2's acceptance test):
```bash
AT="x-admin-token: $ADMIN_TOKEN"; H='content-type: application/json'
curl -s -X POST localhost:8787/admin/api/prompts -H "$AT" -H "$H" -d '{"slug":"greet"}'
curl -s -X POST localhost:8787/admin/api/prompts/greet/versions -H "$AT" -H "$H" \
  -d '{"messages_json":[{"role":"system","content":"Reply in English. {{style}}"}],"variables_json":[{"name":"style","required":true}]}'   # v1
curl -s -X POST localhost:8787/admin/api/prompts/greet/versions -H "$AT" -H "$H" \
  -d '{"messages_json":[{"role":"system","content":"Reply in French. {{style}}"}],"variables_json":[{"name":"style","required":true}]}'    # v2
curl -s -X PUT localhost:8787/admin/api/prompts/greet/labels/prod -H "$AT" -H "$H" -d '{"version":2}'
# client call with pg_prompt greet@prod + pg_vars {"style":"tersely"} → French reply
curl -s -X PUT localhost:8787/admin/api/prompts/greet/labels/prod -H "$AT" -H "$H" -d '{"version":1}'
# same client call, zero client changes → English reply. That's the rollback story.
sqlite3 data/promptgate.db "SELECT prompt_id, prompt_version FROM requests ORDER BY id DESC LIMIT 2;"
```

### Phase 5 — Eval harness (`pg-eval`)

Human-approved gate amendment (2026-07-27): Phase 5 runs exactly `gemini-2.5-flash` and `deepseek-v4-flash` as targets and cross-judges them. DeepSeek judges Gemini output, Gemini judges DeepSeek output, and neither model judges itself. OpenAI and Anthropic remain supported gateway providers but are not Phase 5 target or judge models. Phase 6's later four-provider requirement is unchanged.

1. **Package scaffold.** `packages/evals`: deps `yaml zod`, bin entry `pg-eval` → `src/cli.ts` (hand-rolled arg parsing or `node:util` parseArgs — no commander needed for 3 commands: `run`, `seed-ci`, `comment`).

2. **Dataset schema.** Zod mirror of §7.1's YAML (description, prompts as registry refs, providers/models list, `defaultTest.threshold` — promptfoo's actual path, not under `options` — tests[] with description/vars/assert[]). Loader resolves `file://` javascript asserts relative to the dataset file and computes `dataset_hash` (sha256 of the file). Every test gets a stable `id`: explicit `id:` field or slugified description — warn on collision.

3. **Assertion registry.** `src/assertions.ts`:
   ```ts
   type AssertFn = (output: string, arg: unknown, ctx: CaseCtx)
     => Promise<{ pass: boolean; score?: number; detail: string }>;
   export const ASSERTIONS: Record<string, AssertFn> = {
     equals, contains, icontains, regex, "is-json": isJson,
     "json-schema": jsonSchema, javascript: jsFile, "llm-rubric": llmRubric };
   ```
   Order within a case: deterministic ones first, short-circuit on fail, `llm-rubric` last (§7.2 cost control).

4. **Gateway client.** Thin fetch wrapper (base URL + key from flags/env). Phase 5 target and judge calls use `temperature: 0`; judge calls send no provider-specific reasoning-effort override. All calls set **`pg_no_cache: true`** (persisted quality runs must hit live models — cached responses conceal provider drift; `--allow-cache` is for local harness development only) and `pg_feature: "eval"`.

5. **Judge.** `llmRubric` calls the gateway through the locked cross-provider map: **Gemini target → DeepSeek judge; DeepSeek target → Gemini judge**. It uses registry prompt `judge_rubric_v1@1` (create it via seed script — the rubric prompt is itself versioned, per §7.2), `response_format: {type: "json_object"}`, and parses `{pass, score, rationale}`. Reject every unapproved target model before admin mutation or provider traffic, and reject any self-judge mapping. Malformed judge output = infrastructure error (exit 2), not a case failure.

6. **Run + persist + compare.** At start: resolve every label ref to a concrete version (frozen for the whole run, §7.2) and upsert the dataset via `POST /admin/api/evals/datasets`. Runner creates **one `eval_runs` row per model**, loops that model's cases, persists run + results via `POST /admin/api/evals/runs` (admin token from `--admin-token`/`PG_ADMIN_TOKEN` — eval traffic and persistence use different credentials, §5.2). `--baseline prod` is **paired**: run the baseline ref first, then the candidate, compare within the pair (works in a fresh CI database); `--baseline-from-history` for cheap local iteration only. Apply §7.2's exit-code contract verbatim. Print the markdown summary table (case, model, pass, score, first failed assertion detail).

7. **Golden dataset.** Execute amended §7.3: preserve the recoverable carematch probes, derive additional seeds from the immutable safety policy without calling them verbatim originals, expand with Claude Fable 5 / high, and hand-review every final label. Commit `safety_screening.yaml`, `asserts/*.js`, and `docs/evidence/phase-5-seed-provenance.md` together.

**Verify phase 5:**
```bash
pnpm --filter @promptgate/evals exec pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod \
  --gateway http://localhost:8787 --key $KEY --admin-token $ADMIN_TOKEN
echo $?    # 0 on the good prompt
# now deliberately break the candidate prompt (new version that drops the safety instruction), re-point label:
echo $?    # 1, with a table naming exactly which cases failed
```
Plus the §11 meta-test: fixture dataset + fake provider → assert exact pass/fail/score output.

### Phase 6 — CI gate

1. **Seed script.** `pg-eval seed-ci` (runs against a fresh gateway): create key `ci-evals` with `budget_micro_usd_month: 1000000` ($1 — §7.4's circuit breaker, enforced by reserve-then-reconcile), create `safety_screen` + `judge_rubric_v1` prompts from checked-in JSON fixtures (`packages/evals/fixtures/prompts/*.json`), set labels `prod` and `candidate`, register the dataset. Idempotent (safe to re-run).

2. **Secrets.** Create **dedicated CI keys at each provider with provider-side spend limits** (the gateway's $1 budget can't stop PR code from calling providers directly with the env keys) and add them as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `DEEPSEEK_API_KEY` repo secrets. The Phase 5 Gemini/DeepSeek amendment does not waive Phase 6's four-provider requirement; any Phase 6 provider omission needs a separate human gate amendment. `ADMIN_TOKEN` for CI is generated per-run — the workflow writes it and the provider keys into `.env` so **docker compose actually passes them to the gateway container** (secrets set only on a step's `env:` never reach the container).

3. **Workflow.** Commit §7.4's `eval-gate.yml`, replacing every `<pinned-sha>` with the action's full commit SHA (supply-chain pin). Keep the trigger on `pull_request` (fork PRs then get no secrets, by GitHub default). The `comment` subcommand reads the summary markdown and posts via `GITHUB_TOKEN` — optional; skip if you'd rather read logs.

4. **Branch protection.** GitHub → Settings → Branches → require `eval-gate` (and `ci`) checks on `main`.

**Verify phase 6:** open two PRs: one no-op (green), one that re-points `candidate` at a deliberately degraded prompt version — the check must go red and the log/comment must name the failing cases. Merge neither; delete after screenshot (the red one is README material).

### Phase 7 — Dashboard

1. **Scaffold.** `packages/dashboard`: Vite vanilla-TS app, Chart.js pinned. `vite.config.ts` dev proxy: `/admin/api → http://localhost:8787`. Build output → `packages/dashboard/dist`.

2. **Serve from gateway.** `@fastify/static` at `/` rooted at dashboard `dist` (path via env with sane default; Dockerfile copies dist in). API routes registered before static so they win.

3. **Token flow.** On load, prompt for admin token, keep in a module-level variable (deliberately not localStorage, §8), single `api()` fetch wrapper attaches the header; 401 → re-prompt.

4. **Screens in this order** (each is one `.ts` module + one Chart.js config; §8 table is the panel spec):
   1. Overview — needs only `/admin/api/metrics/timeseries` + keys list. Build the timeseries endpoint SQL as you go: `GROUP BY strftime('%Y-%m-%d %H', ts)` buckets, group-dimension from the query param.
   2. Cost explorer — same endpoint, `group=feature|key|model` toggle.
   3. Prompts — list/detail/diff (diff endpoint returns plain text — render in `<pre>` with ±-line coloring), promote/rollback buttons calling `PUT .../labels/...` with a confirm dialog.
   4. Quality drift — `/admin/api/evals/runs` scatter/line of `score_avg` + pass-rate over time; vertical annotation lines where `(prompt_version)` or `(model)` changes between consecutive runs (both are columns on the run rows — no extra bookkeeping).

**Verify phase 7:** with real local traffic + ≥2 eval runs in the DB: all four screens render non-empty; label rollback from the UI changes the next request's version (re-run the phase-4 verify through the UI); drift chart shows the version-change annotation.

### Phase 8 — Dogfood + writeup

1. Deploy compose on the host that runs web_builder_llm; create key `web_builder_llm`, budget $5.
2. Resolve §9's `TODO(verify)`s: config surface (base URL / key / model name), `/v1/models` usage, `tools` usage (should already be settled since phase 2).
3. Point web_builder_llm at PromptGate; run its normal flows; confirm streaming UX unchanged and rows accrue.
4. Migrate one of its prompts into the registry, switch that call site to `pg_prompt` (satisfies §9's definition of proven).
5. After a week: screenshot overview + drift; write the README case study — numbers to include: total spend, cache "$ saved", p95 latency added by the gateway (compare a direct-vs-proxied sample), one rollback story.
6. **Add `contract-nightly.yml`** (deferred until now on purpose — §11): scheduled workflow, one minimal streaming + one non-streaming live request for each of OpenAI, Anthropic, Gemini, and DeepSeek, response shape asserted against the adapters' Zod schemas. Missing provider credentials are reported explicitly as deferred and never as live-green; decide the workflow's skip-vs-red policy when phase 8 creates it.
7. Close out in the **README**, not the idea file (the idea file stays untouched — ORCHESTRATOR.md rule): a "Deliverables" section mapping the idea file's five deliverables to evidence links (screenshot, workflow run, commit).
