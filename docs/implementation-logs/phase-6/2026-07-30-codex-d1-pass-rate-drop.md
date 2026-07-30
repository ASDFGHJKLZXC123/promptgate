# Post-Phase-6 defect D1 — pass-rate drop guard

Date: 2026-07-30

Branch: `codex/d1-pass-rate-drop`

Base: protected `master` at
`bcca560c36222dffa89d7944e0ca7239e05af499` (evidence PR #7 merge)

## Authority

The project owner explicitly:

1. approved Phase 6 completion; and
2. approved D1 Remedy A with a `0.05` baseline-to-candidate pass-rate drop
   limit.

Phase 6 is therefore done and human-approved. This is bounded post-phase
corrective work that must be published before Phase 7 starts.

## Defect

The runner previously compared only `score_avg` against a baseline. A
deterministic assertion failure short-circuits before rubric scoring, so
breaking deterministic behavior could remove low-scoring cases from the
candidate denominator and raise its `score_avg`.

PR #6 demonstrated the gap: candidate v2 added five deterministic failures,
passed 45/50 cases, raised `score_avg` from approximately `0.972` to `0.988`,
and exited 0 because 0.90 remained above the absolute 0.8 dataset threshold.

## Implemented contract

- Added `--max-pass-rate-drop`, default `0.05`.
- Fresh distinct-version and historical baseline comparisons return quality
  exit 1 when the candidate pass rate drops materially more than the limit.
- Exact `0.05` is accepted with the same one-scale-adjusted-machine-epsilon
  comparator used for score drops.
- Fresh same-version pairs still execute and persist once; both relative drops
  are defined and reported as zero.
- Historical baseline rows must contain a safe non-negative `cases_passed`
  count no greater than `cases_total`.
- Deterministic failures remain unscored by the rubric; no synthetic zero
  scores were introduced.
- Baseline comparison output now names baseline and candidate pass rates, the
  computed drop, and the allowed limit.
- The Phase 6 workflow command is unchanged and relies on the default.
- Database/API schema, dataset threshold, prompt fixtures, target/judge
  topology, caching, retry, persistence, budgets, and credentials are
  unchanged.

## Files

Runtime and tests:

- `packages/evals/src/runner.ts`
- `packages/evals/src/runner.test.ts`
- `packages/evals/src/runner.meta.test.ts`
- `packages/evals/src/cli.ts`
- `packages/evals/src/cli.test.ts`
- `packages/evals/src/eval-gate-workflow.test.ts`

Authority and evidence:

- `ORCHESTRATOR.md`
- `BUILD_PLAYBOOK.md`
- `IMPLEMENTATION_GUIDE.md`
- `PromptGate_PROJECT_IDEA.md`
- `PROGRESS.md`
- `docs/evidence/phase-6.md`

## Regression proof

Focused coverage includes:

- fresh and historical exact `0.05` boundaries accepted;
- fresh and historical drops above `0.05` rejected;
- invalid direct option values rejected before dataset/service work;
- missing, negative, and greater-than-total historical `cases_passed` rejected
  as sanitized infrastructure failures before mutation/provider traffic;
- same-version one-run behavior with both drops zero;
- the recorded D1 shape: baseline 50/50, candidate 45/50, candidate
  `score_avg` higher than baseline, absolute threshold still met, exit 1 from
  the pass-rate band;
- workflow source still has one invocation and no explicit drop flags.

## Verification

- Focused runner/CLI/workflow suite: 4 files, 77 tests passed.
- Full repository suite: 59 files, 781 tests passed.
- Lint: 158 files checked, no fixes required.
- Four-package build: passed.
- Compose configuration: passed.
- Eval-package TypeScript check: passed independently.
- `git diff --check`: passed.
- Independent GPT-5.6 Sol / xhigh review: **APPROVE**, no blocking findings.

No provider call, live eval, credential read, Docker runtime start, database
mutation, or Phase 7 implementation occurred.

## Corrected development-only checks

The first lint attempt reported only three formatter deltas; the scoped
formatter corrected them and lint then passed.

The first D1 replay fixture accidentally embedded `safety@2` in a deliberately
failing response while asserting absence of `safe`; `safety` itself contains
that substring, so the test incorrectly passed the deterministic assertion.
The fixture was corrected to emit `blocked <index>`, after which the exact
regression returned exit 1 and all focused/full gates passed. This was a test
fixture error, not a runner failure.

## Status

**PASS — implementation and independent verification complete; ready for the
protected publication workflow. Phase 7 remains not started.**
