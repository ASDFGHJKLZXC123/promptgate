# PromptGate — LLMOps Gateway & Evaluation Platform

Status: idea only — no code yet. Split from `NEW_PROJECT_IDEAS_FOR_UNPROVEN_CONCEPTS.md` (2026-07-12).
Suggested build order: **#4 of 5**.

## Why this project type is new for the portfolio
The portfolio has many LLM *consumers* (assistants, copilots, generators). This is the *ops layer* those apps would sit behind — developer tooling for AI, a different product category.

## Unproven concepts this project closes
- LLMOps end-to-end: eval harnesses, prompt versioning, model gateway, cost/latency observability — currently the hottest completely-empty cell in the concepts matrix
- Bonus: contract testing against provider APIs; FinOps flavor (cost per feature/request)

## What it is
A self-hosted **model gateway** (multi-provider routing — already a mastered pattern — now with per-request cost and latency metering, response caching, budgets and rate limits per API key), plus a **prompt registry** (versioned prompts, diffs, rollback), plus an **eval harness**: golden datasets, deterministic assertions + LLM-as-judge scoring, run in CI so a prompt or model change fails the build on quality regression. Dashboard tracks cost and quality drift over time.

## Key deliverables
1. Gateway with 4 providers, metering, caching, per-key budgets
2. Prompt registry with version history and diff view
3. Eval harness + 1 golden dataset, wired as a CI regression gate
4. Cost/quality drift dashboard
5. Dogfood proof: one existing app's LLM calls routed through the gateway

## Scope guard
4 providers (amended 2026-07-25, see decision #2), 1 golden dataset (reuse a task from an existing app — e.g. carematch_ai's safety screening), 1 CI gate. Not a SaaS: single-tenant, self-hosted.

## Decisions (locked 2026-07-12; amended 2026-07-15 after human-approved plan reviews, 2026-07-25 for the four-provider scope, 2026-07-26 for decision #12 provenance, and 2026-07-27 for the Phase 5 decision #11 gate — see PROGRESS.md decision log)

### A. Architecture
1. **Gateway API surface: Chat Completions-compatible subset of `/v1/chat/completions`** (the fields the dogfood apps use, not universal OpenAI compatibility). Makes dogfooding a base-URL change (see #16).
2. **Providers: OpenAI, Anthropic, Gemini, DeepSeek.** (Amended 2026-07-25, human-approved — see PROGRESS.md decision log; supersedes the original 2-provider lock. BUILD_PLAYBOOK.md phase 1 steps 9–12 build the foundation, then DeepSeek and Gemini non-streaming adapters, then integration.) Real cost metering across all four is the point. Phase verification makes bounded live calls only for configured provider keys and records every unavailable provider as deferred, never falsely green; Gemini and DeepSeek are the current live-verification path, while OpenAI and Anthropic remain future activation checks. Keep CI cost at pennies by pinning cheap models. Ollama remains a stretch fifth provider only.
3. **Streaming: yes in v1.** Existing apps stream (AI_Inbox_Copilot SSE, AI_reading_assistant); meter via each provider's stream usage metadata (OpenAI, Gemini, and DeepSeek: final usage requested with `stream_options.include_usage`; Anthropic: `message_start` input tokens + `message_delta` output tokens).

### B. Stack
4. **Language: TypeScript (Fastify).** Streaming proxies and provider SDKs are first-class in Node, and the built-in dashboard is cheapest there. Python/FastAPI is already proven twice (Distributed Job Queue, SIGNAL); Go's value is better banked by finishing Cross-Device Clipboard Sync.
5. **Database: SQLite.** Matches the single-tenant scope guard; Postgres signal is already proven ~6 times across the portfolio; better-sqlite3 experience exists from AI_reading_assistant.
6. **Cache: exact-match (hash of model+prompt+params) in DB.** Semantic cache is a documented stretch goal only.
7. **Dashboard: built-in lightweight web UI served by the gateway.** It's a headline deliverable; a separate React app adds a repo, not a concept.

### C. Prompt registry
8. **Version storage: DB rows, immutable versions + labels (e.g. "prod").** Git export can come later.
9. **Consumption: request references `slug@version` or `slug@label` (e.g. `safety_screen@prod`); gateway interpolates variables server-side.** This is what enables eval/rollback without app deploys — the core LLMOps claim.

### D. Eval harness
10. **Custom harness core with promptfoo-compatible dataset format.** Custom proves the empty concept cell; format compatibility shows ecosystem awareness and gives free test data.
11. **Judge: deterministic assertions first; Phase 5 cross-judges Gemini 2.5 Flash and DeepSeek V4 Flash.** DeepSeek judges only Gemini target output, and Gemini judges only DeepSeek target output, so neither model judges itself. Judge calls use the immutable `judge_rubric_v1@1` prompt, JSON-object output, temperature zero, and no cache; no provider-specific reasoning-effort override is sent. The runtime judge remains a small, explicitly invoked part of the gate and is not used when deterministic assertions are sufficient. This human-approved 2026-07-27 amendment narrows the Phase 5 live target/judge matrix only; it does not remove OpenAI or Anthropic gateway support or amend Phase 6's later four-provider requirement.
12. **Golden dataset: seed from verified carematch_ai safety artifacts, expand synthetically to ~50 labeled cases.** The recoverable sources are `server/safety.js` at public commit `d22bf9d798ed22b77690a02a02a9284494ca188c` and the exact safety probes retained in the 2026-05-23 build session. No six-case test file is verifiable: preserve recovered probe inputs verbatim, identify policy-derived cases as derived rather than original, identify model-generated cases as synthetic, and hand-review every final label.

### E. Ops
13. **CI: GitHub Actions** (portfolio-wide standard).
14. **Deployment: Docker Compose.** Kubernetes belongs to SRE Lab — don't double-spend.
15. **Auth: static hashed API keys in DB with per-key budget + rate limit.**
16. **Dogfood app: web_builder_llm** (kept in `Finished/`), NOT carematch_ai (archived). web_builder_llm already supports OpenAI-compatible providers via configurable base URL (it routes Mistral/xAI/Groq/OpenRouter that way), so with decision #1 dogfooding is literally pointing that base URL at PromptGate. Backup: AI_Inbox_Copilot.
17. **Repo layout: monorepo** — `packages/{shared,gateway,evals,dashboard}` (shared holds wire types/cost math/template engine).

Open trade-offs consciously accepted: #2 means CI eval runs cost real (tiny) money — the unapproved Ollama stretch fifth provider would make them free at the cost of weaker cost-metering proof; #4 passes on Go reinforcement because clipsync covers Go better.
