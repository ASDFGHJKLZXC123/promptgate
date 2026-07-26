# Phase 2 verification evidence

Date: 2026-07-25

Status: **pass — checkpoint A returned `proceed with adjustments`; human-approved
on 2026-07-26**. The adjustments were completion-record updates only. Phase 3
has not started.

## Commit sequence

Each numbered Phase 2 playbook step has one commit, in order:

```console
2046f30 phase-2 step-1: author provider contract fixtures
72ca89f phase-2 step-2: add the Anthropic adapter
35cef11 phase-2 step-3: add compatible provider streaming
51c641f phase-2 step-4: translate Anthropic streaming
4686ba4 phase-2 step-5: abort disconnected streams
71525fa phase-2 step-6: add owner-scoped usage lookup
```

The human-approved fixture-timing amendment and the mandatory live-contract
correction are isolated in:

```console
9eb0ebd phase-2 amend: defer live fixture capture to verify
b1b3f6e phase-2 verify: reconcile live compatible streams
```

## Verification setup and key matrix

The current committed image was explicitly rebuilt before each live Verify run
so Compose could not reuse stale application code:

```console
$ docker compose build
Image promptgate-gateway Built
```

No key value was printed or committed. `.env` is ignored by Git. Presence-only
inspection returned:

```console
ADMIN_TOKEN=configured
GEMINI_API_KEY=configured
DEEPSEEK_API_KEY=configured
OPENAI_API_KEY=absent
ANTHROPIC_API_KEY=absent
```

The project owner placed the Gemini and DeepSeek keys for this testing. The
OpenAI and Anthropic activation checks are therefore deferred, not described as
live passes.

## Fixture activation and live-contract reconciliation

The approved Verify window made exactly one bounded direct non-streaming request
and one bounded direct streaming request to each configured provider. All four
capture requests returned HTTP 200:

| Provider | Mode | Captured contract |
|---|---|---|
| Gemini 2.5 Flash | non-streaming | Content `OK`; usage prompt `4`, completion `1`, total `30` |
| Gemini 2.5 Flash | streaming | One JSON event combining assistant role, content `OK`, finish `stop`, and usage `4/1/30`, then `[DONE]` |
| DeepSeek V4 Flash | non-streaming | Content `OK.`; usage prompt `7`, completion `29`, total `36`, cache hit/miss `0/7`, reasoning `26` |
| DeepSeek V4 Flash | streaming | 40 JSON events: role, 36 reasoning deltas, visible `OK.`, combined finish+usage `7/39/46` with cache hit/miss `0/7` and reasoning `36`, then `[DONE]` |

Credentials were never part of response bodies. Provider-generated response IDs
and the DeepSeek fingerprint were replaced with deterministic `pgfixture`
values. The sanitized live captures are:

- `packages/gateway/test/fixtures/gemini-non-streaming.json`
- `packages/gateway/test/fixtures/gemini-streaming.txt`
- `packages/gateway/test/fixtures/deepseek-non-streaming.json`
- `packages/gateway/test/fixtures/deepseek-streaming.txt`

Their four `live_capture_pending` markers are `false`. OpenAI and Anthropic lack
keys, so their four official-contract fixtures remain explicitly pending.

The captures differed from the authored compatible-stream contract: Gemini and
DeepSeek attached usage to a nonempty final choice instead of sending a
separate empty-choice usage frame. The adapter now accepts exactly one terminal
usage-bearing frame in either observed form:

1. empty choices (the retained OpenAI contract); or
2. nonempty choices where every choice has a supported, non-null
   `finish_reason` (the captured Gemini/DeepSeek contract).

The frame remains terminal before one buffered `[DONE]` and clean EOF.
Duplicate, missing, malformed, unfinished, post-usage, post-`[DONE]`, and
truncated transcripts still fail closed.

## First literal run: correctly failed the gate

The first current-image gateway run exposed that drift:

```console
gemini-2.5-flash: 502 Upstream gemini request failed.

BEGIN deepseek-v4-flash request_id=4847c7f1-65a2-4655-bde7-a97e344bfa6e
Hi! How can I help you today?
END deepseek-v4-flash chunks=44 content_chars=29 usage=undefined
USAGE deepseek-v4-flash status=200 body={"request_id":"4847c7f1-65a2-4655-bde7-a97e344bfa6e","model":"deepseek-v4-flash","streamed":true,"input_tokens":null,"output_tokens":null,"cost_micro_usd":null,"cost_estimated":false,"status":"provider_error"}

DEFERRED gpt-5.6-luna: OPENAI_API_KEY is not configured
DEFERRED claude-sonnet-5: ANTHROPIC_API_KEY is not configured

deepseek-v4-flash|1|1362|1441|
gemini-2.5-flash|1||767|
```

Those rows are retained as evidence of the resolved defect and are not counted
as passes. Per the playbook, the fixtures/code were reconciled, the full offline
suite passed, correction `b1b3f6e` was committed, the image was rebuilt, and
the literal Verify block was rerun from the start.

## Passing literal Phase 2 Verify rerun

The repository-pinned OpenAI SDK was used with `stream: true`. Every visible
content delta was printed as it arrived; the final request UUID was also checked
through the new owner-scoped usage endpoint.

Actual output:

```console
Container promptgate-gateway-1 Recreate
Container promptgate-gateway-1 Recreated
Container promptgate-gateway-1 Starting
Container promptgate-gateway-1 Started
Container promptgate-gateway-1 Waiting
Container promptgate-gateway-1 Healthy

BEGIN gemini-2.5-flash request_id=30c1f8f6-0f0d-4001-a7e1-1cbef357417b
Hi!
END gemini-2.5-flash chunks=1 content_chars=3 usage={"completion_tokens":2,"prompt_tokens":3,"total_tokens":20}
USAGE gemini-2.5-flash status=200 body={"request_id":"30c1f8f6-0f0d-4001-a7e1-1cbef357417b","model":"gemini-2.5-flash","streamed":true,"input_tokens":3,"output_tokens":17,"cost_micro_usd":44,"cost_estimated":false,"status":"ok"}

BEGIN deepseek-v4-flash request_id=665a6500-b123-4c45-8570-5acd3697e87a
Hi!
END deepseek-v4-flash chunks=64 content_chars=3 usage={"prompt_tokens":6,"completion_tokens":63,"total_tokens":69,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":60},"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":6}
USAGE deepseek-v4-flash status=200 body={"request_id":"665a6500-b123-4c45-8570-5acd3697e87a","model":"deepseek-v4-flash","streamed":true,"input_tokens":6,"output_tokens":63,"cost_micro_usd":19,"cost_estimated":false,"status":"ok"}

DEFERRED gpt-5.6-luna: OPENAI_API_KEY is not configured
DEFERRED claude-sonnet-5: ANTHROPIC_API_KEY is not configured
```

Exit code: `0`

The literal SQLite command and actual output were:

```console
$ sqlite3 data/promptgate.db \
  "SELECT model, streamed, first_token_ms, total_ms, cost_micro_usd FROM requests ORDER BY id DESC LIMIT 4;"
deepseek-v4-flash|1|1350|1379|19
gemini-2.5-flash|1|604|623|44
deepseek-v4-flash|1|1362|1441|
gemini-2.5-flash|1||767|
```

The first two rows are the passing from-start rerun. The bottom two are the
retained pre-correction failures documented above. A supplemental exact-row
query returned:

```console
665a6500-b123-4c45-8570-5acd3697e87a|deepseek-v4-flash|1|6|63|1350|1379|19|0|ok
30c1f8f6-0f0d-4001-a7e1-1cbef357417b|gemini-2.5-flash|1|3|17|604|623|44|0|ok
```

Both executed final rows have non-null tokens/cost,
`first_token_ms < total_ms`, `streamed=1`, `cost_estimated=0`, and
`status='ok'`.

## Live/deferred activation matrix

| Provider | Model | Result | Reason |
|---|---|---|---|
| Gemini | `gemini-2.5-flash` | **live pass** | Configured key; one-chunk compatible stream returned, exact usage/cost row persisted, sanitized direct fixture pair activated |
| DeepSeek | `deepseek-v4-flash` | **live pass** | Configured key; incremental reasoning/content stream returned, exact cache-aware usage/cost row persisted, sanitized direct fixture pair activated |
| OpenAI | `gpt-5.6-luna` | **deferred** | `OPENAI_API_KEY` is not configured; official-contract fixtures remain pending |
| Anthropic | `claude-sonnet-5` | **deferred** | `ANTHROPIC_API_KEY` is not configured; official-contract fixtures remain pending |

Offline adapter, pipeline, abort, metering, and fixture tests cover all four
approved providers. Missing-key checks are not described as live-green.

## Published-rate cost reconciliation

Rates are integer micro-USD per one million tokens from the approved
date-effective rows. Each component is rounded independently.

| Provider | Reconciliation | Persisted cost |
|---|---|---:|
| Gemini | ordinary input `round(3 × 300000 / 1e6) = 1`; billable output includes hidden thinking, `20 total - 3 prompt = 17`; output `round(17 × 2500000 / 1e6) = 43` | `44` micro-USD |
| DeepSeek | cache hit `round(0 × 2800 / 1e6) = 0`; cache miss `round(6 × 140000 / 1e6) = 1`; output `round(63 × 280000 / 1e6) = 18` | `19` micro-USD |

The independent local calculation printed:

```console
{"gemini_micro_usd":44,"deepseek_micro_usd":19}
```

## Local quality, build, Docker, and health

```console
$ pnpm lint
Checked 93 files in 153ms. No fixes applied.

$ pnpm test
Test Files  31 passed (31)
Tests       502 passed (502)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/shared build: Done
packages/gateway build: Done

$ docker compose ps
NAME                   IMAGE                SERVICE   STATUS                    PORTS
promptgate-gateway-1   promptgate-gateway   gateway   Up 32 seconds (healthy)   127.0.0.1:8787->8787/tcp

$ curl -s -i http://127.0.0.1:8787/healthz
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8

{"ok":true}

$ git diff --check
# no output; exit code 0
```

All automated tests remain offline. The only live traffic was the bounded
Verify matrix and the one direct capture pair per configured provider.

## Checkpoint A

GPT-5.6 Sol / xhigh independently audited the Phase 1-approved base through
final Phase 2 commit `b1b3f6e`, this evidence, the decision log, and the Phase 3
playbook. Verdict: **`proceed with adjustments`**.

The reviewer confirmed:

- all four provider paths honor GUIDE §§3.1–§3.5;
- routing/pricing agreement and optional-key boot behavior remain strict;
- native Anthropic and compatible OpenAI/Gemini/DeepSeek streaming, retry,
  abort, and metering paths preserve their provider-specific contracts;
- Gemini/DeepSeek live rows and fixture activation are exact;
- missing-key OpenAI/Anthropic checks are deferred without being called
  live-green;
- the owner-scoped usage lookup and client-abort metering are correct;
- the Phase 3 cache/budget plan remains implementable at the finalized seams;
- no Phase 3 code exists; and
- lint, 502 tests, strict build, fixture sanitization, and secret checks pass.

The only required adjustments were to commit this evidence, move
`PROGRESS.md` to awaiting human approval, link this file, and keep Phase 3 not
started. No implementation adjustment or blocker remains.

## Acceptance status

- Six numbered Phase 2 steps committed in documented order: **pass**.
- OpenAI, Anthropic, Gemini, and DeepSeek non-streaming/streaming code parity:
  **pass offline; checkpoint A confirmed**.
- Every configured provider streamed through the same OpenAI SDK client:
  **pass** (Gemini and DeepSeek).
- Missing provider keys explicitly named and deferred: **pass** (OpenAI and
  Anthropic).
- Configured-provider sanitized fixture pairs activated; unavailable-provider
  fixtures remain pending: **pass**.
- Every final live row has exact non-null metering, `streamed=1`,
  `first_token_ms < total_ms`, and `status='ok'`: **pass**.
- Owner-scoped streamed usage lookup returns the exact final row: **pass**.
- Client disconnect abort, estimated fallback, exact-usage abort, and iterator
  cleanup: **pass offline with real loopback coverage**.
- Lint, 502 tests, strict TypeScript build, Docker health, and HTTP 200 health:
  **pass**.
- Phase 3 work: **not started**.

No implementation or live-verification blocker remains. The project owner
explicitly approved the Phase 2 completion gate on 2026-07-26. Phase 3 has not
started.
