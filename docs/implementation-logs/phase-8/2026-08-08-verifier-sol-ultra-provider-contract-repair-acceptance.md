# Phase 8 — Provider contract repair final acceptance audit

Date: 2026-08-08
Verifier: fresh GPT-5.6 Sol / ultra independent acceptance agent
Base: protected `master` at `340dbce86c23662f7bc2aec206b1ca81ffc36380`
Final status: **APPROVE**

## Review scope and constraints

I independently audited the complete uncommitted Phase 8 provider-contract
repair after correction pass 3. I read `../AGENTS.md` through EOF, the relevant
authority chain, every changed source/test/progress line, the implementation
record, both immutable `REQUEST_CHANGES` verifier records, and the shared
request, real-adapter, CLI, workflow, and retry boundaries.

This acceptance record is my only repository write. I did not modify source,
tests, progress, authority, workflow, evidence, README, runtime, database,
registry, deployment, dogfood state, keys, labels, or secrets. I made no commit,
push, workflow invocation, provider call, external-network request, credential
read, Docker action, or runtime/database operation. Every transport used by my
compiled probes was an injected in-process fake.

## Files inspected

- `../AGENTS.md`
- `ORCHESTRATOR.md`
- `BUILD_PLAYBOOK.md` (provider contracts and Phase 8 in full)
- `IMPLEMENTATION_GUIDE.md` (provider, dogfood, testing, and security sections)
- `PromptGate_PROJECT_IDEA.md` (read-only)
- `PROGRESS.md`, including its complete current diff
- `docs/implementation-logs/phase-8/2026-08-08-sol-ultra-provider-contract-repair.md`
- `docs/implementation-logs/phase-8/2026-08-08-verifier-sol-ultra-provider-contract-repair.md`
- `docs/implementation-logs/phase-8/2026-08-08-verifier-sol-ultra-provider-contract-repair-final.md`
- `.github/workflows/contract-nightly.yml`
- `packages/shared/src/wire/chat-request.ts`
- `packages/shared/src/wire/strip-pg-fields.ts`
- `packages/gateway/src/contracts/nightly.ts`
- `packages/gateway/src/contracts/nightly.test.ts`
- `packages/gateway/src/contracts/nightly-workflow.test.ts`
- `packages/gateway/src/contracts/nightly-cli.ts`
- `packages/gateway/src/providers/types.ts`
- `packages/gateway/src/providers/provider-error.ts`
- `packages/gateway/src/providers/retry.ts`
- `packages/gateway/src/providers/openai.ts`
- `packages/gateway/src/providers/openai-compatible.ts`
- `packages/gateway/src/providers/openai-compatible-stream.ts`
- `packages/gateway/src/providers/anthropic.ts`
- `packages/gateway/src/providers/anthropic-translate.ts`
- `packages/gateway/src/providers/anthropic-stream.ts`
- `packages/gateway/src/providers/gemini.ts`
- `packages/gateway/src/providers/deepseek.ts`
- the complete tracked diff, untracked implementation/verifier records, Git
  state/history, and protected-path comparison against `340dbce`

## Findings

No product, test, evidence, or scope defect remains.

### Prior blocker closure

I reproduced the trust-boundary cases that caused both earlier
`REQUEST_CHANGES` verdicts against freshly compiled output. All are contained:

- `response.status` is read exactly once inside `try/catch`; throwing,
  arbitrary, and changing getters emit only a validated 100–599 safe integer
  or `unknown`.
- `body.data`, `Array.isArray(data)`, and `data.length` are inside the outer
  summary boundary. A revoked body, revoked nested error, and revoked Array
  Proxy at `body.data` all resolve to fixed unknown metadata without rejecting
  the suite.
- `data.length` is read exactly once and accepts only a nonnegative safe
  integer. Throwing/arbitrary values make both count and target presence
  unknown; a changing getter cannot replace the validated snapshot.
- Throwing `ownKeys`, array-index, and entry-`id` getters are each caught after
  one access. They retain only the already validated model count and report
  target presence as unknown.
- The caller-level summary catch provides a second fail-closed boundary, so a
  future summarizer regression cannot suppress the required complete/stream
  modes or change suite accounting.
- The diagnostic fetch explicitly uses `redirect: "error"` and does not use the
  provider retry helper. Injected 302, 503, rejection, and malformed-body paths
  each made exactly one fetch invocation.

The successful compiled hostile probe ended with:

```text
{"cases":22,"manualCalls":1,"eventAndMissingKeySuppression":5,"statusReadOnce":true,"lengthReadOnce":true,"revokedArrayResolved":true,"revokedBodyResolved":true,"revokedErrorResolved":true,"ownKeysReads":1,"indexReads":1,"idReads":1,"deterministicCap":1000,"redirect":"error","noRetry":true,"accountingNonInterference":true,"noLeak":true}
```

### Disclosure and deterministic-output boundary

The manual diagnostic emits only validated HTTP status, validated array count,
exact equality of an entry ID to the trusted pinned target, and the existing
scalar allowlist `type`/`code`/`param`/`status`/`message`.

Independent source inspection, regressions, and compiled hostile probes prove:

- raw/non-JSON response text, unknown fields, headers, arbitrary thrown text,
  enumerated model IDs, and getter exception messages are not emitted;
- configured secrets are redacted before output, including the existing
  overlap/containment cases;
- C0, DEL, and C1 controls are normalized out of emitted diagnostic fields;
- every allowlisted field is capped at 200 code units and the complete
  diagnostic is deterministically capped at 1,000 code units; and
- URL-bearing hostile getter/rejection text, raw-body sentinels, unlisted model
  IDs, secret values, and revoked-Proxy exception text did not survive in the
  result, report, or rendered summary surfaces.

The approved pinned model remains visible in the ordinary provider summary by
design; the diagnostic never discloses the returned model list or a nonmatching
entry ID.

### Event, request, and accounting policy

Exact `GITHUB_EVENT_NAME === "workflow_dispatch"` plus a configured Gemini key
is required. Schedule, push, missing event, a near-match event, and a missing
Gemini key all made zero diagnostic calls. The one eligible path made exactly
one GET to the pinned `/v1beta/openai/models` URL with Bearer auth, JSON accept,
an abort signal, `redirect: "error"`, and no body.

The diagnostic remains metadata only. A successful diagnostic left a passing
Gemini provider at configured/passed/failed/skipped `1/1/0/0`; a deliberately
failed complete mode still ran streaming once and retained the ordinary red
provider accounting `1/0/1/0`. Scheduled runs own no `diagnostic` property.
Named missing-key `SKIPPED`, configured-provider red, zero-configured red, and
the statement that manual dispatch does not substitute for scheduled evidence
remain unchanged.

### Provider request contract

A compiled capture through the real OpenAI, Anthropic, Gemini, and DeepSeek
adapters observed exactly eight transports: one complete and one stream per
provider.

- OpenAI/Luna complete and stream carried exactly
  `max_completion_tokens: 64` and no `max_tokens`.
- Anthropic/Sonnet, Gemini/Flash, and DeepSeek/V4 Flash complete and stream
  carried exactly `max_tokens: 64` and no `max_completion_tokens`, including
  the native Anthropic translation.
- OpenAI-compatible streaming retained only its existing `stream: true` and
  `stream_options.include_usage: true` additions; Anthropic retained its native
  `stream: true` request.
- The exact Luna, Sonnet, Gemini 2.5 Flash, and DeepSeek V4 Flash pins and the
  four approved provider endpoints were unchanged.

The capture result was:

```text
{"transports":8,"modesPerProvider":2,"openai":"max_completion_tokens-only","others":"max_tokens-only","endpoints":"pinned","scheduleDiagnosticCalls":0}
```

The shared loose request schema correctly retains the OpenAI-only compatible
field without widening its actively validated/budgeted field set. OpenAI
passthrough remains pure. No shared schema, provider adapter, retry policy,
workflow, model pin, or endpoint was edited.

### Evidence and protected scope

`PROGRESS.md` truthfully records PRs #13/#14, scheduled run `31169217048`, the
diagnostic-only manual run `31230468869`, the OpenAI field defect, external
Anthropic credit blocker, unresolved Gemini 404, passing DeepSeek modes, both
verifier rejections, all three correction passes, the transient prior full-test
failure plus its isolated/clean-rerun recovery, current gate counts, and the
fact that no green scheduled run is claimed. Its pre-acceptance wording that a
fresh recheck is pending was accurate when written; the integrator can update
that state only after accepting this record.

The tracked product diff remains exactly:

```text
10  6   PROGRESS.md
407 1   packages/gateway/src/contracts/nightly.test.ts
204 19  packages/gateway/src/contracts/nightly.ts
```

Before this record, the only untracked files were the implementation record and
the two immutable `REQUEST_CHANGES` records. The project idea, authority docs,
README, workflow YAML, shared package, provider adapters, pipeline, database,
registry, and Phase 8 evidence have no diff. `master`, local `master`, and
`origin/master` all resolve to `340dbce86c23662f7bc2aec206b1ca81ffc36380`.

## Verification commands and successful checks

1. `pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts`
   — **40/40 passed** across two files.
2. `pnpm test` — **899/899 passed** across 69 files on the first acceptance-audit
   run.
3. `pnpm lint` — **185 files checked**, no fixes or errors.
4. `pnpm --filter @promptgate/gateway build` — passed.
5. `pnpm build` — all four workspace package builds passed.
6. Compiled real-adapter eight-transport capture — passed exact fields, two
   modes, call counts, native/compatible behavior, and pinned endpoints without
   external traffic.
7. Compiled 22-case hostile/proxy capture — passed revoked body/error/array,
   status/length snapshots, own-key/index/ID traps, fixed fallbacks, event/key
   gating, exact request shape, redirect/no-retry, disclosure/caps,
   determinism, and accounting non-interference.
8. `git diff --check` — passed.
9. Raw C0/DEL/C1 source/evidence scan — no forbidden source code point found.
10. Credential-pattern scan — only the pre-existing disclosed synthetic
    `sk-must-not-appear-1234567890` and overlap-test literals; no real-looking
    credential was introduced.
11. Protected-path diff — empty for every authority, workflow, README, shared,
    adapter, pipeline, DB, registry, and Phase 8 evidence path.

## Failed checks and suspected causes

No product or repository gate failed in this acceptance audit.

Three preliminary compiled verifier-harness attempts exited nonzero for
verifier-only reasons:

1. The first leak assertion incorrectly treated ordinary printable ASCII and
   summary layout newlines as forbidden controls.
2. The next attempt completed all substantive assertions but its final summary
   print referenced a misspelled verifier variable.
3. A condensed helper then used JavaScript default parameters, accidentally
   turning an explicitly absent event/key into the helper's manual/configured
   defaults.

None exposed a product failure. I corrected the harness expectations/defaults
without changing the repository, reran the compiled capture, and obtained the
green 22-case result quoted above.

## Known risks and limitations

- This is an offline acceptance. It proves no repaired Gemini credential, live
  OpenAI success, Anthropic account credit, green scheduled contract run, or
  final Phase 8 approval.
- Anthropic's insufficient credit is an external account blocker, not a source
  defect in this patch.
- Gemini key/project/model visibility remains unresolved until the later
  separately authorized manual diagnostic disposition; this audit does not
  justify changing the key, pin, or endpoint.
- `max_completion_tokens: 64` includes Luna reasoning tokens, so live evidence
  could still show insufficient visible output. Raising the cap or changing
  reasoning behavior requires evidence and is outside this repair.
- The diagnostic parses the complete model-list JSON before bounded
  summarization, so allocation remains proportional to the upstream response.
  That disclosed limitation was outside both prior verifier repair requests.
- A valid very large safe array length may be reported, but target inspection
  enumerates actual own keys rather than iterating to that length.

## Final verdict

**APPROVE.** Correction pass 3 closes the last revoked-Array-Proxy escape. The
earlier status/length, traversal, disclosure, redirect, and exact-one-GET
blockers also remain closed. Provider request fields, modes, calls, policy,
pins, endpoints, protected artifacts, evidence claims, and all offline gates
are clean. The integrator may accept and publish this narrow repair; live
Anthropic credit, Gemini diagnosis, and a qualifying green schedule-triggered
run remain separate Phase 8 closure requirements.
