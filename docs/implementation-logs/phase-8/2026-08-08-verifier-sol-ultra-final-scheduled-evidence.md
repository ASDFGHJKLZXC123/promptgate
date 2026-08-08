# Phase 8 final scheduled evidence — independent verification

Date: 2026-08-08
Verifier: fresh GPT-5.6 Sol / ultra
Base: protected `master` at `120dfb75be4405f5ba295a79485bddcaf0ef2155`
Status: **APPROVE**

## What was reviewed

I independently audited the uncommitted documentation-only evidence pass on
`codex/phase8-final-evidence`. The review reconciled the exact GitHub Actions
run and provider matrix against the README, Phase 8 evidence, authoritative
progress state, session-history entry, and implementation record. I also
checked for stale pending language, manual-run substitution, unsupported live
provider claims, scope drift, secret exposure, broken relative links, and test
regressions.

## Files inspected

- `../AGENTS.md`
- `README.md`
- `docs/evidence/phase-8.md`
- `PROGRESS.md`
- `docs/implementation-logs/phase-8/2026-08-08-sol-ultra-final-scheduled-evidence.md`
- `.github/workflows/contract-nightly.yml` through its retained local link and
  the sanitized scheduled-run output
- the complete local diff and working-tree scope

This verifier added only this record.

## Independent GitHub reconciliation

Read-only `gh` metadata and sanitized log inspection proved that run
[`31251691537`](https://github.com/ASDFGHJKLZXC123/promptgate/actions/runs/31251691537):

- has event exactly `schedule`, branch `master`, head
  `120dfb75be4405f5ba295a79485bddcaf0ef2155`, and conclusion `success`;
- is the first later scheduled run after the earlier red scheduled run
  `31169217048`;
- reports OpenAI/Luna non-streaming as one validated visible-text choice and
  streaming as four validated chunks with one terminal usage chunk;
- reports DeepSeek/V4 Flash non-streaming as one validated visible-text choice
  and streaming as 27 validated chunks with one terminal usage chunk;
- names Anthropic/Sonnet and Gemini/Flash `SKIPPED` because their credentials
  were unconfigured and states that both live modes were not run; and
- reports exactly 2 configured, 2 passed, 0 failed, and 2 skipped.

PR #15 is merged at the same exact commit. A separate read-only check of
diagnostic-only run `31236238498` corroborated the historical Anthropic-credit
and Gemini-catalog claims without treating that `workflow_dispatch` run as
scheduled evidence. Presence-only repository-secret metadata contains only
`DEEPSEEK_API_KEY` and `OPENAI_API_KEY`; no secret value was read or printed.

## Evidence and wording findings

- The README pending notice is replaced by the exact scheduled-run URL, and the
  same URL appears in the appropriate Deliverables row.
- README, Phase 8 evidence, and `PROGRESS.md` all explicitly disclose that
  Anthropic and Gemini were named unconfigured skips and were not live-verified
  in the qualifying schedule.
- No manual dispatch is substituted for the qualifying run, and no current
  status text still claims that green scheduled evidence is pending.
- The provider/model names, exact head, timings, mode details, totals, and
  remaining closure work agree across the edited records and the live run.
- The working tree stayed inside the authorized documentation/log scope; no
  source, workflow, authority document, provider configuration, runtime data,
  registry state, label, key limit, secret, deployment, or dogfood repository
  changed.
- All relative Markdown links in the changed README and Phase 8 evidence
  resolve, and the diff-level secret-pattern scan is clean.

## Verification commands and results

1. `gh run view 31251691537 ... --json ...`

   Passed: exact event, branch, head, timestamps, URL, job, and green conclusion.

2. `gh run view 31251691537 ... --log` with bounded provider/summary filtering

   Passed: exact four-provider matrix and 2/2/0/2 totals reproduced above.

3. `gh run list ... --workflow contract-nightly.yml --event schedule`

   Passed: the qualifying run is the first later scheduled run after the prior
   red schedule.

4. `gh pr view 15 ...`, the bounded diagnostic-run check, and presence-only
   `gh secret list`

   Passed: merge/head and surrounding history are consistent; only the two
   configured credential names remain.

5. `pnpm lint`

   Passed: Biome checked **185 files** with no fixes or errors.

6. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`

   Passed: **2 files, 40/40 tests**.

7. Immediate single-worker isolation of the six tests affected by the first
   full-run stall

   Passed: **6 files, 119/119 tests**.

8. `pnpm exec vitest run --fileParallelism=false --maxWorkers=1`

   Passed: clean serialized full rerun, **69 files, 899/899 tests**.

9. Exact-claim/stale-pending scans, relative-link validation, protected-scope
   and secret-pattern scans, plus `git diff --check`

   Passed with no discrepancy, missing link, scope drift, secret-shaped value,
   or whitespace error.

## Failed checks and suspected causes

An extra default-parallel `pnpm test` attempt eventually reported six unrelated
timeout/health failures after an abnormal roughly fourteen-minute stall, while
the other 893 tests passed. None of the failed files is changed in this pass.
All six affected files passed immediately in a one-worker isolation (119/119),
and the complete clean one-worker rerun passed 899/899 in 21 seconds. The
evidence points to transient shared-host/process scheduling contention in the
parallel attempt, not a reproducible repository or documentation defect.

## Known risks and limitations

- The qualifying scheduled run live-verified only OpenAI/Luna and DeepSeek/V4
  Flash. Anthropic/Sonnet and Gemini/Flash remain named unconfigured skips; this
  audit does not convert those skips into live contract proof.
- This pass completes scheduled evidence publication only. Exact final-merge
  redeployment, the literal Phase 8 Verify block, the final deployment audit,
  and owner approval remain required.

## Final status

**APPROVE.** The evidence is exact, appropriately limited, internally
consistent, secret-safe, and ready for protected publication. No corrective
edit is required before commit and PR checks.
