# Phase 8 — Nightly diagnostics independent recheck

Date: 2026-08-07
Verifier: fresh independent Codex verification sub-agent
Branch/base: `codex/phase8-nightly-diagnostics` at
`3c330a8d4da829481ea7c9a341b7f2c3b740900a`
Final status: **REQUEST_CHANGES (evidence records only; source correction passes)**

## Review scope

I independently reviewed the complete current diff, the original implementation
record, the prior `REQUEST_CHANGES` verifier record, and the surrounding nightly,
provider-error, adapter, CLI, workflow, package, authority, registry, and runtime
paths. I made no product, source, test, progress, authority, workflow, provider,
registry, runtime-data, or existing-log edit. This fresh verifier record is my
only source-tree write.

Files inspected directly:

- `../AGENTS.md`
- `docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md`
- `docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics.md`
- `PROGRESS.md`
- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/contracts/nightly-workflow.test.ts`
- `packages/gateway/src/providers/provider-error.ts`
- `packages/gateway/src/providers/openai-compatible.ts`
- `packages/gateway/src/providers/openai-compatible-stream.ts`
- `packages/gateway/src/providers/anthropic.ts`
- `packages/gateway/src/providers/anthropic-stream.ts`
- `packages/gateway/src/providers/anthropic-translate.ts`
- `packages/gateway/src/providers/openai.ts`
- `packages/gateway/src/providers/gemini.ts`
- `packages/gateway/src/providers/deepseek.ts`
- `packages/gateway/src/providers/types.ts`
- `.github/workflows/contract-nightly.yml`
- `package.json`
- `packages/gateway/package.json`

I also checked the entire tracked/untracked changed-file set and explicitly
diffed all protected provider, workflow, authority, README, configuration,
registry, database, pipeline, pricing, lockfile, and evidence paths.

## Findings

### 1. Blocker — the claimed correction-pass implementation record is absent

The source correction itself passes, but the required implementation record does
not describe it. Lines 6–8 of
`2026-08-07-claude-code-nightly-diagnostics.md` say the correction pass is
“appended below”; the file ends at line 256 with the original pass's final
status, and no correction section exists.

Consequently, the record still states all of the rejected pre-correction facts:

- 13 new diagnostic tests rather than the current 16;
- focused tests 28/28 rather than the current 31/31;
- full tests 887/887 rather than the current 890/890;
- final numstat `nightly.ts` 103/3 and `nightly.test.ts` 333/0 rather than
  157/7 and 424/0;
- a source-function inventory that omits `Span`, `findSecretSpans`,
  `mergeSpans`, `isControlChar`, and the C1 bounds; and
- no description, command evidence, success/failure accounting, risks, or final
  status for the actual overlapping-secret and C1 correction.

This conflicts with `../AGENTS.md`, which says no work step is complete until
the implementation log states what was done, files changed, verification
commands, successful and failed checks with causes, known risks, and final
status. Append a truthful correction section before accepting this work.

### 2. Blocker — the new progress row also reports pre-correction evidence

The new 2026-08-07 `PROGRESS.md` row still says the patch adds 13 tests, focused
tests passed 28/28, and the full suite passed 887/887. The current corrected tree
adds 16 diagnostic tests, passes 31/31 focused tests, and passes 890/890 in the
full suite. Update those counts so the progress record describes the tree being
accepted.

These are evidence-integrity blockers, not source-code defects. No additional
product or test change is requested.

## Prior blocker resolution

### Overlapping configured-secret redaction — resolved

`nightly.ts:116-155` now locates every occurrence of every nonempty configured
secret against the original untouched value, sorts the half-open spans, merges
containment, adjacency, and arbitrary overlap, and renders one redaction marker
per merged span. Match discovery advances by one code unit, so self-overlapping
occurrences are also included.

The added containment and arbitrary-overlap tests pass through the exported
`runNightlyContracts` path. My independent source-path harness went further:

- all four configured provider secrets were present in one synthetic diagnostic;
- the secrets included prefix containment and non-prefix overlap;
- both `complete` and `stream` threw the same `ProviderError`;
- returned mode details, all report callback lines, and the rendered summary
  were scanned;
- no complete secret or exposed overlap fragment survived;
- a self-overlapping secret (`aaa` in five consecutive `a` characters) became
  one marker; and
- the adapter-construction failure path produced identical, redacted details for
  both modes.

The same containment/arbitrary-overlap assertions passed against the compiled
`packages/gateway/dist/contracts/nightly.js` output after the gateway build.

### C1 normalization — resolved

`nightly.ts:169-197` now normalizes C0 U+0000–U+001F, DEL U+007F, and the full C1
U+0080–U+009F range before whitespace collapse and per-field truncation. The
added C1 regression constructs the range numerically, so it does not embed raw
controls in the test source.

My independent runner probe inserted all 65 covered code points (32 C0 plus DEL
and 32 C1) into a structured provider message and checked both returned modes.
Both contained `message=left right`, and no covered code point survived. The
equivalent probe also passed against the compiled gateway output.

## Other confirmed behavior

- `safeError` still routes only `ProviderError` through structured extraction.
  Plain `Error` output and unknown-thrown-value output remain byte-for-byte
  equivalent to the base implementation. An independent two-mode probe asserted
  exact generic output and configured-secret redaction.
- All configured secrets come from every supplied provider definition, not only
  the provider whose mode failed. The independent four-provider probe confirmed
  this across returned details, callback reports, and Markdown summary output.
- Extraction remains a shallow fixed allowlist of scalar `type`, `code`, `param`,
  `status`, and `message`. Arrays, objects, nulls, non-finite numbers, and unknown
  fields are not emitted or stringified.
- Nested `body.error` scalars retain per-field precedence over top-level fields,
  with top-level scalar fallback.
- A cyclic body is read shallowly without recursion. A throwing `body.error`
  getter falls back to the base `ProviderError` message, after which configured
  secrets are still redacted. Both behaviors passed in both modes.
- Each structured field remains capped at 200 UTF-16 code units, and the final
  detail remains capped at 1,000. An adversarial five-field run exercised an
  exact 1,000-character final result in both modes while retaining the per-field
  cap and redaction.
- The adapter-setup, non-streaming, and streaming catches all feed the same safe
  formatter. A non-streaming failure still does not suppress the streaming call.
- The real provider constructors use fixed local base messages and preserve
  upstream bodies in `ProviderError`; the new formatter does not change their
  request or transport behavior.

## Scope audit

The tracked diff contains only:

- `PROGRESS.md` — 1 insertion;
- `packages/gateway/src/contracts/nightly.test.ts` — 424 insertions; and
- `packages/gateway/src/contracts/nightly.ts` — 157 insertions, 7 deletions.

Before this record, the only untracked files were the implementation record and
the prior verifier record under `docs/implementation-logs/phase-8/`. This fresh
record is the third untracked file there.

The branch, `HEAD`, local `master`, and `origin/master` all resolve to
`3c330a8d4da829481ea7c9a341b7f2c3b740900a`.

There is no change to provider pins, endpoints, request shapes, adapters,
workflow triggers or permissions, package scripts or dependencies, lockfile,
`.env.example`, authority docs, README, pricing, registry, database/pipeline
code, evidence/runtime data, or secrets. Within `nightly.ts`, the model table,
`buildRequest`, non-streaming and streaming contract logic, suite policy, and
summary rendering are unchanged; the diff is confined to the `ProviderError`
import, safe diagnostic helpers, and the `safeError` dispatch.

No network/provider call, workflow trigger, credential access, Docker action,
commit, push, or runtime-data operation was performed during this recheck. All
credentials used by the probes were synthetic literals.

## Verification commands and exact outcomes

1. `cat ../AGENTS.md`, both Phase 8 records, and the direct source/context files
   listed above; `git diff`/`nl -ba`/`rg` inspections of the complete current
   diff and surrounding error construction paths.
   - Confirmed the implemented algorithms and test coverage.
   - Exposed findings 1 and 2.
2. `git rev-parse HEAD && git rev-parse master && git rev-parse origin/master && git log -1 --oneline --decorate`
   - All three revisions were
     `3c330a8d4da829481ea7c9a341b7f2c3b740900a`.
3. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
   - Passed: 2 files, 31 tests.
4. `pnpm exec tsx -e '<offline source-path adversarial harness>'`
   - Passed through the exported source `runNightlyContracts` path.
   - Reported: 2 overlap modes; 4 configured secrets; 8 callback reports; 2
     generic-error modes; 65 control code points; cap lengths 1,000/1,000; 2
     cyclic modes; 2 hostile modes; 2 self-overlap modes; 2 setup-failure modes.
5. `pnpm test`
   - Passed: 69 files, 890 tests.
6. `pnpm lint`
   - Passed: 185 files checked, no fixes applied.
7. `pnpm --filter @promptgate/gateway build`
   - Passed: clean TypeScript build, packaged-data copy, and scripts type-check.
8. `node --input-type=module -e '<offline compiled-output adversarial harness>'`
   - Passed against `packages/gateway/dist`: 4 mode results, 11 rendered/reported
     outputs, 4 configured secrets, and all 65 covered control code points.
9. `rg -nUaP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' <all changed source/evidence files>`
   - Exit 1 with no matches, the expected clean result.
10. `rg -nUaP '[\x{80}-\x{9F}]' <all changed source/evidence files>`
    - Exit 1 with no matches, the expected clean result.
11. `git diff --check`
    - Exit 0; no whitespace errors.
12. `git diff --name-status HEAD && git diff --numstat HEAD && git status --short --branch && git ls-files --others --exclude-standard`
    - Tracked scope and exact counts are recorded in Scope audit above.
13. `git diff --exit-code HEAD -- .github/workflows package.json pnpm-lock.yaml .env.example README.md PromptGate_PROJECT_IDEA.md BUILD_PLAYBOOK.md IMPLEMENTATION_GUIDE.md ORCHESTRATOR.md packages/gateway/package.json packages/gateway/pricing.json packages/gateway/src/config.ts packages/gateway/src/providers packages/gateway/src/registry packages/gateway/src/db packages/gateway/src/pipeline docs/evidence`
    - Exit 0 with no output; every listed protected path is unchanged.
14. `git diff -U0 HEAD -- packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts | rg --pcre2 '^(@@|[+-](?![+-]))'`
    - Passed and confirmed the exact changed hunks.

One initial invocation of command 14 omitted `--pcre2`; `rg` rejected the
look-ahead syntax before inspecting any product text. Re-running with `--pcre2`
passed. This was a verifier display-filter mistake, not a repository failure.

## Successful checks

- Both prior security blockers are resolved in source and compiled output.
- Focused tests: 31/31.
- Full suite: 890/890 across 69 files.
- Lint: 185 files clean.
- Gateway build: clean.
- Independent source and compiled adversarial probes: clean.
- Raw source/evidence C0/DEL and C1 scans: clean.
- Diff whitespace and protected-path audits: clean.
- Scope is narrow; no provider or workflow behavior changed.

## Failed checks and suspected causes

- **Required implementation evidence failed:** the claimed appended correction
  record is absent and all final counts/details are stale. Suspected cause: the
  source/test correction was applied without appending its implementation log.
- **Progress evidence failed:** its counts were not refreshed after the three
  correction regressions. Suspected cause: the row was written after the initial
  pass and not reconciled after correction.
- **One verifier-only diff filter failed initially:** missing `--pcre2` for a
  look-ahead expression. The corrected read-only command passed.

No test, lint, build, source-path probe, compiled probe, source-cleanliness scan,
diff check, or scope check failed.

## Residual risks

- Redaction and normalization intentionally inspect the full scalar before the
  200-code-unit output slice, so work remains proportional to input length.
  Provider response-size handling bounds the normal upstream source, but a
  synthetic hostile in-memory string can still be very large.
- UTF-16 slicing can divide a supplementary Unicode scalar at a field or total
  boundary, leaving a lone surrogate in diagnostic text. This does not bypass
  redaction or a cap, but code-point-aware slicing would be cleaner.
- The conservative one-level allowlist intentionally provides no structured
  diagnostic for a future provider envelope with a different nesting shape or
  non-scalar diagnostic fields.
- No live provider call was authorized, so this pass proves diagnostic safety
  and visibility offline; it does not identify or fix the actual provider-side
  causes of scheduled run `31169217048`.

None of these residual risks is an additional acceptance blocker for this
narrow diagnostic change.

## Final status

**REQUEST_CHANGES (evidence records only).** The corrected source is approved:
the overlapping-secret and full-C1 failures are fixed, the real source and
compiled runner paths pass adversarial checks in both modes, all standard gates
are green, and scope is clean. Do not accept the work yet because the required
implementation and progress records still describe the rejected pre-correction
tree. Append the actual correction pass to the Claude Code implementation log
and refresh the progress counts; no product or test edit and no live provider or
workflow run is needed for this request.
