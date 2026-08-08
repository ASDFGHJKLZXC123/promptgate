# Phase 8 — Nightly diagnostics independent verification

Date: 2026-08-07
Verifier: independent Codex verification sub-agent
Branch/base: `codex/phase8-nightly-diagnostics` at `3c330a8d4da829481ea7c9a341b7f2c3b740900a`
Final status: **REQUEST_CHANGES**

## Review scope

I independently reviewed the entire uncommitted diff and the relevant error,
adapter, CLI, workflow, and test paths. I did not edit any product, test,
progress, authority, workflow, provider, or runtime file. This verifier record
is my only write.

Files inspected:

- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/providers/provider-error.ts`
- `packages/gateway/src/providers/openai-compatible.ts`
- `packages/gateway/src/providers/openai-compatible-stream.ts`
- `packages/gateway/src/providers/anthropic.ts`
- `packages/gateway/src/providers/anthropic-stream.ts`
- `packages/gateway/src/providers/anthropic-translate.ts`
- `.github/workflows/contract-nightly.yml`
- `package.json`
- `packages/gateway/package.json`
- `PROGRESS.md`
- `docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md`
- `../AGENTS.md`

The changed-file audit found only the intended contract source/test,
`PROGRESS.md`, and the Phase 8 implementation-log directory. `HEAD`, local
`master`, and `origin/master` all resolved to the Phase 8 merge
`3c330a8d4da829481ea7c9a341b7f2c3b740900a`. There is no diff in provider
adapters, provider pins/endpoints/request construction, workflow YAML,
README, `PromptGate_PROJECT_IDEA.md`, authority docs, registry, or runtime
data.

## Findings

### 1. Blocker — overlapping configured secrets can leak a credential suffix

`packages/gateway/src/contracts/nightly.ts:107-114` redacts configured secrets
sequentially in provider-definition order. If one configured key is a prefix
of another, replacing the shorter key first destroys the longer match and
leaves the longer key's suffix in the diagnostic. The new test at
`packages/gateway/src/contracts/nightly.test.ts:664-686` covers only one
configured secret, so it does not exercise this cross-provider condition.

An offline reproduction through the real `runNightlyContracts` path used
synthetic secrets `sk-overlap` and `sk-overlap-extended`. A `ProviderError`
body containing only the longer synthetic key rendered:

```text
message=[REDACTED]-extended
```

That output discloses part of a configured credential and does not satisfy
the accepted requirement that every configured provider secret be redacted.
At minimum, deduplicate and process configured secrets longest-first before
replacement, then add a regression with overlapping cross-provider secrets
that requires the complete longer value to become one redaction marker with
no suffix. A union-of-matches implementation would be stronger for arbitrary
non-prefix overlap, but the prefix regression is the concrete failing case.

### 2. Blocker — C1 control characters survive diagnostic normalization

`packages/gateway/src/contracts/nightly.ts:129-138` replaces C0 controls
(U+0000 through U+001F) and DEL (U+007F), but it does not replace the C1
control range U+0080 through U+009F. The whitespace split does not remove all
of that range. The existing test at
`packages/gateway/src/contracts/nightly.test.ts:720-740` covers only newline,
tab, and carriage return.

An offline reproduction through the real diagnostic path placed U+0081
between `left` and `right`. The resulting detail still contained code point
`0x81`:

```text
contains_u0081=true
... 6c 65 66 74 81 72 69 67 68 74
```

This contradicts the implementation-log claim that no raw control character
survives. Normalize the full C0, DEL, and C1 ranges (at least U+0000-U+001F
and U+007F-U+009F), and add a C1 regression such as U+0081 or U+009B.

### 3. Evidence correction — source diff count is misstated

The implementation log states `nightly.ts` is `+106/-3` at lines 91-92 and
147. `git diff --numstat` reports `103/3`; 106 is the total changed-line
count, not the insertion count. Correct this when recording the remediation
pass so the evidence remains literal and reproducible.

## Confirmed behavior

Subject to the two blockers above, the rest of the formatter is narrowly
scoped and behaves as intended:

- It reads only the fixed scalar fields `type`, `code`, `param`, `status`, and
  `message`; arbitrary object/array/null/unknown fields are not stringified or
  traversed.
- Nested `body.error` fields take per-field precedence over top-level body
  fields, with top-level fallback when a nested scalar is absent.
- Extraction is shallow, so cyclic bodies do not recurse. Property access is
  inside a catch boundary, so a throwing body/error/field getter falls back
  to the base message.
- Per-field output is capped at 200 UTF-16 code units, and `safeError` retains
  the existing 1,000-code-unit total cap.
- The generic `Error` and unknown-thrown-value branches are textually the same
  as the pre-patch implementation; the existing generic-error redaction test
  remains green.
- Both non-streaming and streaming errors use the same `captureMode` and
  formatter path.
- Provider pins, endpoints, request shapes, adapters, workflow triggers, and
  runtime behavior outside nightly failure reporting are unchanged.

## Verification commands and exact outcomes

All commands were offline; no provider, network, workflow, Docker, credential,
registry, or runtime-data operation was performed.

1. `git diff --check && git diff --name-status && git status --short --branch && git diff --numstat`
   - `git diff --check`: clean.
   - Changed tracked files: `PROGRESS.md`, `nightly.test.ts`, `nightly.ts`.
   - Untracked directory: `docs/implementation-logs/phase-8/`.
   - Numstat: `PROGRESS.md` 1/0, `nightly.test.ts` 333/0,
     `nightly.ts` 103/3.
2. `git rev-parse HEAD && git rev-parse master && git log -1 --oneline --decorate`
   - Both revisions were
     `3c330a8d4da829481ea7c9a341b7f2c3b740900a`.
3. `git diff -- .github README.md PromptGate_PROJECT_IDEA.md BUILD_PLAYBOOK.md IMPLEMENTATION_GUIDE.md ORCHESTRATOR.md packages/gateway/src/providers`
   - No output; all listed protected/out-of-scope paths were unchanged.
4. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
   - Passed: 2 files, 28 tests.
5. `pnpm lint`
   - Passed: 185 files checked, no fixes applied.
6. `pnpm --filter @promptgate/gateway build`
   - Passed: clean TypeScript build and packaged-data copy.
7. `pnpm test`
   - Passed: 69 files, 887 tests.
8. `rg -nUaP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts PROGRESS.md docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md`
   - Exit 1 with no matches, the expected clean result for forbidden raw C0
     bytes/DEL in the edited text files.
9. `rg -nUP '[\x{80}-\x{9F}]' packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts PROGRESS.md docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md`
   - Exit 1 with no matches; no literal C1 code points are embedded in those
     source/evidence files. This source-file cleanliness does not fix finding
     2, which concerns runtime input/output.
10. Offline synthetic overlap probe using `pnpm exec tsx -e` and the exported
    `runNightlyContracts` plus `ProviderError`:
    - Reproduced
      `detail="Adapter setup failed: ProviderError: failed | upstream message=[REDACTED]-extended"`.
11. Offline synthetic C1 probe using `pnpm exec tsx -e` and the same real
    diagnostic path:
    - Printed `contains_u0081=true`; the detail's code-point list contained
      `81` between `left` and `right`.

One initial overlap-probe invocation failed before exercising product code
because `tsx -e` compiled top-level `await` as CommonJS. The suspected cause
was exactly that eval-mode limitation. Re-running the same probe inside an
async IIFE succeeded and exposed finding 1. This was a verifier-harness
failure, not a repository test/build failure.

## Successful checks

- Focused tests: 28/28.
- Full suite: 887/887 across 69 files.
- Lint: 185 files clean.
- Gateway build: clean.
- Diff whitespace check: clean.
- Raw edited-file C0/DEL and C1 scans: clean.
- Scope audit: no pin, endpoint, request, adapter, workflow, authority,
  README, registry, or runtime-data change.
- Allowlist, precedence, scalar handling, shallow cyclic safety, hostile
  getter fallback, non-`ProviderError` preservation, and output caps were
  confirmed by code review and the green focused tests.

## Failed checks and suspected causes

- **Secret-redaction contract failed:** sequential shortest-before-longest
  replacement can partially expose a longer configured key. Cause: configured
  secrets are neither length-ordered nor matched against the original string
  as a set.
- **Control-normalization contract failed:** U+0081 survives. Cause: the
  numeric predicate stops at U+001F and checks only U+007F, omitting
  U+0080-U+009F.
- **First synthetic probe harness invocation failed:** top-level `await` was
  unsupported in `tsx -e` CommonJS output. Cause and recovery are described
  above; the async-IIFE rerun succeeded.

## Known risks

- Normalization/redaction processes each complete upstream scalar before
  slicing to 200 code units. The output is bounded, but extremely large
  hostile strings still incur work proportional to their full size. Provider
  response-size handling already bounds the practical source upstream; this
  is noted as residual risk, not an additional acceptance blocker here.
- UTF-16 `.slice` can split a supplementary Unicode scalar at a bound,
  yielding a lone surrogate in a diagnostic. This does not expose unknown
  fields or bypass the byte/character limit, but code-point-aware truncation
  would produce cleaner output. It is not an acceptance blocker for this
  narrow remediation.
- The formatter intentionally emits no structured diagnostics for providers
  that use a different envelope shape or non-scalar values. That conservative
  fallback is aligned with the allowlist requirement.

## Final status

**REQUEST_CHANGES.** Do not commit or publish this diagnostic patch yet.
Correct the overlapping-secret redaction and C1 control normalization, add
focused regressions for both, correct the implementation-log diff count, then
run a fresh independent verification pass. No live provider or workflow run
is needed to prove these offline security corrections.
