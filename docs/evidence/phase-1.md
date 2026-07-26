# Phase 1 verification evidence

Date: 2026-07-25

Status: **pass — human-approved on 2026-07-25**. Phase 2 has not started.

## Numbered commit sequence

Each numbered playbook step has one commit, in order:

```console
f96aa73 phase-1 step-1: define OpenAI wire schemas
9fff718 phase-1 step-2: seed approved model pricing
7ca395c phase-1 step-3: add admin API key management
9b1d4e8 phase-1 step-4: authenticate client API keys
c7ad759 phase-1 step-5: define the provider routing seam
b074fb6 phase-1 step-6: add the OpenAI adapter
3523510 phase-1 step-7: add the metered chat route
e68e5c4 phase-1 step-8: list available models
68ff2a2 phase-1 step-9: expand the provider pricing foundation
9da1f28 phase-1 step-10: add the DeepSeek adapter
2380c47 phase-1 step-11: add the Gemini adapter
0ab709c phase-1 step-12: integrate the new providers
```

The human-approved pre-verification amendments are isolated in:

```console
734c777 phase-1 correction: add Gemini 2.5 Flash
da35e4d phase-1 correction: count Gemini thinking tokens
```

## Verification setup

The current image was built explicitly before the literal block because
`docker compose up` does not rebuild an already-present image:

```console
$ docker compose build
# completed successfully
```

The checked-in pricing was seeded into the same root database mounted by
Compose. The explicit path avoids a package-relative working directory:

```console
$ node packages/gateway/dist/scripts/seed-pricing.js --db-path data/promptgate.db
# exit code 0

$ sqlite3 data/promptgate.db \
  "SELECT provider, model, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from
   FROM model_pricing
   WHERE model IN ('gemini-2.5-flash','gemini-2.5-flash-lite','deepseek-v4-flash')
   ORDER BY provider, model, effective_from;"
deepseek|deepseek-v4-flash|140000|2800|280000|2026-07-25
gemini|gemini-2.5-flash|300000|30000|2500000|2026-07-25
gemini|gemini-2.5-flash-lite|100000||400000|2026-07-25
```

No key value was printed or committed. `.env` is ignored by Git.

## Literal Verify block

The amended Phase 1 Verify block was run unchanged:

```bash
set -a
. ./.env
set +a
docker compose up -d --wait
KEY=$(curl -s -X POST localhost:8787/admin/api/keys -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"phase1-verify-$(date +%s)\"}" | jq -r .plaintext_key)
verify_model() {
  ENV_NAME="$1"
  MODEL="$2"
  if [ -z "$(printenv "$ENV_NAME")" ]; then
    echo "DEFERRED $MODEL: $ENV_NAME is not configured"
    return
  fi
  KEY="$KEY" MODEL="$MODEL" node --input-type=module -e '
    import OpenAI from "openai";
    const c = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: process.env.KEY });
    const r = await c.chat.completions.create({
      model: process.env.MODEL,
      messages: [{ role: "user", content: "say hi" }]
    });
    console.log(process.env.MODEL, r.choices[0].message.content, r.usage);
  '
}
verify_model GEMINI_API_KEY gemini-2.5-flash
verify_model DEEPSEEK_API_KEY deepseek-v4-flash
verify_model OPENAI_API_KEY gpt-5.6-luna
echo "DEFERRED claude-sonnet-5: Anthropic adapter is Phase 2"
sqlite3 data/promptgate.db "SELECT model, input_tokens, output_tokens, cost_micro_usd, status FROM requests ORDER BY id DESC LIMIT 3;"
```

Actual output:

```console
 Container promptgate-gateway-1 Recreate
 Container promptgate-gateway-1 Recreated
 Container promptgate-gateway-1 Starting
 Container promptgate-gateway-1 Started
 Container promptgate-gateway-1 Waiting
 Container promptgate-gateway-1 Healthy
gemini-2.5-flash Hi! { prompt_tokens: 3, completion_tokens: 2, total_tokens: 30 }
deepseek-v4-flash Hi! How can I help you today? {
  prompt_tokens: 6,
  completion_tokens: 60,
  total_tokens: 66,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 6,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 50 }
}
DEFERRED gpt-5.6-luna: OPENAI_API_KEY is not configured
DEFERRED claude-sonnet-5: Anthropic adapter is Phase 2
deepseek-v4-flash|6|60|18|ok
gemini-2.5-flash|3|27|69|ok
deepseek-v4-flash|6|49|15|ok
```

Exit code: `0`

The same repository-pinned OpenAI SDK client therefore reached both configured
Phase 1 providers through PromptGate.

## Live/deferred activation matrix

| Provider | Model | Result | Reason |
|---|---|---|---|
| Gemini | `gemini-2.5-flash` | **live pass** | Configured key; compatible response returned and exact request row persisted |
| DeepSeek | `deepseek-v4-flash` | **live pass** | Configured key; compatible response returned and exact request row persisted |
| OpenAI | `gpt-5.6-luna` | **deferred** | `OPENAI_API_KEY` is not configured |
| Anthropic | `claude-sonnet-5` | **deferred** | Anthropic adapter is Phase 2 and its key is not configured |

The unavailable checks are explicitly deferred as required; they are not
reported as passes.

## Token and cost reconciliation

All rates below are integer micro-USD per one million tokens from the approved
provider pricing rows. Each billing component is rounded independently. The
rates were checked against the official
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) pages.

| Provider | Reconciliation | Persisted cost | USD to 4 decimals |
|---|---|---:|---:|
| Gemini | ordinary input `round(3 × 300000 / 1e6) = 1`; billable output includes hidden thinking, `(30 total - 3 prompt) = 27`; output `round(27 × 2500000 / 1e6) = 68` | `69` micro-USD | `$0.0001` |
| DeepSeek | cache hit `round(0 × 2800 / 1e6) = 0`; cache miss `round(6 × 140000 / 1e6) = 1`; output `round(60 × 280000 / 1e6) = 17` | `18` micro-USD | `$0.0000` |

These amounts match the providers' published rates to the required fourth
decimal. On 2026-07-25, the project owner explicitly approved the independently
recorded official published-rate reconciliation plus persisted micro-USD rows
as the Phase 1 cost evidence in place of provider account-dashboard artifacts.
The acceptance criterion is therefore satisfied without overstating that an
account billing console was observed.

Supplemental persisted-row evidence:

```console
$ sqlite3 data/promptgate.db \
  "SELECT request_id, provider, model, input_tokens, output_tokens, cost_micro_usd, status
   FROM requests ORDER BY id DESC LIMIT 5;"
749b5a25-80e6-4bd7-b503-f8fc99a1bbd7|deepseek|deepseek-v4-flash|6|60|18|ok
069c3cb1-641c-463e-9c5c-be3d0665fcec|gemini|gemini-2.5-flash|3|27|69|ok
04e3a789-a176-475d-bf26-1536b3cb2688|deepseek|deepseek-v4-flash|6|49|15|ok
cae13aa8-3743-44fc-8763-3ab995402d99|gemini|gemini-2.5-flash|3|2|6|ok
```

The first two rows are the successful post-correction calls. The older Gemini
row at the bottom is retained as evidence of the resolved thinking-token defect
described below.

## Local quality, build, and health

```console
$ pnpm lint
Checked 69 files in 74ms. No fixes applied.

$ pnpm test
Test Files  20 passed (20)
Tests       204 passed (204)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/shared build: Done
packages/gateway build: Done

$ docker compose ps
NAME                   IMAGE                SERVICE   STATUS                   PORTS
promptgate-gateway-1   promptgate-gateway   gateway   Up 2 minutes (healthy)   127.0.0.1:8787->8787/tcp

$ curl -s -w '\nHTTP %{http_code}\n' http://localhost:8787/healthz
{"ok":true}
HTTP 200

$ git diff --check
# no output; exit code 0
```

All automated provider tests use injected fake fetch implementations; the test
suite makes no live provider calls.

## Resolved deviations

1. The first literal run reused a stale pre-integration Docker image. Both SDK
   calls returned local `404` responses before any provider call, and no request
   rows were written. Rebuilding the current image resolved this setup issue;
   the literal block itself was not changed.
2. The first live run against the current image exposed that Gemini's compatible
   `completion_tokens` excludes hidden thinking tokens even though Google bills
   them at the output rate. Commit `da35e4d` added validated Gemini-only
   reconciliation using `total_tokens - prompt_tokens`, while leaving the
   provider response unchanged. The corrected literal rerun is the passing
   output above.
3. The package-scoped source seed command resolved its default database path
   relative to the package. The verified built runner was therefore invoked
   with the explicit root path `data/promptgate.db`; this is an operational
   setup note, not a Phase 1 acceptance blocker.

## Acceptance status

- Same OpenAI SDK client reaches every configured Phase 1 provider: **pass**
  (Gemini and DeepSeek).
- Every executed live row has non-null tokens, cost, and `status='ok'`: **pass**.
- Every executed live cost matches the provider's published rates to the fourth
  decimal: **pass**.
- The project-owner-approved published-rate calculation and persisted
  micro-USD row are captured for every live call: **pass**.
- Unavailable activation checks are named and explicitly deferred: **pass**
  (OpenAI missing key; Anthropic scheduled for Phase 2).
- Lint, 204 tests, strict TypeScript build, Docker health, and HTTP health check:
  **pass**.
- Phase 2 work: **not started**.

No Phase 1 blocker remains. The project owner explicitly approved the Phase 1
completion gate on 2026-07-25. Phase 2 has not started.
