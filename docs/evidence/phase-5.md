# Phase 5 verification evidence

Date: 2026-07-28

Status: **incomplete — the literal good paired command returned infrastructure
exit 2 during a Gemini rubric call**. Phase 5 remains verify-pending. The
degraded prompt and degraded command have not been created or run.

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

## Current blocker

The paired good command can require 14 Gemini judgments. On this new Pacific
quota day, ten Gemini judgments succeeded and the next one failed despite the
approved pace. Re-running the unchanged command today would consume more
provider traffic without producing valid completion evidence, so no retry was
made.

Completion now requires either a provider path confirmed to support all 14
independent judgments or a separately approved gate amendment. A dedicated
Google project or confirmed quota increase is the zero-contract-change path.

GPT-5.6 Sol / xhigh independently audited the captured artifacts and returned
the same blocked verdict without overclaiming an upstream 429/RPD cause. It
confirmed that baseline run ID 1 is an exact current-HEAD baseline with the
current dataset hash, `safety_screen@prod` prompt ID 3/version 1,
`deepseek-v4-flash`, 50 results, 50 passes, and all seven rubric scores at
1.0.

The audit's smallest in-repo recommendation is a human-approved
persisted-baseline amendment: harden historical matching to require the frozen
dataset hash, prompt ID/ref/version, model, and 50-case count, then reuse run
ID 1 for the remaining good candidate. That would reduce each remaining
command to at most seven Gemini judgments. Baseline history is not authorized
by the current literal gate, so it will not be used without that amendment.
Changing to an OpenAI judge would also require an amendment and key rotation;
rubric removal, rubric batching, and self-judging are not authorized
substitutes.

The degraded version has not been created, checkpoint B1/B2 have not started,
and Phase 6 remains untouched.

After this evidence and `PROGRESS.md` were drafted, the required local gate
remained green:

```console
$ pnpm lint
Checked 147 files. No fixes applied.

$ pnpm test
Test Files  53 passed (53)
Tests       717 passed (717)
```

## Secret-handling note

During preflight, shell-sourcing the gitignored `.env` encountered a
shell-incompatible OpenAI entry and emitted that OpenAI value in a local
command error. It was not committed, persisted in this evidence, or sent to a
provider. All subsequent commands used Node's dotenv loader and presence-only
output. The exposed OpenAI key must be rotated before any OpenAI live call.
