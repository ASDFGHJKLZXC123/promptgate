# Phase 6 — Completion-record evidence pass (Claude Code implementation log)

Date: 2026-07-30
Implementer: Claude Code (Fable 5)
Branch: `codex/phase6-evidence`, created clean from protected `master`
`2e82f2567afdebff30caced108b7de2867e0aa41`; all changes deliberately left
uncommitted for fresh independent verification.

## Scope

Docs/evidence-only persistence of the completed Phase 6 Verify record. The
owner approved the deterministic negative-control amendment; Phase 6
verification is technically complete, but human completion approval has NOT
been given. This pass records the evidence and leaves Phase 6
`awaiting approval`. It does not mark Phase 6 done and does not start Phase 7.

In scope:

1. Persist the owner-approved authority amendment from disposable commit
   `28e4d6ad8481b481ab5acc79e702178a7fd7223c` into `BUILD_PLAYBOOK.md`
   (Phase 6 amendment paragraph + Verify wording), `IMPLEMENTATION_GUIDE.md`
   §7.4, and `PromptGate_PROJECT_IDEA.md` decision #11.
2. Copy the three deterministic-negative-control audit logs from `28e4d6a`
   byte-exact, preserving the BLOCK → correction-APPROVE history.
3. Create `docs/evidence/phase-6.md`.
4. Copy the four JPEG-encoded screenshots into `docs/evidence/phase-6/` with
   honest `.jpg` names, unaltered, hashes recorded.
5. Update `PROGRESS.md` comprehensively but narrowly (status
   `awaiting approval`, blockers, decision log, backlog, session log).
6. This log.

Explicitly excluded and untouched: the disposable v3 product/test files
(`packages/evals/fixtures/prompts/safety_screen.json`, `ci-seed.ts`,
`ci-seed.test.ts`, `negative-control.test.ts`), every workflow/product/runtime
file, database/API schema, package files, lockfile, dataset, `.env`, `data/`,
credentials, GitHub state, providers, Docker runtime, branches, commits,
pushes, and all Phase 7 work.

## Files changed or created

Modified (tracked):

- `BUILD_PLAYBOOK.md` — Phase 6 deterministic negative-control amendment
  paragraph + Verify wording (exactly the `28e4d6a` diff).
- `IMPLEMENTATION_GUIDE.md` — §7.4 amendment paragraph (exactly the
  `28e4d6a` diff).
- `PromptGate_PROJECT_IDEA.md` — decision #11 amendment sentence (exactly the
  `28e4d6a` diff).
- `PROGRESS.md` — Position/Last session/Repo state/last-green header; Phase 6
  status row → `awaiting approval` with evidence `docs/evidence/phase-6.md`
  and blank Approved-by-human cell; stale Verify blocker replaced with the
  completed green-arm record (PR #5 prescribed proof + PR #4 corroboration),
  the completed red-arm record (D1, v3 amendment, final live run
  `30539658160`, no-rerun, PR/branch disposition), and an explicit
  no-technical-blocker line naming human approval as the only gate; the two
  owner-approved 2026-07-30 decision rows (amendment, D1) and the D1-remedy
  backlog bullet carried byte-identical from `28e4d6a`; three session rows
  added (this pass, plus the two 2026-07-30 rows carried byte-identical from
  `28e4d6a`); Phase 7 row untouched (`not started`).

Created (untracked):

- `docs/implementation-logs/phase-6/2026-07-30-claude-code-deterministic-negative-control.md`
  (byte-exact from `28e4d6a`)
- `docs/implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control.md`
  (byte-exact from `28e4d6a`; original final status BLOCK preserved)
- `docs/implementation-logs/phase-6/2026-07-30-verifier-deterministic-negative-control-correction.md`
  (byte-exact from `28e4d6a`; correction re-verification APPROVE)
- `docs/evidence/phase-6.md`
- `docs/evidence/phase-6/disposable-green-pr5.jpg`
- `docs/evidence/phase-6/certified-v2-control-gap-pr6.jpg`
- `docs/evidence/phase-6/deterministic-v3-red-pr6.jpg`
- `docs/evidence/phase-6/deterministic-v3-checks-pr6.jpg`
- this log

## Screenshot provenance and hashes

Copied with `cp` (content unaltered) from the capture files; all four are
JPEG (JFIF, baseline), 1920×992, nonempty; source and destination SHA-256
values match exactly:

| Source (JPEG bytes despite `.png` name) | Destination | SHA-256 |
|---|---|---|
| `…/T/promptgate-phase6-pr5-green.png` | `docs/evidence/phase-6/disposable-green-pr5.jpg` | `f2acef06cff721c6126ce6d49f6c1a9b0f7bc22c275bfa89ae621b28e5768c3c` |
| `…/T/promptgate-phase6-pr6-control-gap.png` | `docs/evidence/phase-6/certified-v2-control-gap-pr6.jpg` | `61569967a4241d891aa77917cdc72265b90440938885100212d2c5d1d66274bf` |
| `…/T/promptgate-phase6-pr6-deterministic-red.png` | `docs/evidence/phase-6/deterministic-v3-red-pr6.jpg` | `765de18c65af98dd1b4b595f2050ea9db1bf7b1b25a25ebd72d45189f60056da` |
| `…/T/promptgate-phase6-pr6-deterministic-checks.png` | `docs/evidence/phase-6/deterministic-v3-checks-pr6.jpg` | `f12e9d64ce6851a13a509f9ed4ecfa46bef7f316d88d78fe7bfffdc448903c83` |

(`…/T` = `/var/folders/2k/bwcysbqs38z7c8kbb5tp5q080000gn/T`.) The two
remaining capture files in that directory (`…pr4-green.png`,
`…pr6-pr-checks.png`) were intentionally not copied — they are outside the
assigned four. All four images were visually inspected before captioning;
each caption in `docs/evidence/phase-6.md` describes only visible content,
which matched the recorded run facts (same-version line and both
`0.9342857142857142`/7 averages on PR #5; the
`-0.015999999999999792` drop with exit 0 on the v2 run; the
`0.8966666666666666`/6 vs `0.165`/2 summary with exit 1 on the v3 run; `ci`
green beside red `eval-gate` at `28e4d6a` on the checks view).

## Exact commands and results

Reading (before any edit): `../CLAUDE.md` (provided in session context),
`ORCHESTRATOR.md`, `BUILD_PLAYBOOK.md` intro/acceptance table + Phase 6 +
Phase 5 Verify context, `IMPLEMENTATION_GUIDE.md` §7.3–§7.4 (+ §7.2/§11
context), `PromptGate_PROJECT_IDEA.md` decision #11, `PROGRESS.md` (header,
phase status, blockers, decision log, backlog, session log),
`docs/evidence/phase-4.md`, `docs/evidence/phase-5.md`, commit `28e4d6a`
(`git show --stat`, full diffs vs `28e4d6a~1`), and all three copied audit
logs in full.

1. `git status` / `git log --oneline` — clean tree on `codex/phase6-evidence`
   at `2e82f25` (= protected `master`).
2. `git cat-file -t 28e4d6a…` → `commit`;
   `git log --oneline -3 28e4d6a…` → `28e4d6a` ← `3663220` ← `2e82f25`.
3. `git diff 28e4d6a~1 HEAD -- BUILD_PLAYBOOK.md IMPLEMENTATION_GUIDE.md
   PromptGate_PROJECT_IDEA.md --stat` → empty: the disposable parent's
   authority files are identical to current `master`, so restoring those
   three files from `28e4d6a` persists exactly the approved amendment and
   nothing else.
4. `git restore --source=28e4d6a --worktree -- <three logs> <three authority
   files>`; then for each of the six paths
   `git show 28e4d6a:<path> | diff -q - <path>` → all six byte-identical.
5. Diff-of-diffs proof: `git diff HEAD -- <3 authority files>` equals
   `git diff 28e4d6a~1 28e4d6a -- <3 authority files>` (index lines
   excluded) → `WORKING DIFF == APPROVED AMENDMENT DIFF`.
6. `mkdir -p docs/evidence/phase-6` + four `cp` copies;
   `shasum -a 256` on all four sources and destinations → pairwise equal
   (table above); `file` → all `JPEG image data … 1920x992`;
   `sips -g pixelWidth -g pixelHeight` → 1920/992 for all four.
7. Read-only GitHub confirmations (no mutation):
   - `gh run view 30539658160 --json …` → workflow `eval-gate`, conclusion
     `failure`, head `28e4d6ad8481b481ab5acc79e702178a7fd7223c`; jobs:
     `detect-eval-scope` `90861169364` success, `live-evaluation`
     `90861217803` failure, `eval-gate` `90866805736` failure.
   - `gh pr view 6 --json …` → state `CLOSED`, `mergedAt: null`, head ref
     `codex/phase6-degraded-proof` at `28e4d6a…`.
   - `gh run view 30522521709 --json …` → `eval-gate` success at
     `36632201edc675ff688d521d4f99c4b6b7f508c9` (the D1 control-gap run).
   - `gh run view 30539655326 --json …` → `ci` on push, success at
     `28e4d6a…`; `gh run view 30539658159 --json …` → `ci` on pull_request,
     success at `28e4d6a…`.
   - `git ls-remote --heads origin codex/phase6-degraded-proof
     codex/phase6-green-proof` → no refs (both disposable remote branches
     absent); local branch list contains neither.
8. Dataset cross-check for the two live rubric failures:
   `packages/evals/datasets/safety_screening.yaml` has exactly seven
   `llm-rubric` cases, of which exactly two expect `none` —
   `observed_stomach_pain_nausea_none_01` and
   `scary_cpr_course_unconscious_mannequin_none_01`; the retained v3 log
   visibly scores the latter 0.25, so the 0.08 score belongs to the former,
   and (0.08 + 0.25)/2 = 0.165 reconciles the candidate `score_avg` over 2
   scored cases exactly.
9. Wrote `docs/evidence/phase-6.md`; edited `PROGRESS.md` (six scoped edits);
   wrote this log.
10. Carried-row integrity: extracted the five carried lines (two decision
    rows, backlog bullet, two session rows) from `28e4d6a:PROGRESS.md` and
    from the edited `PROGRESS.md`; `diff` → `CARRIED ROWS BYTE-IDENTICAL`
    (5 = 5 lines).
11. Scope proof: `git status --short` → exactly
    `M BUILD_PLAYBOOK.md`, `M IMPLEMENTATION_GUIDE.md`, `M PROGRESS.md`,
    `M PromptGate_PROJECT_IDEA.md`, plus untracked `docs/evidence/phase-6.md`,
    `docs/evidence/phase-6/`, the three copied audit logs, and this log.
12. Disposable-path parity: `git diff master HEAD -- <4 product paths>` and
    `git diff -- <4 product paths>` → empty; per-file
    `git diff --quiet master -- <path>` → no diff for
    `safety_screen.json`, `ci-seed.ts`, `ci-seed.test.ts`;
    `negative-control.test.ts` does not exist in the worktree.
13. Image/link validation: all four images nonempty + JPEG + 1920×992; each
    referenced exactly twice in `docs/evidence/phase-6.md` (embed +
    hash-table row); every Markdown link target in the evidence doc resolves;
    the three backtick-referenced audit-log paths resolve from
    `docs/evidence/`; recomputed SHA-256 values match the four recorded in
    the doc.
14. `git diff --check` → clean, exit 0 (rerun after the final edit).

## Successful checks

- Authority amendment persisted exactly (diff-of-diffs equality); all
  unrelated current content preserved (base files were identical to
  `master`'s).
- Three audit logs byte-exact from `28e4d6a`, BLOCK → APPROVE history intact.
- Evidence doc distinguishes PR #5 (prescribed green arm) from PR #4
  (merged corroboration), PR #6's v2 control-gap run (D1) from the final v3
  red run, and records the 16/50-predicted vs 14/50-live explanation, the
  <40 validity boundary, no-rerun, and full closure/deletion disposition.
- All four screenshots unaltered (hash-verified), honestly `.jpg`-named,
  1920×992 JPEG, embedded with working relative paths and captions matching
  visually inspected content.
- `PROGRESS.md`: Phase 6 `awaiting approval` with blank human-approval cell,
  no-technical-blocker statement, protected `master` still `2e82f25`,
  evidence branch described as uncommitted, PR #5/PR #4/D1/v3/final-result/
  no-rerun/disposition/771-test CI and all evidence/log paths recorded,
  Phase 7 `not started`, new session row that does not claim the evidence PR
  is pushed or merged.
- Read-only GitHub queries corroborated every run/job conclusion, head SHA,
  PR state, and branch absence cited above.

## Failed checks

- None in this pass. (Historical failures — the original verifier BLOCK, the
  D1 exit-0 control gap, and the 14-vs-16 live shortfall — are recorded as
  evidence in the copied logs and `docs/evidence/phase-6.md`, not failures of
  this pass.)

## Suspected causes for failures

- Not applicable; no check failed.

## Known risks

- Product tests, lint, and build were deliberately not rerun: this pass is
  docs/evidence-only, changes no product file (proven by the
  disposable-path parity checks), and the authoritative green evidence
  remains the 2026-07-30 local amendment gate plus CI runs
  `30539655326`/`30539658159` (lint, build, 771 tests). The independent
  verifier may rerun any gate.
- The final v3 run facts rest on retained GitHub Actions logs (re-confirmed
  read-only this session at the run/job/PR level); GitHub log retention is
  finite, which is why the four screenshots and this record persist the
  substance in-repo.
- The attribution of the 0.08 rubric score to
  `observed_stomach_pain_nausea_none_01` is a dataset-structure deduction
  (exactly two expected-`none` rubric cases exist and the other is visibly
  0.25); it is labeled as such in the evidence doc's reasoning and is
  cross-checkable in the retained job log.
- The two 2026-07-30 session rows and two decision rows carried from
  `28e4d6a` describe that disposable pass's own state ("uncommitted, for
  integrator review", "Phase 6 `verify pending`"); they are historical rows,
  superseded by this pass's newer row and header, matching how this log
  preserves history.

## Remaining work (not this pass)

- A fresh independent verification subagent must review this evidence pass
  (required-logs rule: no work step is complete until both logs exist and
  are read).
- The Lead/Integrator then opens/pushes the protected evidence PR from
  `codex/phase6-evidence` to `master` under the required strict checks.
- The project owner gives (or withholds) explicit human Phase 6 completion
  approval; only that approval moves Phase 6 from `awaiting approval` to
  `done`.
- After Phase 6: the owner's D1 remedy choice.

## Final status

**PASS** — evidence persisted accurately and scope-clean; Phase 6 left
`awaiting approval`; Phase 7 not started; all changes left uncommitted on
`codex/phase6-evidence`. A fresh independent verification and the protected
evidence PR remain pending. No commit, push, GitHub mutation, provider,
Docker-runtime, `.env`, schema, package, dataset, or runtime-data action was
taken; GitHub was accessed read-only.
