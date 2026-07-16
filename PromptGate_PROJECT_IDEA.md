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
1. Gateway with 2 providers, metering, caching, per-key budgets
2. Prompt registry with version history and diff view
3. Eval harness + 1 golden dataset, wired as a CI regression gate
4. Cost/quality drift dashboard
5. Dogfood proof: one existing app's LLM calls routed through the gateway

## Scope guard
2 providers, 1 golden dataset (reuse a task from an existing app — e.g. carematch_ai's safety screening), 1 CI gate. Not a SaaS: single-tenant, self-hosted.

## Decisions (locked 2026-07-12; amended 2026-07-15 after human-approved plan reviews — see PROGRESS.md decision log)

### A. Architecture
1. **Gateway API surface: Chat Completions-compatible subset of `/v1/chat/completions`** (the fields the dogfood apps use, not universal OpenAI compatibility). Makes dogfooding a base-URL change (see #16).
2. **Providers: Anthropic + OpenAI.** Real cost metering on both is the point. Keep CI cost at pennies by pinning cheap models. Ollama as a stretch third provider only.
3. **Streaming: yes in v1.** Existing apps stream (AI_Inbox_Copilot SSE, AI_reading_assistant); meter via each provider's stream usage metadata (OpenAI: usage chunk via `stream_options.include_usage`; Anthropic: `message_start` input tokens + `message_delta` output tokens).

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
11. **Judge: deterministic assertions first; GPT-5.6 Terra at high reasoning only where needed.** The runtime judge remains a small, explicitly invoked part of the gate; it is not used when deterministic assertions are sufficient.
12. **Golden dataset: seed from carematch_ai (now in `Archive/`, still readable), expand synthetically to ~50 labeled cases.** carematch has no dataset per se — extract its ~6 in-code safety test cases plus the keyword-urgency logic as seeds.

### E. Ops
13. **CI: GitHub Actions** (portfolio-wide standard).
14. **Deployment: Docker Compose.** Kubernetes belongs to SRE Lab — don't double-spend.
15. **Auth: static hashed API keys in DB with per-key budget + rate limit.**
16. **Dogfood app: web_builder_llm** (kept in `Finished/`), NOT carematch_ai (archived). web_builder_llm already supports OpenAI-compatible providers via configurable base URL (it routes Mistral/xAI/Groq/OpenRouter that way), so with decision #1 dogfooding is literally pointing that base URL at PromptGate. Backup: AI_Inbox_Copilot.
17. **Repo layout: monorepo** — `packages/{shared,gateway,evals,dashboard}` (shared holds wire types/cost math/template engine).

Open trade-offs consciously accepted: #2 means CI eval runs cost real (tiny) money — Ollama would make them free at the cost of weaker cost-metering proof; #4 passes on Go reinforcement because clipsync covers Go better.
