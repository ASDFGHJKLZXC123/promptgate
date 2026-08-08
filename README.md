# PromptGate

PromptGate is a single-tenant, self-hosted LLMOps gateway. It exposes the
OpenAI Chat Completions subset used by its client applications while routing to
OpenAI, Anthropic, Gemini, and DeepSeek. Around that routing layer it adds
per-request cost and latency metering, exact-match caching, per-key budgets and
rate limits, an immutable prompt registry, a regression-evaluation harness,
and a built-in operations dashboard.

Phase 8 closeout is in progress. The seven-day dogfood observation, closing
analysis, and required green **schedule-triggered** provider contract run are
complete; exact final-merge deployment verification and final owner approval
remain.

## Quick start

Prerequisites are Node.js 22, pnpm 10.33.0, and Docker Compose.

```sh
cp .env.example .env
chmod 600 .env
# Set a strong ADMIN_TOKEN and only the provider keys you intend to use.
pnpm install --frozen-lockfile
pnpm build
pnpm test
docker compose up --build -d
curl --fail http://127.0.0.1:8787/healthz
```

Compose publishes the gateway only on `127.0.0.1:8787`. The dashboard is
served at the same origin and asks for the admin token in memory. Create a
bounded client key through the admin API before sending model requests. See
the [implementation guide](IMPLEMENTATION_GUIDE.md) for the API, provider,
registry, evaluation, and deployment contracts.

## Phase 8 dogfood case study

The existing `web_builder_llm` application was routed through PromptGate using
the dedicated `web_builder_llm` key, capped at **$5 per month and 60 RPM**. One
of its request envelopes was migrated to the registry as
`web_builder_request@prod`; durable gateway rows identify prompt ID 4 and the
resolved immutable version.

The inclusive observation window ran from **2026-07-31 through 2026-08-06**.
All seven local calendar days contain real registry-backed dogfood traffic, and
six distinct days contain a successful qualifying request, exceeding the
required five-of-seven floor. The final day's single logical edit produced two
durable `client_aborted` rows through the application's bounded internal retry,
so it is counted as traffic but not as a successful day. No extra request was
sent merely to make that day green.

### Buffered-client boundary

`web_builder_llm` uses a buffered response body and does not request provider
token streaming. During successful generate and edit flows, its UI waits for
the synchronous model call and then replays `START`, provider `STATUS`,
`TOKEN_COUNT`, and `DONE`. This proves the existing buffered request/response
and post-completion progress UX, not token-by-token streaming. Live streaming
coverage belongs to the provider contract workflow described below.

### Spend and cache savings

PromptGate stores money as integer micro-USD. The fifteen retained dogfood rows
sum to **18,977 micro-USD ($0.018977)**: 17,122 micro-USD exact and 1,855
micro-USD conservative estimated spend from aborted requests.

One provider completion predating the buffered-disconnect persistence fix had
an exact price of 5,089 micro-USD but no request row. It remains separately
disclosed rather than being backfilled. Adding it produces
**24,066 micro-USD ($0.024066) orphan-inclusive accounting**: 22,211 micro-USD
of known exact provider-priced completions plus 1,855 micro-USD of conservative
abort estimates. The retained ledger and orphan-inclusive figure are not
interchangeable.

Known cache savings use this retained-row formula:

```text
sum(cache_saved_micro_usd)
for retained rows where cache_hit = 1
and cache_saved_micro_usd is known
```

The dogfood result is **5,089 exact micro-USD ($0.005089)** saved,
**0 estimated micro-USD**, and **0 excluded unknown legacy cache-hit rows**.
The equal numeric value of the known pre-fix orphan is a separate accounting
fact, not an additional cache-savings claim. The complete row-level narrative
is retained in the [Phase 8 evidence](docs/evidence/phase-8.md).

### Matched p95 latency

The latency method was committed before benchmark traffic. It used the same
`deepseek-v4-flash` model and a byte-identical buffered request body in both
arms, 20 measured calls per arm, one excluded warm-up per arm, balanced AB/BA
interleaving in the same 37.101-second window, and nearest-rank p95 at rank 19.
Every measured proxied request was a PromptGate cache miss, and every response
reported the same 9 input, 2 output, and 11 total tokens with no provider-cache
hits.

| Arm | p95 |
|---|---:|
| Direct provider | 1,042.557 ms |
| Through PromptGate | 1,041.012 ms |
| Proxied minus direct | **-1.545 ms** |

The negative signed delta is interpreted as **no measurable positive gateway
overhead in this small provider-variance-dominated sample**. It is not evidence
that PromptGate accelerates the provider. This measures complete buffered JSON
response time, not first-token or streaming latency. The predeclared method and
raw observations are in the
[latency sample](docs/evidence/phase-8/latency-sample.json).

### Registry rollback

The `prod` label was first pointed to canary v2. A live dogfood edit recorded
prompt ID 4/version 2. The label was then moved from v2 back to v1, and the
very next unchanged app request—without an app restart—recorded prompt ID
4/version 1. The two rendered outputs were byte-identical, proving that the
served prompt version can be rolled back independently of a client deployment.
`prod` remains at immutable v1. See the
[rollback evidence](docs/evidence/phase-8.md#confirmed-rollback-and-next-call--prod--v1)
and [rollback commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/6c8ab5b73ee176020c56dd600b28b0f2e42ffdf5).

### Closing dashboard

[![PromptGate closing Overview dashboard](docs/evidence/phase-8/overview.png)](docs/evidence/phase-8/overview.png)

The Overview's data/DOM and original browser capture predate benchmark traffic.
The current PNG was re-encoded afterward without refreshing that 439-request
view, so benchmark rows 440–460 are absent even though the PNG file time is
later. Its `$0.12` known global subtotal and database-wide unknown-pricing
caveats are broader than the dogfood-only accounting above; the dogfood key is
shown at `$0.01 of $5.00`.

[![PromptGate closing Quality Drift dashboard](docs/evidence/phase-8/quality-drift.png)](docs/evidence/phase-8/quality-drift.png)

Quality Drift shows five retained eval runs in one dataset-hash series and the
v1-to-v2 prompt change marker. Historical judge identity was not persisted, so
the chart supplies change context without claiming that the prompt or model
caused a score movement.

### Nightly live contracts

[`contract-nightly.yml`](.github/workflows/contract-nightly.yml) runs on a
daily schedule and by manual dispatch. For each configured provider it makes
one minimal non-streaming request and one minimal streaming request and
validates the response/chunk contract. A missing credential is reported as a
named `SKIPPED` result, a configured provider failure makes the workflow red,
and zero configured providers also makes it red.

> **Schedule-triggered run evidence:** [run
> `31251691537`](https://github.com/ASDFGHJKLZXC123/promptgate/actions/runs/31251691537)
> succeeded on 2026-08-08 for exact default-branch commit
> `120dfb75be4405f5ba295a79485bddcaf0ef2155`. OpenAI/Luna and DeepSeek/V4
> Flash each passed both live modes. Anthropic/Sonnet and Gemini/Flash were
> named `SKIPPED` because their credentials were unconfigured, so neither was
> live-verified in this qualifying run. Totals: 2 configured, 2 passed, 0
> failed, and 2 skipped.

## Security and retention boundaries

- Exact-match caching still applies when `temperature > 0`; temperature is
  part of the key, so an identical parameter set reuses an identical response.
  Use `pg_no_cache: true` when a live provider response is required.
- Cached responses in `cache_entries` and versioned prompts in
  `prompt_versions` are stored in **plaintext SQLite**. Do not route secrets
  through this single-tenant deployment unless that at-rest model is
  acceptable.
- The default cache TTL is **24 hours**. The documented default raw request
  retention window is **90 days**.
- Provider keys and `ADMIN_TOKEN` belong only in the gitignored `.env` or CI
  secret store. Keep the loopback binding unless a TLS-terminating reverse
  proxy protects remote access.

## Deliverables

The original five deliverables map to the following implementation and
evidence. The project idea file remains unchanged.

| # | Deliverable | Evidence |
|---:|---|---|
| 1 | Four-provider gateway with metering, caching, and per-key budgets | [Four-provider evidence](docs/evidence/phase-2.md), [cache/budget evidence](docs/evidence/phase-3.md), [nightly workflow](.github/workflows/contract-nightly.yml), [green scheduled contract run](https://github.com/ASDFGHJKLZXC123/promptgate/actions/runs/31251691537), [provider completion commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/155d56792e8fa3d16ab91c3b5c8aacb71605fa73), [limits completion commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/76ff0404c406be23ee6f0183fc0ac6f7d3f65950) |
| 2 | Prompt registry with immutable history and diff/rollback | [Phase 4 evidence](docs/evidence/phase-4.md), [live dogfood rollback](docs/evidence/phase-8.md#confirmed-rollback-and-next-call--prod--v1), [registry completion commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/bd2a4de84d57628485a21ed72ff88c224dbfe1f1), [Phase 8 rollback commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/6c8ab5b73ee176020c56dd600b28b0f2e42ffdf5) |
| 3 | Eval harness, one golden dataset, and CI regression gate | [Eval evidence](docs/evidence/phase-5.md), [golden dataset](packages/evals/datasets/safety_screening.yaml), [CI evidence](docs/evidence/phase-6.md), [`eval-gate.yml`](.github/workflows/eval-gate.yml), [eval completion commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/a19468c37f1e24d2fe52c3dc298887305b8b2d6b), [CI workflow commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/0461418b1e7d85afd0c2c19abb66a676d474dded) |
| 4 | Cost and quality-drift dashboard | [Overview screenshot](docs/evidence/phase-8/overview.png), [Quality Drift screenshot](docs/evidence/phase-8/quality-drift.png), [Phase 7 evidence](docs/evidence/phase-7.md), [dashboard completion commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/408c65552378c6d18d7d9905437b2f30ff7fc629) |
| 5 | Existing-app dogfood proof through PromptGate | [Phase 8 evidence](docs/evidence/phase-8.md), [seven-day close commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/b2a0dee91ec619788bbd1821562cc88415dd1f4c), [matched-latency method commit](https://github.com/ASDFGHJKLZXC123/promptgate/commit/a7aabe9c2f86a9bde610a4b5167e403976b7867b) |
