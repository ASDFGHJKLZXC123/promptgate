# Phase 5 verification evidence

Date: 2026-07-28

Status: **incomplete — completed baseline run ID 1 is now owner-accepted as
current live baseline evidence under the hardened persisted-baseline
amendment; the good and degraded candidates remain pending**. Phase 5 remains
verify-pending. The degraded prompt and degraded command have not been created
or run.

## Committed gate

The live attempt used the clean committed amendment:

```console
$ git rev-parse HEAD
a77b9cfc59226a1a901cdef435a9e17ab04a87dd

$ git status --short
# no output
```

The checked-in Phase 5 matrix was unchanged:

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

## Owner-approved persisted-baseline path

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

## Remaining blocker

The good candidate awaits a fresh Gemini quota day. After it completes with
exit 0 and persisted evidence, the deliberately degraded candidate must be
created and run on a separate fresh quota day with the same hardened history
path; it must return quality exit 1 with the named failing cases. Checkpoint B1
then B2 remain ordered after the completed live Verify.

The offline persisted-baseline amendment gate is green:

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

The actual read-only history endpoint returned run ID 1 with dataset hash
`407c72cc4e9699ccb6aee1a3221e9da348b364ef4851a7f3a07e810b6bf8bef5`,
prompt ID 3/ref `safety_screen@prod`/version 1,
`deepseek-v4-flash`, and 50 cases. Independently loading the checked-in dataset
returned the same hash, 50 cases, one DeepSeek target, and seven rubric cases.
GPT-5.6 Sol / xhigh independently passed 64 focused tests and the eval strict
build, required one test-discrimination correction, and returned final
`APPROVE` after that correction.

## Secret-handling note

During preflight, shell-sourcing the gitignored `.env` encountered a
shell-incompatible OpenAI entry and emitted that OpenAI value in a local
command error. It was not committed, persisted in this evidence, or sent to a
provider. All subsequent commands used Node's dotenv loader and presence-only
output. The exposed OpenAI key must be rotated before any OpenAI live call.
