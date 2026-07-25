# PromptGate — Build Progress

> Maintained by the orchestrator (see `ORCHESTRATOR.md`). Updated after every step. Humans: the Position line is always the truth.

**Position:** Phase 0 — done and human-approved; Phase 1, step 10 — not started
**Last session:** 2026-07-25 — completed the human-approved Phase 1 step 9 four-provider config/pricing/metering foundation and synchronized every authority document
**Repo state at last update:** provider taxonomy/config/pricing now covers OpenAI, Anthropic, Gemini, and DeepSeek; migration 003 preserves existing prices while adding optional cache-hit input rates; no Gemini/DeepSeek adapter or route exists yet
**Last commit:** phase-1 step-9 (this commit) · **Last green `pnpm lint && pnpm test`:** 2026-07-25 (18 test files, 155 tests passed)

## Phase status

Model/effort per ORCHESTRATOR.md → Model & effort assignment.

| Phase | Name | Implementer | Status | Verify evidence | Approved by human |
|---|---|---|---|---|---|
| 0 | Scaffold | GPT-5.3-Codex-Spark / xhigh; Terra / medium for DB+Docker | done | `docs/evidence/phase-0.md` | project owner — 2026-07-16 |
| 1 | OpenAI-compatible non-streaming | Claude Sonnet 5 / high; Spark+Luna support; Sol / xhigh expansion audit | in progress (step 10) | — | — |
| 2 | Anthropic + four-provider streaming | Claude Opus 4.8 / xhigh; Luna fixtures; Sol / xhigh checkpoint | not started | — | — |
| 3 | Cache, limits, budgets | GPT-5.6 Terra / high; Sol / xhigh budget audit | not started | — | — |
| 4 | Prompt registry | GPT-5.6 Terra / high; Spark support | not started | — | — |
| 5 | Eval harness | Claude Opus 4.8 / xhigh; Spark+Luna support; Fable dataset | not started | — | — |
| 6 | CI gate | GPT-5.6 Terra / high; Spark draft support | not started | — | — |
| 7 | Dashboard | GPT-5.6 Terra / high; Spark scaffold; Sol / high polish | not started | — | — |
| 8 | Dogfood + writeup | Claude Sonnet 5 / high; Luna evidence; Sol / high writeup | not started | — | — |

Evidence = link/pointer to captured verify-block output (commit, gist, or `docs/evidence/phase-N.md`).

Status values: `not started` · `in progress (step K)` · `verify pending` · `awaiting approval` · `done`

## Pathway reviews (mixed-model)

| Checkpoint | Trigger | Reviewer | Verdict | Date |
|---|---|---|---|---|
| A — provider seam | after phase 2 | GPT-5.6 Sol / xhigh | pending | — |
| B1 — eval gate technical audit | after phase 5 | GPT-5.6 Sol / xhigh | pending | — |
| B2 — dataset/pathway verdict | after B1 | Claude Fable 5 / high | pending | — |
| Phase 0 Compose binding | doc-authority conflict | Claude Fable 5 / high | proceed with adjustments — publish on loopback and sync the playbook | 2026-07-16 |
| Phase 1 request identity | schema/API doc-authority conflict | Claude Fable 5 / high | proceed with adjustments — persist a UUID in migration 002, renumber the uncommitted registry/eval migrations, and schedule the owner-scoped usage endpoint in phase 2 | 2026-07-17 |
| Phase 1 four-provider scope | locked scope/provider expansion | Fable 5 / high unavailable (usage credits); GPT-5.6 Sol / xhigh technical audit + project owner | proceed with adjustments — approve OpenAI, Anthropic, Gemini, and DeepSeek; use an explicit available-key live matrix; add cache-aware pricing; keep full streaming parity in phase 2 | 2026-07-25 |

## Blockers (current)

- none

## TODO(verify) resolutions

| Item | Where | Resolution | Date |
|---|---|---|---|
| web_builder_llm sends `tools`? | GUIDE §3.2 / playbook phase 2 | unresolved | — |
| web_builder_llm calls `GET /v1/models`? | GUIDE §5.1 / playbook phase 8 | unresolved | — |
| carematch_ai safety cases: file paths + the 6 cases | GUIDE §7.3 / playbook phase 5 | unresolved | — |
| web_builder_llm provider config surface (env vars) | GUIDE §9 / playbook phase 8 | unresolved | — |

## TODO(build-time) resolutions

| Item | Resolution | Date |
|---|---|---|
| Pinned cheap eval models (one per provider) | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic), `gemini-2.5-flash-lite` (Gemini), and `deepseek-v4-flash` (DeepSeek) | 2026-07-25 |
| `pricing.json` seeded from current provider pricing | Human-approved rows: Luna $1/$6, Terra $2.50/$15 effective 2026-07-16; Sonnet 5 promotional $2/$10 effective 2026-06-30 and published $3/$15 effective 2026-09-01; Gemini 2.5 Flash-Lite $0.10/$0.40 and DeepSeek V4 Flash $0.14 cache-miss input/$0.0028 cache-hit input/$0.28 output effective from the 2026-07-25 verification date, all per Mtok and stored as integer micro-USD/Mtok | 2026-07-25 |

## Decision log

Small choices the spec didn't cover (architectural ones go to the human instead — see ORCHESTRATOR.md).

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-25 | Applied the project-owner-approved decision #2 amendment from two to four providers: OpenAI, Anthropic, Gemini, and DeepSeek. Phase 1 adds DeepSeek/Gemini non-streaming in steps 10–12; Phase 2 provides streaming parity across all four. Phase verify blocks call every configured implemented provider and name missing-key activation checks as deferred, never live-green. | The owner currently has workable Gemini/DeepSeek credentials but not OpenAI/Anthropic credentials. This preserves forward support without blocking current gateway proof; it does not amend the locked `gpt-5.6-terra` judge, so a working OpenAI key remains a future Phase 5 prerequisite rather than a Phase 1 blocker. Fable 5 / high was attempted but unavailable because of usage credits; GPT-5.6 Sol / xhigh supplied the technical expansion audit before human approval. |
| 2026-07-25 | Added nullable `model_pricing.cached_input_micro_usd_per_mtok` in migration 003, renumbered the still-uncommitted registry/eval migrations to 004/005, and defined validated DeepSeek cache usage plus three-component rounding (cache-hit input, cache-miss input, output). Older pricing JSON may omit the new field and normalizes it to `null`. | DeepSeek publishes separate cache-hit and cache-miss input prices, so one input rate cannot produce exact cost. A new additive migration upgrades both fresh and already-applied databases without rewriting 001/002; independently rounded integer micro-USD components preserve the approved no-floating-money rule. |
| 2026-07-17 | Made `GET /v1/models` return the current official OpenAI list envelope with one deterministically ordered row per model that has a currently effective price; `owned_by` comes from the latest effective provider row and `created` is stable Unix seconds from the earliest pricing date. | Official OpenAI OpenAPI was checked at build time; sourcing the endpoint exclusively through a DAO keeps provider keys optional, avoids network calls, excludes future-only routes, and prevents price-history duplicates. Claude Sonnet 5 / high owned the implementation. |
| 2026-07-17 | Applied the human-approved Fable 5 / high correction by adding nullable, uniquely indexed `requests.request_id` in `002_request_identity.sql`, enforcing UUIDs for every gateway DAO insert, renumbering the then-uncommitted registry/eval migrations (subsequently moved to 004/005 by the 2026-07-25 pricing migration), and scheduling `GET /v1/requests/:request_id/usage` in phase 2. | The response UUID must be persisted for the future owner-scoped usage lookup; a new migration converges already-applied and fresh databases without editing 001, while nullable legacy rows remain compatible and unaddressable. |
| 2026-07-17 | Made the non-streaming chat route an explicit authenticated Zod-validated pipeline with injected adapters, date-effective exact/estimated metering, route-level 1 MiB body hardening, a 120-second abort timeout, safe OpenAI error envelopes, and caught `onResponse` logging. | The route must remain fully offline-testable, keep optional provider keys from blocking boot, never leak upstream bodies or secrets, and send responses before synchronous SQLite logging; standard `invalid_request_error`/`provider_error` codes avoid expanding the documented taxonomy before phase 2. Claude Sonnet 5 / high owned the implementation and returned `APPROVE` after the orchestrator hardening pass. |
| 2026-07-16 | Implemented the OpenAI adapter against the current official `POST /v1/chat/completions` OpenAPI contract with JSON and Bearer provider auth, kept the provider key optional until adapter invocation, and Zod-validated successful upstream responses. | Official OpenAI documentation was checked at build time without a live call; dependency injection keeps all tests offline and prevents ambient developer credentials from entering test behavior. Claude Sonnet 5 / high owned and self-reviewed the implementation. |
| 2026-07-16 | Made shared `stripPgFields()` remove every `pg_`-prefixed key while retaining all other known and unknown fields; made the reusable provider retry helper retry only 429/5xx twice with equal jitter over 250ms/1s bases, body release, and abort cleanup. | Prefix stripping stays correct as PromptGate extensions grow and preserves OpenAI passthrough compatibility; the bounded retry behavior exactly matches §3.6 without retrying ordinary client errors or network/abort rejections. |
| 2026-07-16 | Defined `SseChunk` as a serialized OpenAI SSE data payload plus an explicit terminal flag, made provider resolution return a discriminated success/error result including HTTP 400, and required a currently effective pricing row through a DAO. | The phase 2 seam can stream JSON or `[DONE]` without prematurely defining another wire schema; step 7 can forward `unknown_model` without reconstructing either its envelope or status; no request can route without a rate usable for metering. |
| 2026-07-16 | Made `@promptgate/shared` a real workspace dependency with declarations and conditional development/compiled exports, while excluding emitted test bodies and declarations from its deployable `dist`. | Tests run before builds on clean CI checkouts, whereas the production Node image must resolve only compiled JavaScript and published declarations. A clean deploy and runtime import verified both paths. |
| 2026-07-16 | Installed client authentication through an encapsulated `/v1` Fastify plugin, attached a typed context containing only active-key metadata, and centralized all gateway error envelopes in `src/errors.ts`. | The plugin seam ensures future `/v1` handlers inherit auth without URL-condition middleware, while a safe context and one formatter prevent stored hashes or inconsistent error shapes from leaking downstream. Claude Sonnet 5 / high owned and self-reviewed the implementation. |
| 2026-07-16 | Scoped admin authentication and OpenAI-envelope error handling through the Fastify `/admin` plugin, returned only `{plaintext_key}` from create, listed non-secret metadata plus month-to-date spend, and returned non-secret metadata from patch. | Prefix encapsulation keeps admin policy off `/healthz`; the response shapes fulfill §5.2 while ensuring plaintext and stored hashes never appear after creation. Claude Sonnet 5 / high independently reviewed the completed auth/key path and returned `APPROVE` with no required corrections. |
| 2026-07-16 | Seeded only `gpt-5.6-luna`, locked judge `gpt-5.6-terra`, and `claude-sonnet-5`, with a future date-effective Sonnet 5 row for the published post-promotion price. | The human explicitly approved the current official-source proposal; limiting the table to routed models preserves the unknown-model guard and date-effective metering semantics. |
| 2026-07-16 | Made shared OpenAI wire schemas validate only fields PromptGate touches while preserving unknown provider fields with Zod loose objects; included the current `developer` role and official reasoning-effort values. | The gateway is a compatibility boundary: malformed fields it consumes must fail early, while untouched fields must survive OpenAI passthrough and future API additions. |
| 2026-07-16 | Pinned official `actions/checkout@v6.0.3` and `actions/setup-node@v6.5.0` to their verified full commit SHAs, with read-only contents permission and no pnpm cache bootstrap. | Phase 0 CI needs an immutable, least-privilege toolchain on the supported Node 24 action runtime; omitting setup-node pnpm caching avoids requiring the pnpm executable before Corepack activates the repository-pinned version. |
| 2026-07-16 | Applied the human-approved Fable 5 / high `proceed with adjustments` verdict by changing Phase 0 Compose publication to `127.0.0.1:8787:8787` and synchronizing the playbook. | The higher-authority security specification requires loopback for single-host use, and every documented local verify command remains compatible. |
| 2026-07-16 | Deployed only the gateway production `dist` payload from a multi-stage build, retained native build tools only in the builder, and ignored persisted data plus local `.env` variants. | The runtime needs the native SQLite binding and migration assets without compilers, source/tests, database files, or editor-created secret backups entering commits or images. |
| 2026-07-15 | Made gateway startup create the configured database parent, limited Vitest discovery to source tests, and made gateway builds clear stale `dist` output. | The default `./data/promptgate.db` must boot in a fresh workspace, and generated test copies or stale artifacts must not be executed or packaged as current output. |
| 2026-07-15 | Allowlisted lifecycle scripts only for `better-sqlite3` and `esbuild`, and made the gateway build replace-copy SQL migrations into `dist`. | The native SQLite binding and TS runtime tooling must install in clean local/Docker environments, and compiled startup needs the numbered SQL assets without stale nested copies. |
| 2026-07-15 | Scoped Node 22 types to the gateway package and enabled Biome's Git ignore integration. | Strict compilation needs the `process` type at the owning package boundary, while generated `dist/` files must stay outside lint input. |
| 2026-07-15 | Added root TypeScript with Node 22 types and real `tsc` build scripts for all four package stubs. | The required root `pnpm build` command must compile strict TypeScript for Docker/CI instead of succeeding through no-op package scripts. |
| 2026-07-15 | Installed root Biome/Vitest dev tooling in step 1 and configured Vitest `passWithNoTests` while the suite is empty. | The required `pnpm lint` and `pnpm test` pre-commit checks must be runnable from the first commit; this preserves step 6 as the first real test. |
| 2026-07-15 | Model allocation amended to a mixed OpenAI/Anthropic plan: Spark for bounded scaffolding, Luna for repeatable support work, Terra for routine phase ownership and the runtime judge, Sol for technical checkpoints/polish, Sonnet (never below high) for phases 1 and 8, Opus for phases 2 and 5, and Fable for dataset/pathway judgment. | Human-approved model-policy change. GPT-5.6 Terra / high replaces the previous runtime judge; no Haiku model is permitted. Cross-provider review is preferred for quiet-failure code. |
| 2026-07-15 | Plan review corrections applied (external agent review, human-approved). Highlights: budget → reserve-then-reconcile hard cap, integer micro-USD money, cache key = full forwarded body, evals run `pg_no_cache: true`, one eval run per model + `dataset_hash` + label freezing, paired CI baseline, pg-eval gets admin credential + dataset upsert endpoint, `x-pg-cost-usd` non-streaming only + `GET /v1/requests/:id/usage`, `response_format` → Anthropic `output_config.format` translation, promptfoo `defaultTest.threshold` path, FK pragma + composite label FK, `requests_daily` schema, repo bootstraps in place, provider keys optional at boot, node-native healthcheck, `--filter @promptgate/*`, CI secrets → container via `.env` + SHA-pinned actions + provider-side spend caps, contract-nightly deferred to phase 8, completion evidence → README (idea file stays clean), new guide §12 security/privacy. | Review verdicts accepted after independent fact-check (promptfoo threshold path, Anthropic structured outputs both confirmed against docs); two points accepted with qualification (streaming-usage wording was already correct in playbook; CI secret risk partly mitigated by GitHub's fork-PR secret withholding). |

## Backlog (noted, not acted on)

- none

## Session log

| Date | Covered | Ended at |
|---|---|---|
| 2026-07-25 | Phase 1 step 9 — human-approved four-provider authority amendment; optional Gemini/DeepSeek boot config; approved Gemini/DeepSeek prices; additive cache-rate migration with legacy preservation; Zod-validated paired cache usage; exact cache-hit/cache-miss/output metering; pricing/DAO compatibility; 16 focused test additions, 155 total tests, lint, and build. Claude Sonnet 5 / high produced the bounded draft but did not return before the orchestration cap; GPT-5.6 Sol / xhigh independently audited the integrated result. | Phase 1, step 10 — not started |
| 2026-07-17 | Phase 1 step 8 — authenticated DAO-backed `GET /v1/models`, current date-effective distinct rows, exact official OpenAI list envelope, deterministic ordering, offline provider/network guardrails, 16 focused tests, 139 total tests, and build under Claude Sonnet 5 / high ownership | Phase 1 — verify pending |
| 2026-07-17 | Phase 1 step 7 — human-approved Fable request-identity correction, migration 002 with legacy upgrade proof, non-streaming authenticated chat route, injected providers, exact/estimated metering, UUID/cost/cache headers, bounded body/upstream limits, post-response request logging, safe error mapping, 27 focused tests, 123 total tests, build, and Sonnet 5 / high `APPROVE` | Phase 1, step 8 — not started |
| 2026-07-16 | Phase 1 step 6 — official-spec OpenAI non-streaming adapter, shared prefix-based `pg_*` stripping, strict response validation, typed provider/config errors, reusable abort-aware 429/5xx retry helper, explicit phase 2 stream stub, and 33 focused tests under Claude Sonnet 5 / high ownership | Phase 1, step 7 — not started |
| 2026-07-16 | Phase 1 step 5 — exact provider adapter contract, forward streaming chunk type, static provider prefixes, date-effective pricing DAO, complete `unknown_model` results, shared workspace package exports, 10 focused tests, and deployed-runtime import verification under Claude Sonnet 5 / high ownership | Phase 1, step 6 — not started |
| 2026-07-16 | Phase 1 step 4 — shared OpenAI error formatter, DAO-backed Bearer-key lookup, disabled/invalid-key rejection, typed safe request context, protected `/v1` plugin seam, and 5 focused auth tests under Claude Sonnet 5 / high ownership | Phase 1, step 5 — not started |
| 2026-07-16 | Phase 1 step 3 — DAO-backed admin key create/list/patch endpoints, one-time `pg-` plaintext issuance with SHA-256-only storage, scoped timing-safe admin auth, MTD spend, strict validation/errors, 9 focused tests, and Claude Sonnet 5 / high `APPROVE` | Phase 1, step 4 — not started |
| 2026-07-16 | Phase 1 step 2 — human-approved, Zod-validated provider pricing JSON plus transactional, idempotent source/compiled SQLite seed runners and focused tests | Phase 1, step 3 — not started |
| 2026-07-16 | Phase 1 step 1 — shared Zod OpenAI-compatible wire schemas, inferred strict types, passthrough compatibility, and 34 focused schema tests; exact Claude Sonnet 5 / high review found no required edits | Phase 1, step 2 — blocked pending human pricing/model confirmation |
| 2026-07-16 | Phase 0 completion gate — human approval recorded after local, Docker, Terra, and GitHub Actions evidence passed | Phase 1, step 1 — not started |
| 2026-07-16 | Phase 0 step 8 and completion verification — SHA-pinned workflow, actionlint, frozen install, lint/test/build, Docker health HTTP 200, and green remote `ci` run | Phase 0 completion gate — awaiting explicit human approval |
| 2026-07-16 | Phase 0 step 7 — native-module multi-stage image, loopback-only Compose service, healthcheck, and approved playbook correction | Phase 0, step 8 — not started |
| 2026-07-15 | Phase 0 steps 1–6 — workspace scaffold through the migrated Fastify health server and its first real test | Phase 0, step 7 — blocked before implementation pending human input |
