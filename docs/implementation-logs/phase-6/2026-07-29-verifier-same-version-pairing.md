# Phase 6 — Same-version pairing amendment (independent verification)

Date: 2026-07-29
Verifier: independent Codex verification subagent
Branch: `codex/phase6-pricing-seed-fix` at `02109b3`, with the amendment uncommitted

## What was reviewed

Reviewed the complete amendment diff and its implementation record for the
owner-approved Phase 6 same-version pairing behavior.

- Traced prompt-ref freezing and the fresh/history branch selection in
  `runEvaluation`.
- Verified that a fresh baseline and candidate resolving to the same prompt id
  and version skip the baseline execution, run and persist the candidate once,
  retain the dataset pass-rate threshold, define the score drop as zero, and
  report both refs plus the shared version.
- Verified that fresh distinct versions still execute and persist baseline
  first and candidate second, retain the default 0.05 score-drop band and its
  scalar floating-point tolerance, and append the measured comparison.
- Verified that historical-baseline lookup and comparison do not enter the
  same-version shortcut.
- Verified that the Phase 6 workflow still contains exactly one live
  `pg-eval run` command with `--baseline prod`, without runner/outer retry,
  history reuse, cache opt-in, or a score-drop override.
- Checked the synchronized authority/progress documentation for consistency and
  for premature Phase 6 completion.

## Files inspected

- `packages/evals/src/runner.ts`
- `packages/evals/src/runner.test.ts`
- `packages/evals/src/runner.meta.test.ts`
- `packages/evals/src/eval-gate-workflow.test.ts`
- `.github/workflows/eval-gate.yml`
- `PromptGate_PROJECT_IDEA.md`
- `IMPLEMENTATION_GUIDE.md`
- `BUILD_PLAYBOOK.md`
- `PROGRESS.md`
- `docs/implementation-logs/phase-6/2026-07-29-claude-code-same-version-pairing.md`
- `../CLAUDE.md`
- `ORCHESTRATOR.md`

## Verification commands run

1. `pnpm exec vitest run packages/evals/src/runner.test.ts packages/evals/src/runner.meta.test.ts packages/evals/src/eval-gate-workflow.test.ts`
   - Passed: 3 test files, 38 tests.
2. `pnpm lint`
   - Passed: Biome checked 158 files with no fixes.
3. `pnpm test`
   - Passed: 59 test files, 768 tests.
4. `pnpm build`
   - Passed: dashboard, shared, evals, and gateway workspace builds.
5. `docker compose config --quiet`
   - Passed with no output.
6. `git diff --check`
   - Passed with no whitespace errors.

Supporting read-only inspection used `git status`, `git diff`, `git log`,
`rg`, and bounded file reads. No provider, network, Docker runtime, database,
GitHub, commit, or push action was performed.

## Successful checks

- Same-version fresh pair: the code requires both prompt id and concrete version
  to match after ref freezing, excludes history mode, and omits the baseline
  `runModel`/persistence path.
- Candidate execution and persistence remain unchanged, so the shared version
  produces exactly one persisted candidate run. The focused regression proves
  one target call plus its one declared rubric call and one `createRun`.
- Absolute quality protection remains active because `qualityFail` is still
  initialized from the candidate pass rate versus
  `dataset.defaultTest.threshold`. The below-threshold same-version regression
  exits 1 while persisting only the candidate.
- The same-version result names both refs and the shared concrete version, then
  reports identical baseline/candidate averages and scored counts with a literal
  zero drop.
- Distinct fresh versions retain baseline-first persistence order. The new
  boundary regression passes a mathematical 0.05 drop and fails at
  0.050000001.
- History mode still performs exact historical lookup, runs/persists only the
  candidate, applies the historical score comparison, and does not emit the
  same-version shortcut text.
- The exact-output meta regression includes the new fresh-pair comparison line
  after the unchanged per-case markdown table.
- Workflow source and its contract test retain one paired invocation and contain
  none of the prohibited workaround flags or retry text.
- `PROGRESS.md` continues to describe Phase 6 Verify as pending and does not mark
  the phase complete.

## Failed checks

No execution command failed.

One documentation consistency check failed:

- `BUILD_PLAYBOOK.md` Phase 5 step 6 ends with “Phase 6 remains unchanged”
  immediately after defining the new same-version behavior that expressly
  changes Phase 6 execution and persistence. The new Phase 6 amendment paragraph
  later in the same authority document correctly states that only the workflow
  command and the listed rails are unchanged. As written, the broad sentence is
  materially contradictory and leaves the authoritative Phase 6 contract
  ambiguous.

## Suspected cause

The final sentence appears to be stale wording from the pre-amendment Phase 5
contract. The intended invariant is narrower: the Phase 6 workflow command
remains unchanged, while same-version runner behavior changes under the approved
amendment.

## Required correction

With the owner's amendment approval already recorded, narrow the stale final
sentence in `BUILD_PLAYBOOK.md` Phase 5 step 6 from:

> Phase 6 remains unchanged.

to:

> The Phase 6 workflow command remains unchanged.

Then rerun `git diff --check` and confirm the surrounding Phase 5/Phase 6
authority text reads consistently. No product-code or test correction is
required by this review.

## Known risks

- Fresh distinct-pair comparison output prints JavaScript's raw numeric
  subtraction, so an exact decimal 0.05 pair may display the normal binary
  floating-point representation even though the scalar-epsilon gate correctly
  accepts the boundary. This is informational and does not violate the
  “computed drop” contract.
- `docs/implementation-logs/.DS_Store` is an unrelated untracked filesystem
  artifact. It must not be staged with the amendment.
- Live green/degraded Phase 6 proof remains pending; this review covers the
  offline amendment only.

## Final recheck

The integrator applied the exact required owner-authorized wording correction:
the final sentence of `BUILD_PLAYBOOK.md` Phase 5 step 6 now reads, “The Phase 6
workflow command remains unchanged.”

- Inspected the complete `BUILD_PLAYBOOK.md` diff and confirmed the sentence is
  correctly narrowed. It now agrees with the same-version behavior defined in
  that step and with the Phase 6 amendment paragraph; no other material change
  was introduced by the correction.
- `git diff --check` passed.
- Re-ran the focused three-file command:
  `pnpm exec vitest run packages/evals/src/runner.test.ts packages/evals/src/runner.meta.test.ts packages/evals/src/eval-gate-workflow.test.ts`.
  All 3 files and all 38 tests passed.

The sole blocker identified above is resolved.

## Final status

**APPROVE**

The same-version pairing amendment is scope-consistent, fully green under the
requested offline verification gates, and ready to commit/push for the live
Phase 6 green/degraded pull-request proof. Phase 6 itself remains incomplete
until that live proof and the explicit human phase-completion approval.
