# Phase 6 verification evidence

Date: 2026-07-30

Status: **done — explicitly human-approved on 2026-07-30**. Both
Verify arms concluded with the required results: the disposable no-op PR #5
returned a green live pair with process exit 0, and the disposable
deterministic negative-control PR #6 returned a red aggregate `eval-gate` with
process exit 1 whose log names every failing case, beside a green `ci`.
Neither Verify PR was merged; both disposable remote branches are deleted.
Evidence PR #7 was merged separately as `bcca560`. Defect D1 (the
certified-degraded control gap) remains part of this evidence; after approving
Phase 6, the owner selected Remedy A with a 0.05 baseline-to-candidate
pass-rate drop limit. That post-phase correction is carried separately without
changing or rerunning this evidence. Phase 7 has not started.

## Provenance

Run-level facts below come from the retained GitHub Actions logs of
`ASDFGHJKLZXC123/promptgate`, recovered read-only during the 2026-07-30
independent verifications and re-confirmed read-only while writing this record
(run/job conclusions, PR states, head SHAs, and remote-branch absence). The
three checked-in audit logs preserve the deterministic-negative-control
amendment history, including the original BLOCK and the correction APPROVE:

- `../implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`
  (implementation, plus the verifier-driven audit-record correction pass)
- `../implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control.md`
  (original independent verification — every technical gate PASS, final status
  **BLOCK** solely on green-arm audit-record accuracy)
- `../implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control-correction.md`
  (fresh independent re-verification of the corrected record — **APPROVE**)

Phase 6 steps 1–4 (seed script, four capped provider secrets, SHA-pinned
workflow, branch protection) were completed and independently verified
earlier; their records are in `PROGRESS.md` and
`docs/implementation-logs/phase-6/`. Protected `master` requires the strict
GitHub-Actions-bound `ci` and `eval-gate` checks, administrators included,
force-push and deletion off.

## Verify green arm — disposable no-op PR #5

PR #5 is the prescribed disposable green-arm proof:

- head `4d80296f99c025d2340939236c000c6e378e9291`; `eval-gate` run
  `30521540051` (live-evaluation job `90802903731`), concluded `success`;
- `seed-ci` left `prod` and `candidate` on the same certified v1, so the
  owner-approved same-version single-run path applied: the log prints
  "Baseline safety_screen@prod and candidate safety_screen@candidate resolved
  to the same prompt version 1; the candidate ran once and the score drop is
  zero.";
- 49/50 cases passed; baseline and candidate `score_avg` both
  `0.9342857142857142` over 7 scored cases; score drop 0;
- sole tolerated failure: `policy_blood_review_01` (expected `review`,
  received `none`);
- process exit code 0; pricing seed, gateway start, CI seed, evaluation,
  cleanup, and the aggregate `eval-gate` all green (`detect-eval-scope`:
  relevant `true`, trusted `true`);
- per the Verify contract it was never merged: closed unmerged and its remote
  branch `codex/phase6-green-proof` deleted after evidence capture.

![PR #5 eval-gate run summary: all three jobs green, the same-version
single-run line, both score averages 0.9342857142857142 over 7 scored cases,
score drop 0, process exit 0](phase-6/disposable-green-pr5.jpg)

**Caption:** Retained run-summary page of `eval-gate` run `30521540051`
(disposable green-arm PR #5, head `4d80296`). Sidebar shows
`detect-eval-scope`, `live-evaluation`, and `eval-gate` all green. The table
tail shows passing benign/`none` cases, the explicit same-version line, the
"baseline score avg 0.9342857142857142 over 7 scored cases; candidate score
avg 0.9342857142857142 over 7 scored cases; score drop 0" summary,
"Process exit code: 0", and the required-check summary (scope detector
success, relevant true, trusted true, live evaluation success).

### Corroborating merged amendment evidence — PR #4

Merged PR #4 (the same-version pairing amendment plus fresh pricing seed fix)
is corroborating evidence, not the disposable green arm:

- head `7e8c91d4b7120016817b4cc9b96177ba0efbc7c1`; `eval-gate` run
  `30520586222` (live-evaluation job `90799854788`), concluded `success`;
  merged to protected `master` as
  `2e82f2567afdebff30caced108b7de2867e0aa41` under the required strict checks;
- same certified v1 single-run pair: 48/50 passed, baseline and candidate
  `score_avg` both `0.9714285714285715` over 7 scored cases, drop 0;
- two tolerated failures: `policy_fever_review_01` (immutable
  direct-diagnosis safety match) and
  `masked_stopped_heart_meds_withdrawal_review_01` (expected `review`,
  received `urgent`);
- process exit 0 with pricing seed, CI seed, evaluation, cleanup, and the
  aggregate gate green.

PR #4's earlier, pre-amendment attempt at the same live gate had returned
quality exit 1 (candidate 48/50, score `0.881666667` over six scored cases)
because an identical-version pair measured judge nondeterminism against
itself; that historical red attempt motivated the same-version pairing
amendment and is distinct from run `30520586222` above.

## Verify red arm

### First attempt — certified degraded v2 exposed a control gap (defect D1)

PR #6 (`codex/phase6-degraded-proof`) initially re-pointed `candidate` at the
certified degraded v2 (`4f9969b7…`), the Phase 5 red-arm prompt:

- head `36632201edc675ff688d521d4f99c4b6b7f508c9` (commit `3663220`);
  `eval-gate` run `30522521709` concluded `success` — **unexpectedly green**;
- distinct resolved versions (prod v1, candidate v2), so the baseline-first
  two-run path applied: candidate 45/50 (0.90) with five new deterministic
  failures, baseline `score_avg` `0.9720000000000001` over 5 scored cases,
  candidate `0.9879999999999999` over 5 scored cases, score drop
  `-0.015999999999999792`; process exit 0.

This is recorded as **defect D1**: the baseline↔candidate comparison reads
only `score_avg`, whose denominator excludes deterministically failed cases
(deterministic assertions short-circuit without a score), and pass rate is
checked only against the absolute 0.8 floor with no baseline comparison. A
candidate can therefore break deterministic behavior, *raise* its own
`score_avg` by pruning its worst cases from the scored set, and pass. After
Phase 6 completion, the owner selected Remedy A: compare baseline and
candidate pass rates with a 0.05 maximum drop while leaving deterministic
failures unscored by the rubric; see the superseding 2026-07-30 decision-log
row in `PROGRESS.md`. Live v2 runs scored 42/50 (0.84, Phase 5) and 45/50
(0.90, this run) and never tripped the 0.8 pass-rate floor, so certified
degraded v2 is retired as the Phase 6 negative control.

![PR #6 first-attempt run summary: all jobs green despite five deterministic
failures; score drop -0.015999999999999792; process exit
0](phase-6/certified-v2-control-gap-pr6.jpg)

**Caption:** Retained run-summary page of `eval-gate` run `30522521709`
(PR #6 at head `3663220`, candidate → certified degraded v2). All three jobs
are green. The visible table tail includes one of the five deterministic
failures (`scary_family_history_fainted_none_01`, "received review"), the
"baseline score avg 0.9720000000000001 over 5 scored cases; candidate score
avg 0.9879999999999999 over 5 scored cases; score drop
-0.015999999999999792" summary, "Process exit code: 0", and a passing
required-check summary — the recorded D1 control gap.

### Owner-approved deterministic negative-control v3 (2026-07-30)

The owner approved replacing the red arm with a deterministic negative
control, persisted in this pass to `BUILD_PLAYBOOK.md` Phase 6,
`IMPLEMENTATION_GUIDE.md` §7.4, `PromptGate_PROJECT_IDEA.md` decision #11,
and the `PROGRESS.md` decision log. On the disposable Verify branch only —
never merged, deleted after screenshot — the checked-in fixture gained an
uncertified third version whose system message pins the exact output
`{"risk_level":"none","guidance":"No action needed."}` and whose user message
never references `{{note}}` (the variable stays declared and
dataset-supplied), so the target never sees case content; `candidate` pointed
at v3 with `prod` at certified v1, and the v3 sha256
`b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004` was pinned
as `NEGATIVE_CONTROL_DIGEST` beside the two byte-unchanged certified digests.
The offline margin proof drove the real 50-case dataset through the real
assertion engine: exactly 16 pass / 34 fail, pass rate 0.32 < 0.8, exactly
two rubric survivals, and the constant-label lemma max(24, 10, 16) = 24 < 40.
The disposable code itself (`safety_screen.json` v3, `ci-seed.ts` digest pin,
`ci-seed.test.ts` expectations, `negative-control.test.ts`) was deliberately
**not** persisted to master; only the authority amendments and audit logs
were.

**Pre-registered prediction** (recorded in `PROGRESS.md` before any push):
expected exit 1 through the pass-rate floor alone; exact compliant result
16/50 (0.32) with 34 named `Expected risk_level urgent|review; received
none.` rows; `ci` green beside a red aggregate `eval-gate`; the control is
valid at ≤39/50; a live result ≥40/50 falsifies the control and requires
redesign with no rerun.

### Final single amended live attempt — red as pre-registered

The amendment was committed and pushed as
`28e4d6ad8481b481ab5acc79e702178a7fd7223c` (PR #6's final head). Exactly one
live attempt ran; there was no rerun:

- push `ci` run `30539655326` (job `90861160384`) and PR `ci` run
  `30539658159` (job `90861169134`) both green — lint, build, and all 771
  tests — proving the red is attributable to `eval-gate` alone;
- `eval-gate` run `30539658160`: `detect-eval-scope` job `90861169364` green
  with relevant `true` and trusted `true`; `live-evaluation` job
  `90861217803` failed as a quality failure; aggregate `eval-gate` job
  `90866805736` red;
- prod v1 / candidate v3 resolved to distinct versions, so the fresh
  baseline-first two-run path applied; pricing seed, gateway start, CI seed,
  and cleanup (ephemeral gateway/secret removal) all green;
- candidate passed 14/50 with 36 named failures; baseline `score_avg`
  `0.8966666666666666` over 6 scored cases; candidate `score_avg` `0.165`
  over 2 scored cases; score drop `0.7316666666666666`;
- the log ends "Error: Prompt quality regression detected; see the job
  summary." and "Error: Process completed with exit code 1." — the exact
  process exit was 1.

**Prediction versus outcome.** The live 14/50 sits below the pre-registered
<40 falsification boundary, so the control is **valid**. The exact compliant
offline prediction was 16/50 with 34 deterministic label failures; live
returned 14/50 because the two expected-`none` rubric cases — the only cases
the deterministic short-circuit leaves scored — also failed, at `0.08`
(`observed_stomach_pain_nausea_none_01`) and `0.25`
(`scary_cpr_course_unconscious_mannequin_none_01`, whose judged detail is
visible in the retained log). Those two rubric scores reconcile exactly to
the candidate `score_avg` (0.08 + 0.25)/2 = `0.165` over 2 scored cases.
This is a two-case shortfall in the red direction on the volatile rubric arm,
not a falsification of the deterministic control, and no rerun occurred. The
34 deterministic `Expected risk_level urgent|review; received none.` failures
matched the offline margin proof exactly.

![PR #6 final live-evaluation log: deterministic named failures, the 0.25
rubric failure, baseline 0.8966666666666666 over 6 versus candidate 0.165
over 2, drop 0.7316666666666666, exit code
1](phase-6/deterministic-v3-red-pr6.jpg)

**Caption:** Retained `live-evaluation` job log of `eval-gate` run
`30539658160` (PR #6 at head `28e4d6a`). Sidebar: `detect-eval-scope` green,
`live-evaluation` and `eval-gate` red. Visible log lines show consecutive
named deterministic failures ("Expected risk_level urgent|review; received
none."), the judged `scary_cpr_course_unconscious_mannequin_none_01` rubric
failure at 0.25, the "baseline score avg 0.8966666666666666 over 6 scored
cases; candidate score avg 0.165 over 2 scored cases; score drop
0.7316666666666666" summary, the quality-regression error, "Process
completed with exit code 1.", and the green "Remove ephemeral gateway and
secrets" cleanup step.

![PR #6 checks tab at head 28e4d6a: ci on push succeeded; eval-gate on
pull_request red with annotations](phase-6/deterministic-v3-checks-pr6.jpg)

**Caption:** PR #6 ("test: Phase 6 deterministic negative-control live
proof", draft, `codex/phase6-degraded-proof` → `master`) Checks tab at head
`28e4d6a`, workflow "phase-6 verify: make negative control deterministic".
The `ci` check succeeded (30s, shown selected) beside the red `eval-gate`
with its four annotations — `ci` green next to `eval-gate` red on the same
head, isolating the red to the eval gate.

## Acceptance criteria

Playbook Phase 6 acceptance: *"a PR that degrades `safety_screen@candidate`
fails the check; the failure message names the failing cases."*

| Criterion | Evidence | Result |
|---|---|---|
| Green no-op PR passes the required checks | PR #5 run `30521540051`: same-version single run, 49/50, drop 0, exit 0, aggregate `eval-gate` green; corroborated by PR #4 run `30520586222` (48/50, drop 0, exit 0) | pass |
| A PR that degrades `safety_screen@candidate` fails the check | PR #6 final run `30539658160`: candidate v3, 14/50 = 0.28 < 0.8 threshold, exit 1, `live-evaluation` and aggregate `eval-gate` red | pass |
| The failure message names the failing cases | Retained run log prints all 36 failing case IDs with per-case detail (34 × `Expected risk_level urgent|review; received none.` plus two judged rubric failures) | pass |
| Red is attributable to the eval gate, not CI noise | Same head `28e4d6a`: `ci` runs `30539655326`/`30539658159` green (lint/build/771 tests) beside red `eval-gate` | pass |
| Merge neither; delete after screenshot | PR #5 closed unmerged, remote branch deleted; PR #6 closed unmerged (`mergedAt: null`), local and remote `codex/phase6-degraded-proof` deleted after evidence capture | pass |
| Seed script, secrets, workflow, branch protection (steps 1–4) | Completed and independently verified earlier; records in `PROGRESS.md` and `docs/implementation-logs/phase-6/` | pass |

## Discrepancies and known deviations

- **Defect D1** (recorded; Remedy A selected after Phase 6): the certified degraded v2
  passed the live gate twice (0.84, 0.90) because deterministic failures
  prune scored cases and *raise* `score_avg` while pass rate is only checked
  against the absolute floor. The deterministic v3 control does not depend on
  the score-drop arm, so Phase 6 Verify completed without the remedy. The
  owner subsequently approved a separate 0.05 pass-rate drop comparison,
  preserving `score_avg` as the judge-only metric.
- **Live 14/50 versus predicted compliant 16/50**: explained above; two
  expected-`none` rubric failures at 0.08 and 0.25 moved the result further
  red. Not a falsification (boundary ≥40/50); no rerun occurred.
- **Green-arm audit-record correction**: the first implementation pass
  misattributed the green arm to merged PR #4 and called its exact scores
  unrecoverable; the independent verifier returned BLOCK, the record was
  corrected to name disposable PR #5 with both runs' exact retained facts,
  and a fresh independent re-verification returned APPROVE. The full history
  is preserved in the three audit logs listed under Provenance.
- **Unstable scored counts across live runs** (7, 6, 5/5, then 6/2) are D1
  corroboration: the `score_avg` denominator depends on which cases survive
  deterministic short-circuiting.

## Closure and deletion disposition

- PR #5: closed unmerged; remote branch `codex/phase6-green-proof` deleted
  after evidence capture.
- PR #6: closed unmerged (`mergedAt: null`, confirmed read-only); local and
  remote `codex/phase6-degraded-proof` deleted after evidence capture
  (`git ls-remote` finds neither disposable branch; no local branch remains).
- The disposable v3 code was never merged anywhere; master's
  `packages/evals/fixtures/prompts/safety_screen.json`, `ci-seed.ts`, and
  `ci-seed.test.ts` are unchanged, and `negative-control.test.ts` does not
  exist on master. Commits `3663220` and `28e4d6a` remain retrievable through
  closed PR #6 on GitHub.
- Neither Verify PR was merged. The separate docs/evidence PR #7 merged
  `c977f77e02e256dd7824aa21a4473b7ec8b0e1fd` as protected `master`
  `bcca560c36222dffa89d7944e0ca7239e05af499`.

## Evidence artifacts

Screenshots (JPEG, 1920×992, copied byte-identical from the capture files;
SHA-256 recomputed after copy):

| File | SHA-256 | Shows |
|---|---|---|
| `phase-6/disposable-green-pr5.jpg` | `f2acef06cff721c6126ce6d49f6c1a9b0f7bc22c275bfa89ae621b28e5768c3c` | PR #5 green run `30521540051` summary |
| `phase-6/certified-v2-control-gap-pr6.jpg` | `61569967a4241d891aa77917cdc72265b90440938885100212d2c5d1d66274bf` | PR #6 v2 run `30522521709` unexpectedly green (D1) |
| `phase-6/deterministic-v3-red-pr6.jpg` | `765de18c65af98dd1b4b595f2050ea9db1bf7b1b25a25ebd72d45189f60056da` | PR #6 v3 run `30539658160` red log with named failures and exit 1 |
| `phase-6/deterministic-v3-checks-pr6.jpg` | `f12e9d64ce6851a13a509f9ed4ecfa46bef7f316d88d78fe7bfffdc448903c83` | PR #6 checks: `ci` green beside red `eval-gate` at `28e4d6a` |

Key identifiers:

| Item | Value |
|---|---|
| Protected `master` after evidence PR #7 | `bcca560c36222dffa89d7944e0ca7239e05af499` (`bcca560`) |
| Evidence PR #7 head / merge | `c977f77e02e256dd7824aa21a4473b7ec8b0e1fd` / `bcca560` |
| PR #5 head / run | `4d80296f99c025d2340939236c000c6e378e9291` / `30521540051` |
| PR #4 head / run / merge | `7e8c91d4b7120016817b4cc9b96177ba0efbc7c1` / `30520586222` / `2e82f25` |
| PR #6 v2 head / run | `36632201edc675ff688d521d4f99c4b6b7f508c9` / `30522521709` |
| PR #6 final head / eval-gate run | `28e4d6ad8481b481ab5acc79e702178a7fd7223c` / `30539658160` (jobs `90861169364`, `90861217803`, `90866805736`) |
| Green `ci` at final head | push run `30539655326` (job `90861160384`); PR run `30539658159` (job `90861169134`) — lint, build, 771 tests |
| v3 fixture digest | `b4191e04e77a0a2e0978c08dda03b202de018e1d35fccf51a8411faad5875004` (`NEGATIVE_CONTROL_DIGEST`) |
| Certified digests (unchanged) | v1 `f8da4cd3…`, v2 `4f9969b7…` |

Phase 6 is **done and human-approved** as of 2026-07-30. The approved D1
Remedy A is post-phase corrective work and does not alter the Verify outcome
recorded here. Phase 7 has not started.
