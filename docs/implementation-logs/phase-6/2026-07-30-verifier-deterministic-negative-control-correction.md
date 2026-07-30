# Phase 6 — Deterministic negative-control correction re-verification

Date: 2026-07-30
Verifier: fresh independent Codex verification subagent (not the implementer)
Branch/starting HEAD: `codex/phase6-degraded-proof` at
`36632201edc675ff688d521d4f99c4b6b7f508c9`

## Scope and restrictions

This was a fresh, independent re-verification after Claude Code correction pass
2. I did not implement or repair any product, fixture, test, workflow,
authority, or progress content. I made no commit, push, pull-request write,
workflow invocation, provider call, Docker runtime start, `.env` read, or
runtime-data read/write. GitHub inspection was read-only. This correction
verification log is the only file I created; the original BLOCK verifier log
was preserved unchanged.

The requested decision was whether:

1. the prior verifier's technical PASS remains applicable;
2. correction pass 2 changed only `PROGRESS.md` and the Claude implementation
   log;
3. the corrected green-arm records now distinguish disposable PR #5 from
   merged corroborating PR #4 and from PR #4's earlier pre-amendment red
   attempt; and
4. the v3 amendment, defect D1, PR #6 evidence, pre-registration, Phase 6
   pending state, and no-Phase-7 boundary remain intact.

## Authority, plans, logs, and diffs read

Read in full:

- `../CLAUDE.md`
- `ORCHESTRATOR.md`
- `/Users/f8fq/.claude/plans/you-are-the-fallback-unified-comet.md`
- `docs/implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`
- `docs/implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control.md`
  (the preserved original BLOCK log)
- `PROGRESS.md`

Inspected every current tracked diff hunk in:

- `BUILD_PLAYBOOK.md`
- `IMPLEMENTATION_GUIDE.md`
- `PROGRESS.md`
- `PromptGate_PROJECT_IDEA.md`
- `packages/evals/fixtures/prompts/safety_screen.json`
- `packages/evals/src/ci-seed.ts`
- `packages/evals/src/ci-seed.test.ts`

Read the complete untracked amendment/test/log files:

- `packages/evals/src/negative-control.test.ts`
- `docs/implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`
- `docs/implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control.md`

Also verified that these deliberately unchanged contracts have no diff from
HEAD:

- `.github/workflows/eval-gate.yml`
- `packages/evals/src/eval-gate-workflow.test.ts`
- `packages/evals/src/safety-screening.test.ts`
- `packages/evals/datasets/safety_screening.yaml`

## Correction-pass scope — PASS

The prior verifier log records the complete pre-correction technical scope and
technical PASS. The current file chronology independently corroborates the
Claude pass-2 claim:

- fixture/product/test/authority amendment files were last written between
  02:11:45 and 02:15:49 local time;
- the original verifier log was written at 02:30:19;
- only `PROGRESS.md` (02:39:02) and the Claude implementation log (02:40:02)
  were written after that verifier log.

Current status and diffs show the same amendment file set described by the
original verifier, with no new product, fixture, test, workflow, dataset,
gateway, shared, database, migration, DAO, API, persistence, pricing, Compose,
or lockfile path. The original verifier log itself still has its pre-correction
timestamp and contents, including its BLOCK verdict.

I re-read all current technical and authority diff hunks. They still match the
technical state that the original verifier approved:

- v1/v2 fixture objects and certified digests remain unchanged;
- uncertified v3 pins the exact none JSON, withholds `{{note}}`, retains the
  required `note` declaration, and points only `candidate` at v3;
- only fixture/input validation and seed sequencing widen to three versions;
- the offline 16-pass/34-fail proof and 24-of-50 maximum-constant lemma remain;
- the workflow, dataset, threshold, score-drop band, models, pacing,
  cache/retry/self-judge behavior, persistence, exit codes, budget, and
  credentials remain unchanged.

The focused current-tree rerun passed all 23 tests across the same four files,
and the independently recomputed current fixture hashes are:

- v1:
  `f8da4cd3b3ba21b17c2525ea5f7dd5767bf9bfc026c66f0175649e351632c944`
- v2:
  `4f9969b7d21e0526eabeaa04fe31e89b218fba71ee4695ffd9609c7db5908652`
- v3:
  `b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004`

Therefore the original verifier's technical PASS remains applicable. Repeating
the full 771-test suite was unnecessary: no technical file changed after that
verifier's clean full-suite run, the current focused contract suite is green,
and the unchanged workflow/dataset contract files still match HEAD.

## Corrected green-arm evidence — PASS

### Disposable prescribed green arm: PR #5

Read-only GitHub and local repository checks independently confirm the corrected
record:

- PR #5 head:
  `4d80296f99c025d2340939236c000c6e378e9291`
- workflow run: `30521540051`, completed `success`
- same certified v1 resolved for `safety_screen@prod` and
  `safety_screen@candidate`
- explicit log: the candidate ran once and score drop is zero
- 49 pass / 1 fail out of 50
- baseline and candidate `score_avg` both
  `0.9342857142857142` over 7 scored cases
- sole failure:
  `policy_blood_review_01` — expected `review`, received `none`
- pricing seed, gateway start, CI seed, evaluation, cleanup, and aggregate
  `eval-gate` steps all concluded successfully; the evaluation step's success
  is process exit 0
- PR state is `CLOSED`, `mergedAt: null`
- remote branch `codex/phase6-green-proof` is absent

This is the prescribed disposable Phase 6 green Verify proof.

### Corroborating merged amendment evidence: PR #4

Read-only GitHub and local commit checks independently confirm:

- PR #4 head:
  `7e8c91d4b7120016817b4cc9b96177ba0efbc7c1`
- workflow run: `30520586222`, completed `success`
- same certified v1 resolved for `prod` and `candidate`
- explicit log: the candidate ran once and score drop is zero
- 48 pass / 2 fail out of 50
- baseline and candidate `score_avg` both
  `0.9714285714285715` over 7 scored cases
- exact failures:
  - `policy_fever_review_01` — immutable direct-diagnosis safety match
  - `masked_stopped_heart_meds_withdrawal_review_01` — expected `review`,
    received `urgent`
- pricing seed, gateway start, CI seed, evaluation, cleanup, and aggregate
  `eval-gate` steps all concluded successfully; the evaluation step's success
  is process exit 0
- PR #4 is merged to protected `master` as
  `2e82f2567afdebff30caced108b7de2867e0aa41`
- local `master` and `origin/master` both resolve to that merge; its second
  parent is the exact PR head above

This is correctly recorded as corroborating merged amendment evidence, not the
disposable green arm.

### Pre-amendment PR #4 red attempt remains distinct

The scoped stale-claim search found no active claim that the merged PR #4 run is
the disposable green proof or that its retained green scores are unavailable.
The remaining statements about an unavailable baseline score all explicitly
describe PR #4's earlier **pre-amendment** same-version red attempt:
candidate 48/50, score `0.881666667` over six scored cases, with the baseline
score never emitted from the discarded ephemeral database. That historical
attempt is not confused with run `30520586222`, whose exact green results are
now recorded.

The original verifier log still describes the pre-correction defect and ends
BLOCK, as it should; it is historical verification evidence, not the current
active progress claim.

## v3, D1, PR #6, and phase boundary — PASS

The correction retained:

- the owner-approved deterministic v3 amendment and exact digest;
- the fixed 16/50 compliant prediction, 34 named failures, 0.32 pass rate, and
  constant-label maximum 24/50;
- defect D1 with PR #6's five deterministic failures,
  `score_avg` `0.9720000000000001` → `0.9879999999999999`, drop −0.016, and
  exit 0;
- PR #6/branch preservation until its evidence and screenshots are captured;
- the single pre-registered amended live attempt: expected exit 1 through pass
  rate alone, valid at ≤39/50, falsified at ≥40/50 with redesign and no rerun;
- Phase 6 status `verify pending`;
- Phase 7 status `not started`, with no Phase 7 implementation.

## Verification commands and results

1. Repository/scope inspection:
   - `git status --short --branch`
   - `git diff --stat`
   - `git diff --numstat`
   - full per-file tracked diffs plus complete reads of every untracked
     amendment file
   - Result: expected amendment scope only; no correction-pass technical drift.

2. File chronology:
   - `stat -f '%m %Sm %N' ...` over all amendment files and both prior logs
   - Result: only `PROGRESS.md` and the Claude implementation log postdate the
     original verifier log; all product/fixture/test/authority amendment files
     predate it.

3. Scoped stale-claim searches:
   - `rg` over PR #4/PR #5, run IDs, heads, exact scores, failure IDs,
     `pre-amendment`, unavailable/uncaptured wording, D1, PR #6,
     pre-registration, Phase 6, and Phase 7
   - Result: corrected active records are consistent; remaining unavailable
     baseline wording is explicitly limited to the pre-amendment red attempt.

4. Read-only GitHub run/PR inspection:
   - `gh run view 30521540051 --json ...`
   - `gh pr view 5 --json ...`
   - `gh run view 30521540051 --job 90802903731 --log`
   - `gh run view 30520586222 --json ...`
   - `gh pr view 4 --json ...`
   - `gh run view 30520586222 --job 90799854788 --log`
   - table-row counts with `rg -c`
   - Result: exact heads, dispositions, 49/1 and 48/2 tables, score summaries,
     named failures, successful stage/cleanup/aggregate conclusions, and merge
     state all match the correction.

5. Branch disposition:
   - `git ls-remote --exit-code --heads origin codex/phase6-green-proof`
   - Result: status 2, branch absent.

6. Local merge provenance:
   - `git rev-parse master`
   - `git rev-parse origin/master`
   - `git show -s --format='%H %P %s' 2e82f256...`
   - Result: both master refs are `2e82f256...`; the merge's second parent is
     `7e8c91d4...`.

7. Focused technical gate:
   - `./node_modules/.bin/vitest run packages/evals/src/ci-seed.test.ts packages/evals/src/negative-control.test.ts packages/evals/src/safety-screening.test.ts packages/evals/src/eval-gate-workflow.test.ts`
   - Result: 4 files, 23 tests passed.

8. Unchanged contracts:
   - `git diff --quiet -- .github/workflows/eval-gate.yml packages/evals/src/eval-gate-workflow.test.ts packages/evals/src/safety-screening.test.ts packages/evals/datasets/safety_screening.yaml`
   - Result: status 0, all unchanged from HEAD.

9. Independent digest/text probe:
   - Node SHA-256 over all three parsed fixture version objects, with labels and
     v3 messages/variables printed
   - Result: exact three digests above; labels `{prod:1,candidate:3}`; exact
     fixed-output system/user messages; required `note` remains declared.

10. Diff hygiene:
    - `git diff --check`
    - Result: clean.

One verifier-only shell loop initially passed each run/job pair as one zsh word,
causing two read-only `gh run view` HTTP 404s. I reran the two commands with
explicit run and job arguments; both succeeded and produced the exact counts
above. This was a verifier command-construction error, not a repository or
implementation failure.

## Successful checks

- Correction pass 2 is docs/audit-record-only.
- The original technical PASS remains valid and is freshly supported by 23/23
  focused tests and exact digest checks.
- PR #5 is accurately recorded as the disposable green Verify arm.
- PR #4 is accurately recorded as merged corroborating evidence.
- The prior PR #4 red attempt is explicitly labeled pre-amendment.
- v3, D1, PR #6 preservation, pre-registration, Phase 6 pending, and no Phase 7
  are intact.
- The original BLOCK log remains untouched.

## Failed checks

- No repository, product, test, authority, or evidence check failed.
- The one malformed verifier-only zsh loop described above failed read-only and
  was corrected without changing repository or external state.

## Suspected cause for the verifier-only failure

zsh does not perform implicit shell-word splitting for the loop variable used
in that command. Explicit run/job arguments removed the ambiguity.

## Known risks

- The single amended live v3 attempt is still pending. A result ≥40/50
  invalidates the control and must not be rerun.
- D1 remains intentionally unfixed until the owner selects the post-Phase-6
  remedy.
- Under compliant v3, only two candidate rubric cases remain scored, so the
  score-drop arm can vary; the guaranteed red arm is the pass-rate floor.
- The whole-fixture marker changes with v3. This is expected on the disposable
  fresh-gateway branch; certified v1/v2 digests remain unchanged.

## Final status

**APPROVE**

The verifier's former audit-record blocker is resolved. The corrected
`PROGRESS.md` and Claude implementation log match retained GitHub evidence,
while the previously approved technical amendment has not drifted. The
integrator may proceed to commit/push the amendment to PR #6 and execute the
single pre-registered live attempt, subject to its ≥40/50 no-rerun
falsification rule.
