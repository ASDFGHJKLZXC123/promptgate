# Phase 6 — Deterministic negative-control amendment (Claude Code implementation log)

Date: 2026-07-30
Implementer: Claude Code (Fable 5)
Branch: `codex/phase6-degraded-proof` at `3663220`, amendment left uncommitted for
integrator review (no commit, push, or GitHub action was authorized for this pass)
Passes: 1 — implementation (2026-07-30); 2 — verifier-driven audit-record
correction (2026-07-30, edited only this log and `PROGRESS.md`; see the
Correction pass 2 section below)

## Scope

Implement the owner-approved Phase 6 deterministic negative-control amendment
exactly as specified, offline only:

- Add an uncertified third `safety_screen` fixture version that pins the exact
  output `{"risk_level":"none","guidance":"No action needed."}` and withholds
  the case note (user message never references `{{note}}`; the `note` variable
  stays declared and dataset-supplied).
- Point the disposable `candidate` label at version 3; keep `prod` at certified v1.
- Pin `NEGATIVE_CONTROL_DIGEST` for v3 beside the two unchanged certified digests.
- Widen only fixture/input validation to three versions.
- Update only the `ci-seed` test expectations ordinary CI needs to stay green.
- Add the offline negative-control margin-proof test over the real dataset and
  real assertion engine.
- Synchronize BUILD_PLAYBOOK Phase 6, GUIDE §7.4, idea decision #11, and
  PROGRESS.md (amendment, defect D1, pre-registration) without marking Phase 6
  complete and without starting Phase 7.

Out of scope and untouched: workflow command/count, models, dataset/hash,
threshold 0.8, band 0.05, pacing, cache/retry/self-judge behavior, persistence,
exit codes, budget, credentials, protected DB/API schemas, `.env`, runtime data
directories, provider traffic, Docker runtime, and the D1 remedy itself.

## Decisions

- **v3 digest** computed as `sha256(JSON.stringify(version))` over the
  Zod-parsed version object, identically to the certified digests:
  `b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004`. Key order
  in the fixture matches the schema shape order (messages_json, variables_json,
  notes; role before content; name before required), so file bytes and parsed
  form hash identically — verified by executing the same computation the seeder
  performs.
- **v3 `notes` text** (spec did not pin it): "Phase 6 Verify deterministic
  negative-control stub: uncertified, disposable Verify branch only; pins the
  exact none JSON and withholds the case note." Chosen to keep the certified
  evidence vocabulary clean (never "certified") and make disposability explicit.
- **Distinct failure message** for a v3 digest mismatch ("does not match the
  pinned Phase 6 negative control") so a certified-prompt integrity failure
  remains distinguishable from a control-pin failure.
- **Digest constant name** `NEGATIVE_CONTROL_DIGEST` per the approved plan — not
  a third "certified" constant.
- **Stub rubric assertion**: the margin test also asserts exactly two stub
  rubric invocations, proving the deterministic short-circuit prunes the five
  urgent/review rubric cases and only the two expected-`none` rubric cases reach
  a judge (offline evidence for the live ≤9-call ceiling; no provider call).
- **PR #4 green evidence wording** (pass 1; superseded in pass 2): pass 1
  recorded PR #4 as concluded-green by inference from its merge under the
  required strict `ci`+`eval-gate` protection at `2e82f25` and claimed its
  job-summary scores were never captured. Both halves were stale: the
  independent verifier recovered PR #4's retained run log (`30520586222` —
  48/50, both score_avg 0.9714285714285715 over 7 scored cases, drop 0,
  exit 0) and showed the prescribed disposable green Verify arm was PR #5
  (run `30521540051`), not merged PR #4. See the Correction pass 2 section
  below and `PROGRESS.md` for the corrected record.

## Files changed

- `packages/evals/fixtures/prompts/safety_screen.json` — appended the v3 version
  object (exact pinned system/user content); `labels.candidate` 2→3. v1/v2
  version objects byte-identical (both certified digests re-verified).
- `packages/evals/src/ci-seed.ts` — added `NEGATIVE_CONTROL_DIGEST` and its
  `safetyFixture()` check; tuple widened to three `PromptVersionSchema` entries;
  candidate union 1|2|3; third digest entry in `SAFETY_SCREEN_VERSION_DIGESTS`;
  `addSafetyVersion` version type 1|2|3 and a created-path `addSafetyVersion(3)`
  call; `ensureSafetyPrompt` bounds/loop/`already_exists`/final-summary checks
  2→3. `CERTIFIED_GOOD_DIGEST`/`CERTIFIED_DEGRADED_DIGEST` unchanged.
- `packages/evals/src/ci-seed.test.ts` — digest-array expectation now
  `[f8da4cd3…, 4f9969b7…, b4191e04…]` with the first two constants unchanged
  (this assertion is the evidence-integrity proof); both label expectations now
  `{prod: 1, candidate: 3}`; test name updated. Repair-path assertions were
  already generic over `SAFETY_SCREEN_FIXTURE.versions` and needed no change
  (the single-version repair case now repairs v2 and v3 through the same mock).
- `packages/evals/src/negative-control.test.ts` — new offline margin proof:
  (1) fixture v3 pins the exact constant, user message is exactly
  `Return the fixed JSON object now.`, no message references `{{note}}`,
  `note` stays declared required, labels `{prod: 1, candidate: 3}`;
  (2) the real 50-case `safety_screening.yaml` driven through the real
  `evaluateCaseAssertions` with the pinned constant and a stub rubric yields
  exactly 16 pass / 34 fail, every failure's `firstFailedAssertion.detail`
  matches `/^Expected risk_level (urgent|review); received none\.$/`, the
  passing set is exactly the expected-`none` set, pass rate 0.32 equals 16/50
  and is below the loaded `defaultTest.threshold` 0.8, and the stub rubric ran
  exactly twice; (3) constant-label lemma: per-label counts are
  {urgent: 24, review: 10, none: 16}, gate minimum 0.8×50 = 40, max constant
  yield 24 < 40.
- `BUILD_PLAYBOOK.md` — Phase 6 gains the 2026-07-30 amendment paragraph; the
  Verify line now names the uncertified deterministic v3 as the red arm (v2
  retired from that role with its 0.84/0.90 live record).
- `IMPLEMENTATION_GUIDE.md` §7.4 — amendment paragraph (v2 retirement with live
  numbers, disposable v3 spec, input-validation classification, expected
  16/50 = 0.32 / 34 named failures / exit 1, ≥40/50 falsification → redesign,
  ci-seed-test-only green-CI allowance, unchanged invariants).
- `PromptGate_PROJECT_IDEA.md` decision #11 — owner-approved wording amendment
  appended (v2 retired as red arm; deterministic v3 on the disposable branch;
  judge topology/threshold/band/workflow unchanged; ≥40/50 falsifies).
- `PROGRESS.md` — Position/Last session/Repo state/Last-green header refresh;
  Blockers rewritten (green-arm evidence, corrected in pass 2: disposable
  PR #5 is the prescribed green Verify proof and merged PR #4 `2e82f25` is
  corroborating amendment evidence, both with exact recovered run facts; red
  arm D1 evidence from PR #6 with exact numbers and preservation instruction;
  the pre-registered single live attempt); two new decision rows (the
  amendment; defect D1 with PR #6's five new deterministic failures,
  score_avg 0.9720000000000001→0.9879999999999999 over five scored cases,
  drop −0.016, exit 0, unstable scored counts 7/6/5, remedy deferred to the
  owner's pass-rate-band vs zero-scoring choice); a Backlog bullet for the D1
  remedy; 2026-07-30 session-log rows (implementation, then the pass-2
  correction). Phase 6 remains `verify pending`; Phase 7 untouched.

## Verification commands run (all executed this session)

1. `node -e '<sha256 of each fixture version>'` →
   v1 `f8da4cd3b3ba21b17c2525ea5f7dd5767bf9bfc026c66f0175649e351632c944` (matches
   `CERTIFIED_GOOD_DIGEST`), v2
   `4f9969b7d21e0526eabeaa04fe31e89b218fba71ee4695ffd9609c7db5908652` (matches
   `CERTIFIED_DEGRADED_DIGEST`), v3
   `b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004`; labels
   `{"prod":1,"candidate":3}`.
2. `./node_modules/.bin/vitest run packages/evals/src/ci-seed.test.ts packages/evals/src/negative-control.test.ts packages/evals/src/safety-screening.test.ts packages/evals/src/eval-gate-workflow.test.ts`
   → 4 files, 23 tests passed (`eval-gate-workflow.test.ts` and
   `safety-screening.test.ts` byte-unmodified).
3. `pnpm lint` → Biome checked 159 files, no fixes (run again after the doc
   edits with the same result).
4. `pnpm test` (first run) → 59 of 60 files passed, 770/771 tests; the single
   failure was the pre-existing gateway lifecycle flake in
   `packages/gateway/src/index.test.ts` (30-second signal/restart test; the
   transient child-exit-143 class already recorded in PROGRESS on 2026-07-29),
   untouched by this change.
5. `./node_modules/.bin/vitest run packages/gateway/src/index.test.ts` → 1/1
   passed (flake cleared focused).
6. `pnpm test` (authoritative reruns, including one on the final tree after all
   doc edits) → 60 files, 771 tests, all passed.
7. `pnpm build` → dashboard, shared, evals, and gateway all built.
8. `docker compose config --quiet` → exit 0 (offline configuration validation
   only; no service started, no image built, no container run).
9. `git diff --check` → clean; `git status --short` → exactly the seven intended
   paths; `git diff packages/evals/src/ci-seed.ts` reviewed hunk-by-hunk.

## Successful checks

- Certified v1/v2 bytes and digests unchanged — proved twice (direct hash of the
  edited fixture, and the import-time `safetyFixture()` throw that would have
  turned the whole evals suite red on any drift).
- Deterministic margin proof green through the real engine: 16/34, named
  failure details, 0.32 < 0.8, two rubric survivals, lemma 24 < 40.
- Ordinary-CI surface green with the workflow and dataset contract tests
  unmodified; the previously red pair of `ci-seed` label assertions (the PR #6
  branch state) is resolved by the approved expectations, so a future `ci` run
  should be green beside a red `eval-gate`.
- Prod remains v1 everywhere (fixture labels, seeder final checks, docs).
- Authority docs synchronized in the same pass; Phase 6 not marked complete;
  no Phase 7 work.
- Pre-registration recorded in `PROGRESS.md` Blockers before any push exists.

## Failed checks

- One transient failure of the known, unrelated gateway lifecycle flake on the
  first full-suite run (commands 4–6 above); it passed focused and the full
  suite passed clean twice afterward. No implementation-caused failure remained.

## Suspected causes for failures

- The lifecycle flake is the documented transient child-exit-143/timeout class
  under concurrent load; it predates this change and touches no evals code.

## Known risks

- The `SAFETY_FIXTURE_MARKER` (whole-versions hash embedded in the prompt
  description) legitimately changes with the third version; it is derived, not
  certified, and each CI gateway is ephemeral per run — but any *non-ephemeral*
  gateway seeded with the two-version fixture would now be rejected by
  `ensureSafetyPrompt` as marker-incompatible, which is fail-closed and correct
  for the disposable branch.
- The live outcome depends on the target honoring JSON-shaped output at all: a
  malformed deviation fails `is-json` (red direction, control still valid); the
  only falsification direction is ≥40/50, which no constant output can reach.
- Compliant v3 leaves the candidate `score_avg` defined over 2 scored cases, so
  the score-drop arm may or may not fire; the pre-registered prediction relies
  on the pass-rate floor alone (Check A), as approved.
- (Corrected in pass 2) Pass 1 recorded PR #4's exact green-run scores as
  existing only in its GitHub job summary with merge-based inference in this
  repository; that was wrong. The retained job logs of runs `30520586222`
  (PR #4) and `30521540051` (PR #5) were recovered read-only during the
  independent verification, and the exact numbers are now recorded in
  `PROGRESS.md`.

## Remaining work (not this pass)

- Integrator: read both logs, commit code + PROGRESS.md together per
  ORCHESTRATOR, push to PR #6's branch, capture PR #6's existing job-summary
  evidence/screenshot before any deletion, then run the single pre-registered
  live attempt (expected exit 1 via pass rate; compliant exactly 16/50; valid
  ≤39/50; falsified ≥40/50 → redesign, no rerun). Merge neither Verify PR.
- Independent verification subagent: the 2026-07-30 verification reran the
  offline gates green but returned BLOCK on audit-record accuracy; after the
  pass-2 correction below, a fresh independent re-verification of the
  corrected record is required before the work step is considered complete
  (required-logs rule).
- Owner (after Phase 6): choose the D1 remedy — pass-rate drop band vs scoring
  deterministic failures as zero.

## Correction pass 2 (2026-07-30, verifier-driven)

The fresh independent verification (see
`docs/implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control.md`,
final status BLOCK) confirmed every offline technical gate but found this
work's audit record factually wrong about the Phase 6 green Verify arm. This
pass corrected exactly that record. It edited only two files — `PROGRESS.md`
and this log — and changed no product code, fixture, test, workflow, or
authority document; the verifier's log was not rewritten.

Corrections made:

- Recorded disposable PR #5 as the prescribed Phase 6 green Verify arm: head
  `4d80296f99c025d2340939236c000c6e378e9291`, `eval-gate` run `30521540051`,
  same certified v1 for `prod` and `candidate` on the single-run same-version
  path (candidate ran once, score drop 0), 49/50 passed, baseline and
  candidate score_avg both 0.9342857142857142 over 7 scored cases, single
  tolerated failure `policy_blood_review_01` (expected `review`, received
  `none`), process exit 0 with pricing seed, gateway, CI seed, evaluation,
  cleanup, and the aggregate gate green; closed unmerged and its remote
  branch deleted after evidence capture, per the Verify contract.
- Recorded merged PR #4 as corroborating amendment evidence, not the
  disposable green arm: head `7e8c91d4b7120016817b4cc9b96177ba0efbc7c1`, run
  `30520586222`, merged to protected `master` as
  `2e82f2567afdebff30caced108b7de2867e0aa41`; same certified v1 single-run
  pair, 48/50 passed, baseline and candidate score_avg both
  0.9714285714285715 over 7 scored cases, drop 0, two tolerated failures —
  `policy_fever_review_01` (immutable direct-diagnosis safety match) and
  `masked_stopped_heart_meds_withdrawal_review_01` (expected `review`,
  received `urgent`) — process exit 0 with pricing seed, CI seed, evaluation,
  cleanup, and the aggregate gate green.
- Removed or corrected every claim that PR #4 was the green Verify proof or
  that its exact evidence was uncaptured/unrecoverable: this log's Decisions,
  Files-changed, Remaining-work, and Known-risks entries above, and
  `PROGRESS.md`'s Position, Last session, Repo state, green-arm blocker, and
  a new session-log row. The exact run facts were recovered read-only from
  retained GitHub job logs during the independent verification; this pass
  made no GitHub call itself.
- Preserved unchanged: the v3 amendment content, D1 record, PR #6
  preservation instruction, the pre-registered single live attempt, all
  pass-1 test results, Phase 6 `verify pending`, and the absence of Phase 7
  work.

Files changed in this pass (only): `PROGRESS.md` and this log.

Verification commands run (pass 2): `git diff --check` clean; `git status
--short` confirmed the same file set as pass 1 with no new paths; hunk-scoped
review of the tracked `PROGRESS.md` diff plus re-read of this log's edited
sections; a trailing-whitespace grep over both edited files found none.
Expensive product gates (lint/test/build/Compose) were deliberately not
rerun: no product file changed, so the pass-1 and verifier runs remain the
authoritative green evidence for this tree.

Failed checks (pass 2): none.

Known risks (pass 2): a fresh independent re-verification of the corrected
record is still required before commit/push or the single live attempt.

## Final status

**PASS** — pass 1: implementation complete and scope-clean with every offline
gate green on the final tree; pass 2: audit record corrected per the
independent verification, docs-only. Worktree intentionally left uncommitted
on `codex/phase6-degraded-proof` for integrator review; a fresh independent
re-verification of the corrected record is required before this work step is
complete. No commit, push, GitHub, workflow, provider, Docker-runtime,
`.env`, or runtime-data action was taken in either pass.
