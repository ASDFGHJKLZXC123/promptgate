# Phase 6 — Deterministic negative-control amendment (independent verification)

Date: 2026-07-30
Verifier: independent Codex verification subagent (not the implementer)
Branch/starting HEAD: `codex/phase6-degraded-proof` at
`36632201edc675ff688d521d4f99c4b6b7f508c9`

## Scope and restrictions

Independently verify the owner-approved deterministic negative-control amendment
already present uncommitted. I did not implement or repair product, test,
fixture, workflow, or authority content. I made no commit, push, pull-request
write, workflow invocation, provider call, Docker runtime start, `.env` read, or
runtime-data read/write. This verification log is the only file I created.

## Authority and evidence read

Read in full:

- `../CLAUDE.md`
- `ORCHESTRATOR.md`
- `/Users/f8fq/.claude/plans/you-are-the-fallback-unified-comet.md`
- `docs/implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`

Read the complete relevant Phase 6 / CI-gate / decision / current-state sections
of:

- `BUILD_PLAYBOOK.md` (Phase 6 in full, including Verify)
- `IMPLEMENTATION_GUIDE.md` (§7.2 context and §7.4 in full)
- `PromptGate_PROJECT_IDEA.md` (complete file, especially decision #11)
- `PROGRESS.md` (position, phase status, blockers, 2026-07-30 decisions, backlog,
  and session record)

Also inspected the real D1 control flow in `assertions.ts` and `runner.ts`:
deterministic failures return before a score is attached, `scoreAvg` averages
only scored cases, and pass rate is compared only with the absolute dataset
threshold.

## Files inspected

Read every changed or new implementation/test/fixture file in full:

- `packages/evals/fixtures/prompts/safety_screen.json`
- `packages/evals/src/ci-seed.ts`
- `packages/evals/src/ci-seed.test.ts`
- `packages/evals/src/negative-control.test.ts`

Inspected every diff hunk in the four authority/progress files and the
implementation log:

- `BUILD_PLAYBOOK.md`
- `IMPLEMENTATION_GUIDE.md`
- `PromptGate_PROJECT_IDEA.md`
- `PROGRESS.md`
- `docs/implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`

Verified byte identity to `HEAD` for these deliberately unmodified contracts:

- `.github/workflows/eval-gate.yml`
- `packages/evals/src/eval-gate-workflow.test.ts`
- `packages/evals/src/safety-screening.test.ts`

The implementation scope before this log was exactly those four authority/
progress files, the fixture, `ci-seed.ts`, `ci-seed.test.ts`, the new
negative-control test, and the required Claude implementation log. No gateway,
shared, workflow, dataset, DB migration, DAO, route, persistence, API-contract,
pricing, Compose, or lockfile change was present.

## Independent findings

### Fixture and digest integrity — PASS

- The current v1/v2 version objects are deep-identical to the two `HEAD`
  objects; the fixture diff only appends v3 and changes `candidate` 2→3.
- Independently recomputed canonical SHA-256 values:
  - v1:
    `f8da4cd3b3ba21b17c2525ea5f7dd5767bf9bfc026c66f0175649e351632c944`
  - v2:
    `4f9969b7d21e0526eabeaa04fe31e89b218fba71ee4695ffd9609c7db5908652`
  - v3:
    `b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004`
- `CERTIFIED_GOOD_DIGEST` and `CERTIFIED_DEGRADED_DIGEST` are unchanged;
  v3 is separately named `NEGATIVE_CONTROL_DIGEST`.
- `prod` is exactly 1 and `candidate` exactly 3.
- v3's system text exactly matches the approved fixed-output sentence and JSON;
  its user text is exactly `Return the fixed JSON object now.` No v3 message
  contains `{{note}}`; `variables_json` still declares required `note`.

### Seeder/input-validation widening — PASS

- The only runtime widening is the checked-in fixture trust boundary and its
  seed sequence: a three-element tuple, candidate union 1|2|3,
  `addSafetyVersion` 1|2|3, create-path v3 insertion, and
  `ensureSafetyPrompt` upper bound/repair loop/already-exists/final check at 3.
- The v3 digest is checked separately from the certified Phase 5 pair.
- Creation seeds all three versions. The repair regression starts from v1 and
  therefore exercises repair of both v2 and v3; reuse proves the three-version
  state is not duplicated. Label assertions require candidate v3.
- No protected DB/API/persistence schema, migration, DAO, route, runner,
  workflow, dataset, or model contract changed. The amendment's
  input-validation classification is accurate.

### Deterministic margin proof — PASS

Independent parsing of the real checked-in dataset and risk-label module found:

- 50 cases
- threshold 0.8, therefore 40 passes required
- labels `{ urgent: 24, review: 10, none: 16 }`
- maximum constant-label yield 24, strictly below 40

I separately drove the built real `evaluateCaseAssertions` engine over all 50
real cases with the exact pinned constant and an offline stub rubric. It
reproduced:

- 16 pass / 34 fail
- pass rate 0.32 < 0.8
- exactly two rubric calls
- every failed case's detail exactly
  `Expected risk_level <that case's urgent|review label>; received none.`

The new test exercises the same real dataset/engine and passed. It additionally
pins the passing set to the expected-`none` set and the constant-label lemma.

### CI/workflow rails — PASS

- The focused four-file suite passed 23/23 tests.
- `eval-gate-workflow.test.ts` and `safety-screening.test.ts` are byte-unmodified
  from `HEAD` and pass.
- The real workflow still contains exactly one `pg-eval run`, includes
  `--baseline prod` and `--min-request-interval-ms 15000`, and contains no
  retry, `--max-score-drop`, `--baseline-from-history`, or `--allow-cache`.
- Lint, all 771 tests in 60 files, all four package builds, Compose offline
  configuration, and diff whitespace checks passed.

### Authority amendment, D1, and pre-registration — PARTIAL PASS

The amendment text itself is consistent across the playbook, guide, idea
decision #11, and progress decision log:

- v2 live results 42/50 and 45/50 are recorded;
- D1 correctly records deterministic-failure score pruning, the PR #6
  0.972→0.988 / five-failure / exit-0 evidence, and defers the remedy;
- v3, input-validation classification, 16/34 result, 24<40 lemma, and unchanged
  rails are accurate;
- the single live attempt is pre-registered as expected exit 1, exact compliant
  16/50, valid at ≤39/50, and falsified at ≥40/50 with redesign/no rerun;
- Phase 6 remains `verify pending`; Phase 7 is not started.

However, the current progress/audit record has a blocking factual
reconciliation defect:

1. `PROGRESS.md` identifies merged PR #4 as the completed Phase 6 green Verify
   arm and omits the actual disposable green proof PR #5. The Verify contract
   says the green proof PR is not merged and is deleted after evidence.
   Read-only GitHub evidence independently confirms PR #5 was that disposable
   proof: run `30521540051`, head
   `4d80296f99c025d2340939236c000c6e378e9291`, same certified v1 single run,
   49/50, score `0.9342857142857142` over seven scored cases, drop 0, one
   tolerated failure `policy_blood_review_01`, green pricing/seed/evaluation/
   cleanup/aggregate result. PR #5 is closed unmerged and its remote branch is
   deleted.
2. `PROGRESS.md` and the Claude implementation log say PR #4's exact green
   summary was not captured and use merge/protection as the evidence. Its
   retained job log is still retrievable. Read-only GitHub inspection of run
   `30520586222` independently recovered head
   `7e8c91d4b7120016817b4cc9b96177ba0efbc7c1`, 48/50 with two named failures,
   baseline and candidate score `0.9714285714285715` over seven scored cases,
   drop 0, successful evaluation, cleanup, and aggregate gate. This is useful
   corroborating PR #4 evidence, but it does not replace recording disposable
   PR #5 as the prescribed green Verify arm.

Because `PROGRESS.md` declares its Position line the truth and Phase 6 requires
an evidence-accurate green/red Verify record, these are not cosmetic omissions.
They must be reconciled before this amendment is pushed into the single live
attempt.

## Verification commands and results

1. Repository/authority inspection:
   - `git status --short`, branch/HEAD reads, `git diff --stat`,
     `git diff --name-only`, full/hunk-scoped diffs, and full file reads.
   - Result: scope described above; no unrelated implementation change.
2. Independent hash/distribution script:
   - First root-cwd Node invocation failed before checks because `yaml` is a
     package-scoped eval dependency and is not resolvable from the monorepo
     root.
   - Re-ran from `packages/evals`; result PASS with v1/v2 deep equality, all
     three exact digests, exact v3 text/labels, 50 cases, threshold 0.8,
     24/10/16 distribution, max 24 versus gate 40, and byte-unmodified workflow
     contract files.
3. Focused tests:
   - `./node_modules/.bin/vitest run packages/evals/src/ci-seed.test.ts packages/evals/src/negative-control.test.ts packages/evals/src/safety-screening.test.ts packages/evals/src/eval-gate-workflow.test.ts`
   - Result: 4 files, 23 tests passed.
4. Workflow source inspection:
   - `rg` over `pg-eval run`, baseline, pacing, retry/history/cache/drop flags.
   - Result: one approved invocation and no forbidden options.
5. `pnpm lint`
   - Result: 159 files checked, no fixes.
6. `pnpm test`
   - Result: 60 files, 771 tests passed.
7. `pnpm build`
   - Result: dashboard, shared, evals, and gateway built successfully.
8. `docker compose config --quiet`
   - Result: exit 0; configuration only, no runtime started.
9. `git diff --check`
   - Result: exit 0.
10. Independent real-engine probe:
    - First attempted the root `tsx` shim; it was absent, so no product code
      executed.
    - Re-ran with Node against the just-built eval JavaScript.
    - Result: 16 pass, 34 fail, 0.32 < 0.8, two rubric calls, and every failed
      detail exactly matched its case's expected non-none label.
11. Read-only GitHub evidence reconciliation:
    - `gh run view 30520586222 --json ... --log` plus table counts.
    - Result: PR #4 retained exact green evidence, 48/50, two failures,
      `0.9714285714285715`/7 on both sides, drop 0.
    - `gh run view 30521540051 --json ... --log` plus table counts and
      `gh pr view 5`.
    - Result: PR #5 retained disposable green proof, 49/50, one named failure,
      `0.9342857142857142`/7 on both sides, drop 0; PR closed unmerged, remote
      branch absent.

## Successful checks

- All product, fixture, test, workflow, digest, margin, lint, test, build,
  Compose-configuration, and diff checks passed.
- Certified v1/v2 and every protected runtime rail remain unchanged.
- The deterministic control is technically sound and has a decisive offline
  margin.
- D1 and the amended-live falsification rule are correctly pre-registered.

## Failed checks

- No product/test/build check failed.
- Two verifier-only probe invocations initially used unavailable root-scoped
  tooling (`yaml` resolution, then a nonexistent root `tsx` shim); both were
  rerun through the correct package/built runtime and passed. These are not
  implementation defects.
- Authority/evidence accuracy failed: the progress record attributes the green
  Verify arm to PR #4, omits PR #5, and fails to record retrievable exact PR #4
  evidence. The implementation log repeats the stale PR #4 evidence claim.

## Suspected cause

The implementation synchronized authority text from an earlier snapshot that
relied on merge/protection inference before the integrator recovered the two
retained job logs. It did not reconcile the later disposable PR #5 proof into
`PROGRESS.md`.

## Known risks

- The live v3 attempt is intentionally still pending. A result ≥40/50
  invalidates the control and must not be rerun.
- Under compliant v3 only two candidate rubric cases remain scored, so the
  score-drop arm can vary; the guaranteed/pre-registered red arm is the 0.32
  pass rate.
- The derived whole-fixture marker changes with v3. That is expected for this
  disposable fresh-gateway branch; certified v1/v2 digests do not change.
- D1 remains deliberately unfixed until the owner chooses the post-Phase-6
  remedy.

## Final status

**BLOCK**

The implementation and all offline technical gates are ready, but the required
Phase 6 audit record is not yet factually correct. Before commit/push or the
single live attempt, a Claude Code correction pass must:

1. record disposable PR #5/run `30521540051` as the actual green Verify arm with
   its exact 49/50 / `0.9342857142857142` / one-failure / exit-0 evidence and
   closed-unmerged/deleted-branch disposition;
2. retain PR #4/run `30520586222` as corroborating merged amendment evidence
   with its recovered exact 48/50 / `0.9714285714285715` / two-failure /
   exit-0 facts; and
3. correct the stale claims in `PROGRESS.md` and the Claude implementation log.

No product, fixture, test, or workflow redesign is required.
