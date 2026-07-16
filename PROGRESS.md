# PromptGate — Build Progress

> Maintained by the orchestrator (see `ORCHESTRATOR.md`). Updated after every step. Humans: the Position line is always the truth.

**Position:** Phase 0 — done and human-approved; Phase 1, step 1 — not started
**Last session:** 2026-07-16 — human approved the completed Phase 0 gate; Phase 1 remains unstarted
**Repo state at last update:** Literal Verify block, lint, test, build, native-module Docker integration, health HTTP 200, and SHA-pinned GitHub `ci` workflow all pass
**Last commit:** phase-0 step-8 (this commit) · **Last green `pnpm lint && pnpm test`:** 2026-07-16 (1 test file, 1 test passed)

## Phase status

Model/effort per ORCHESTRATOR.md → Model & effort assignment.

| Phase | Name | Implementer | Status | Verify evidence | Approved by human |
|---|---|---|---|---|---|
| 0 | Scaffold | GPT-5.3-Codex-Spark / xhigh; Terra / medium for DB+Docker | done | `docs/evidence/phase-0.md` | project owner — 2026-07-16 |
| 1 | OpenAI passthrough | Claude Sonnet 5 / high; Spark+Luna support | not started | — | — |
| 2 | Anthropic + streaming | Claude Opus 4.8 / xhigh; Luna fixtures | not started | — | — |
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

## Blockers (current)

- none at the current position — later-phase `TODO(verify)`/`TODO(build-time)` items below block only their consuming phases.

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
| Pinned cheap eval models (one per provider) | unresolved | — |
| `pricing.json` seeded from current provider pricing | unresolved | — |

## Decision log

Small choices the spec didn't cover (architectural ones go to the human instead — see ORCHESTRATOR.md).

| Date | Decision | Rationale |
|---|---|---|
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
| 2026-07-16 | Phase 0 completion gate — human approval recorded after local, Docker, Terra, and GitHub Actions evidence passed | Phase 1, step 1 — not started |
| 2026-07-16 | Phase 0 step 8 and completion verification — SHA-pinned workflow, actionlint, frozen install, lint/test/build, Docker health HTTP 200, and green remote `ci` run | Phase 0 completion gate — awaiting explicit human approval |
| 2026-07-16 | Phase 0 step 7 — native-module multi-stage image, loopback-only Compose service, healthcheck, and approved playbook correction | Phase 0, step 8 — not started |
| 2026-07-15 | Phase 0 steps 1–6 — workspace scaffold through the migrated Fastify health server and its first real test | Phase 0, step 7 — blocked before implementation pending human input |
