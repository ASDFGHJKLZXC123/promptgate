# Phase 8 — Provider contract repair independent verification

Date: 2026-08-08
Verifier: fresh GPT-5.6 Sol / ultra independent verification agent
Base: protected `master` at `340dbce86c23662f7bc2aec206b1ca81ffc36380`
Final status: **REQUEST_CHANGES**

## Review scope and constraints

I independently reviewed the complete uncommitted provider-contract repair and
its evidence. I read `../AGENTS.md` through EOF, the relevant authority chain,
`PromptGate_PROJECT_IDEA.md` read-only, the full implementation record, the
complete `PROGRESS.md` diff, Git state/history, every changed source/test line,
the nightly CLI/workflow boundary, shared request schema, and all provider
adapters involved in the two contract modes.

This record is my only repository write. I made no source, test, progress,
authority, workflow, evidence, runtime, database, registry, deployment, or
dogfood change. I made no commit, push, workflow trigger, credential read, or
provider/external-network call. All adversarial values were synthetic and all
transport probes used injected in-process fakes.

## Files inspected

- `../AGENTS.md`
- `ORCHESTRATOR.md`
- `BUILD_PLAYBOOK.md` (Phase 8 in full)
- `IMPLEMENTATION_GUIDE.md` (provider, dogfood, testing, and security sections)
- `PromptGate_PROJECT_IDEA.md` (read-only)
- `PROGRESS.md`
- `docs/implementation-logs/phase-8/2026-08-08-sol-ultra-provider-contract-repair.md`
- `docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-final-recheck.md`
- `.github/workflows/contract-nightly.yml`
- `packages/shared/src/wire/chat-request.ts`
- `packages/shared/src/wire/strip-pg-fields.ts`
- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-workflow.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/providers/{openai,openai-compatible,openai-compatible-stream,anthropic,gemini,deepseek,retry}.ts`

## Findings

### Blocking 1 — hostile model metadata can escape the safety boundary, leak arbitrary output, or abort the suite

`summarizeGeminiModelList` checks `Array.isArray(data)`, then reads
`data.length` outside its guarded block at
`packages/gateway/src/contracts/nightly.ts:302-305`. The value is not validated
as a safe integer. A hostile array Proxy can therefore:

- throw from `length`, escaping `runGeminiModelListDiagnostic` and rejecting the
  entire `runNightlyContracts` call before provider accounting completes; or
- return an arbitrary string, which is emitted verbatim as `model_count`.

The compiled-path reproducer with a throwing `length` getter returned:

```text
{"resolved":false,"name":"Error","message":"hostile-length"}
```

The compiled-path reproducer with an arbitrary `length` value returned:

```text
http_status=200 model_count=not-a-safe-integer https://unexpected.invalid target_present=false
```

This violates the required safe-integer count, hostile-input safety, no-URL
leak, deterministic-output boundary, and the rule that a diagnostic cannot
affect the provider contract result. The committed hostile-body test only makes
the containing object's `data` getter throw; it does not exercise a hostile
array or length value and therefore does not detect this path.

The same class of defect exists for HTTP status at
`packages/gateway/src/contracts/nightly.ts:339-345`: `response.status` is read
four times rather than snapshotted once. A changing getter can pass the first
three checks and return an unvalidated fourth value. The compiled probe
produced:

```text
{"reads":4,"diagnostic":"http_status=https://status-leak.invalid model_count=unknown target_present=unknown"}
```

The preflight must snapshot each untrusted value once inside a catch boundary,
validate it, and fall back to `unknown` without rejecting the suite or emitting
arbitrary values. Discriminating regressions are required for throwing and
non-safe `status`/`length` access.

### Blocking 2 — the implementation does not strictly guarantee exactly one HTTP GET

The model-list fetch at `packages/gateway/src/contracts/nightly.ts:325-333`
does not set a redirect policy. Production uses `globalThis.fetch`, whose
default request redirect mode is `follow`; the local no-network check
`new Request(..., {method: "GET"}).redirect` returned `follow`. A redirect can
therefore cause more than one HTTP GET even though the injected fetch function
is invoked once. This contradicts the explicit one-GET rail and is not covered
by the current call-count test.

The diagnostic request should fail closed on redirects (for example, an
explicit non-following redirect policy) and have an offline regression that
asserts that request option. The existing adapter retry behavior must remain
unrelated and unchanged.

### Evidence mismatch

The implementation record at lines 56-61 says hostile responses produce
bounded `unknown` values and never report arbitrary/model-list data. The two
compiled reproductions above disprove that claim. `PROGRESS.md` likewise calls
the preflight safe and offline-green. Those claims must be corrected or
re-established after the source defects receive regressions and the complete
gate is rerun. The record's broader statement that cyclic responses always
produce unknowns is also too broad: its own committed cyclic test intentionally
emits the allowlisted scalar `message=safe cyclic message`.

## Successful verification

### Provider request-field repair

An injected compiled-path capture used the real OpenAI, Anthropic, Gemini, and
DeepSeek adapters and forced a safe synthetic HTTP 400 after request capture.
It observed exactly eight adapter transports: one complete and one stream per
provider.

- OpenAI complete and stream each contained exactly
  `max_completion_tokens: 64` and no `max_tokens`.
- Anthropic complete and stream each contained exactly `max_tokens: 64` and no
  `max_completion_tokens` after native translation.
- Gemini and DeepSeek complete and stream each contained exactly
  `max_tokens: 64` and no `max_completion_tokens`.
- OpenAI remained pure passthrough; streaming added only the existing
  `stream: true` and `stream_options.include_usage: true` behavior.

The captured URLs remained the pinned OpenAI Chat Completions, Anthropic
Messages, Gemini OpenAI-compatible Chat Completions, and DeepSeek Chat
Completions endpoints. Pins remained Luna, Sonnet, Gemini 2.5 Flash, and
DeepSeek V4 Flash.

### Normal preflight and policy paths

Independent compiled probes confirmed the intended ordinary behavior:

- exact `workflow_dispatch` plus configured Gemini key makes one injected GET
  with method GET, official `/v1beta/openai/models` URL, Bearer auth, JSON
  accept header, no request body, then still runs one complete and one stream;
- schedule, push, absent event, and near-match `workflow_dispatch ` make zero
  diagnostic fetch calls and own no `diagnostic` result property;
- a missing Gemini key makes zero diagnostic fetch calls and remains named
  `SKIPPED`;
- ordinary success, empty list, empty body, non-JSON body, provider error, and
  fetch rejection produce bounded summaries;
- an injected 503 produces one fetch invocation only (no application retry)
  and does not change an otherwise passing provider result;
- repeated ordinary inputs produce byte-identical diagnostics;
- arbitrary-overlap secrets were fully redacted with no fragments surviving;
- all C0, DEL, and C1 values were removed from emitted diagnostics; and
- unknown error fields and model-list entries were not emitted.

The existing named-SKIPPED/configured-red/zero-configured-red accounting and
both provider modes remain intact. The diagnostic result is excluded from all
count/status calculations on non-hostile inputs and the summary explicitly
states that manual diagnostics do not substitute for scheduled evidence.

### Scope and protected artifacts

The tracked product diff is exactly:

```text
8   6   PROGRESS.md
232 1   packages/gateway/src/contracts/nightly.test.ts
176 19  packages/gateway/src/contracts/nightly.ts
```

Six tests were added, yielding 37 focused test declarations. Before this
record, the sole untracked file was the required Sol implementation record.
There is no diff in the project idea, guide, playbook, orchestrator, README,
workflow YAML, shared package, provider adapters, pipeline, database, registry,
or Phase 8 evidence. Raw-control scans found zero forbidden source code points.
The credential-pattern scan found only the pre-existing synthetic
`sk-must-not-appear-1234567890` test value, already disclosed by the
implementation record.

## Verification commands and outcomes

- `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
  — **37/37 passed** across 2 files.
- `pnpm test` — **896/896 passed** across 69 files.
- `pnpm lint` — **185 files checked**, no fixes or errors.
- `pnpm --filter @promptgate/gateway build` — passed.
- `pnpm build` — all four workspace package builds passed.
- Compiled real-adapter request capture — passed all eight provider/mode field
  assertions without external traffic.
- Compiled normal preflight matrix — passed success/error/empty/non-JSON,
  missing-key, event-gating, overlap-redaction, full-control-range,
  deterministic-output, accounting, and one injected-call assertions.
- Compiled hostile-array/status probes — **failed** with the exact escaping and
  arbitrary-output results recorded in Blocking 1.
- Redirect-policy inspection — **failed** the exact-one-HTTP-GET rail because
  the production request defaults to `redirect: "follow"`.
- `git diff --check` — passed.
- Git scope/protected-path, raw-control, and credential-pattern scans — passed
  except for the substantive source/evidence findings above.

## Failed checks and suspected causes

1. Hostile array length and status safety failed because untrusted properties
   are read outside or repeatedly across their validation boundary.
2. Exact-one-HTTP-GET failed because the fetch options omit an explicit
   non-following redirect policy.
3. Evidence truthfulness failed because the implementation/progress records
   describe these paths as safe before the adversarial cases were covered.

## Known risks and limitations

- This was an offline audit. It does not claim a repaired Gemini credential,
  live OpenAI success, a green scheduled run, or any provider-side result.
- Anthropic's insufficient-credit failure remains an external owner-side
  blocker and is not a source defect in this patch.
- The implementation's documented in-memory parsing cost remains proportional
  to the model-list response size; this review does not broaden the requested
  repair to introduce a response-size policy.

## Final verdict

**REQUEST_CHANGES.** The provider-specific token-limit repair is correct and
the ordinary manual-only gating/accounting behavior is sound, but the Gemini
preflight does not yet meet its hostile-input, safe-metadata, deterministic,
no-URL-leak, non-interference, or exact-one-GET contract. Fix only those narrow
defects, add discriminating offline regressions, reconcile the implementation
and `PROGRESS.md` claims, rerun the full gates, and obtain a fresh independent
recheck before commit or publication.
