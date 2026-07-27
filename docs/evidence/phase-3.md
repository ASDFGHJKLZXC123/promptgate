# Phase 3 verification evidence

Date: 2026-07-26

Status: **pass — awaiting explicit human approval**. Phase 4 has not started.

## Commit sequence

Each numbered Phase 3 playbook step has one commit, in order:

```console
5f63020 phase-3 step-1: canonicalize cache keys
b45dd95 phase-3 step-2: replay validated cache hits
23ae7db phase-3 step-3: persist metered cache entries
68e16f4 phase-3 step-4: enforce per-key rate limits
47ce559 phase-3 step-5: guard per-key budgets
aa41d09 phase-3 step-6: lock pipeline order
```

The project-owner-approved budget/pipeline authority correction is isolated
between steps 1 and 2:

```console
059d940 phase-3 amend: correct budget pipeline invariants
```

The completion-gate cached-stream correction is also isolated:

```console
41fe9c9 phase-3 verify: harden cached stream replay
```

## Changed-file scope

Relative to the human-approved Phase 2 gate (`155d567`), the numbered
implementation/amendment/correction range through `41fe9c9` changed 22 files: 3,823
insertions and 60 deletions. This evidence file and the final `PROGRESS.md`
update are the additional completion records.

```console
M  BUILD_PLAYBOOK.md
M  IMPLEMENTATION_GUIDE.md
M  PROGRESS.md
M  packages/gateway/src/admin/keys.ts
M  packages/gateway/src/config.ts
A  packages/gateway/src/pipeline/budget.dao.test.ts
A  packages/gateway/src/pipeline/budget.dao.ts
A  packages/gateway/src/pipeline/budget.test.ts
A  packages/gateway/src/pipeline/budget.ts
A  packages/gateway/src/pipeline/cache-key.test.ts
A  packages/gateway/src/pipeline/cache-key.ts
A  packages/gateway/src/pipeline/cache.dao.test.ts
A  packages/gateway/src/pipeline/cache.dao.ts
M  packages/gateway/src/pipeline/handler.stream.test.ts
M  packages/gateway/src/pipeline/handler.test.ts
M  packages/gateway/src/pipeline/handler.ts
M  packages/gateway/src/pipeline/meter.ts
A  packages/gateway/src/pipeline/ratelimit.test.ts
A  packages/gateway/src/pipeline/ratelimit.ts
A  packages/gateway/src/pipeline/stream-assembler.test.ts
A  packages/gateway/src/pipeline/stream-assembler.ts
M  packages/gateway/src/server.ts
```

No migration, provider adapter, prompt-registry, eval, dashboard, secret, or
Phase 4 implementation was added.

## Verification setup

The exact final Phase 3 commit was explicitly rebuilt and recreated before the
authoritative live rerun:

```console
$ git rev-parse --short HEAD
41fe9c9

$ docker compose build
Image promptgate-gateway Built

$ docker compose up -d --force-recreate --wait
Container promptgate-gateway-1 Recreate
Container promptgate-gateway-1 Recreated
Container promptgate-gateway-1 Starting
Container promptgate-gateway-1 Started
Container promptgate-gateway-1 Waiting
Container promptgate-gateway-1 Healthy
```

No credential value was printed or committed. `.env` is ignored by Git.
Presence-only inspection returned:

```console
ADMIN_TOKEN=present
GEMINI_API_KEY=present
DEEPSEEK_API_KEY=present
OPENAI_API_KEY=absent
ANTHROPIC_API_KEY=absent
```

The authoritative functional Verify used `gemini-2.5-flash`, two disposable
gateway keys, and a unique 400-character request marker. The request's
documented reservation was independently calculated from the checked-in
current pricing row as 37 micro-USD. The available-key matrix used one
additional disposable gateway key for `deepseek-v4-flash`. All three keys were
disabled through the admin API after verification; their plaintext values
existed only in shell memory.

## Superseded runs and pre-gate correction

An initial step-6-image harness attempt stopped because `status` is a read-only
special parameter in zsh. Its command substitution had already issued one
bounded Gemini request. A host-side SQLite read while Docker Desktop still held
the bind-mounted WAL open then exposed a macOS VirtioFS interoperability
hazard: the gateway retained deleted `promptgate.db-wal`/`promptgate.db-shm`
descriptors, so that transient state was discarded. The corrected initial run
used graceful gateway stops before host SQLite reads and passed, including one
DeepSeek activation.

The mandatory pre-gate full-suite rerun then exposed a real transport timing
edge in the cached-stream disconnect regression: a multi-megabyte cached SSE
frame could be handed to Node as one source buffer and become
`writableEnded` before the client received its first bytes and reset. Commit
`41fe9c9` splits only the already-framed transport bytes into 16 KiB shared
subarray views; it changes neither JSON nor SSE payload bytes.

Correction evidence before the final rerun:

```console
orchestrator_cache_reset_repetitions=10/10_passed
sol_xhigh_cache_reset_repetitions=30/30_passed
stream_handler_tests=23/23_passed
manual_stream_http=200 cache=hit cost_usd=0.000000 frames=3 content_chars=131072 usage=4/1 done=true
manual_stream_key_id=8 disabled=true post_stream_health={"ok":true}
```

GPT-5.6 Sol / xhigh returned `APPROVE`: the exact framed bytes are preserved,
each replay write is bounded, the subarrays do not copy payload data, and the
real-socket regression covers both durable abort reconciliation and retained
debt on logging failure.

Because streaming code changed, the completion gate was reopened. The
authoritative results below come from a new clean run against rebuilt commit
`41fe9c9`. Every settings mutation still used the admin API. The gateway was
gracefully stopped before each literal host `sqlite3` query so Docker Desktop
checkpointed its WAL safely, then restarted and rechecked health.

## Literal Phase 3 Verify output

### Cache: identical request twice

The first request was the live Gemini call. The second identical request was
served from cache.

```console
health={"ok":true}
setup commit=41fe9c9 model=gemini-2.5-flash reservation_estimate_micro_usd=37 key_ids=9,10,11
cache verification
first_http=200 x-pg-cache=miss
second_http=200 x-pg-cache=hit
```

The literal cache query and a key-scoped supplemental query returned:

```console
$ sqlite3 data/promptgate.db \
  "SELECT cache_hit, cost_micro_usd FROM requests ORDER BY id DESC LIMIT 2;"
1|0
0|22

cache_rows_with_status
9|1|0|ok
9|0|22|ok
```

The cache hit therefore cost zero. The `x-pg-cache: hit` path bypasses the
adapter by construction, with offline integration coverage proving no provider
call and exact hit metadata.

### Budget: admin PATCH and immediate refusal

After the cache checkpoint/restart, the key budget was set to one micro-USD
through the admin API. The very next request was rejected by the 37-micro-USD
reservation:

```console
post_cache_restart_health={"ok":true}
budget verification
budget_http=429 budget_code=budget_exceeded
```

No direct SQLite setting update was used, so the server-side budget memo
invalidation path was exercised.

### Rate limit: RPM 2, five sequential requests

The same key's budget was restored and `rate_limit_rpm` was patched to 2. The
request was already cached, ensuring these checks added no provider traffic:

```console
rate-limit verification
rate_request_1=200/ok
rate_request_2=200/ok
rate_request_3=429/rate_limited
rate_request_4=429/rate_limited
rate_request_5=429/rate_limited
```

This is the documented full two-request burst followed by refusal on the third
and later requests.

### Ten-way burst-overspend regression

The second disposable key was patched through the admin API to a monthly budget
of exactly one 37-micro-USD reservation, which is strictly less than two
reservations. Ten `pg_no_cache: true` requests were launched in parallel:

```console
burst verification
burst_http_counts
200=1
429=9
burst_outcome_counts
budget_exceeded=9
provider_admitted=1
```

The one admitted call reached Gemini and succeeded; all other calls were
rejected before provider dispatch. After a graceful checkpoint, the durable
rows were:

```console
burst_rows
ok|null|1
rejected_budget|budget_exceeded|9
```

The configured DeepSeek activation then returned a successful, exactly metered
non-streaming row:

```console
deepseek activation
deepseek_http=200 outcome=ok cache=miss
deepseek_usage={"model":"deepseek-v4-flash","streamed":false,"input_tokens":120,"output_tokens":39,"cost_micro_usd":28,"cost_estimated":false,"status":"ok"}

deepseek_persisted_row
deepseek|deepseek-v4-flash|0|120|39|28|0|ok|null
```

The complete three-key outcome list was:

```console
9|0|22|ok|null
9|1|0|ok|null
9|0||rejected_budget|budget_exceeded
9|1|0|ok|null
9|1|0|ok|null
9|0||rejected_rate_limited|rate_limited
9|0||rejected_rate_limited|rate_limited
9|0||rejected_rate_limited|rate_limited
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0||rejected_budget|budget_exceeded
10|0|22|ok|null
11|0|28|ok|null
```

The disposable-key cleanup and final runtime state were:

```console
verify_keys_disabled
9|true
10|true
11|true

final_health={"ok":true}
NAME                   IMAGE                COMMAND                  SERVICE   CREATED         STATUS                   PORTS
promptgate-gateway-1   promptgate-gateway   "docker-entrypoint.s…"   gateway   2 minutes ago   Up 5 seconds (healthy)   127.0.0.1:8787->8787/tcp

cleanup verify_keys_disabled=true temporary_responses_removed=true
```

## Configured-provider activation matrix

The project owner supplied both configured provider keys and explicitly
authorized live verification with `gemini-2.5-flash` and
`deepseek-v4-flash`. The authoritative run above exercised both models through
the same rebuilt commit. Each provider request used a unique marker; DeepSeek
also used `pg_no_cache: true`.

| Provider | Key state | Verification outcome |
|---|---|---|
| Gemini | configured | live through gateway; cache/budget/rate/burst Verify passed |
| DeepSeek | configured | live through gateway; HTTP 200; exact 120 input/39 output/28 micro-USD row |
| OpenAI | absent | explicitly deferred — missing key |
| Anthropic | absent | explicitly deferred — missing key |

Every implemented provider with a configured key was therefore called in the
Phase 3 Verify window.

## Offline quality and build

The final committed implementation plus this evidence/progress update passed:

```console
$ pnpm exec vitest run <eight Phase 3 pipeline suites>
Test Files  8 passed (8)
Tests       90 passed (90)

$ pnpm lint
Checked 105 files. No fixes applied.

$ pnpm test
Test Files  37 passed (37)
Tests       556 passed (556)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/shared build: Done
packages/gateway build: Done

$ git diff --check
# no output; exit code 0
```

All automated tests used injected fake adapters. Across the superseded and
authoritative verification work, live traffic was bounded to at most five
Gemini calls (the discarded first attempt, two initial corrected calls, and two
final calls) and exactly two DeepSeek calls (one initial activation and the
final authoritative activation). The 128 KiB manual streaming correction check
was a seeded cache hit and made no provider call. No OpenAI or Anthropic call
was attempted.

## Independent review

GPT-5.6 Sol / xhigh independently audited the budget and final pipeline
integration:

- Step 5 received `APPROVE` after validation-before-release, direct
  current-month spend DAO tests, and durable/failed-log `actual > reserved`
  regressions were added.
- Step 6 received `APPROVE` after post-header provider failures retained exact
  usage or an explicit estimate, Phase 3 header fallbacks were wired, and a
  real cached-stream socket-reset regression proved durable release plus
  fail-closed debt on logging failure.
- The pre-gate cached-stream correction received `APPROVE` after 30/30 repeated
  real-socket resets, the complete 23-test streaming suite, exact-byte review,
  and a no-copy/backpressure audit.
- The final pipeline is fixed as auth → request-log init → rate limit →
  validation → provider/pricing → Phase 4 prompt-resolution placeholder →
  budget reservation → cache read → adapter → meter → cache write → durable
  request log → budget reconciliation.

## Acceptance status

| Phase 3 criterion | Evidence | Result |
|---|---|---|
| Exact whole-forwarded-body cache identity | Recursive sorted JSON; only transport and `pg_*` fields excluded; deterministic shuffle and field-sensitivity tests | pass |
| Identical request is miss then hit | Live headers `miss`, then `hit` | pass |
| Cache hit cost is zero and provider is bypassed | Literal rows `1|0`, then `0|22`; offline adapter-call assertion | pass |
| Streaming cache replay | Exact terminal usage replay plus real disconnect logging/reconciliation regression | pass |
| Successful metered cache writes and expiry | Atomic upsert, priced-cost persistence, strict stream assembler, positive TTL, hourly sweep tests | pass |
| Per-key RPM limiter | RPM 2 produced 200, 200, then three `rate_limited` 429s | pass |
| Immediate budget refusal after admin PATCH | Next request returned 429 `budget_exceeded` | pass |
| Concurrent calls cannot outrun reservations | Ten parallel calls produced exactly one admitted call and nine budget 429s | pass |
| Durable-log reconciliation and failed-log debt | Direct DAO/unit/integration and cached-stream reset trigger coverage | pass |
| Error taxonomy and final pipeline order | Discriminating short-circuit tests plus Sol / xhigh approval | pass |
| Every configured provider is activated | Gemini and DeepSeek live passed; OpenAI and Anthropic explicitly deferred for absent keys | pass |
| Strict TypeScript, Zod boundaries, DAO separation, no secrets | lint, 556 tests, strict build, diff/secret review | pass |
| Phase 4 not started | No registry migration, prompt DAO, template resolution, or Phase 4 endpoint work | pass |

All Phase 3 acceptance criteria pass. There is no remaining product blocker.
The deviations were the discarded first Verify-harness attempt, the safe
Docker Desktop WAL checkpoint procedure, and the pre-gate cached-stream
backpressure correction. That correction was committed, independently
approved, rebuilt, and followed by the complete authoritative rerun above.
