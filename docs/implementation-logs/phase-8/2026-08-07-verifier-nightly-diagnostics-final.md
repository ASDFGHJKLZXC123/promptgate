# Phase 8 — Nightly diagnostics final evidence verification

Date: 2026-08-07
Verifier: fresh independent Codex verification sub-agent
Branch/base: `codex/phase8-nightly-diagnostics` at
`3c330a8d4da829481ea7c9a341b7f2c3b740900a`
Final status: **REQUEST_CHANGES (evidence only; corrected source still passes)**

## Review scope

I independently rechecked the complete current tracked diff, every untracked
Phase 8 nightly-diagnostics record, the newly appended implementation
correction, the updated `PROGRESS.md` row, the prior two verifier decisions,
the relevant source and compiled paths, and the current changed-file scope.

I wrote no product, source, test, progress, implementation, prior-verifier,
authority, workflow, provider, registry, runtime-data, or protected file. This
fresh final verifier record is my only write.

Files inspected directly:

- `../AGENTS.md`
- `PROGRESS.md`
- `docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md`
- `docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics.md`
- `docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-recheck.md`
- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/contracts/nightly-workflow.test.ts`
- `packages/gateway/src/providers/provider-error.ts`
- `packages/gateway/src/providers/types.ts`
- the `ProviderError` construction sites in the OpenAI-compatible and
  Anthropic non-streaming/streaming adapters
- `.github/workflows/contract-nightly.yml`
- root and gateway `package.json`
- the complete tracked/untracked changed-file set and every protected path
  named in the scope audit below

All verification was offline. I made no provider or other external network
call, workflow invocation, credential access, Docker action, commit, push,
registry mutation, runtime-data read/write, or live-state query. Synthetic
adversarial strings were the only values used as credentials.

## Findings

### 1. Blocker — the new progress row overstates unchanged generic-error behavior

The new 2026-08-07 row in `PROGRESS.md` says:

> non-`ProviderError` behavior is unchanged

That is not true for every input in the corrected tree. The correction replaces
the shared `redact()` implementation used by all `safeError` branches, not only
the `ProviderError` branch. Generic `Error` dispatch and base-message
construction remain unchanged, but overlapping-secret redaction is now safer
for generic errors too.

An exact offline probe through exported `runNightlyContracts` used the synthetic
configured secrets `sk-overlap` and `sk-overlap-extended` and threw a plain
`Error` containing the longer value. It printed:

```text
current="Error: generic [REDACTED]"
legacy="Error: generic [REDACTED]-extended"
equal=false
```

The current output is correct and fixes the same suffix exposure for generic
errors. This is an evidence wording defect, not a source defect. Narrow the
progress claim to say that non-`ProviderError` dispatch and base-message
construction are unchanged while the overlap-safe shared redactor now applies
to every error kind. The implementation correction should also explicitly
supersede pass 1's historical “completely unaffected” wording. The prior
recheck's byte-for-byte generic-output statement is retained as historical
review evidence but was too broad for overlapping configured secrets.

### 2. Blocker — the authoritative current-state fields in `PROGRESS.md` remain stale

`PROGRESS.md` says its Position line is always the truth, but its top-level
current-state fields still describe the 2026-08-06 pre-merge tree:

- Position still says the Phase 8 merge remains.
- Last session still describes the initial 15/15 focused and 874/874 full
  gates rather than the current diagnostics work.
- Repo state still says protected `master` is `6f2d44e`, the working branch is
  `codex/phase8-dogfood`, and PR #13 remains to be merged.
- Last-green fields still say 874 tests on 2026-08-06.
- The current Phase 8 blocker still says the nightly/README work is in PR #13
  and only merge plus later gates remain.

The current read-only Git result is different: `HEAD`, local `master`, and
`origin/master` all resolve to
`3c330a8d4da829481ea7c9a341b7f2c3b740900a`, whose subject is the merge of PR
#13; this branch is `codex/phase8-nightly-diagnostics`; the first scheduled run
is recorded as red rather than pending; and the current reproducible repository
gate is 890/890 tests.

The corrected 2026-08-07 history row now has the requested 16/31/890 counts,
but it does not reconcile the fields that the document itself designates as
current truth. Refresh those current-state fields in the same evidence-only
pass. No product or test change is requested.

### 3. The previously requested count and correction records are now present

The specific evidence omissions from the preceding Sol / ultra recheck were
fixed correctly:

- The implementation record now appends “Correction pass 2 — overlapping
  secrets and full control range,” including scope, implementation history,
  files/counts, commands, successes, failures/causes, risks, no-live limitation,
  and final status.
- The diagnostic block adds exactly 16 tests: the current nightly test file has
  27 `test(...)` declarations versus 11 at `HEAD`, and the unchanged workflow
  file has 4, yielding the reproduced focused total of 31.
- Current tracked numstat is exactly `PROGRESS.md` 1/0,
  `nightly.test.ts` 424/0, and `nightly.ts` 157/7.
- The new progress row now says 16 new diagnostic tests, focused 31/31, and
  full 890/890 across 69 files.

No stale 13/28/887 or 103/3 + 333/0 value is presented as the correction-pass
final count. Those values remain only inside the explicitly historical pass-1
and first-verifier sections, where they are appropriate.

### 4. Both prior source blockers remain resolved

Overlapping-secret redaction is corrected. `findSecretSpans` locates every
occurrence of every nonempty configured secret against the original scalar,
advancing by one UTF-16 code unit so self-overlap is included. `mergeSpans`
sorts and merges containment, adjacency, and arbitrary overlap before one
marker is rendered per union. All configured definitions contribute their
nonempty environment value before any adapter executes.

The independent source and compiled probes each used three configured
synthetic secrets with arbitrary cross-secret overlap and self-overlap, threw
the same `ProviderError` in both modes, and inspected returned details, callback
reports, and the rendered summary. Both probes passed with 6 details, 6 report
lines, 3 configured secrets, and no complete secret or overlap fragment in any
surface. Every detail contained:

```text
message=token=[REDACTED] self=[REDACTED] left right
```

Control normalization is also corrected. The source predicate covers decimal
0 through 31, DEL 127, and C1 128 through 159. Both independent probes inserted
all 65 covered code points programmatically and confirmed none survived in any
detail or callback line in either mode. The added C1 regression likewise builds
the range numerically and embeds no raw C1 character in the test source.

The fixed scalar allowlist, per-field precedence, primitive/non-finite
rejection, hostile-getter catch boundary, shallow cyclic handling, 200-unit
field cap, 1,000-unit total cap, and both mode paths are consistent with the
source and green focused suite. Provider adapters continue to preserve their
parsed upstream error bodies in `ProviderError`; no request construction,
provider transport, model pin, endpoint, or workflow behavior changed.

### 5. Failure and agent-interruption disclosure is materially truthful

The first verifier record documents the reproduced suffix leak, surviving C1
control, and its one corrected verifier-harness invocation. The second verifier
record proves those source fixes and requests only evidence reconciliation. The
implementation correction now carries both classes of failure and does not
misrepresent them as repository test/build failures.

The agent-service history is transient process evidence, not reproducible from
repository state. During this final check the orchestrator supplied the exact
observed tool outcomes:

- Sonnet session 43745 ended with `API Error: Connection closed mid-response.`
  after starting the log correction.
- Sonnet continuation 60424 ended with the same connection error while checking
  the end of the file.
- Opus / max session 28790 ended with the same connection error during initial
  inspection.
- Fable / max session 38308 exited with an out-of-usage-credits message.

Those exact process attestations corroborate the implementation record's
shorter summary. I did not and cannot independently replay historical service
interruptions from repository artifacts, and this limitation does not affect
the independently reproducible source/test verdict.

Pass 1's historical lint and raw-control editing incidents are implementer
reports rather than reconstructable failures on the current tree. Fresh lint,
raw-control scans, tests, and build are clean, and no contradictory residual
artifact was found.

### 6. Scope and no-live-green limitations are honest

The tracked diff contains only the intended contract source/test plus
`PROGRESS.md`. Before this record, the only untracked files were the
implementation record and two prior verifier records under the Phase 8 log
directory. This record is the fourth untracked file there.

The protected-path audit is empty. There is no change to provider adapters,
pins, endpoints, request shapes, workflow triggers/permissions, package
scripts/dependencies, lockfile, environment template, README, project idea,
authority documents, pricing, registry, database/pipeline code, or evidence and
runtime-data paths.

The records correctly retain the material operational limitation: this patch
makes a future provider failure more safely diagnosable, but it neither proves
nor fixes the upstream causes of scheduled run `31169217048`. No green
schedule-triggered run is claimed. I did not query live workflow state under
this task's no-network/no-workflow constraint; the run history remains a
process/evidence attestation rather than a fact reproduced in this offline
check.

## Verification commands and exact outcomes

1. `cat ../AGENTS.md` and complete reads of all three existing nightly
   diagnostics records; complete separate diffs for `PROGRESS.md`,
   `nightly.ts`, and `nightly.test.ts`; numbered reads of the current source,
   workflow, CLI, provider error type, adapter throw sites, and progress state.
   - Confirmed the requested appended record/count fixes.
   - Exposed findings 1 and 2.
2. `git rev-parse HEAD`, `git rev-parse master`, `git rev-parse origin/master`,
   and `git log -1 --oneline --decorate`
   - All three revisions:
     `3c330a8d4da829481ea7c9a341b7f2c3b740900a`.
   - Subject: `Merge pull request #13 from
     ASDFGHJKLZXC123/codex/phase8-dogfood`.
3. Test-declaration counts using `rg '^\s*test\('` on the current nightly and
   workflow tests and on `git show HEAD:.../nightly.test.ts`, plus the added-test
   diff filter.
   - Current nightly: 27; base nightly: 11; workflow: 4; added diagnostic
     tests: exactly 16; focused total: 31.
4. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
   - Exit 0: 2 files passed, 31/31 tests passed.
5. `pnpm test`
   - Exit 0: 69 files passed, 890/890 tests passed.
6. `pnpm lint`
   - Exit 0: 185 files checked, no fixes applied.
7. `pnpm --filter @promptgate/gateway build`
   - Exit 0: clean gateway TypeScript build, packaged migrations/pricing copy,
     and scripts type-check.
8. `pnpm exec tsx -e '<inline source-path overlap/control harness>'`
   - Exit 0: `{"details":6,"reports":6,"configuredSecrets":3,"controls":65,"expectedSnippetPresent":true}`.
   - Assertions covered arbitrary cross-secret overlap, self-overlap, both
     modes, all 65 C0/DEL/C1 points, returned details, callback reports, and
     summary redaction through exported source functions.
9. `node --input-type=module -e '<equivalent compiled-output overlap/control harness>'`
   - Exit 0 with the same exact JSON result and assertions against
     `packages/gateway/dist` after the build.
10. `pnpm exec tsx -e '<inline generic-Error legacy/current comparison>'`
    - Exit 0:
      `{"current":"Error: generic [REDACTED]","legacy":"Error: generic [REDACTED]-extended","equal":false}`.
    - This is the exact reproduction for finding 1.
11. `rg -nUaP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' <all changed source/evidence files>`
    - Exit 1 with no output, the expected clean result for forbidden raw
      C0/DEL text bytes.
12. `rg -nUaP '[\x{80}-\x{9F}]' <all changed source/evidence files>`
    - Exit 1 with no output, the expected clean result for raw C1 characters.
13. `git diff --check`
    - Exit 0 with no whitespace errors in the tracked diff.
14. `git diff --name-status HEAD`, `git diff --numstat HEAD`,
    `git status --short --branch`, and
    `git ls-files --others --exclude-standard`
    - Tracked: `PROGRESS.md`, `nightly.test.ts`, and `nightly.ts` only.
    - Numstat: 1/0, 424/0, and 157/7 respectively.
    - Untracked: exactly the four Phase 8 nightly-diagnostics log files after
      this record was added.
15. `git diff --exit-code HEAD -- .github/workflows package.json pnpm-lock.yaml .env.example README.md PromptGate_PROJECT_IDEA.md BUILD_PLAYBOOK.md IMPLEMENTATION_GUIDE.md ORCHESTRATOR.md packages/gateway/package.json packages/gateway/pricing.json packages/gateway/src/config.ts packages/gateway/src/providers packages/gateway/src/registry packages/gateway/src/db packages/gateway/src/pipeline docs/evidence`
    - Exit 0 with no output; every named protected/out-of-scope path is
      unchanged.

## Successful checks

- Both prior source/security blockers remain resolved in source and compiled
  output.
- Focused tests: 31/31.
- Full suite: 890/890 across 69 files.
- Lint: 185 files clean.
- Gateway build: clean.
- Exactly 16 new diagnostic tests and exact final source/test numstat confirmed.
- Source/compiled overlap, self-overlap, all-control, report, and summary probes:
  clean.
- Raw C0/DEL and C1 scans: clean.
- Tracked diff check and protected-path audit: clean.
- Required implementation correction section and requested progress-row counts:
  present.
- Residual risks and the no-live-green limitation: disclosed.

## Failed checks and suspected causes

- **Current progress wording failed:** the shared redaction correction changes
  output for overlapping secrets in generic `Error` messages, contrary to the
  row's blanket “non-`ProviderError` behavior is unchanged” statement. Cause:
  the evidence preserved pass 1's branch-focused wording after replacing the
  shared redactor in pass 2.
- **Authoritative current progress state failed:** Position/repo/session/gate and
  current-blocker fields still describe the pre-merge Aug-6 state. Cause: only
  the historical progress row was reconciled after the prior evidence-only
  rejection.

No focused/full test, lint, build, source/compiled adversarial probe, raw-control
scan, tracked diff check, or protected-scope check failed in this pass.

## Residual risks

- Redaction and normalization inspect each full scalar before slicing, so work
  is proportional to input length even though output is bounded.
- UTF-16 slicing can split a supplementary scalar at a field or total boundary,
  leaving a lone surrogate without bypassing redaction or the cap.
- The intentionally shallow scalar allowlist will omit a future provider's
  differently nested or non-scalar diagnostic envelope.
- The actual provider-side causes of run `31169217048` remain unknown/unfixed,
  and no green schedule-triggered run is established by this offline pass.
- Historical agent-service outcomes and live-run facts cannot be independently
  replayed from repository state; this record distinguishes those attestations
  from reproducible code/test evidence.

None of these residual source risks adds a product-code blocker for this narrow
diagnostic change.

## Final status

**REQUEST_CHANGES (evidence only).** The corrected source/test patch remains
approved: both security defects are resolved, all required offline gates are
green, and protected scope is clean. Do not accept the evidence set yet. Update
the authoritative top-level `PROGRESS.md` current-state fields and correct the
blanket non-`ProviderError` claim; append a pass-2 clarification that the shared
overlap-safe redactor applies to every error branch. No product/test change and
no provider, workflow, credential, Docker, or runtime-data action is needed.
