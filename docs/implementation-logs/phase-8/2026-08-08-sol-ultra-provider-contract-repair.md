# Phase 8 — Provider contract repair (GPT-5.6 Sol Ultra implementation log)

Date: 2026-08-08
Implementer: fresh GPT-5.6 Sol / ultra replacement authorized by the project owner
Base: protected `master` at `340dbce86c23662f7bc2aec206b1ca81ffc36380`
Status: **CORRECTION PASS 3 OFFLINE-COMPLETE — fresh independent recheck required**

## Scope and constraints

This pass repairs only the provider-contract behavior proven by the supplied
diagnostic-only workflow run `31230468869` and adds the narrow diagnostic needed
to distinguish the remaining Gemini HTTP 404. It does not repair or reinterpret
Anthropic's account-credit failure.

The pass made no commit, push, workflow invocation, provider request, credential
read, Docker action, registry mutation, database/runtime-state operation, or
deployment. It did not alter `PromptGate_PROJECT_IDEA.md`, either authority
specification, the workflow YAML, provider adapters, provider pins/endpoints,
the original or ignored-clone `web_builder_llm` repository, registry versions,
labels, key limits, secrets, persistent data, README, or Phase 8 evidence.

## Plan review before implementation

I read `../AGENTS.md` completely, then reviewed `BUILD_PLAYBOOK.md`,
`IMPLEMENTATION_GUIDE.md`, `ORCHESTRATOR.md`, the locked project idea,
`PROGRESS.md`, the nightly workflow, shared request schema, complete nightly
runner and tests, current Phase 8 evidence, all five preceding nightly
diagnostics records, relevant provider/fetch/error seams, and current Git state.

The proposed OpenAI correction is the smallest authority-compliant design:

- The live diagnostic proved that Luna rejects `max_tokens` and requires
  `max_completion_tokens` in both modes.
- The nightly caller now chooses the output-limit field by provider. OpenAI
  receives exactly `max_completion_tokens: 64`; Anthropic, Gemini, and DeepSeek
  retain exactly `max_tokens: 64`.
- Both modes continue to use one shared request builder, so they cannot drift.
- `ChatRequestSchema` is deliberately loose and retains unknown compatible
  fields. Adding first-class shared-schema support would unnecessarily raise
  precedence, validation, and budget-reservation semantics outside this repair.
- Rewriting `openai.ts` or the compatible core would violate the guide's pure
  OpenAI passthrough rule and change ordinary client requests. No adapter or
  shared-schema change is warranted.
- Anthropic must retain `max_tokens`; removing it would make its translator use
  the 1,024-token default instead of the contract's 64-token ceiling.

The original Gemini proposal needed one narrowing. A permanent model-list GET
on every schedule would add an unnecessary third scheduled provider request and
change the evidence surface. Instead, the model-list preflight runs only when
`GITHUB_EVENT_NAME` is exactly `workflow_dispatch`. A scheduled evidence run,
local invocation, or missing Gemini credential sends no diagnostic request.
The manual-only preflight uses one GET, consumes no generation tokens, runs
before the two required Gemini modes, and does not change provider/suite
pass/fail status or substitute for scheduled evidence.

The preflight reports only HTTP status, model count, exact pinned-target
presence, and the existing allowlisted scalar error fields. It never reports a
raw body, response header, credential, or model ID/list. Existing overlap-safe
configured-secret redaction, control normalization, 200-unit field caps, and
the 1,000-unit total cap apply. Malformed, non-JSON, hostile, or rejected
metadata produces bounded `unknown` values rather than arbitrary error text;
cyclic bodies remain shallow and may retain a reachable allowlisted scalar, as
the regression intentionally demonstrates with `message=safe cyclic message`.

No material authority conflict was found, and no authority-document amendment
is required: the scheduled four-provider/two-mode gate is unchanged, OpenAI
passthrough remains pure, the pinned models/endpoints remain fixed, and manual
dispatch remains diagnosis rather than evidence.

## Work completed

### OpenAI nightly request repair

- Made the nightly request builder provider-aware.
- OpenAI complete and stream requests now contain only
  `max_completion_tokens: 64`.
- Anthropic, Gemini, and DeepSeek complete and stream requests remain on only
  `max_tokens: 64`.
- Kept the common prompt, model pins, call counts, schemas, stream terminal
  rules, adapters, retry behavior, and suite policy unchanged.

### Manual-only Gemini model-list preflight

- Added one injected-fetch GET to Google's documented OpenAI-compatible models
  endpoint, gated strictly to `workflow_dispatch` plus a configured Gemini key.
- The safe result carries `http_status`, `model_count`, and `target_present`,
  plus only existing allowlisted scalar error fields when available.
- Added a clearly labeled manual-diagnostics section to the job summary stating
  that it neither changes pass/fail nor substitutes for scheduled evidence.
- Kept scheduled runs and zero/missing-credential behavior provider-call
  identical to the merged base.

### Offline regressions

- Updated the existing all-provider/two-mode request-shape test to assert the
  exact OpenAI field and absence of `max_tokens`, and the exact inverse for the
  other three providers.
- Added six Gemini diagnostic tests covering one manual-only request, exact
  URL/method/auth/no-body shape, target present, target absent without model-list
  disclosure, scheduled-event suppression, allowlisted/redacted errors,
  non-JSON/cyclic/hostile bodies, and a fixed safe fetch-rejection result.

## Files changed

- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `docs/implementation-logs/phase-8/2026-08-08-sol-ultra-provider-contract-repair.md`
- `PROGRESS.md` (truthful current-position/session record only)

## Files inspected

- `../AGENTS.md`
- `BUILD_PLAYBOOK.md`
- `IMPLEMENTATION_GUIDE.md`
- `ORCHESTRATOR.md`
- `PromptGate_PROJECT_IDEA.md` (read-only)
- `PROGRESS.md`
- `.github/workflows/contract-nightly.yml`
- `packages/shared/src/wire/chat-request.ts`
- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-workflow.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/providers/gemini.ts`
- `packages/gateway/src/providers/openai-compatible.ts`
- `packages/gateway/src/providers/provider-error.ts`
- `packages/gateway/src/providers/retry.ts`
- `packages/gateway/src/providers/types.ts`
- `docs/evidence/phase-8.md` (current nightly section)
- all five `2026-08-07-*nightly-diagnostics*.md` implementation/verifier records
- root and gateway package/build configuration plus current Git status/log/diff

## Verification commands and results

1. Focused runner/workflow gate:

   `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`

   Final result: 2 files, **37/37 tests passed**.

2. Full repository test gate:

   `pnpm test`

   Result: 69 files, **896/896 tests passed**.

3. Lint:

   `pnpm lint`

   Final result: **185 files checked**, no fixes or errors.

4. Gateway build:

   `pnpm --filter @promptgate/gateway build`

   Result: TypeScript compilation, packaged data copy, and scripts type-check
   passed.

5. Full workspace build:

   `pnpm build`

   Result: shared, dashboard, evals, and gateway builds passed.

6. Scope, whitespace, raw-control, credential-pattern, and protected-path
   checks:

   - `git diff --check` passed.
   - Before this log/progress update, the product diff was exactly the two
     intended nightly source/test files (`nightly.ts` 176/19 and
     `nightly.test.ts` 232/1 insertions/deletions).
   - Raw C0/DEL/C1 scans found no forbidden code point in either edited source
     file.
   - The credential-pattern scan found only the pre-existing synthetic
     `sk-must-not-appear-1234567890` diagnostic-test literal, not a real key.
   - The protected-path diff was empty for the project idea, authority docs,
     workflow, README, shared package, provider adapters, pipeline, DB,
     registry, and Phase 8 evidence.

No command contacted a provider or GitHub workflow.

## Failed checks and causes

1. The first focused run had 36 passes and one failure. The scheduled-event
   regression correctly proved no diagnostic fetch occurred, but the result
   object still owned `diagnostic: undefined`. The cause was unconditional
   object construction, not a provider-call leak. The two configured-result
   constructors now conditionally omit the property when no diagnostic ran;
   the final focused gate passed 37/37.
2. The first lint run reported only Biome line-wrapping differences in the two
   edited files. The exact suggested formatting was applied by hand without a
   logic change; the final lint gate passed clean.

No product test, full-suite test, TypeScript build, workspace build, scope,
secret-safety, raw-control, or protected-path check remained red.

## Known risks and limitations

- `max_completion_tokens: 64` includes Luna reasoning tokens. A later live run
  could still produce insufficient visible text. This pass does not raise the
  cap or add reasoning controls without evidence.
- The Gemini preflight deliberately performs no retry: one manual diagnostic
  dispatch produces exactly one no-generation GET. A network failure reports
  unknowns and requires another explicitly authorized diagnostic decision.
- Target presence uses the documented OpenAI-compatible `data[].id` and exact
  pinned model string. A different response shape reports unknown/absent rather
  than printing or guessing from the model list.
- The complete upstream JSON value is parsed in memory before the bounded safe
  summary is formed. Output disclosure is capped, but work remains proportional
  to the provider response size, as in the existing adapter error-body path.
- The Anthropic failure is operational, not a source defect: the account behind
  the configured credential still needs sufficient API credit before a green
  live contract can exist.
- Gemini's actual GitHub-key/project/model visibility remains unproven until an
  authorized manual dispatch runs this preflight. No key replacement, endpoint
  change, or model-pin change is justified by the current bare 404 alone.

## Pass 1 final status (superseded by the correction pass below)

**OFFLINE-COMPLETE — independent verification required.** The minimal OpenAI
nightly contract repair and manual-only safe Gemini preflight are implemented.
Focused and full tests, lint, gateway/full builds, and scope/security checks are
green. No live provider success, green scheduled run, or repaired Anthropic
account is claimed. The Lead/Integrator should obtain a fresh read-only audit
before committing, publishing, or authorizing another diagnostic workflow.

## Correction pass 2 — hostile metadata snapshots and redirect fail-closed

### Trigger

The first fresh independent Sol / ultra verifier approved the provider-specific
token-limit repair and ordinary manual-only preflight behavior, but returned
`REQUEST_CHANGES` for three concrete diagnostic-safety defects:

1. `response.status` was read repeatedly, so a changing getter could pass the
   checks and emit an unvalidated later value;
2. a hostile array Proxy's `length` was read outside the catch boundary and was
   not validated, so it could throw out of the suite or emit arbitrary text;
3. omitted fetch redirect policy inherited `follow`, so one injected fetch
   invocation did not strictly guarantee one HTTP GET.

The verifier's compiled probes demonstrated URL-bearing arbitrary status/count
output and a thrown suite. Its complete record is
`docs/implementation-logs/phase-8/2026-08-08-verifier-sol-ultra-provider-contract-repair.md`.

### Corrections made

- `response.status` is snapshotted exactly once inside `try/catch`. Only a
  numeric safe integer from 100 through 599 is emitted; every throw, changing
  later value, string, non-safe number, or out-of-range value becomes
  `http_status=unknown`.
- `data.length` is snapshotted exactly once inside `try/catch`. Only a numeric
  nonnegative safe integer is emitted; every throw or invalid value makes both
  count and target presence unknown.
- Target inspection uses caught `Object.keys` plus bounded canonical numeric
  indexes rather than the array iterator, so it does not reread hostile
  `length`. A throwing Proxy traversal/index/field read is contained and retains
  only the already validated count with unknown target presence.
- The one manual diagnostic fetch now sets `redirect: "error"`. Redirects fail
  closed instead of following to another GET; no retry was added.
- Two new table-driven tests cover throwing, arbitrary, and changing status;
  throwing, arbitrary, and changing length; throwing Proxy traversal; one-read
  assertions; no synthetic URL leakage across result/report/summary; unchanged
  suite accounting; and exact `redirect: "error"` request policy.
- The earlier cyclic-body wording is corrected above: the shallow allowlist may
  safely emit a reachable scalar from a cyclic object rather than forcing all
  cyclic inputs to unknown.

No model pin, endpoint, adapter, shared schema, workflow, authority document,
README, registry, runtime data, key, label, secret, provider traffic, or
scheduled evidence behavior changed.

### Correction verification

1. Focused nightly/workflow gate:

   `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`

   Final result: **39/39 passed** across 2 files.

2. Full repository gate:

   `pnpm test`

   Final result: **898/898 passed** across 69 files.

3. `pnpm lint` — **185 files checked**, no fixes or errors after one mechanical
   line-wrap correction requested by Biome.
4. `pnpm --filter @promptgate/gateway build` — passed.
5. `pnpm build` — all four workspace package builds passed.
6. A no-network compiled-output adversarial harness exercised changing and
   throwing status, changing/arbitrary/throwing length, throwing Proxy
   traversal, summary/report/result URL scans, suite accounting, and the exact
   redirect option. It exited 0 with:

   `{"statusReads":1,"lengthReads":1,"redirect":"error","cases":5,"suiteOk":true}`

7. The final product diff against `340dbce` is exactly:

   - `packages/gateway/src/contracts/nightly.ts`: 203 insertions, 19 deletions;
   - `packages/gateway/src/contracts/nightly.test.ts`: 361 insertions, 1 deletion.

   The test delta is exactly eight nightly tests over the merged base, yielding
   35 nightly test declarations plus four unchanged workflow declarations.

Final raw-control, credential-pattern, whitespace, protected-path, and complete
scope checks are recorded after the evidence reconciliation below; none invokes
GitHub, a provider, Docker, a credential, registry/database/runtime state, or
the dogfood application.

### Failed checks and causes

- The first independent verifier's hostile-length/status and redirect probes
  failed for the three source causes recorded under Trigger. All received
  discriminating regressions and now pass in source tests and compiled output.
- The first correction-pass lint run found one formatter-only line wrap in the
  new table-driven length regression. It was changed exactly as Biome requested;
  the final lint run passed.
- No focused/full test, TypeScript build, workspace build, compiled corrected
  adversarial probe, or provider-contract assertion remains red.

### Residual risks

- JSON body allocation remains proportional to the upstream model-list response
  size before the safe summary is formed; this pre-existing class of bounded
  diagnostic input cost was explicitly left outside the verifier's requested
  repair.
- A valid but extremely large safe array length is reported as metadata. Target
  inspection enumerates actual own keys rather than looping to that length, so
  the count cannot force a length-sized scan.
- The diagnostic deliberately performs no redirect, retry, or pass/fail change.
  A redirect/network failure produces fixed unknown metadata and requires a
  later explicit diagnostic decision.
- Anthropic credit and Gemini live visibility remain external closure facts; no
  live success is claimed.

### Final evidence reconciliation checks

- `git diff --check` passed.
- The final tracked numstat is `PROGRESS.md` 9/6,
  `nightly.test.ts` 361/1, and `nightly.ts` 203/19. The only untracked files
  are this required implementation record and the first independent verifier
  record.
- Source inspection finds exactly one `data.length` read, exactly one
  `response.status` read, and explicit `redirect: "error"`.
- Raw C0/DEL/C1 scans of every changed source/evidence file returned no match.
- The credential-pattern scan found only the pre-existing disclosed synthetic
  diagnostic literal; no real key-like value was introduced.
- The protected-path diff is empty for the project idea, authority documents,
  workflow, README, shared package, provider adapters, pipeline, DB, registry,
  and Phase 8 evidence.

## Final status after correction pass 2

**OFFLINE-COMPLETE — fresh independent recheck required.** Both verifier-found
metadata-boundary defects and the redirect rail are corrected with
discriminating source tests and a passing compiled adversarial harness. Focused
39/39, full 898/898, lint, gateway/full builds, and all completed safety/scope
checks are green. No commit, push, workflow/provider call, credential access,
runtime mutation, deployment, or green scheduled evidence occurred.

## Correction pass 3 — revoked-Proxy classification containment

### Trigger and plan review

The fresh final recheck in
`docs/implementation-logs/phase-8/2026-08-08-verifier-sol-ultra-provider-contract-repair-final.md`
returned `REQUEST_CHANGES`. It confirmed correction pass 2's status/length,
ordinary-Proxy, redirect, request-shape, disclosure, and accounting behavior,
but its compiled probe proved one remaining trust-boundary escape:
`Array.isArray(data)` throws for a revoked Array Proxy and still sat before the
existing catch. That exception rejected `runNightlyContracts` before provider
accounting returned.

The smallest compliant repair was to move array classification into the
complete model-list inspection boundary and retain the inner traversal boundary
that can preserve an already validated count. I also added caller-level
fail-closed defense around the summarizer so a future summary-only regression
cannot abort provider modes or alter suite accounting. This does not change the
manual-dispatch gate, fetch shape, scheduled behavior, provider adapters,
models/endpoints, pass/fail policy, or disclosure allowlist. No material
authority conflict or wider source change was found.

### Work completed

- Enclosed body `data` access, `Array.isArray`, the single validated length
  snapshot, and traversal in one outer catch that returns unknown metadata.
- Retained the narrower traversal catch, which returns a validated count with
  unknown target presence when only own-key/index inspection fails.
- Added caller-level catch defense around `summarizeGeminiModelList`.
- Added a discriminating revoked Array Proxy regression. It proves
  `runNightlyContracts` resolves, both Gemini modes run once and pass, suite
  accounting remains configured/passed/failed/skipped `1/1/0/0`, the diagnostic
  is exactly `model_count=unknown target_present=unknown`, and no revoked-Proxy
  exception text reaches result, reports, or rendered summary.
- Reconciled `PROGRESS.md` with both verifier rejections, correction pass 3,
  current counts, the transient full-suite rerun, and fresh-recheck status.

### Verification commands and results

1. Focused nightly/workflow tests passed **40/40** across two files.
2. The first full-suite run reported one failure in the pre-existing gateway
   SIGTERM/checkpoint durability test. The exact test passed **1/1** immediately
   in isolation, and the clean authoritative full rerun passed **899/899**
   across 69 files.
3. `pnpm lint` checked **185 files** with no fixes or errors.
4. The gateway build passed.
5. The full four-package workspace build passed.
6. A no-network compiled-output harness covered a revoked Array Proxy, revoked
   body, revoked nested error, changing status, and changing length using only
   injected fetch and fake adapters. It exited 0 with:

   `{"cases":5,"revokedArrayResolved":true,"suiteOk":true,"statusReads":1,"lengthReads":1,"redirect":"error","noLeak":true}`

7. `git diff --check` passed. The final tracked numstat is `PROGRESS.md`
   10/6, `nightly.test.ts` 407/1, and `nightly.ts` 204/19. Source inspection
   still finds one `Array.isArray(data)`, one `data.length`, one
   `response.status`, and one explicit `redirect: "error"`, all at the intended
   caught/single-read boundary.

### Scope and security reconciliation

- Raw C0/DEL/C1 scanning returned no match. The value-redacted credential scan
  found only the previously disclosed synthetic diagnostic and overlap-test
  literals at their existing source/evidence lines; correction pass 3 adds no
  credential-like literal or diagnostic URL. The protected-path diff was empty
  for the project idea, authority documents, workflow, README, shared package,
  provider adapters, pipeline, DB, registry, and Phase 8 evidence.
- The only product files remain the nightly runner and its tests. `PROGRESS.md`,
  this implementation record, and both immutable verifier records are the only
  evidence/progress files in scope.
- No provider/network call, workflow trigger, credential read, runtime/database
  action, Docker action, deployment, commit, push, registry/label mutation, or
  dogfood traffic occurred.

### Final status after correction pass 3

**OFFLINE-COMPLETE — fresh independent recheck required.** The final verifier's
revoked-Proxy escape is contained with a discriminating source regression and
passing compiled adversarial harness. No live provider success, green scheduled
run, repaired Anthropic credit, or resolved Gemini visibility is claimed.
