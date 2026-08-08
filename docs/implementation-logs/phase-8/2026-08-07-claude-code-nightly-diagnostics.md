# Phase 8 — Nightly diagnostic remediation (Claude Code implementation log)

Date: 2026-08-07
Implementer: Claude Code (Sonnet 5)
Branch: `codex/phase8-nightly-diagnostics` at exact merge `3c330a8`
Passes: 2 — original implementation and offline verification (2026-08-07),
plus a correction pass addressing the independent verifier's
REQUEST_CHANGES findings (2026-08-07, appended below)

## Scope

The first genuine scheduled `contract-nightly` run (`31169217048`, on exact
merge `3c330a8`) was correctly red: OpenAI and Anthropic each returned HTTP
400 in both modes, Gemini returned HTTP 404 in both modes, and DeepSeek
passed both modes. Current official provider docs confirm all four model
pins and endpoints are correct as configured, so the red result is not a
pinning defect. An independent read-only audit found the actual blocker:
`ProviderError` (`packages/gateway/src/providers/provider-error.ts`)
preserves the full structured upstream error body, but
`packages/gateway/src/contracts/nightly.ts`'s `safeError` only ever read
`error.name`/`error.message`, discarding the body entirely — so the exact
upstream cause (bad model string, wrong endpoint path, malformed request
field, etc.) could not be diagnosed from the job summary alone.

This pass implements the smallest safe remediation: a contract-only
diagnostic formatter, used by `safeError` only when the caught error is a
`ProviderError`, that emits a fixed allowlist of scalar fields (`type`,
`code`, `param`, `status`, `message`) read from the top-level body or a
nested `body.error`, redacted, control-normalized, and bounded.

Out of scope and untouched: model pins, endpoints, request shapes, provider
adapters, workflow triggers, authority docs, README, registry, runtime data,
and secrets. No network call, provider call, workflow trigger, Docker
action, secret read, commit, or push was made.

## Decisions

- **Precedence: nested `body.error.<field>` wins over top-level
  `body.<field>`.** All three real shapes checked (OpenAI, Anthropic,
  Gemini) nest the actual diagnostic under `error`; Anthropic additionally
  duplicates a generic top-level `type: "error"` discriminator alongside a
  specific nested `error.type` (e.g. `invalid_request_error`) — the nested,
  more specific value must win. Verified with a dedicated precedence test
  using a synthetic body where top-level and nested fields differ, and with
  the Anthropic-shaped test asserting `type=invalid_request_error` appears
  and `type=error` does not.
- **Scalar-only extraction.** A field is only emitted if it is a string,
  finite number, or boolean at the read location; objects, arrays, `null`,
  and `undefined` are silently omitted (never stringified or descended
  into). This satisfies "never emit arbitrary body/details/unknown fields"
  and correctly drops OpenAI's common `"param": null`.
  `readScalarField`/`extractDiagnosticFields` only ever read one property
  level deep (`body.<field>` and `body.error.<field>`), so a body with a
  cyclic self-reference (e.g. `body.error` pointing back at `body` itself)
  cannot recurse — the same object is simply read once.
- **Hostile-body safety.** All field extraction is wrapped in a single
  try/catch in `formatProviderErrorDiagnostics`; if reading `error.body`
  throws (e.g. a getter that throws), the formatter falls back to the plain
  base string `"<Name>: <message>"` with no upstream suffix, rather than
  propagating the throw into `captureMode`/`runNightlyContracts`.
- **Per-field bound (200 chars) in addition to the existing total bound
  (1,000 chars, unchanged in `safeError`).** Without a per-field cap, one
  oversized field (e.g. a verbose provider message) could consume the
  entire 1,000-char budget and silently crowd out the other four fields;
  the per-field cap keeps the summary informative even when one field is
  huge.
- **Control-character handling avoids unicode-escape regex character
  classes entirely.** `stripControlChars` iterates code points with
  `codePointAt` and compares numeric character codes directly, instead of
  building a regex character class from unicode escape sequences. This was
  a deliberate implementation-time correction: an initial attempt at that
  regex form ended up with literal raw control bytes embedded in the source
  file during editing, rather than the intended escape-sequence text (see
  Failed checks below for how this was caught and fixed). The
  character-code-comparison implementation avoids that whole class of bug
  and needed no lint escape hatch.
- **Diagnostic suffix format:** the base string followed by
  `" | upstream "` and then each present field as `field=value`
  space-separated, in the fixed order type/code/param/status/message.
  In pass 1, non-`ProviderError` dispatch and base-message construction were
  unaffected; the prior two branches were only reordered under a new leading
  `ProviderError` branch. Correction pass 2 supersedes the broader historical
  “completely unaffected” wording because its overlap-safe shared redactor now
  protects every error kind, including plain `Error` messages.

## Files changed

- `packages/gateway/src/contracts/nightly.ts` — added a `ProviderError`
  import; added `DIAGNOSTIC_FIELDS`, `DIAGNOSTIC_FIELD_MAX_LENGTH`,
  `stripControlChars`, `normalizeControlChars`, `toScalarString`,
  `readScalarField`, `extractDiagnosticFields`, and
  `formatProviderErrorDiagnostics`; `safeError` now dispatches to the new
  formatter only for `error instanceof ProviderError`, with the prior
  generic-`Error`/unknown-value behavior otherwise unchanged. Net
  +103/-3 lines (per `git diff --numstat` at the time of this pass; the
  figure of 106 previously recorded here was the total changed-line count,
  not the insertion count — see the correction pass below). No other
  function in the file was touched; model pins,
  request building, streaming/non-streaming run logic, and
  `renderContractSummary` are byte-identical.
- `packages/gateway/src/contracts/nightly.test.ts` — added a
  `ProviderError` import, a small `detailOf` typed test helper (needed
  because TypeScript does not narrow repeated `result.results[0]` index
  expressions across statements), and a new `describe("nightly ProviderError
  diagnostic formatting", ...)` block with 13 new tests (below). No existing
  test was modified beyond one required reformat (see Failed checks). Net
  +333 lines, all additive.

## New tests (13, all offline/fake-adapter, no network)

1. OpenAI-shaped envelope (`error.message`/`error.type`/`error.param`/`error.code`) — all four fields extracted.
2. Anthropic-shaped envelope — nested `error.type` wins over top-level
   `type: "error"`.
3. Google/Gemini-shaped envelope — numeric `error.code` (404) and string
   `error.status` ("NOT_FOUND") both extracted.
4. Synthetic top-level/nested precedence — nested wins, top-level values
   never appear in output.
5. Top-level-only fallback (no nested `error` object).
6. Streaming-mode capture — same extraction applies to a `ProviderError`
   thrown from `adapter.stream`.
7. Exact secret redaction — a configured provider secret embedded in
   `error.message` is replaced with `[REDACTED]` and never appears verbatim.
8. Unknown-field omission — `details`, `stack`, `requestId` and a literal
   `param: null` are all absent from the formatted output.
9. Control-character/line-break normalization — embedded newline,
   carriage-return, and tab characters in a message are collapsed to single
   spaces; no raw control character survives in the output.
10. Truncation/bounding — a 5,000-character field is bounded (total detail
    at most 1,000 chars; no 300-character run of the raw field survives).
11. Primitive bodies (`string`, `number`, `boolean`, `null`) — no throw;
    output is exactly the plain base message with no upstream suffix.
12. Cyclic body (`body.error` set to point back at `body` itself) — no
    throw/infinite loop; the one reachable scalar field (`message`) is
    still extracted.
13. Hostile getter (`body.error` implemented as a getter that throws) — no
    throw escapes; output falls back to the plain base message.

## Verification commands run

1. Scanned both edited source files for stray raw control bytes with
   `grep -aP` over byte ranges 0x00-0x08, 0x0b-0x0c, 0x0e-0x1f, and 0x7f
   (the `-a` force-text flag matters — see Failed checks) → both exit 1
   (no match), confirming no stray control bytes in either edited file.
2. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts` → **2 files, 28 tests, all passed.**
3. `pnpm lint` → initially 2 Biome formatting errors (a wrapped object-literal message and an unwrapped `??` line the formatter wanted differently); both hand-fixed to the exact formatter-suggested output; rerun → **checked 185 files, 0 errors.**
4. `pnpm --filter @promptgate/gateway build` → clean `tsc` compile, no errors/output (build script also copies migrations/pricing.json and type-checks `scripts/`).
5. `pnpm test` (full suite) → **69 files, 887 tests, all passed** (887 = the prior 874 plus these 13 new tests).
6. `git diff --check` → clean (no whitespace errors).
7. `git status --short` → exactly two changed source files:
   `packages/gateway/src/contracts/nightly.ts`,
   `packages/gateway/src/contracts/nightly.test.ts` (plus this log and
   `PROGRESS.md`, added after these checks).
8. `git diff --numstat` → `nightly.ts` +103/-3, `nightly.test.ts` +333/-0
   (the `+106/-3` figure originally recorded here was the total
   changed-line count, not the insertion count; corrected below).

No network call, provider call, `contract-nightly` workflow trigger, Docker
action, secret read, commit, or push was made in this pass.

## Successful checks

- Focused nightly tests: 28/28 passed.
- Full suite: 887/887 passed across 69 files (874 pre-existing + 13 new).
- Lint: 185 files checked clean after two mechanical formatting fixes.
- Gateway build: clean.
- `git diff --check`: clean.
- Diff scope: exactly the two intended source files changed; no model pin,
  endpoint, adapter, workflow YAML, authority doc, README, registry, or
  runtime-data file touched.

## Failed checks

- `pnpm lint` failed once before a fix: Biome wanted a multi-line object
  property (`message:` on its own line) collapsed to one line in
  `nightly.test.ts`, and wanted the `??` fallback expression in
  `extractDiagnosticFields` wrapped onto two lines in `nightly.ts`. Both
  were purely mechanical formatting differences (no logic change); applied
  by hand to match the formatter's exact suggested diff, then `pnpm lint`
  passed clean. Not a defect in the diagnostic logic itself.
- During editing, an early implementation attempt at the control-character
  regex resulted in literal raw control bytes being written into the source
  file instead of the intended escape-sequence text, which then made that
  region of the file unmatchable by further string-based edits. This was
  caught before any test run, by scanning the file for raw control bytes;
  fixed by rewriting the function to compare Unicode code points
  numerically instead of using a regex character class built from escape
  sequences, and by rewriting the whole source file (from a verified-clean
  in-memory copy) to guarantee no residual raw control bytes remained.
- The same class of issue recurred once more while drafting this log
  itself: three sentences describing the incident in prose (which
  themselves referenced escape-sequence syntax) ended up with the same
  literal raw control bytes embedded in this document. It was initially
  missed because a first verification scan of this log used plain `grep`
  without the `-a` (force-text) flag; `grep` silently treats a file
  containing a raw NUL byte as binary and suppresses all matches without
  `-a`, which produced a false "clean" scan result. Re-running the same
  scan with `-a` found the three affected lines; this document was then
  rewritten in full (this revision) using only plain prose descriptions of
  the escape mechanics, with no literal escape-sequence-shaped text
  anywhere in the file, and reverified clean with the `-a`-flagged scan
  (see Verification commands run, item 1, which lists both files this log
  describes changing — not this log itself, which was rescanned separately
  after this rewrite with the same command and also returned no match).

## Suspected causes for failures

- The two lint failures were pure formatter-preference mismatches (Biome's
  line-wrap heuristics), not correctness issues — confirmed by comparing the
  formatter's suggested diff, which changed only whitespace/line breaks.
- The control-byte incidents (both in the source file and later in this
  log) were caused by the tool-call parameter transport interpreting
  escape-sequence-shaped text in edit instructions before it reached the
  file, rather than preserving it as literal text. Avoided going forward by
  never typing escape-sequence-shaped text in tool parameters when editing
  these files — using numeric code-point comparison instead of regex
  character classes in the source, and plain prose instead of
  escape-sequence syntax in this log.

## Known risks

- The diagnostic formatter is deliberately conservative: it will emit
  nothing beyond the base `"<Name>: <message>"` line for any upstream error
  body that doesn't place its `type`/`code`/`param`/`status`/`message` at
  the top level or one level under `error` as a scalar. If a provider ever
  wraps its error differently (e.g. an array of errors, or nesting under a
  different key), this pass will not surface it — that is an intentional
  allowlist tradeoff (never emit arbitrary/unknown shapes), not a defect,
  but it means the next red run's summary may still be uninformative if the
  real shape differs from what was modeled here.
- This pass does not know, and does not claim to know, the actual
  provider-side cause of the `31169217048` red run. It only makes that cause
  legible in the next red job summary. The four providers' HTTP 400/400/404
  responses have not been re-diagnosed against the new formatter's output
  because doing so would require a live provider call, which was out of
  scope and not authorized for this pass.
- Biome's line-wrap preferences for long chained/ternary expressions had to
  be hand-matched exactly (no `pnpm lint --fix`/auto-fix was applied,
  consistent with keeping the diff minimal and inspectable); a future Biome
  version could reformat these lines differently.
- Anyone re-verifying this pass by editing these files with a similar
  tool chain should scan for stray control bytes with a force-text grep
  (the `-a` flag or equivalent) rather than a default one, given the false
  "clean" result this pass hit partway through (see Failed checks).

## Pass 1 final status

**Offline-complete.** The diagnostic formatter, its 13 new offline tests,
and this log are ready for independent verification. Focused tests, full
suite, lint, and build are all green on the current tree; `git diff --check`
is clean; the changed-file set is exactly the two intended source files.
No commit, push, GitHub, workflow, provider, Docker-runtime, or
runtime-data action was taken. This pass does **not** claim the scheduled
`contract-nightly` run is fixed or that a future scheduled run will be
green — it only makes the next red run's provider-error job summary
diagnosable. The Lead/Integrator should read this log, review the diff, and
decide whether to commit/push and request a fresh independent verification
pass before relying on the diagnostic output against a real red run.

## Correction pass 2 — overlapping secrets and full control range

### Trigger and implementation history

The first independent verifier returned `REQUEST_CHANGES` for two concrete
diagnostic-safety defects in pass 1:

1. configured secrets were replaced sequentially in provider-definition
   order, so a shorter secret contained in a longer secret could be replaced
   first and expose the longer secret's suffix; and
2. control normalization covered C0 and DEL but omitted the C1 range.

The verifier also corrected pass 1's `nightly.ts` numstat from the previously
misstated `106/3` changed-line total to the literal `103/3`
insertions/deletions. A Sonnet 5 / high correction session implemented the
source and test changes below. That session and a bounded continuation both
lost their API connection before completing this evidence section. Per the
owner's escalation order, Opus / max was attempted and also lost its
connection; Fable / max was attempted next and was unavailable because its
account had no usage credits. The owner then authorized a fresh GPT-5.6 Sol /
ultra verification. Sol independently approved the corrected source and
requested only that this missing correction record and the stale `PROGRESS.md`
counts be reconciled before acceptance.

### Corrections made

- `packages/gateway/src/contracts/nightly.ts` now discovers every occurrence
  of every nonempty configured secret against the original untouched scalar.
  It sorts and merges the resulting half-open spans, including containment,
  adjacency, arbitrary cross-secret overlap, and self-overlap, then renders a
  deterministic redaction marker for each merged span. Replacement order can
  no longer destroy a later match or expose an overlap fragment.
- Because this redactor is shared by every `safeError` branch, generic
  `Error` dispatch and base-message construction remain unchanged while a
  generic message containing overlapping configured secrets now receives the
  same complete redaction instead of the legacy partial-suffix result.
- The same file now treats C0 code points, DEL, and every C1 code point from
  decimal 128 through 159 as controls before whitespace collapse. The numeric
  implementation avoids embedding raw control bytes in source.
- `packages/gateway/src/contracts/nightly.test.ts` adds three offline
  regressions to pass 1's 13 diagnostic tests: a shorter configured key
  contained in a longer cross-provider key, two arbitrarily overlapping
  cross-provider keys, and the complete C1 range constructed programmatically.
  The diagnostic block therefore contains 16 new tests in total.
- No provider pin, endpoint, request shape, adapter, workflow trigger,
  authority document, README, registry, runtime data, or secret changed.

Final tracked numstat against `3c330a8`:

- `packages/gateway/src/contracts/nightly.ts`: 157 insertions, 7 deletions;
- `packages/gateway/src/contracts/nightly.test.ts`: 424 insertions,
  0 deletions; and
- `PROGRESS.md`: 7 insertions, 6 deletions after the final evidence-only
  reconciliation of its authoritative current-state fields.

The implementation and independent verifier records remain new untracked
evidence files until the branch is committed.

### Final offline verification

The fresh GPT-5.6 Sol / ultra recheck independently executed the following on
the corrected tree:

1. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
   — 2 files and 31/31 tests passed.
2. `pnpm test` — 69 files and 890/890 tests passed.
3. `pnpm lint` — 185 files checked with no fixes or errors.
4. `pnpm --filter @promptgate/gateway build` — the gateway TypeScript build,
   packaged-data copy, and scripts type-check passed.
5. Source and compiled adversarial harnesses exercised all configured secrets,
   containment, arbitrary overlap, self-overlap, adapter setup, both modes,
   all 65 C0/DEL/C1 code points, generic and unknown errors, hostile and cyclic
   bodies, and the exact 1,000-character total cap; every assertion passed.
6. Raw C0/DEL and C1 scans of every changed source/evidence file returned no
   matches; `git diff --check` passed; the protected-path and scope audits were
   clean.

No repository-driven provider/GitHub network operation, live provider call,
workflow trigger, Docker action, credential access, commit, push, registry
mutation, or runtime-data operation occurred during implementation or
verification. All adversarial credentials were synthetic literals.

### Successful checks

- Both verifier-reproduced security defects are resolved in source and
  compiled output.
- Focused tests: 31/31.
- Full suite: 890/890 across 69 files.
- Lint: 185 files clean.
- Gateway build, adversarial probes, raw-byte scans, diff check, and scope
  audit: clean.

### Failed checks and causes

- Pass 1's independent review failed the overlapping-secret and C1 contracts;
  the causes and corrections are recorded above.
- Two Sonnet evidence-completion sessions and the Opus escalation lost their
  API connections. Fable could not start because usage credits were
  unavailable. These were agent-service failures after the source correction,
  not repository test, build, or runtime failures.
- The first Sol / ultra recheck returned `REQUEST_CHANGES` for evidence only:
  this correction section was absent and `PROGRESS.md` retained pass 1's
  counts. The source itself passed every recheck.
- The next final evidence review found two further wording defects: the
  authoritative `PROGRESS.md` header still described the pre-merge August 6
  state, and the pass-1 statement that every non-`ProviderError` behavior was
  unchanged overlooked the correction's shared redactor. The header now names
  merged PR #13, exact merge `3c330a8`, red scheduled run `31169217048`, the
  diagnostic branch, and the current 890-test gate. The behavioral statement
  now distinguishes unchanged generic dispatch/base-message construction from
  intentionally stronger overlap-safe redaction across every error branch.
- The first explicit staging pass then made the previously untracked evidence
  files visible to `git diff --cached --check` and exposed three trailing
  spaces used as Markdown hard breaks in the first verifier record's header.
  Those three spaces were removed without changing any factual text; the
  complete staged diff was rechecked before commit.

### Residual risks

- Redaction and normalization inspect each full scalar before the 200-code-unit
  field slice; work is proportional to input length, though provider response
  limits bound the normal upstream source.
- UTF-16 slicing can split a supplementary scalar at a field or total bound.
  This does not bypass redaction or the cap but can leave a lone surrogate in
  diagnostic text.
- The deliberately conservative one-level scalar allowlist will not expose a
  future provider's differently nested or non-scalar diagnostic envelope.
- This pass makes a future live failure safely diagnosable; it does not identify
  or fix the provider-side causes of scheduled run `31169217048` and does not
  claim any green scheduled run.

### Pass 2 final status

**Offline-complete and ready for a fresh evidence recheck.** The source
correction is independently proven green, the implementation and progress
records now describe the corrected tree, and no product/test change remains
requested. Publication and any diagnostic-only live workflow remain pending a
fresh independent `APPROVE` of these evidence corrections.
