# Phase 8 — Provider contract repair final independent recheck

Date: 2026-08-08
Verifier: fresh GPT-5.6 Sol / ultra independent verification agent
Base: protected `master` at `340dbce86c23662f7bc2aec206b1ca81ffc36380`
Final status: **REQUEST_CHANGES**

## Review scope and constraints

I independently rechecked the complete corrected, uncommitted Phase 8
provider-contract repair. I read `../AGENTS.md` through EOF, the relevant
authority chain, the complete implementation record, the initial
`REQUEST_CHANGES` verifier record, `PROGRESS.md`, every current diff, and the
nightly runner's shared-schema, adapter, CLI, and workflow boundaries.

This record is my only repository write. I made no source, test, progress,
authority, workflow, Phase 8 evidence, runtime, database, registry, deployment,
dogfood, credential, provider, or network change. I made no commit, push, or
workflow invocation. Every transport probe used an injected offline fake.

## Files inspected

- `../AGENTS.md`
- `ORCHESTRATOR.md`
- `BUILD_PLAYBOOK.md` (provider rules and Phase 8 in full)
- `IMPLEMENTATION_GUIDE.md` (provider, contract-nightly, testing, and security
  sections)
- `PromptGate_PROJECT_IDEA.md` (read-only)
- `PROGRESS.md`
- `docs/implementation-logs/phase-8/2026-08-08-sol-ultra-provider-contract-repair.md`
- `docs/implementation-logs/phase-8/2026-08-08-verifier-sol-ultra-provider-contract-repair.md`
- `.github/workflows/contract-nightly.yml`
- `packages/shared/src/wire/chat-request.ts`
- `packages/gateway/src/contracts/{nightly,nightly.test,nightly-workflow.test,nightly-cli}.ts`
- `packages/gateway/src/providers/{openai,openai-compatible,openai-compatible-stream,anthropic,anthropic-stream,anthropic-translate,gemini,deepseek,retry,types}.ts`
- the complete tracked diff and Git state/history against `340dbce`

## Blocking finding — a revoked Array Proxy still escapes the diagnostic boundary

The prior status, length, ordinary Proxy traversal, and redirect defects are
corrected, but `summarizeGeminiModelList` still invokes `Array.isArray(data)`
outside a catch boundary at
`packages/gateway/src/contracts/nightly.ts:302`. JavaScript throws from
`Array.isArray` when its operand is a revoked Proxy. That exception escapes
`runGeminiModelListDiagnostic`, rejects `runNightlyContracts`, and prevents the
suite from returning provider accounting or running the required Gemini modes.

I reproduced this against the freshly built compiled output with a passing
Gemini adapter and an injected response whose JSON body contained a revoked
Array Proxy at `data`:

```text
{"resolved":false,"name":"TypeError","message":"Cannot perform 'IsArray' on a proxy that has been revoked"}
```

This is a direct remaining violation of the requested hostile-Proxy
containment and diagnostic non-interference contract. It also disproves the
implementation/`PROGRESS.md` statements that hostile traversal is fully
contained and every such diagnostic preserves suite accounting. The narrow
repair is to place the array-classification operation inside the same
fail-closed boundary and add a compiled/regression case for a revoked array
Proxy. This verifier did not implement that repair.

## Successful verification

### Prior blocker reproductions

The focused table-driven regressions and an independent compiled probe now
pass the original defects:

- throwing, arbitrary, and changing `response.status` are read exactly once;
  only a validated 100–599 safe integer is emitted;
- throwing, arbitrary, and changing `data.length` are read exactly once; only
  a nonnegative safe integer is emitted;
- throwing `ownKeys` and array-index getter traps retain only validated count
  metadata and produce `target_present=unknown`;
- thrown/URL-bearing content does not survive in result, report, or rendered
  summary surfaces; and
- these corrected cases retain configured/passed/failed/skipped accounting of
  `1/1/0/0` and `ok=true`.

The independent compiled probe ended with:

```text
{"statusReads":1,"statusCases":3,"lengthReads":1,"lengthCases":3,"proxyTraversalCases":2,"noLeak":true,"accounting":true}
```

The explicit request policy is `redirect: "error"`. The diagnostic uses no
retry wrapper, and injected 302/503/rejection paths make one fetch invocation
without changing provider pass/fail accounting. The direct event/request probe
confirmed exact `workflow_dispatch` gating, zero calls for schedule, push,
missing event, a near-match event, and a missing Gemini key, plus exactly one
manual GET, absent body, and refusal policy:

```text
{"nonManualCases":4,"missingKeyCalls":0,"manualCalls":1,"method":"GET","body":"absent","redirect":"error","passFailUnchanged":true}
```

### Provider token contracts and protected seams

A compiled real-adapter capture observed exactly eight transports: complete
and stream for OpenAI, Anthropic, Gemini, and DeepSeek. OpenAI carried exactly
`max_completion_tokens: 64` and no `max_tokens` in both modes. The other three
carried exactly `max_tokens: 64` and no `max_completion_tokens` in both modes,
including Anthropic after native translation. The capture ended with:

```text
{"transports":8,"openai":"max_completion_tokens-only","others":"max_tokens-only","endpoints":"pinned","bothModes":true}
```

The shared loose request schema preserves the OpenAI-only compatible field;
OpenAI passthrough remains pure; compatible streaming adds only its existing
stream/usage fields. The approved Luna, Sonnet, Gemini Flash, and DeepSeek V4
Flash pins and all four provider endpoints are unchanged. There is no diff in
the shared package, adapters, workflow, project idea, guide, playbook,
orchestrator, README, pipeline, database, registry, or Phase 8 evidence.

### Diagnostic disclosure and suite policy

Source inspection plus the green focused regressions confirm the ordinary
manual diagnostic emits only HTTP status, validated count, exact target
presence, and scalar `type`/`code`/`param`/`status`/`message`. Existing
configured-secret span-union redaction, 200-unit field caps, 1,000-unit total
cap, and C0/DEL/C1 normalization remain active. Tests prove raw bodies,
unknown fields, details, headers, credentials, and enumerated model IDs are not
disclosed; ordinary repeated inputs are deterministic. The diagnostic property
is omitted when it does not run and remains excluded from provider/suite
status calculations.

Named `SKIPPED` behavior for missing keys, configured-provider red behavior,
zero-configured-provider red behavior, independent complete/stream execution,
terminal usage rules, and the summary warning that manual diagnostics do not
substitute for scheduled evidence remain intact.

## Verification commands and outcomes

- Focused nightly/workflow tests — **39/39 passed** across 2 files.
- Full repository tests — **898/898 passed** across 69 files.
- `pnpm lint` — **185 files checked**, no fixes or errors.
- Gateway build — passed.
- Full four-package workspace build — passed.
- Compiled real-adapter eight-transport capture — passed.
- Compiled status/length/ordinary-Proxy/no-leak/accounting probe — passed.
- Compiled manual/schedule/missing-key/near-match/request-shape probe — passed.
- Compiled revoked-Proxy probe — **failed**, with the exact escaping TypeError
  recorded above.
- `git diff --check` — passed before this record.
- Raw C0/DEL/C1 scan across every changed source/evidence file — no match.
- Credential-pattern scan — only the previously disclosed synthetic
  `sk-must-not-appear-1234567890` and overlap-test literals.
- Source read-count scan — exactly one `data.length` read, one
  `response.status` read, and one explicit `redirect: "error"` option.

Before this record, the tracked numstat was exactly:

```text
9   6   PROGRESS.md
361 1   packages/gateway/src/contracts/nightly.test.ts
203 19  packages/gateway/src/contracts/nightly.ts
```

The only pre-existing untracked files were the required implementation record
and initial independent verifier record.

## Failed checks and suspected causes

1. The substantive revoked-Proxy probe failed because `Array.isArray(data)` is
   the only model-list trust-boundary operation still outside a catch.
2. Two preliminary verifier harness attempts stopped on verifier-side helper
   defaults: passing `undefined` selected the helper's manual-event/default-key
   values rather than representing an absent property. Direct probes without
   those defaults passed and are the results recorded above.
3. One preliminary assertion used the synthetic one-character secret `k`; the
   fail-closed redactor correctly replaced that character inside the safe word
   `unknown`. Repeating with a representative non-overlapping synthetic secret
   passed. This was an invalid verifier expectation, not a product failure.

## Known risks and limitations

- Native `Response.json()` returns ordinary JSON rather than a Proxy, but the
  patch and requested audit explicitly claim safety for hostile injected trust
  boundary values. The escaping case therefore remains a blocker rather than a
  production-likelihood waiver.
- JSON allocation remains proportional to the upstream model-list response
  before safe summarization, as already disclosed by the implementation.
- This offline review proves no repaired Gemini credential, live OpenAI
  success, Anthropic credit, or green schedule-triggered run.

## Final verdict

**REQUEST_CHANGES.** The OpenAI token-field repair, exact other-provider token
fields, ordinary manual-only event/request policy, original hostile
status/length/Proxy corrections, disclosure bounds, and suite policy are
otherwise sound. A revoked Array Proxy still aborts the entire suite at the
unprotected `Array.isArray` call. Contain that single operation, add a
discriminating regression, reconcile the overbroad implementation/progress
claims, rerun the complete offline gates, and obtain one fresh independent
recheck before commit or publication.
