# PromptGate — Build Playbook

Begin-to-end build order, split out of `IMPLEMENTATION_GUIDE.md` (which holds the spec this executes). All `§n` references below point to sections of `IMPLEMENTATION_GUIDE.md`.

Ordered so every phase ends with something demoable; each is roughly a focused weekend. Deliverable mapping: D1 = phases 1–3, D2 = phase 4, D3 = phases 5–6, D4 = phase 7, D5 = phase 8.

| # | Phase | Scope | Acceptance criteria |
|---|---|---|---|
| 0 | Scaffold | monorepo, Biome/Vitest/tsconfig, migration runner, docker-compose, `ci.yml` (lint+unit) | `docker compose up` → `GET /healthz` 200; CI green on empty test |
| 1 | OpenAI passthrough | auth keys (create via admin API), routing, non-streaming proxy, metering, `requests` logging, pricing table | curl with OpenAI SDK through gateway → correct response; `requests` row has tokens + cost matching provider dashboard |
| 2 | Anthropic + streaming | Anthropic adapter (§3.2 incl. `response_format` translation), SSE streaming both providers, first-token latency, abort handling | same client code, `model: claude-*` works; streamed response logs combined usage (input from `message_start`, output from `message_delta`); `TODO(verify)` on tools resolved by now |
| 3 | Cache, limits, budgets | exact-match cache (incl. stream replay), token bucket, budget check, error taxonomy | identical request twice → second is `x-pg-cache: hit`, cost 0, no provider call; key over budget → 429 `budget_exceeded`; over rpm → 429 `rate_limited` |
| 4 | Prompt registry | schema 002, immutability trigger, `pg_prompt`/`pg_vars` resolution, admin endpoints, diff + labels | create v1/v2, point `prod` at v1, request via `pg_prompt: x@prod` uses v1; move label → next request uses v2 with no client change; diff endpoint returns sane unified diff |
| 5 | Eval harness | `pg-eval` CLI, YAML loader, deterministic asserts, judge via gateway, baseline compare, run persistence | seeded regression (deliberately worsen candidate prompt) → exit 1 with readable failure table; good prompt → exit 0; runs visible in DB |
| 6 | CI gate | `eval-gate.yml`, ci fixtures/seeding, budget-capped CI key, PR summary output | a PR that degrades `safety_screen@candidate` fails the check; the failure message names the failing cases |
| 7 | Dashboard | Vite app, 4 screens (§8), admin-token flow | all panels render from real local traffic; label rollback works from the UI; drift chart shows ≥2 eval runs with a version-change annotation |
| 8 | Dogfood + writeup | §9 plan, README case study, screenshots | web_builder_llm serving real usage through PromptGate for a week; README shows the money/quality charts |
| S | Stretch (explicitly not v1) | semantic cache, Ollama third provider, git export of registry, tool-call translation (unless promoted in phase 2), chunked cache replay | — |

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

### Phase 1 — OpenAI passthrough (non-streaming)

Build order matters here: types → pricing → keys → auth → adapter → route → metering. Each step is testable before the next.

1. **Wire types in `shared`.** Zod schemas for the OpenAI chat request/response (only fields we touch: `model, messages, temperature, top_p, max_tokens, stream, stop, response_format, reasoning_effort, usage, choices`) plus the `pg_*` extension fields (§5.1). Export inferred TS types. Everything downstream imports these — never redefine wire shapes locally.

2. **Pricing seed.** `packages/gateway/scripts/seed-pricing.ts` upserts rows into `model_pricing` from a checked-in `pricing.json`. `TODO(build-time)`: fill `pricing.json` from both providers' current pricing pages; include only the models you'll actually route, including the locked `gpt-5.6-terra` eval judge.

3. **Key management (admin).** `src/admin/keys.ts`:
   - keygen: `"pg-" + randomBytes(24).toString("hex")`, store `sha256(key)`, return plaintext **once** in the POST response.
   - `POST /admin/api/keys`, `GET /admin/api/keys`, `PATCH /admin/api/keys/:id` per §5.2.
   - Admin auth = Fastify `onRequest` hook on the `/admin` prefix comparing `x-admin-token` with `config.ADMIN_TOKEN` (timing-safe compare).

4. **Client auth hook.** `src/pipeline/auth.ts`: extract Bearer token, hash, look up `api_keys` (reject `disabled`), attach row to `request.ctx`. Wrong/missing key → 401 `invalid_pg_key` in OpenAI error format (§3.6) — write the error-formatter helper now, everything uses it.

5. **Provider seam.** `src/providers/types.ts` — this interface is the contract phase 2 fills in; get it right now:
   ```ts
   export interface ProviderAdapter {
     name: "openai" | "anthropic";
     complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
     stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<SseChunk>;  // phase 2
   }
   ```
   `src/providers/routes.ts` = the §3.1 prefix map + "model must exist in model_pricing" check (reject with `unknown_model`).

6. **OpenAI adapter (non-streaming).** `src/providers/openai.ts`: `fetch` to `https://api.openai.com/v1/chat/completions`, swap auth header, forward body **minus all `pg_*` fields** (strip via one shared `stripPgFields()` — used by cache-keying later too). Wrap in the retry helper (2 retries on 429/5xx, jittered 250ms/1s).

7. **The route.** `POST /v1/chat/completions` in `src/pipeline/handler.ts` — the pipeline is an explicit function chain, not middleware magic:
   ```ts
   // auth (hook) → validate body → resolveProvider → [cache: phase 3] → adapter.complete
   //   → meter(usage) → reply … then logRequest(ctx) in reply's onSend/after
   ```
   Metering (integer micro-USD, §3.5): `cost_micro_usd = Math.round(usage.prompt_tokens * in_micro_rate / 1e6) + Math.round(usage.completion_tokens * out_micro_rate / 1e6)` with rates from the date-effective pricing lookup (`WHERE model = ? AND effective_from <= date('now') ORDER BY effective_from DESC LIMIT 1`). Insert the `requests` row after the response is sent (Fastify `onResponse` hook) so logging never adds latency. Set response headers `x-pg-request-id`, `x-pg-cache: miss`, and `x-pg-cost-usd` (non-streaming only, §5.1).

8. **`GET /v1/models`** from `model_pricing` distinct models, OpenAI list format.

**Verify phase 1:**
```bash
docker compose up -d --wait
KEY=$(curl -s -X POST localhost:8787/admin/api/keys -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"dev"}' | jq -r .plaintext_key)
KEY=$KEY node --input-type=module -e '
  import OpenAI from "openai";
  const c = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: process.env.KEY });
  const r = await c.chat.completions.create({ model: "<openai-cheap-model>", messages: [{ role: "user", content: "say hi" }] });
  console.log(r.choices[0].message.content, r.usage);
'
sqlite3 data/promptgate.db "SELECT model, input_tokens, output_tokens, cost_micro_usd, status FROM requests ORDER BY id DESC LIMIT 1;"
```
Cost in the row (÷1e6 for USD) should match the provider dashboard to the 4th decimal.

### Phase 2 — Anthropic adapter + streaming

1. **Record fixtures first.** One real curl per provider per mode (non-streaming JSON, streaming SSE transcript saved as `.txt`), keys stripped, into `packages/gateway/test/fixtures/`. All adapter unit tests run against these — no network in tests, ever (§11).

2. **Anthropic non-streaming.** `src/providers/anthropic.ts` — request translation table (§3.2): extract/concat `system` messages → `system` param; `max_tokens ??= config.DEFAULT_MAX_TOKENS`; **`response_format` → Anthropic structured outputs via `output_config.format`** (confirm the current param name in Anthropic's structured-outputs docs); map response: `content[0].text` → message, `stop_reason` (`end_turn→stop`, `max_tokens→length`) → `finish_reason`, `usage.{input,output}_tokens` → `{prompt,completion}_tokens`. Reject `tools` with 400 (per §3.2) — and **resolve the `TODO(verify)` now**: grep web_builder_llm for `tools:`; if present, build tool translation in this phase.

3. **OpenAI streaming.** Forward with `stream: true` **and inject `stream_options: { include_usage: true }`** (without it OpenAI sends no usage chunk and metering dies — this is the classic streaming-metering trap). Pipe SSE bytes to the client unbuffered; tee-parse each `data:` line just enough to (a) timestamp the first content delta → `first_token_ms`, (b) capture the final usage chunk.

4. **Anthropic streaming.** Translate the event stream into OpenAI chunk frames:
   | Anthropic event | Emit |
   |---|---|
   | `message_start` | role chunk; stash `usage.input_tokens` |
   | `content_block_delta` (`text_delta`) | content delta chunk |
   | `message_delta` | stash `stop_reason` + `usage.output_tokens` |
   | `message_stop` | finish chunk + usage chunk (combined stash) + `data: [DONE]` |

5. **Abort handling.** One `AbortController` per request; `request.raw.on("close", ...)` aborts upstream; log row with `status='client_aborted'` and `cost_estimated=1` if no usage arrived (§3.5's estimator: `chars/4` is fine, it's flagged).

**Verify phase 2:** same SDK snippet with `stream: true`, once per provider (`claude-*`, `gpt-*`) — chunks print incrementally; then:
```bash
sqlite3 data/promptgate.db "SELECT model, streamed, first_token_ms, total_ms, cost_micro_usd FROM requests ORDER BY id DESC LIMIT 2;"
```
Both rows: `streamed=1`, non-null tokens/cost, `first_token_ms < total_ms`.

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

5. **Budget: reserve-then-reconcile** (§3.5 — a plain spend-sum is only a delayed soft limit). `src/pipeline/budget.ts`:
   ```ts
   class BudgetGuard {
     // settled(keyId): SUM(cost_micro_usd) this month from DB, memoized briefly;
     //   invalidate(keyId) called on admin PATCH and on every reconcile
     reserve(keyId, estMicroUsd): Reservation | "over_budget"
     //   admits iff settled + inFlight + est <= budget; est = ceil(chars/4) input tokens
     //   × input rate + (max_tokens ?? DEFAULT_MAX_TOKENS) × output rate
     reconcile(r: Reservation, actualMicroUsd): void   // release + invalidate memo
   }
   ```
   Over budget → 429 with `code: budget_exceeded, type: insufficient_quota`. Reconcile in the same place the `requests` row is written (including aborts).

6. **Pipeline order — now fixed for good:** auth → rate limit → budget → validate → resolveProvider → [promptResolve: phase 4] → cache read → adapter → cache write → meter → log.

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
# burst-overspend regression test: restore budget to a value < cost of 2 requests, fire 10 in parallel →
#   exactly the reserved-affordable number reach the provider; the rest are 429s (this is the circuit-breaker proof)
```

### Phase 4 — Prompt registry

1. **Migration + immutability trigger.** Copy §4's `002_registry.sql` in, appending:
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

4. **Gateway client.** Thin fetch wrapper (base URL + key from flags/env). All calls `temperature: 0`, **`pg_no_cache: true`** (persisted quality runs must hit live models — cached responses conceal provider drift; `--allow-cache` is for local harness development only), `pg_feature: "eval"`.

5. **Judge.** `llmRubric` calls the gateway with **`model: "gpt-5.6-terra"` and `reasoning_effort: "high"`** plus registry prompt `judge_rubric_v1` (create it via seed script — the rubric prompt is itself versioned, per §7.2), `response_format: {type: "json_object"}`, then parses `{pass, score, rationale}`. The model and effort are locked by decision #11, not silently downgraded for cost. Malformed judge output = infrastructure error (exit 2), not a case failure.

6. **Run + persist + compare.** At start: resolve every label ref to a concrete version (frozen for the whole run, §7.2) and upsert the dataset via `POST /admin/api/evals/datasets`. Runner creates **one `eval_runs` row per model**, loops that model's cases, persists run + results via `POST /admin/api/evals/runs` (admin token from `--admin-token`/`PG_ADMIN_TOKEN` — eval traffic and persistence use different credentials, §5.2). `--baseline prod` is **paired**: run the baseline ref first, then the candidate, compare within the pair (works in a fresh CI database); `--baseline-from-history` for cheap local iteration only. Apply §7.2's exit-code contract verbatim. Print the markdown summary table (case, model, pass, score, first failed assertion detail).

7. **Golden dataset.** Execute §7.3: port carematch's cases (`TODO(verify)` lives there), synth-expand, hand-review, commit `safety_screening.yaml` + `asserts/*.js`.

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

2. **Secrets.** Create **dedicated CI keys at each provider with provider-side spend limits** (the gateway's $1 budget can't stop PR code from calling providers directly with the env keys) and add them as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` repo secrets. `ADMIN_TOKEN` for CI is generated per-run — the workflow writes it and the provider keys into `.env` so **docker compose actually passes them to the gateway container** (secrets set only on a step's `env:` never reach the container).

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
6. **Add `contract-nightly.yml`** (deferred until now on purpose — §11): scheduled workflow, one minimal streaming + one non-streaming live request per provider, response shape asserted against the adapters' Zod schemas.
7. Close out in the **README**, not the idea file (the idea file stays untouched — ORCHESTRATOR.md rule): a "Deliverables" section mapping the idea file's five deliverables to evidence links (screenshot, workflow run, commit).
