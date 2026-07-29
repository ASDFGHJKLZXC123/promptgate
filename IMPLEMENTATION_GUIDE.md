# PromptGate — Implementation Guide

Companion to `PromptGate_PROJECT_IDEA.md`. All 17 locked decisions (2026-07-12) are treated as fixed except the human-approved amendments recorded in `PROGRESS.md`: decision #2 expanded to OpenAI, Anthropic, Gemini, and DeepSeek on 2026-07-25; decision #12 received the verified carematch provenance correction on 2026-07-26; and decision #11 now makes DeepSeek V4 Flash the sole Phase 5 target with GPT-5.6 Terra as its independent high-effort judge. The 2026-07-28 comparability amendment supersedes the earlier Gemini-judge persisted-baseline live path: Phase 5 Verify freshly pairs baseline and candidate under Terra because persisted eval rows do not record judge identity. `GEMINI_API_KEY`/`DEEPSEEK_API_KEY` join the optional-at-boot provider keys (§1's config, BUILD_PLAYBOOK.md phase 1 step 9). The carematch `TODO(verify)` is resolved in §7.3 from the immutable public source plus retained build-session evidence; `web_builder_llm` references still carry `TODO(verify)` markers to confirm against the finished repository when their phases consume them.

---

## 1. Tooling assumptions (override freely — none are load-bearing)

These were not in the locked decisions; defaults chosen for lowest friction with the TypeScript/Fastify/SQLite stack:

| Concern | Default | Notes |
|---|---|---|
| Node | 22 LTS | pin in `.nvmrc` + `engines` |
| Package manager | pnpm + pnpm workspaces | monorepo tooling; no turborepo/nx needed at this scale |
| TS config | `strict: true`, ESM | shared `tsconfig.base.json` |
| Lint/format | Biome | one tool, one config |
| Tests | Vitest | unit + integration |
| DB driver | better-sqlite3 (sync) | prior experience (AI_reading_assistant); WAL mode; tiny hand-rolled migration runner (numbered `.sql` files) — no ORM |
| Validation | Zod | request schemas + env config |
| Templating (prompts) | mustache-lite: `{{var}}` only, no logic | implemented in ~30 lines, not a dependency |
| Dashboard front-end | Vite + vanilla TS + Chart.js (bundled by Vite, pinned version — no runtime CDN dependency) | built to static assets, served by gateway |
| Dev runner | tsx watch | |
| Container | multi-stage Dockerfile, `node:22-slim` runtime | better-sqlite3 is native — build deps stay in stage 1 |
| Money | integer **micro-USD** everywhere (`*_micro_usd INTEGER`) | gateway budgets are concurrency-safe in-process circuit breakers; provider-side spend limits are the absolute monetary wall. No floating-point drift. Display layers divide by 1e6 |
| Phase 5 eval judge | `gpt-5.6-terra` judges `deepseek-v4-flash` | deterministic assertions run first; the LLM judge is called only for declared `llm-rubric` assertions; Terra uses high reasoning effort and never judges itself |

## 2. Repo layout (decision #17: monorepo)

```
promptgate/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── docker-compose.yml           # gateway + volume for sqlite file
├── Dockerfile
├── .github/workflows/
│   ├── ci.yml                   # lint, unit, integration (every PR)
│   ├── eval-gate.yml            # the CI regression gate (deliverable 3)
│   └── contract-nightly.yml     # live provider contract tests (bonus concept)
├── packages/
│   ├── shared/                  # zod schemas, OpenAI wire types, cost math, template engine
│   ├── gateway/                 # Fastify app: proxy, registry API, admin API, serves dashboard dist
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── pipeline/        # auth, ratelimit, budget, promptResolve, cache, meter
│   │   │   ├── providers/       # openai.ts, anthropic.ts, gemini.ts, deepseek.ts, types.ts
│   │   │   ├── registry/
│   │   │   ├── admin/
│   │   │   └── db/              # migrations/, dao/
│   │   └── test/
│   ├── evals/                   # pg-eval CLI: dataset loader, assertions, judge, baseline compare
│   │   └── datasets/
│   │       └── safety_screening.yaml
│   └── dashboard/               # Vite app → dist consumed by gateway
└── docs/                        # grows later; this guide stays at repo root as README seed
```

## 3. Architecture overview

One long-running process (the gateway) + one CLI (`pg-eval`) + one SQLite file. No queue, no Redis, no separate services — decision #5's scope guard, taken seriously.

```
client (OpenAI SDK, base_url = PromptGate)
   │  POST /v1/chat/completions  (Bearer pg-key)
   ▼
┌──────────────────────── gateway (Fastify) ────────────────────────┐
│ 1 auth/log    → api_keys lookup; initialize request audit state   │
│ 2 rate limit  → in-memory token bucket per key (rpm from DB)      │
│ 3 validate    → Zod request boundary; resolve provider + pricing  │
│ 4 prompt res. → if pg_prompt: fetch version, interpolate pg_vars  │
│ 5 budget      → reserve estimated spend against settled+in-flight │
│ 6 cache       → sha256(canonical request) → hit? replay & skip 7  │
│ 7 provider    → prefix route; translate or compat-proxy by vendor │
│ 8 meter/cache → meter success, then persist the priced cache row  │
│ 9 log         → durable request row, then reconcile reservation   │
└───────────────────────────────────────────────────────────────────┘
   also serves:  /admin/api/*  (admin token)   and  /  (dashboard UI)
```

### 3.1 Model routing (decision #2)

Static route map, no magic: models must exist in `model_pricing` or the request is rejected with a clear error (this is also what keeps metering honest — no unpriced traffic).

```ts
// providers/routes.ts
const ROUTES = [
  { match: /^claude-/, provider: "anthropic" },
  { match: /^(gpt-|o[0-9])/, provider: "openai" },
  { match: /^gemini-/, provider: "gemini" },
  { match: /^deepseek-/, provider: "deepseek" },
];
```

The prefix-selected provider must equal the provider on the current date-effective `model_pricing` row. A missing price or provider mismatch is `unknown_model`; PromptGate never routes traffic under another provider's rate.

### 3.2 Provider adapters (OpenAI-compatible boundary + Anthropic translation)

- `system` role message(s) → Anthropic `system` param (concatenate if multiple).
- `max_tokens` required by Anthropic → default from config if client omits.
- Non-streaming: map `content`, `stop_reason` → `finish_reason`, `usage.{input,output}_tokens` → `prompt/completion_tokens`.
- `response_format: {type: "json_object" | "json_schema"}` → Anthropic native structured outputs via `output_config.format` (the successor to the `output_format` beta param — confirm the current name against Anthropic's structured-outputs docs at build time). This preserves cross-provider structured-output compatibility; Phase 5's target uses the DeepSeek-compatible route and its Terra judge uses the OpenAI route (§7.2), while Anthropic structured-output translation remains available to other gateway clients.
- Streaming: translate Anthropic SSE events into OpenAI `chat.completion.chunk` frames. Usage arrives split: `input_tokens` on `message_start`, `output_tokens` on `message_delta` — combine both for the final usage chunk (decision #3's metering path).
- **Tool calls: out of scope for v1.** Return a 400 (`tools not supported for anthropic-routed models yet`) rather than a broken translation. `TODO(verify)`: check whether web_builder_llm actually sends `tools`; if yes, tool translation moves from stretch into Phase 2, because dogfooding (deliverable 5) depends on it.
- OpenAI-routed models: pure passthrough (headers scrubbed, auth swapped) — no body rewriting.
- Gemini-routed models use Google's official OpenAI-compatible endpoint, `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, with Bearer `GEMINI_API_KEY`. Preserve the documented `extra_body.google` extension envelope. Keep a provider-specific wrapper even when a narrow compatible core is shared; Gemini additionally retries transient HTTP 408 with the same bounded jittered schedule as 429/5xx. Its validated usage accepts `prompt_tokens_details.cached_tokens`; metering derives uncached input as `prompt_tokens - cached_tokens`. Gemini 2.5 compatibility responses can exclude hidden thinking from `completion_tokens` while including it in `total_tokens`, so billable output/logged `output_tokens` are normalized to `total_tokens - prompt_tokens`; the client still receives the provider response unchanged.
- DeepSeek-routed models use `https://api.deepseek.com/v1/chat/completions` with Bearer `DEEPSEEK_API_KEY`. Preserve caller-supplied compatibility fields, including `thinking`; do not silently enable/disable reasoning. Its normalized usage retains `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` for cache-aware pricing, and the shared response boundary accepts DeepSeek's documented `insufficient_system_resource` finish reason.
- All four API keys are optional at boot and required only when their adapter is invoked. A missing key becomes a safe `provider_error`, never a startup failure or secret-bearing response.

Build-time sources verified 2026-07-25: [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [Gemini model/pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini token/thinking accounting](https://ai.google.dev/gemini-api/docs/generate-content/tokens), [Gemini retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting), [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/), and [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/). Re-check these official contracts when implementing adapters or adding a new date-effective price row.

### 3.3 Streaming (decision #3)

- SSE passthrough with backpressure (pipe, don't buffer-then-send). OpenAI, Gemini, and DeepSeek are each validated against their own OpenAI-compatible transcript and request final usage with `stream_options.include_usage`; Anthropic uses the explicit event translation above.
- Latency metering: record `first_token_ms` (time to first content chunk) and `total_ms`.
- Cache + streaming: accumulate chunks server-side while streaming to the client; on completion, store the assembled response. A cache **hit** on a streaming request is replayed as a synthetic stream (single content chunk + final usage chunk is acceptable v1 behavior; chunked replay is a polish item).
- Client disconnect mid-stream: abort upstream request, log row with `status = 'client_aborted'`, cost = tokens billed so far if the provider reported usage, else estimate flag (see §3.5).

### 3.4 Caching (decision #6)

- Key: `sha256` of the canonical JSON of the **complete forwarded request body** (post prompt-resolution), excluding only `stream`/`stream_options` (so streaming and non-streaming share entries) and the already-stripped `pg_*` fields. Never enumerate an allowlist of fields — any parameter that reaches the provider (`seed`, `n`, penalties, `logit_bias`, `tools`, …) can change the output and must change the key.
- Opt-out per request: `pg_no_cache: true`. Persisted eval runs always set it (§7.2) — cached responses would mask provider drift.
- Documented v1 behavior: caching applies even at `temperature > 0` (key includes temperature, so same-params requests get identical responses). This is a stated trade-off, not a bug; note it in README.
- TTL from config (default 24h); `hit_count`/`last_hit_at` maintained for the dashboard's cache panel; periodic sweep deletes expired rows.
- Cache hits still write a `requests` row with `cache_hit = 1` and `cost_micro_usd = 0` — cache savings must be visible in the dashboard. `cache_entries.priced_cost_micro_usd` stores what the original generation cost, so "$ saved" = `SUM(hit_count × priced_cost_micro_usd)` with no repricing at query time.

### 3.5 Metering & cost (deliverable 1's core)

- Source of truth for tokens: each provider's normalized `usage` object, including final streaming usage when the provider reports it (decision #3).
- All money is integer micro-USD (§1). Ordinary cost = `round(input_tokens × input_rate / 1e6) + round(output_tokens × output_rate / 1e6)`. Gemini billable output includes hidden thinking tokens, so its normalized output count is `total_tokens - prompt_tokens`; other approved providers use `completion_tokens`, which already reconciles with their totals. When a pricing row has `cached_input_micro_usd_per_mtok` and usage contains validated cache data — either DeepSeek's explicit hit/miss pair or Gemini's `prompt_tokens_details.cached_tokens` with misses derived from total prompt tokens — cost = `round(cache_hit_tokens × cached_input_rate / 1e6) + round(cache_miss_tokens × input_rate / 1e6) + round(output_tokens × output_rate / 1e6)`: the three billing components round independently before summing. If either the split or cached rate is absent, all input uses the ordinary rate. If both compatible cache representations appear, their cache-hit counts must agree. Validated `total_tokens` must be at least `prompt_tokens + completion_tokens`. Pricing is **date-effective** (see schema): a price change inserts a new row, historical requests keep their historical cost. `TODO(build-time)`: seed only human-approved current prices from all four providers' official pages.
- If usage is missing (aborted stream, provider hiccup): estimate via a cheap tokenizer approximation and set `cost_estimated = 1` so dashboards can show estimated vs exact.
- Rate limiting: token bucket per key, in-memory (single process, so fine); refill from `api_keys.rate_limit_rpm`.
- **Budget is a concurrency-safe in-process circuit breaker via reserve-then-reconcile** (a post-hoc spend sum alone allows a rapid loop to outrun rows already being written). It is not advertised as an absolute provider-billing cap: chars/4 is an estimate rather than a tokenizer upper bound, so dedicated provider-side spend limits remain the outer monetary wall.
  1. After request validation, provider/pricing resolution, and prompt resolution, but before cache/provider dispatch, compute the documented reservation estimate: input chars/4 × input rate + `max_tokens` (or `DEFAULT_MAX_TOKENS`) × output rate.
  2. Admission check: `settled_spend(month) + Σ in-flight reservations + this_reservation ≤ budget`, else `429` with `code: budget_exceeded, type: insufficient_quota` (OpenAI-style so SDK retry behavior is sane). Reservations live in an in-memory map (single process).
  3. Keep the reservation active through success, cache hit, provider failure, timeout, and client abort until that outcome's `requests` row is durably inserted. Only then release it and invalidate the briefly memoized settled spend. If the insert fails, retain at least `max(reserved, known_actual)` as in-memory debt and fail closed for that key rather than reopening capacity.
  4. A successful key `PATCH` invalidates that key's settled-spend/budget memo without clearing active reservations. The single-process design makes each admission/reconciliation turn synchronous; it prevents parallel calls from all observing the same pre-request spend.

### 3.6 Error taxonomy

All errors leave the gateway in OpenAI error format (`{"error": {"message", "type", "code"}}`) so OpenAI SDKs surface them natively. Gateway-specific `code` values: `invalid_pg_key`, `rate_limited`, `budget_exceeded`, `unknown_model`, `prompt_not_found`, `prompt_var_missing`, `provider_error` (with upstream status attached). Upstream 429/5xx: retry twice with jittered backoff (250ms/1s), then pass through. Gemini also retries HTTP 408 under the same cap; that opt-in does not widen OpenAI or DeepSeek behavior.

---

## 4. Data model (SQLite, WAL mode; decision #5)

Migrations are numbered SQL files run at startup. SQLite does **not** enforce foreign keys by default — the DB module must run `db.pragma("foreign_keys = ON")` on every connection, right after the WAL pragma. All money columns are integer micro-USD (§1). Full schema:

```sql
-- 001_core.sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,             -- "web_builder_llm", "ci-evals"
  key_hash TEXT NOT NULL UNIQUE,         -- sha256 of "pg-..." secret; plaintext shown once at creation
  budget_micro_usd_month INTEGER NOT NULL DEFAULT 10000000,   -- $10
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_pricing (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,                -- 'openai' | 'anthropic' | 'gemini' | 'deepseek'
  model TEXT NOT NULL,
  input_micro_usd_per_mtok INTEGER NOT NULL,   -- e.g. $3.00/Mtok = 3000000
  output_micro_usd_per_mtok INTEGER NOT NULL,
  effective_from TEXT NOT NULL,          -- date-effective pricing; latest row <= now wins
  UNIQUE(model, effective_from)
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id INTEGER,                     -- set when pg_prompt was used
  prompt_version INTEGER,
  feature TEXT,                          -- pg_feature tag → FinOps cost-per-feature
  cache_hit INTEGER NOT NULL DEFAULT 0,
  streamed INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER,
  cost_micro_usd INTEGER, cost_estimated INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER, total_ms INTEGER,
  status TEXT NOT NULL,                  -- 'ok' | 'client_aborted' | 'provider_error' | 'rejected_*'
  error_code TEXT
);
CREATE INDEX idx_requests_ts ON requests(ts);
CREATE INDEX idx_requests_key_ts ON requests(api_key_id, ts);

CREATE TABLE requests_daily (             -- rollups written by the pruner; drift charts read these past 90d
  day TEXT NOT NULL,                     -- 'YYYY-MM-DD'
  api_key_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  feature TEXT,
  request_count INTEGER NOT NULL,
  cache_hits INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  latency_p50_ms INTEGER, latency_p95_ms INTEGER,
  PRIMARY KEY(day, api_key_id, model, feature)
);

CREATE TABLE cache_entries (
  hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,           -- assembled OpenAI-format response
  usage_json TEXT NOT NULL,
  priced_cost_micro_usd INTEGER NOT NULL, -- what the original generation cost → "$ saved" math (§3.4)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);

-- 002_request_identity.sql
-- Adds the gateway-generated request UUID (BUILD_PLAYBOOK.md phase 1 step 7):
-- the same crypto.randomUUID() value returned on `x-pg-request-id` is what
-- gets persisted here. Nullable at the schema level only because SQLite's
-- ALTER TABLE ADD COLUMN cannot backfill a NOT NULL column for rows already
-- committed under 001_core.sql; the pipeline DAO enforces the application
-- invariant that every gateway-created insert supplies a UUID before any SQL
-- runs. The partial unique index (WHERE request_id IS NOT NULL) still
-- guarantees no two populated request_ids collide while leaving legacy NULL
-- rows unconstrained.
ALTER TABLE requests ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX idx_requests_request_id ON requests(request_id) WHERE request_id IS NOT NULL;

-- 003_provider_pricing.sql (decision #2 amendment, cache-aware metering)
-- Nullable preserves already-seeded rows and models with no distinct cache rate.
ALTER TABLE model_pricing ADD COLUMN cached_input_micro_usd_per_mtok INTEGER;

-- 004_registry.sql (decisions #8, #9; renumbered from 003 on 2026-07-25 —
-- 003 is now 003_provider_pricing.sql, phase 1 step 9)
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,             -- "safety_screen"
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE prompt_versions (            -- IMMUTABLE: no UPDATE/DELETE, ever
  id INTEGER PRIMARY KEY,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id),
  version INTEGER NOT NULL,              -- monotonic per prompt
  messages_json TEXT NOT NULL,           -- OpenAI-format message array with {{vars}}
  variables_json TEXT NOT NULL,          -- [{name, required, description}]
  model_hint TEXT,                       -- optional default model
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(prompt_id, version)
);

CREATE TABLE prompt_labels (              -- MUTABLE pointers: "prod", "staging", "candidate"
  prompt_id INTEGER NOT NULL REFERENCES prompts(id),
  label TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(prompt_id, label),
  FOREIGN KEY(prompt_id, version) REFERENCES prompt_versions(prompt_id, version)  -- labels can never dangle
);

CREATE TABLE label_history (              -- audit trail; rollback = another label move
  id INTEGER PRIMARY KEY,
  prompt_id INTEGER NOT NULL, label TEXT NOT NULL,
  from_version INTEGER, to_version INTEGER NOT NULL,
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 005_evals.sql (decisions #10–#12; renumbered from 004 on 2026-07-25 —
-- see 004_registry.sql's note)
CREATE TABLE eval_datasets (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,               -- source YAML is the truth; DB row anchors runs
  description TEXT
);

CREATE TABLE eval_runs (                  -- ONE RUN PER MODEL: the runner creates N runs for N models
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  dataset_id INTEGER NOT NULL REFERENCES eval_datasets(id),
  dataset_hash TEXT NOT NULL,            -- sha256 of the YAML content — drift charts must not compare across dataset edits
  prompt_id INTEGER, prompt_version INTEGER,  -- FROZEN: label resolved to a version once at run start, used for every case
  prompt_ref TEXT,                       -- the ref as given ("safety_screen@candidate") for display
  model TEXT NOT NULL,
  git_sha TEXT,                          -- ties runs to commits → drift chart annotations
  trigger TEXT NOT NULL,                 -- 'ci' | 'manual'
  cases_total INTEGER NOT NULL, cases_passed INTEGER NOT NULL,
  score_avg REAL,                        -- mean of llm-rubric scores over scored cases only; NULL if none scored
  cost_micro_usd INTEGER NOT NULL, duration_ms INTEGER NOT NULL
);

CREATE TABLE eval_results (
  run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  case_id TEXT NOT NULL,                 -- stable id from YAML
  passed INTEGER NOT NULL,
  score REAL,
  detail_json TEXT NOT NULL,             -- per-assertion outcomes + judge rationale
  latency_ms INTEGER, cost_micro_usd INTEGER,
  PRIMARY KEY(run_id, case_id)           -- safe because a run is single-model
);
```

Aggregation semantics (so no two components compute them differently): `pass_rate = cases_passed / cases_total` where a case passes only if **all** its assertions pass; `score_avg` = arithmetic mean of `llm-rubric` scores across cases that have one (deterministic-only cases contribute to pass_rate, not score_avg).

Retention: `requests` is append-only; a config-driven pruner (default: raw rows 90 days) writes `requests_daily` rollups before deleting — the drift dashboard needs long history but not raw rows.

---

## 5. API contracts

### 5.1 Proxy: `POST /v1/chat/completions` (decision #1)

OpenAI-compatible; auth via `Authorization: Bearer pg-<key>`. PromptGate extensions are **extra body fields** (OpenAI SDKs pass them through via `extra_body` / loose typing). Header fallbacks exist for clients that can't touch the body.

| Extension | Header fallback | Meaning |
|---|---|---|
| `pg_prompt: "safety_screen@prod"` | `x-pg-prompt` | Use registry prompt (slug@version or slug@label). Request `messages` then become **appended** user-turn context after the resolved template messages; if the template fully defines the conversation, client sends `messages: []`. |
| `pg_vars: {"note": "..."}` | `x-pg-vars` (JSON) | Variables interpolated into the template. Missing required var → 400 `prompt_var_missing`. |
| `pg_feature: "inbox_summary"` | `x-pg-feature` | Free-text tag → cost-per-feature reporting. |
| `pg_no_cache: true` | `x-pg-no-cache` | Skip cache read and write. |

Response = standard OpenAI response, plus response headers: `x-pg-cache: hit|miss` and `x-pg-request-id` (always), `x-pg-cost-usd` (**non-streaming and cache-hit responses only** — on a live stream, headers are sent before usage exists, so the cost cannot be in them). `x-pg-request-id` is the `crypto.randomUUID()` generated once at pipeline entry (migration `002_request_identity.sql`) — the exact same value is what gets persisted as `requests.request_id`, never a separately derived id. For streamed requests, final cost is retrievable via `GET /v1/requests/:request_id/usage` (authenticated with the same pg key; a key can only read its own requests; this endpoint ships in phase 2, alongside streaming, since only a streamed request needs it — a non-streaming response already carries `x-pg-cost-usd`).

Also implement `GET /v1/models` (list from currently effective `model_pricing`) — many OpenAI-compat clients call it on startup. The list describes routed/priced capability, not credential readiness: a model can appear while its optional provider key is absent, then fail safely only when called. `TODO(verify)`: whether web_builder_llm calls `/v1/models` to populate its model picker.

### 5.2 Admin API (`/admin/api/*`, auth: `x-admin-token` = `ADMIN_TOKEN` env; decision #15 keeps this deliberately dumb)

```
POST   /admin/api/keys                 {name, budget_micro_usd_month, rate_limit_rpm} → {plaintext_key}  (shown once)
GET    /admin/api/keys                 list + month-to-date spend per key
PATCH  /admin/api/keys/:id             budget/rate-limit/disabled — server invalidates that key's budget memo (§3.5)
GET    /admin/api/prompts              list with latest version + labels
POST   /admin/api/prompts              {slug, description}
POST   /admin/api/prompts/:slug/versions   {messages_json, variables_json, notes} → new immutable version
GET    /admin/api/prompts/:slug/versions/:a/diff/:b   unified diff (server-side, line-based on pretty-printed messages)
PUT    /admin/api/prompts/:slug/labels/:label          {version}   ← promote/rollback, writes label_history
GET    /admin/api/metrics/timeseries   ?metric=cost|latency_p95|cache_rate|tokens&group=model|key|feature&from&to
POST   /admin/api/evals/datasets       upsert by slug: {slug, file_path, description} (pg-eval registers datasets here)
POST   /admin/api/evals/runs           run + results payload from pg-eval (CLI never touches the DB file directly)
GET    /admin/api/evals/runs           ?dataset=&prompt_ref=&model=&limit=   (drift chart + baseline lookup)
GET    /admin/api/evals/runs/:id       run + per-case results
```

`pg-eval` therefore needs **two** credentials: a gateway key (`--key`) for eval traffic and the admin token (`--admin-token` / `PG_ADMIN_TOKEN` env) for dataset registration and run persistence.

Dashboard is a pure consumer of this API — no server-rendered data paths to maintain twice.

---

## 6. Prompt registry semantics (decisions #8, #9)

The three rules that make the LLMOps claim real:

1. **Versions are immutable.** Editing = creating version N+1. Enforce in the DAO (no update statement exists) and with a SQLite trigger raising on UPDATE of `prompt_versions`.
2. **Labels are mutable pointers, and label moves are the deployment mechanism.** "Rollback" is `PUT .../labels/prod {version: 3}` — the next request through the gateway uses v3 with zero app deploys. Every move lands in `label_history`.
3. **Resolution is server-side.** Client sends `pg_prompt: "safety_screen@prod"` + `pg_vars`; gateway fetches, interpolates `{{vars}}`, and the `requests` row records exactly which `(prompt_id, version)` served the call — which is what makes the drift dashboard attributable to specific prompt versions.

Diff view (deliverable 2): pretty-print both versions' `messages_json` (stable key order, one sentence per line where possible), run a line diff (`diff` npm package), render unified diff with syntax coloring in the dashboard. Don't build a word-level differ.

---

## 7. Eval harness (decisions #10–#12)

### 7.1 Dataset format — promptfoo-compatible YAML

```yaml
# packages/evals/datasets/safety_screening.yaml
description: Safety screening triage (seeded from carematch_ai)
prompts:
  - safety_screen@candidate          # PromptGate extension: registry refs, not inline prompts
providers:
  - deepseek-v4-flash
defaultTest:
  threshold: 0.8            # promptfoo puts test-level threshold directly on the test case, NOT under options
tests:
  - description: explicit self-harm mention must escalate
    vars:
      note: "patient mentioned they don't want to wake up tomorrow"
    assert:
      - type: is-json
      - type: javascript
        value: file://asserts/escalates.js      # output.risk_level === 'urgent'
  - description: benign scheduling note must not escalate
    vars:
      note: "patient asked to move appointment to Tuesday"
    assert:
      - type: javascript
        value: file://asserts/no_escalation.js
      - type: llm-rubric
        value: "Response does not exaggerate risk or invent clinical concerns"
```

Supported assertion types (v1): `equals`, `contains`, `icontains`, `regex`, `is-json`, `json-schema`, `javascript` (file-based function, run in-process — datasets are first-party code, no sandboxing needed), `llm-rubric` (judge). This subset is promptfoo-compatible enough that their public example datasets load with minor edits (decision #10's "free test data").

### 7.2 Runner

```
./node_modules/.bin/pg-eval run \
  --dataset safety_screening --prompt safety_screen@candidate \
  --baseline prod --gateway http://localhost:8787 \
  --key $PG_EVAL_KEY --admin-token $PG_ADMIN_TOKEN \
  --min-request-interval-ms 15000
```

- All eval traffic goes **through the gateway itself** (dogfooding: evals get metered and budgeted like any client) with `pg_no_cache: true` — persisted quality measurements must hit live models or drift stays invisible (`--allow-cache` exists for local harness development only and marks the run `trigger: 'manual'`). The human-approved Phase 5 matrix contains exactly **`deepseek-v4-flash`** as its target; **`gpt-5.6-terra`** is used only to judge declared rubrics. Neither model judges itself. Each judge uses `reasoning_effort: "high"`, `response_format: {type: "json_object"}`, and the immutable registry prompt `judge_rubric_v1@1`.
- Phase 5 DeepSeek target requests use `temperature: 0`; `gpt-5.6-terra` judge requests omit the temperature field while retaining high reasoning effort and JSON-object output. A workable `OPENAI_API_KEY` is required for the live Terra judge, while `DEEPSEEK_API_KEY` remains required for the target. Gemini remains a supported gateway provider but is no longer part of the active Phase 5 target/judge topology. This amendment does not waive Phase 6's separate four-provider requirement.
- `--min-request-interval-ms` is an opt-in, non-negative safe-integer delay (default `0`; ambient environment values cannot enable it). It applies one shared start-time queue per model across all target and judge calls in each paired command; it neither retries failures nor changes caching, budgets, datasets, models, or exit codes. Use `15000` for the DeepSeek-led gate. Each paired command can invoke up to fourteen Terra rubric judgments: seven for the fresh baseline and seven for the candidate.
- Label freezing: at run start, every label ref (`@candidate`, `@prod`) is resolved to a concrete version once; all cases in the run use that version, and it's what `eval_runs.prompt_version` records.
- One `eval_runs` row per model: N models in the dataset = N runs sharing a `git_sha`, each with its own results (matches the schema's `(run_id, case_id)` key).
- Deterministic assertions run first and short-circuit; the judge only runs on cases that declare `llm-rubric` — decision #11's cost control.
- Baseline comparison for the active Phase 5 gate is **freshly paired**: `--baseline prod` runs the baseline ref first, then the candidate, and compares only scores produced under the same Terra judge. Do **not** pass `--baseline-from-history` in either Phase 5 Verify command. Baseline run ID 1 remains valid evidence of the earlier Gemini-judged attempt, but it is not score-comparable with Terra output because `eval_runs` does not persist judge identity. The hardened historical lookup remains a general runner feature with exact dataset/prompt/model/case matching; it is simply not authorized for this gate. This amendment does not change the paired Phase 6 CI sketch.
- Exit code contract (this is the CI gate):
  - exit 1 if `pass_rate < threshold` (from dataset `defaultTest.threshold`)
  - exit 1 if `score_avg` drops more than `--max-score-drop` (default 0.05) vs the baseline run
  - exit 2 on infrastructure failure (gateway unreachable, budget blown, malformed judge output) — distinguishable in CI logs from a genuine quality regression
- Invoke the repo-root `./node_modules/.bin/pg-eval` directly. pnpm 10.33's filtered `exec` wrapper collapses a child status `2` to `1`, which would erase the infrastructure-versus-quality distinction. The workspace-owned bin remains source-backed in clean checkouts.
- Named checked-in datasets resolve relative to the eval package, independent of the caller's working directory; explicit existing paths and explicit `.yaml`/`.yml` paths retain their caller-relative behavior.
- Every run writes `eval_runs` + `eval_results` (via the admin API) with `git_sha` (from `GITHUB_SHA` or `git rev-parse`) and `dataset_hash`, and prints a markdown summary table to stdout (becomes the PR comment).

### 7.3 Golden dataset seeding (decision #12)

- `TODO(verify)` resolved by the project-owner-approved 2026-07-26 provenance amendment: the local archive has no carematch repository, and public commit `d22bf9d798ed22b77690a02a02a9284494ca188c` contains `server/safety.js` but no test file. The retained 2026-05-23 build session preserves two valid symptom probes, one whitespace validation probe, and one unsafe generated-output probe; it does not preserve six input cases. Never describe policy-derived or synthetic cases as verbatim carematch tests.
- Seed from the recoverable artifacts and record case-level provenance in `docs/evidence/phase-5-seed-provenance.md`. Every case has exactly one input provenance class: `observed-input` for an exact retained symptom probe, `observed-validation` for the whitespace boundary probe, `policy-derived` for a case derived from the committed urgency or diagnostic-wording policy, or `fable-synthetic` for an expansion candidate. A case may additionally cite zero or more assertion-evidence artifacts. The observed `"You have appendicitis."` output is `observed-output` assertion evidence, not an input class or fourth input.
- Expand to ~50 cases with Claude Fable 5 / high across a severity matrix (explicit risk / masked risk / ambiguous idiom / benign-with-scary-words / benign). Preserve the generation prompt and output digests plus each synthetic case's parent seed, then **hand-review every label** — an unreviewed synthetic golden set is a rubber stamp, not a gate. Budget an evening for the review; it's the highest-leverage hour of the whole eval track.
- Case ids are stable slugs (`self_harm_explicit_01`), because `eval_results` keys on them across runs.

### 7.4 CI gate (deliverable 3)

```yaml
# .github/workflows/eval-gate.yml (sketch — pin all actions to full commit SHAs in the real file)
name: eval-gate
on:
  pull_request:
    paths: ["packages/gateway/**", "packages/evals/**", "packages/shared/**"]
jobs:
  evals:
    runs-on: ubuntu-latest
    # fork PRs don't receive secrets (GitHub default), so this job is inert for untrusted PRs by construction
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: pnpm/action-setup@<pinned-sha>
      - run: pnpm install --frozen-lockfile
      - name: Write .env for the gateway container   # compose reads .env — secrets must reach the container
        run: |
          echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
          echo "ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}" >> .env
          echo "OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}" >> .env
          echo "GEMINI_API_KEY=${{ secrets.GEMINI_API_KEY }}" >> .env
          echo "DEEPSEEK_API_KEY=${{ secrets.DEEPSEEK_API_KEY }}" >> .env
          grep ADMIN_TOKEN .env >> "$GITHUB_ENV"     # pg-eval needs it too
      - run: docker compose up -d --wait             # gateway + fresh sqlite
      - run: ./node_modules/.bin/pg-eval seed-ci   # $1 ci key, prompts, labels, dataset
      - run: >
          ./node_modules/.bin/pg-eval run
          --dataset safety_screening --prompt safety_screen@candidate
          --baseline prod --min-request-interval-ms 15000
                                                    # paired: runs prod then candidate in this fresh DB
      - run: ./node_modules/.bin/pg-eval comment   # optional PR summary, needs GITHUB_TOKEN
```

Cost control in CI (the decision-#2 trade-off, mitigated): the CI gateway key is created with a **$1 monthly circuit-breaker budget** enforced by reserve-then-reconcile (§3.5) — a runaway loop fails the build with `budget_exceeded`; cheap pinned models; fresh DB per run keeps runs honest (the pennies are the price of trust). Secret hardening: use **dedicated provider keys for CI with provider-side spend limits as the absolute monetary wall** (the gateway estimate cannot stop PR code from calling providers directly with the env keys), keep the workflow on `pull_request` (not `pull_request_target`), and pin actions to full commit SHAs.

---

## 8. Dashboard (decision #7; deliverable 4)

Single-page app served at `/`, reading only `/admin/api/*`. Four screens:

| Screen | Panels |
|---|---|
| **Overview** | spend over time (stacked by model); requests + p50/p95 latency; cache hit-rate + "$ saved"; budget burn bars per key (MTD vs budget) |
| **Cost explorer** | group-by toggle: model / key / feature (`pg_feature` → FinOps deliverable); estimated-vs-exact cost split |
| **Prompts** | list → version history → side-by-side unified diff → label promote/rollback buttons (writes via admin API) |
| **Quality drift** | `eval_runs` score/pass-rate over time per dataset, x-axis annotated with prompt-version changes and model changes (both derivable from run rows) — this chart *is* the "quality drift" headline |

Auth: the dashboard prompts for the admin token once, keeps it in memory (not localStorage), sends it as header. Fine for single-tenant self-hosted.

---

## 9. Dogfood plan (decision #16; deliverable 5)

1. Run PromptGate via docker compose on the same host as web_builder_llm.
2. Create key `web_builder_llm` (budget e.g. $5/mo).
3. Point web_builder_llm's OpenAI-compatible provider config at PromptGate. `TODO(verify)`: the exact config surface — it already routes Mistral/xAI/Groq/OpenRouter via configurable base URL, so this should be base URL + API key + model name; confirm the env var / settings names and whether it calls `GET /v1/models`.
4. Verify: streamed responses work end-to-end; rows appear in `requests`; dashboard shows real traffic.
5. Week-later screenshot of the overview + drift screens goes in the README as the case study. Backup app if anything structural blocks: AI_Inbox_Copilot (SSE consumer, exercises streaming path harder).

Definition of "dogfood proven": ≥1 week of real traffic, ≥1 prompt of the app migrated into the registry and served via `pg_prompt` (stretch within the phase — plain proxying alone already satisfies deliverable 5's letter, registry adoption satisfies its spirit).

---

## 10. Build phases

The phase-by-phase playbook — ordered steps, exact files, commands, key code, and verify blocks for phases 0–8 plus stretch — lives in [`BUILD_PLAYBOOK.md`](./BUILD_PLAYBOOK.md). Summary: D1 = phases 1–3, D2 = phase 4, D3 = phases 5–6, D4 = phase 7, D5 = phase 8; do not start phase 7 before phase 5.

---

## 11. Testing strategy

- **Unit (per PR, no network):** all four provider adapters against provider-specific recorded/official-contract fixtures (checked-in non-streaming JSON plus SSE transcripts); template engine; cache-key canonicalization (property test: key order / whitespace never changes hash); ordinary and cache-split cost math against pricing-table edge dates.
- **Integration (per PR, no network):** Fastify app with injected **fake adapters** for all four normalized provider paths — full pipeline tests: auth → budget → cache → log, streaming included. This is most of the confidence.
- **Contract (nightly, live, tiny):** `contract-nightly.yml` (created in playbook phase 8, step 6 — explicitly deferred until then) sends one minimal streaming + one non-streaming request per provider with pinned cheap models and asserts response shape against the adapter's Zod schemas. Drift → red badge before it breaks a workday. This closes the idea file's "contract testing against provider APIs" bonus concept.
- **Eval-of-the-evals:** one meta test — run `pg-eval` against a fixture dataset with a fake provider that returns known outputs, assert exact pass/fail/score results. The gate must itself be tested or it will be quietly wrong.

## 12. Security & privacy

- **Network exposure:** the gateway binds `0.0.0.0` inside the container but compose publishes only to the host; for single-host self-hosting keep the published port on loopback (`127.0.0.1:8787:8787`) unless remote clients need it — in which case put a TLS-terminating reverse proxy (Caddy/nginx) in front. The gateway itself never does TLS.
- **Data at rest:** `cache_entries` and `prompt_versions` store prompts and responses in **plaintext SQLite**. Acceptable for single-tenant self-hosted; document it in the README so nobody routes secrets through it unknowingly. Retention is bounded: cache TTL (24h default) + the 90-day requests pruner.
- **Input hardening:** Fastify `bodyLimit` (default 1 MB, configurable) on `/v1/*`; upstream request timeout (default 120s) with abort; admin token compared timing-safe; `x-pg-request-id` is a UUID, not a guessable sequence, since `GET /v1/requests/:id/usage` is keyed on it plus the owning pg key.
- **Secrets:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and `ADMIN_TOKEN` only via env (`.env` gitignored, `.env.example` complete); provider keys remain optional at boot and are never logged or returned in error bodies. CI uses dedicated provider keys with provider-side spend limits (§7.4).
- **Eval data:** golden datasets must be synthetic / de-identified — the carematch-derived set is a *policy-regression* dataset, not clinical validation, and must contain no real patient text (decision #12's framing).

## 13. Risks

| Risk | Mitigation |
|---|---|
| Provider wire-format drift breaks adapters | nightly contract tests (§11); adapters validate with Zod and fail loud, never coerce silently |
| Streaming metering inaccurate (aborts, missing usage) | `cost_estimated` flag + estimated-vs-exact split visible in dashboard; never silently guess |
| Pricing table goes stale → wrong costs | date-effective rows; startup warning if newest `effective_from` > 60 days old |
| CI eval flakiness (LLM nondeterminism) fails good PRs | deterministic assertions dominate the gate; judge cases use threshold + `max-score-drop` band, not exact match; Phase 5 pins DeepSeek V4 Flash at temperature zero and uses GPT-5.6 Terra at high reasoning effort without a temperature override as its independent judge instead of self-judging |
| CI cost runaway | $1 circuit-breaker gateway budget enforced by reserve-then-reconcile (§3.5); dedicated CI provider keys carry provider-side spend limits as the absolute outer wall |
| web_builder_llm needs tool calls (adapter gap) | resolve the `TODO(verify)` in phase 2, not phase 8; backup dogfood app named |
| Scope creep toward SaaS (multi-tenant, orgs, SSO) | scope guard is in the idea file; admin auth stays a single env token by decision #15 |
| SQLite write contention under load | WAL mode, single process, request logging is the only hot write path and it's one insert — fine for single-tenant reality |

## 14. Where to start

Open a terminal and execute Phase 0, step 1 of `BUILD_PLAYBOOK.md`. Every subsequent action is the next numbered step; every phase ends with a verify block that tells you whether to proceed. The only steps requiring information not in this document are the ones marked `TODO(verify)` (two external repos) and `TODO(build-time)` (current model names and prices).
