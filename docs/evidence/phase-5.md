# Phase 5 verification evidence

Date: 2026-07-28

Status: **incomplete — the owner-approved Terra temperature omission is
implemented and offline-green; the fresh paired good Verify has not yet been
rerun from the amended commit**. Only `gpt-5.6-terra` now omits temperature;
DeepSeek retains temperature zero, and every other active Phase 5 invariant is
unchanged. Completed baseline run ID 1 remains useful historical
Gemini-judged evidence but is not comparable with the owner-approved Terra
gate. Phase 5 remains verify-pending. The degraded prompt and degraded command
have not been created or run.

## Prior committed Gemini-judge attempt

The live attempt used the clean committed amendment:

```console
$ git rev-parse HEAD
a77b9cfc59226a1a901cdef435a9e17ab04a87dd

$ git status --short
# no output
```

The then-checked-in Phase 5 matrix was unchanged:

- target: exactly `deepseek-v4-flash`;
- independent judge: exactly `gemini-2.5-flash`;
- dataset: 50 cases, including seven rubric cases;
- paired refs: `safety_screen@prod` and `safety_screen@candidate`, both frozen
  to immutable version 1 for this good run;
- no eval cache, no eval-runner retries, and a 15,000 ms per-model
  request-start pace.

At 2026-07-28 01:02 PDT, the image was rebuilt from this exact source and
force-recreated:

```console
Image promptgate-gateway Built
manifest list sha256:c6360cb613f1cabeaf36f9cab32bbb3a4ee4bc66f37a29c0d949cec334a2c28c
Container promptgate-gateway-1 Recreated
Container promptgate-gateway-1 Healthy

$ curl -fsS http://127.0.0.1:8787/healthz
{"ok":true}
```

The immutable `judge_rubric_v1@1` seeder returned `already_exists`. Before the
run, `eval_runs` and `eval_results` were both empty. A new disposable key,
ID 19, was created with an exact 1,000,000 micro-USD monthly budget and local
RPM 1,000.

## Literal good command

The repo-root direct binary and playbook arguments were used literally:

```bash
./node_modules/.bin/pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod \
  --gateway http://localhost:8787 --key "$KEY" --admin-token "$ADMIN_TOKEN" \
  --min-request-interval-ms 15000
```

Captured output:

```console
$ echo $?
2

# stdout was empty

# stderr
Rubric evaluator failed.
```

The cleanup trap immediately disabled key ID 19. The key row after cleanup was:

```console
id  name                          budget_micro_usd_month  rate_limit_rpm  disabled
19  phase5-good-a77b9cf-20260728  1000000                 1000            1
```

## Durable request and run evidence

Every DeepSeek request completed successfully. Ten Gemini judgments completed
successfully; the next Gemini judgment produced the terminal provider-error
row:

```console
provider  model              status          requests  cost_micro_usd
deepseek  deepseek-v4-flash  ok              77        3599
gemini    gemini-2.5-flash   ok              10        12605
gemini    gemini-2.5-flash   provider_error  1
```

Across the disposable key, 87 of 88 gateway rows were `ok`, with 32,976 input
tokens, 15,463 output tokens, and 16,204 persisted micro-USD. The failed row
retained no provider usage or cost:

```console
id   provider  model              status          error_code      total_ms
162  gemini    gemini-2.5-flash   provider_error  provider_error  3158
```

The per-model pacer operated correctly. Gemini request starts were at least
15 seconds apart, so the observed failure was not caused by exceeding the
documented five-RPM limit. The database intentionally stores only the
sanitized `provider_error` code; it does not preserve the upstream body, so
the exact provider-side quota dimension is an inference rather than a durable
fact.

The complete paired baseline ran first and persisted atomically:

```console
id  prompt_ref          prompt_version  model              cases_total  cases_passed  score_avg  cost_micro_usd  duration_ms
1   safety_screen@prod  1               deepseek-v4-flash  50           50            1.0        11909           737204

run_id  results  passed  avg_scored  result_cost_micro_usd
1       50       50      1.0         11909
```

The candidate stopped after 27 successful DeepSeek cases and three successful
Gemini judgments, before its run could be persisted. This is infrastructure
exit 2, not a candidate quality failure. Both good labels remain unchanged:

```console
slug           label      version
safety_screen  candidate  1
safety_screen  prod       1
```

## Owner-approved persisted-baseline path (historical; superseded)

On 2026-07-28, the project owner accepted completed baseline run ID 1 from the
live attempt at code HEAD `a77b9cf` as the current Phase 5 baseline evidence.
GPT-5.6 Sol / xhigh had independently verified that row against the current
gate artifacts:

- exact frozen safety-screening dataset hash;
- `safety_screen@prod`, prompt ID 3/version 1;
- exact target model `deepseek-v4-flash`;
- 50 persisted results, 50 passes, and score 1.0;
- all seven rubric scores at 1.0.

The approved runtime path is fail-closed. Before dataset upsert, provider
traffic, or any admin mutation, a history response must validate as persisted
run data and contain an exact row matching the current dataset slug and
64-hex hash, frozen baseline prompt ID/ref/version, target model, and current
50-case count. A malformed response or no exact row is a sanitized
infrastructure exit 2 with no provider/admin mutation side effects.

The two remaining live commands retain the baseline label, direct binary,
15-second pace, no-cache/no-retry policy, and disposable $1 key contract while
adding the approved history flag:

```bash
./node_modules/.bin/pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod --baseline-from-history \
  --gateway http://localhost:8787 --key "$KEY" --admin-token "$ADMIN_TOKEN" \
  --min-request-interval-ms 15000
```

Only the candidate is executed and atomically persisted. The stopped partial
candidate from the original attempt has no `eval_runs` row and is never reused;
even candidate-ref history is rejected as a baseline mismatch. Each remaining
command can consume at most seven Gemini rubric judgments. The good and
deliberately degraded candidates must run on separate fresh Gemini quota days.
The Phase 6 fresh-database paired four-provider gate is unchanged.

No provider call, Docker operation, admin/database mutation, degraded prompt
creation, or Phase 6 work occurred while implementing this amendment.

## Superseding Terra-judge comparability amendment

The owner later superseded the live use of history for Phase 5 because run ID 1
was Gemini-judged and `eval_runs` does not persist judge identity. The hardened
`--baseline-from-history` feature remains available to general callers, but the
active gate uses a fresh paired run and omits that flag:

```bash
./node_modules/.bin/pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod \
  --gateway http://localhost:8787 --key "$KEY" --admin-token "$ADMIN_TOKEN" \
  --min-request-interval-ms 15000
```

The target remains `deepseek-v4-flash`; the independent judge is
`gpt-5.6-terra` at temperature 0 and high reasoning effort with the frozen
JSON-object rubric prompt and no cache. The 50 cases, seven rubrics, retry and
self-judge prohibitions, $1 key, persistence, table, and exit contracts remain
unchanged. The degraded gate also requires a fresh pair. No provider, Docker,
admin/database, dataset, Phase 6, or live history operation occurred while
implementing this amendment.

## Terra-judge live attempt — OpenAI authentication blocker

The good Verify started from clean commit
`d00572418c9ac35e4db39953ea389179933e5d7d`. The gateway image was rebuilt and
the container recreated so it received the owner-confirmed rotated key. Docker
reported healthy, `GET /healthz` returned HTTP 200 with `{"ok":true}`, and
presence-only checks confirmed `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and
`ADMIN_TOKEN` inside the container.

The checked-in loader returned the unchanged dataset hash
`407c72cc4e9699ccb6aee1a3221e9da348b364ef4851a7f3a07e810b6bf8bef5`,
50 cases, seven rubrics, sole target `deepseek-v4-flash`, and threshold 0.8.
Both `safety_screen` labels remained at prompt ID 3/version 1, and
`judge_rubric_v1@1` remained present. Current pricing rows named DeepSeek as
the target provider and OpenAI as Terra's provider.

Disposable key ID 20 was created with exactly 1,000,000 micro-USD monthly
budget and RPM 1000. The live command was:

```bash
./node_modules/.bin/pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod \
  --gateway http://localhost:8787 --key "$KEY" --admin-token "$ADMIN_TOKEN" \
  --min-request-interval-ms 15000
```

It returned:

```console
Rubric evaluator failed.
PG_EVAL_EXIT=2
DISPOSABLE_KEY_CLEANUP id=20 disabled=true month_to_date_spend_micro_usd=100
```

The durable request rows were:

```console
id   provider  model              status          input  output  cost_micro_usd  total_ms
163  deepseek  deepseek-v4-flash  ok              399    347     100             4518
164  openai    gpt-5.6-terra      provider_error  —      —       —               268
```

The sanitized gateway/eval contract does not persist an upstream response
body. A single no-generation `GET https://api.openai.com/v1/models` check with
the same rotated credential returned:

```json
{"http_status":401,"content_type":"application/json","model_found":false,"model_count":null}
```

This proves that OpenAI rejected the credential as unauthorized. It does not
establish whether this key would otherwise have access to Terra or whether the
Terra request options are accepted. No retry was made. No new `eval_runs` or
`eval_results` row persisted: database totals remain the earlier one run and
50 results, and both safety labels remain at v1. Key 20 was disabled after two
gateway requests and 100 micro-USD. No degraded prompt, Gemini call, history
reuse, or Phase 6 work occurred.

## Replacement-key live attempt — Terra request-contract blocker

The owner then confirmed another replacement key. Before any generation call,
one presence-safe OpenAI model-list request succeeded:

```json
{"http_status":200,"content_type":"application/json","model_found":true,"model_count":127}
```

This establishes that the replacement credential was authorized and that its
model list included `gpt-5.6-terra`. The gateway was rebuilt and force-recreated
from clean commit `6d6244b232f2490816b03a6399ff51c45d59fa19`:

```console
Image promptgate-gateway Built
manifest list sha256:1b00aa7215d0f4f039b294a770f02a4596f325e7ed6b5cd74d769346f9c9bbf6
Container promptgate-gateway-1 Recreated
Container promptgate-gateway-1 Healthy

$ curl -fsS http://127.0.0.1:8787/healthz
{"ok":true}
```

Presence-only checks again found OpenAI, DeepSeek, and admin credentials inside
the container. The immutable judge prompt remained ID 2/version 1, and both
`safety_screen` labels remained prompt ID 3/version 1. Disposable key ID 21 was
created with exactly 1,000,000 micro-USD monthly budget and RPM 1000. The same
literal fresh-pair command was run once:

```bash
./node_modules/.bin/pg-eval run --dataset safety_screening \
  --prompt safety_screen@candidate --baseline prod \
  --gateway http://localhost:8787 --key "$KEY" --admin-token "$ADMIN_TOKEN" \
  --min-request-interval-ms 15000
```

Captured output:

```console
Rubric evaluator failed.
PG_EVAL_EXIT=2
DISPOSABLE_KEY_CLEANUP id=21 disabled=true month_to_date_spend_micro_usd=49
```

The durable request rows and cleanup state were:

```console
id   provider  model              status          input  output  cost_micro_usd  total_ms  prompt_id  prompt_version
165  deepseek  deepseek-v4-flash  ok              399    163     49              2201      3          1
166  openai    gpt-5.6-terra      provider_error  —      —       —               2405      2          1

key_id  budget_micro_usd_month  rate_limit_rpm  disabled
21      1000000                 1000            1
```

No eval run exists for commit `6d6244b`; database totals remain one earlier
run and 50 results. Both safety labels remain at v1.

The checked-in request builder sends the Terra judge `temperature: 0`,
`reasoning_effort: "high"`, JSON-object output, the immutable judge prompt, and
no cache. OpenAI's
[Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
classifies it as a reasoning model and lists Chat Completions and structured
outputs as supported. The
[GPT-5.6 parameter guide](https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters)
lists high reasoning effort as supported. OpenAI's
[model-grader constraints](https://developers.openai.com/api/docs/guides/graders#model-grader-constraints)
state that temperature changes are unsupported for reasoning models.

Those documented capabilities leave the forced temperature override as the
strongest identified incompatibility. That conclusion is an inference, not a
captured upstream fact: the gateway intentionally persists only the sanitized
`provider_error`, and no provider body or HTTP status was retained for row 166.
Changing the approved Terra wire contract requires owner approval. No retry,
direct diagnostic generation, degraded prompt, history reuse, Gemini call, or
Phase 6 work occurred.

The documentation-only evidence gate passed:

```console
$ pnpm lint
Checked 148 files. No fixes applied.

$ pnpm test
Test Files  53 passed (53)
Tests       719 passed (719)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

The first sandboxed test process reported five `listen EPERM` failures on
`127.0.0.1`; the identical permitted local-loopback rerun above was green.

## Owner-approved Terra temperature amendment

The project owner approved the narrow correction after reviewing the
replacement-key evidence:

- omit `temperature` only for `gpt-5.6-terra`;
- retain `reasoning_effort: "high"`, JSON-object output, immutable
  `judge_rubric_v1@1`, and no cache;
- retain `temperature: 0` for the sole DeepSeek target;
- preserve all 50 cases, seven rubrics, fresh paired execution without history
  reuse, 15-second pacing, disposable $1 keys, no retries or self-judging,
  persistence/table/exit contracts, and Phase 6 unchanged.

The eval request builder and its shared Zod request policy now make Terra and
the existing Claude exception the only pinned eval models for which
temperature must be absent. DeepSeek, Gemini, and Luna remain pinned to zero.
Discriminating shared-policy, client, and real-judge tests assert both valid
pairs and reject Terra-at-zero plus DeepSeek-without-temperature. The project
idea, implementation guide, playbook, orchestration rail, progress record, and
this evidence record carry the same active contract; historical entries remain
unchanged as history.

No provider call, Docker operation, database/admin mutation, dataset change,
degraded prompt, history reuse, or Phase 6 work occurred while implementing
the amendment. The offline gate passed:

```console
$ pnpm exec vitest run packages/shared/src/eval-policy.test.ts \
    packages/evals/src/gateway-client.test.ts packages/evals/src/judge.test.ts
Test Files  3 passed (3)
Tests       36 passed (36)

$ pnpm lint
Checked 147 files. No fixes applied.

$ pnpm test
Test Files  54 passed (54)
Tests       720 passed (720)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

GPT-5.6 Sol / xhigh independently passed 89 tests across eight focused files,
verified the exact request/schema boundary, synchronized active authority
text, historical supersession note, and unchanged Phase 6 scope, and returned
`APPROVE`. Diff checks were clean.

## Fresh good Verify after the Terra amendment

The amendment was committed as
`e47acac9d9eb7e819476ce6597de826fc1464897`. The exact commit was rebuilt as
image manifest
`sha256:b22e54cba5c7479bde3db503ee98ff6d9b4578af7970bc3ab3655d7943c859b6`,
and the gateway returned `{"ok":true}`. Presence-only checks confirmed the
admin, OpenAI, and DeepSeek credentials without printing their values.

A fresh disposable key, ID 22, was created with the required 1,000,000
micro-USD budget and RPM 1000. The command was invoked exactly once with no
history reuse, retry, or cache:

```console
$ ./node_modules/.bin/pg-eval run \
    --dataset safety_screening \
    --prompt safety_screen@candidate \
    --baseline prod \
    --gateway http://localhost:8787 \
    --key <redacted> \
    --admin-token <redacted> \
    --min-request-interval-ms 15000
```

The process continued for about 720 seconds instead of failing at the first
Terra rubric request. The runner's fixed control flow completes the 50-case
baseline before its next admin operation, `POST /admin/api/evals/runs`.
That persistence request returned:

```console
PG_EVAL_STDERR_BEGIN
Admin request failed with HTTP status 500.
PG_EVAL_STDERR_END
PG_EVAL_EXIT=2
DISPOSABLE_KEY_CLEANUP id=22 disabled=true month_to_date_spend_micro_usd=16206
```

This live execution resolves the former Terra request-contract blocker. It
does not complete the good Verify: infrastructure exit 2 is red, no run or
50-result baseline was persisted, and no summary table was available. No
second attempt was made.

### Persistence and WAL evidence

While the gateway was running, its admin API exposed key 22 and the accumulated
16,206-micro-USD spend. After stopping and restarting the gateway, read-only
admin queries returned:

```json
{"keys_status":200,"key_count":21,"max_key_id":21,"has_key_22":false,"runs_status":200,"run_count":1,"max_run_id":1}
```

The host main database therefore remained at the pre-run state: key 22 and its
request rows were gone, and there was still only the earlier run ID 1 with 50
results. The restarted gateway returned `{"ok":true}`. The bind-mounted
sidecars then showed a zero-byte WAL:

```console
data/promptgate.db      327680 bytes
data/promptgate.db-shm   32768 bytes
data/promptgate.db-wal       0 bytes
```

The shutdown durability defect is proven. Compose bind-mounts `./data` to
`/data`, `openDatabase` forces WAL, and Fastify's `onClose` closes the
database, but the production entrypoint installs no SIGTERM/SIGINT handler
that awaits `server.close()`. Existing Phase 3 evidence already records the
Docker Desktop/VirtioFS stale/deleted-WAL-descriptor hazard and the need for a
graceful checkpoint before host SQLite reads.

The precise create-run HTTP 500 cause is **not** proven. The admin route maps
unexpected DAO exceptions to a generic 500, Fastify logging is disabled, and
no sanitized SQLite code was retained. WAL I/O or locking is plausible, but a
constraint, aggregate, or other persistence exception is not excluded.
Missing signal handling fully explains the later uncheckpointed shutdown
behavior; it does not by itself establish why the earlier live create-run
request failed.

### Owner-approved SQLite WAL lifecycle amendment

The project owner approved the narrow correction and exactly one new fresh
good Verify after every offline and Docker durability gate is green:

- retain WAL, the schema, and the current bind mount;
- make SIGTERM and SIGINT share one awaited Fastify shutdown;
- validate a successful TRUNCATE checkpoint and close the database in
  `finally`, retaining a checkpoint error as primary;
- set Compose stop grace beyond the upstream timeout;
- prohibit host `sqlite3` while the gateway is live;
- add production-sized 50-result persistence/reopen, signal/main-file, and
  no-provider Docker write/stop/read/restart gates;
- preserve every DeepSeek/Terra, dataset, rubric, pacing, cache, retry, budget,
  persistence, exit-code, and Phase 6 contract.

The new 50-result regression reproduced a second, pre-existing path to the
observed generic 500. The runner and request schema calculate `score_avg` in
request order, but DAO confirmation rereads results in case-ID order. Seven
ordinary decimal rubric scores produced `0.9114285714285716` in request order
and `0.9114285714285713` after the reorder; the old one-epsilon comparison
rejected that mathematically equivalent mean and rolled back the transaction.
This is a concrete plausible explanation for the lost live create-run, not
proof that key 22 had those unrecoverable scores.

The bounded correction uses one request/DAO helper whose tolerance is
`Number.EPSILON × scored_result_count × max(1, abs(expected), abs(computed))`.
Null remains exact iff there are no scored results; case count, pass count, and
integer micro-USD totals remain exact. A one-billionth mismatch remains red.

No provider call is authorized until the corrected offline suite, independent
audit, exact committed-image build, and no-provider Docker durability canary
all pass. Key 22 and its lost partial sequence remain unusable. The degraded
candidate/run, checkpoint B1/B2, and Phase 6 remain strictly later work.

The corrected offline gate passed:

```console
$ pnpm exec vitest run packages/gateway/src/db/lifecycle.test.ts \
    packages/gateway/src/shutdown.test.ts \
    packages/gateway/src/admin/evals.test.ts \
    packages/gateway/src/index.test.ts
Test Files  4 passed (4)
Tests       30 passed (30)

$ pnpm lint
Checked 154 files. No fixes applied.

$ pnpm test
Test Files  57 passed (57)
Tests       741 passed (741)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

The focused and complete suites ran with local-loopback permission because the
new child-process durability test and five existing streaming tests bind
temporary `127.0.0.1` sockets. GPT-5.6 Sol / xhigh independently checked the
signal guard, checkpoint result/error precedence, 150-second stop grace,
50-result and one-billionth discriminators, main-file/restart proof, score
bound, strict types, secrets, authority synchronization, and unchanged Phase 6
scope, then returned `APPROVE`.

### Exact-image no-provider Docker durability canary

The lifecycle amendment was committed as
`770ea7a7b01fa0c79cbd4eb86250dde39d81b3c3`. Its exact Docker build produced
manifest list
`sha256:cce2449fceb967b0ec5d2440e0bbbc2b7459588261b50ffc0f4703342fce8a11`.
The image ran against an isolated temporary bind mount and loopback port with
only a canary-local admin value. No provider credential was passed.

Initial health and the admin-only production-sized write returned:

```console
health={"ok":true}
{"dataset_id":1,"run_id":1,"returned_results":50,"detail_results":50,"score_avg":0.9114285714285716,"provider_calls":0}
```

The first Docker SIGTERM stop completed with:

```console
status=exited
exit_code=0
oom_killed=false
```

Only after that verified exit, the host inspected the bind mount. The directory
contained only the 135,168-byte `promptgate.db`; both
`promptgate.db-wal` and `promptgate.db-shm` were absent. A read-only query
against a copy of that main file, without either sidecar, returned:

```console
datasets|runs|results|provider_requests|cases_total|score_avg
1|1|50|0|50|0.911428571428572
```

The same stopped container then restarted from the same bind mount:

```console
health={"ok":true}
{"status":200,"run_id":1,"cases_total":50,"results":50,"model":"deepseek-v4-flash","score_avg":0.9114285714285716}
```

Its final graceful stop also returned `exited|0|false`. The temporary container,
database, and main-file copy were removed after evidence capture. The image
contains no `.env` because `.dockerignore` excludes `.env` and `.env.*`.

Every approved pre-paid durability gate is now green. The remaining paid good
Verify is not authorized to start with the currently configured values:
the Compose-render exposure recorded below requires credential rotation first.

The post-evidence gate remained green:

```console
$ pnpm lint
Checked 148 files. No fixes applied.

$ pnpm test
Test Files  54 passed (54)
Tests       720 passed (720)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

The first sandboxed full-test process reported five `listen EPERM` failures on
`127.0.0.1`; all 715 other assertions passed. The identical suite with
local-loopback permission produced the authoritative 720/720 result above.

The prior persisted-baseline amendment gate was green:

```console
$ pnpm exec vitest run packages/evals/src/runner.test.ts \
    packages/evals/src/runner.meta.test.ts packages/evals/src/cli.test.ts
Test Files  3 passed (3)
Tests       43 passed (43)

$ pnpm lint
Checked 147 files. No fixes applied.

$ pnpm test
Test Files  53 passed (53)
Tests       718 passed (718)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

The focused Terra amendment gate is also green:

```console
$ pnpm --filter @promptgate/evals build
packages/evals build: Done

$ pnpm exec vitest run packages/evals/src/judge.test.ts \
    packages/evals/src/runner.test.ts packages/evals/src/runner.meta.test.ts \
    packages/evals/src/cli.test.ts packages/evals/src/gateway-client.test.ts
Test Files  5 passed (5)
Tests       79 passed (79)

$ pnpm lint
Checked 147 files. No fixes applied.

$ pnpm test
Test Files  53 passed (53)
Tests       719 passed (719)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/shared build: Done
packages/evals build: Done
packages/gateway build: Done
```

GPT-5.6 Sol / xhigh independently audited the completed amendment, required
four stale active-document references to be corrected, and returned `APPROVE`
after verifying those corrections. Diff, secret, no-`any`, dataset, gateway,
schema, CI, and Phase 6 scope checks were clean.

The actual read-only history endpoint previously returned run ID 1 with dataset
hash `407c72cc4e9699ccb6aee1a3221e9da348b364ef4851a7f3a07e810b6bf8bef5`,
prompt ID 3/ref `safety_screen@prod`/version 1,
`deepseek-v4-flash`, and 50 cases. Independently loading the checked-in dataset
returned the same hash, 50 cases, one DeepSeek target, and seven rubric cases.
GPT-5.6 Sol / xhigh independently passed 64 focused tests and the eval strict
build, required one test-discrimination correction, and returned final
`APPROVE` after that correction. That evidence remains historically valid but
is not used as the active Terra comparison baseline.

## Secret-handling note

During preflight, shell-sourcing the gitignored `.env` encountered a
shell-incompatible OpenAI entry and emitted that OpenAI value in a local
command error. It was not committed, persisted in this evidence, or sent to a
provider. All subsequent commands used Node's dotenv loader and presence-only
output. The owner confirmed that the exposed key was rotated before the first
Terra call. A later replacement authenticated successfully and listed Terra,
but its first rubric request failed under the approved request contract.
Neither replacement value was printed or persisted in this evidence.

During the WAL amendment's final read-only Compose syntax check,
`docker compose config` expanded the gitignored `.env` values into local
command output. No value was committed, copied into this record, or used for a
later provider request. Treat `ADMIN_TOKEN` and every configured provider key
as exposed and rotate them in `.env` before the authorized paid good Verify.
The intervening Docker durability canary must receive only an isolated local
admin value and no provider credential.
