# Phase 8 evidence

Date started: 2026-07-30

Status: **in progress — step 3 complete; Truthfulness and Verify Amendment A
owner-approved; step 4 next**.

## Step 1 — persistent deployment and dogfood key

Phase 7 publication was complete before Phase 8 started:

- protected PR #12 refreshed both ordinary `ci` checks successfully;
- its same-version live evaluation passed in 13m13s;
- cleanup and aggregate `eval-gate` passed;
- the PR merged as `6f2d44ea2bcf118eccabb815d2fd459f4097bfb0`.

The Phase 8 branch was created from that exact merge. The pre-step repository
baseline passed all 852 tests in 67 files.

The exact merged Compose image was built and deployed on the host that contains
`web_builder_llm`:

```text
image_id=sha256:1070c675c80190765e3bc03ff778592bfb47ae89d3e1a5267fc9da34b737ccea
container=promptgate-gateway-1
listen=127.0.0.1:8787
status=running
health=healthy
database=existing persistent ./data/promptgate.db
```

The local `.env` was tightened to mode `0600`. Before the one-time key-creation
request, the process reserved an empty ignored handoff at
`data/web_builder_llm.key` with mode `0600`. It then created and re-read this
safe metadata:

```json
{
  "id": 26,
  "name": "web_builder_llm",
  "budget_micro_usd_month": 5000000,
  "rate_limit_rpm": 60,
  "disabled": false,
  "month_to_date_spend_micro_usd": 0
}
```

The 51-byte plaintext key was written directly to that ignored owner-only
handoff and was never emitted to output, logs, Git, or shell arguments. The
retained key authenticated successfully against `/v1/models`, which returned
six currently effective routed models.

An authenticated request-count query covering the Phase 7 merge through
`2026-07-31T05:12:59Z` returned `points: []` and total request count zero. Thus
image startup, health, admin metadata, and key-authentication checks caused no
provider request. No provider endpoint was called in step 1.

Final lint checked 178 files, all 852 tests in 67 files passed, Compose
configuration and diff checks passed, and the healthy container retained
restart count zero. A fresh independent read-only audit verified the exact
branch/diff, image/container/mount, ignored owner-only credential files, safe
key metadata, zero request-count metrics through `05:15:42Z`, and absence of a
tracked or container-logged `pg-*` key literal, then returned `APPROVE`.

## Step 2 — finished-repository contract resolution

The target repository is available at:

```text
/Users/f8fq/coding projects/Finished/web_builder_llm
commit=1fe570bb175834107409739703e03efdd5805fc2
branch=main
```

Its tracked source was clean. The unrelated pre-existing untracked
`TECH_STACK.md` was preserved, and no source, runtime, or Git state in that
repository changed.

### Provider configuration

`LlmProviderRegistry` loads an app-level JSON file selected by
`LLM_PROVIDERS_CONFIG` or `site.llm.providers.config`. Provider replacement is
whole-definition rather than merged, config stores an environment-variable name
rather than a literal key, and the normal key precedence is request-typed,
encrypted locally saved, then the named environment variable.

The retained secret-free definition is
`docs/evidence/phase-8/web-builder-promptgate-provider.json`. It specifies:

```text
providerId=promptgate
apiFamily=OPENAI_CHAT
authScheme=BEARER
baseUrl=http://127.0.0.1:8787/v1
defaultEnvKey=PROMPTGATE_API_KEY
jsonStrategy=NATIVE_JSON_OBJECT
defaultModels=[deepseek-v4-flash]
```

The repository blocks loopback/private base URLs by default as a key-exfiltration
defense. This trusted same-host deployment must therefore launch with the
explicit Spring property `site.llm.allowPrivateBaseUrls=true`.

### `GET /v1/models`

The app does call the endpoint, but not at startup or ordinary provider
selection:

1. OpenAI-compatible key validation sends an authenticated
   `GET {baseUrl}/models`.
2. After successful validation, the frontend performs its live-model lookup
   through `/api/models`; `ModelController` asks the same client for its model
   list, causing a second authenticated `GET {baseUrl}/models`.
3. A failed or empty live listing falls back to the configured default models.

For the retained definition, the exact upstream URL is
`http://127.0.0.1:8787/v1/models`.

### Tools and streaming truthfulness

The PromptGate-facing `OpenAiChatLlmClient` sends no tools. Its request contains
the selected model, one user message, `response_format: {"type":"json_object"}`,
and optional sampling fields. The native Anthropic client is the separate path
that sends tools, already resolved and implemented in Phase 2.

The inspection exposed an authority mismatch in the then-current wording. The finished app's OpenAI
Chat client uses a buffered string response and does not send `stream: true`.
Its documented SSE endpoint replays progress events only after synchronous
generation has completed; it is not provider-token streaming. Before Amendment
A, Phase 8 step 3 could not truthfully claim the live token-streaming UX check
as then worded, and the phase had no literal final Verify block even though the
orchestrator requires one for every phase.

The resulting narrow synchronized amendment:

- verifies the existing buffered generation/progress UX without claiming
  provider-token streaming; and
- adds a literal Phase 8 Verify block covering at least seven days of durable
  `web_builder_llm` rows, normal generate/edit success through PromptGate,
  registry `pg_prompt` use plus rollback proof, Overview/Drift screenshots and
  required figures, the scheduled contract result with missing credentials
  named `SKIPPED`, and README deliverable links.

### Opus/max authority verdict

Per the project owner's escalation instruction, Claude Opus at max effort
reviewed the supplied authority and source facts. Its verdict was
`PROCEED WITH ADJUSTMENTS`.

The review rejected implementing token streaming in `web_builder_llm` because
that would widen Phase 8 into a new transport feature in a separate finished
application. It recommended:

- clarify step 3 as the existing buffered request/response plus post-completion
  progress replay, and assign token-stream proof to contract-nightly;
- report missing provider credentials as named skips, fail a configured
  provider's contract break red, and fail if zero providers are configured;
- make the registry `pg_prompt` live before opening the seven-day observation
  window;
- state the cache-savings formula and direct-vs-proxied p95 method so cache hits
  cannot make proxy overhead look artificially favorable; and
- add a literal Verify block covering deployment/key cap, resolved TODOs,
  buffered normal flows and durable rows, live `pg_prompt`, the observation
  window, dashboard screenshots/figures, rollback evidence, scheduled contract
  evidence, README links, and final owner approval.

## Owner-approved Truthfulness and Verify Amendment A

On 2026-07-31, the project owner explicitly approved Phase 8 Truthfulness and
Verify Amendment A. `BUILD_PLAYBOOK.md`, `IMPLEMENTATION_GUIDE.md`,
`PROGRESS.md`, and this evidence file are synchronized under that authority.
The project idea remains unchanged.

The approved contract:

- verifies `web_builder_llm`'s existing buffered request/response plus
  post-completion progress replay in normal generate/edit flows, without
  claiming provider-token streaming or adding a new transport feature;
- assigns live streaming and non-streaming adapter proof to
  `contract-nightly.yml`;
- reports every missing credential as a named `SKIPPED` provider, makes any
  configured provider contract failure red, and makes zero configured
  providers red;
- requires the registry-backed `pg_prompt` call to be live before the
  observation window starts;
- requires at least seven consecutive calendar days with the registry-backed
  path live and at least one real dogfood request on five of those days;
- calculates cache dollars saved as the sum of retained
  `cache_saved_micro_usd` over known cache-hit rows, with exact and estimated
  sums separate and the count of excluded unknown legacy hits reported
  separately;
- calculates gateway p95 overhead as proxied p95 minus direct p95 with the same
  model, prompt, sample size, and measurement window while excluding cache
  hits;
- proves rollback through a confirmed registry-label change and the next live
  dogfood call/version; and
- adds the literal final Verify block covering the healthy deployment and $5
  key, resolved TODOs, buffered normal flows and rows, live `pg_prompt`,
  observation evidence, screenshots and figures, a green schedule-triggered
  contract run, README links, and final owner approval.

### Amendment validation

The synchronized amendment passed the repository gate:

```text
lint: 179 files checked
tests: 67 files, 852 tests passed
compose configuration: valid
git diff check: clean
```

An independent read-only audit initially found stale guide TODO/risk wording,
pre-amendment evidence written in the present tense, and a missing requirement
to report the count of unknown legacy cache hits separately. Those findings
were corrected. The fresh re-audit checked the complete diff against every
approved Amendment A element and returned `APPROVE`.

## Step 3 — buffered dogfood verification and lifecycle recovery

The normal external flow ran through the real built PromptGate deployment and
the finished app's existing UI. The original finished repository remained
unchanged at tracked commit
`1fe570bb175834107409739703e03efdd5805fc2`, including its unrelated
pre-existing untracked `TECH_STACK.md`. To avoid changing that repository, an
ignored local clone under PromptGate's `data/` directory supplied the dogfood
runtime. Its only external-app correction makes the OpenAI Chat request timeout
configurable, keeps the 90-second default, and uses 135 seconds for this
dogfood deployment. The isolated external suite passed all 377 tests, and an
independent review returned `APPROVE`; the local clone records the change as
`5335d9f`.

The first PromptGate generation used the exact prompt:

```text
Phase 8 dogfood 2026-07-31: Create a compact single-page landing page for a fictional neighborhood bike repair shop named Copper Spoke. Include a hero, three services, business hours, and a contact call to action. Use accessible high-contrast colors. Text only; do not request or generate images.
```

It created project `0036b6e2b6254e1795313ac555032eb0` and immutable active
snapshot `2f03a5dae74b4e3f8494cb112c93f96e`. The app visibly replayed `START`,
provider `STATUS`, `TOKEN_COUNT`, and `DONE` only after the buffered provider
call completed. PromptGate retained request row 425 with request ID
`39c2467d-b392-452c-af6c-450733f0a0aa`, model `deepseek-v4-flash`, 574 input
tokens, 7,962 output tokens, exact cost 2,309 micro-USD, cache miss,
non-streaming status, `ok`, and 48,141 ms total latency.

The first edit used this exact prompt:

```text
Phase 8 dogfood edit 2026-07-31: Add a compact accessible FAQ section with exactly three questions below the business hours. Keep all existing sections and remain text-only.
```

That attempt exposed two independent timeout/lifecycle facts:

1. `web_builder_llm` stopped waiting at its fixed 90-second timeout before
   PromptGate's 120-second upstream timeout, so the UI reported failure even
   though the provider later completed.
2. PromptGate's non-streaming persistence depended on Fastify `onResponse`.
   Once the client disconnected, that hook did not retain a row or reconcile
   the in-memory budget reservation for the completed provider response.

The response still populated PromptGate's cache with an exact priced value of
5,089 micro-USD. There was no corresponding request row anywhere in the live
database. That cache-entry/row mismatch is retained as proof of one known
pre-fix orphaned provider completion; no synthetic row was inserted and no
historical spend was backfilled.

After the narrow external timeout correction, repeating the edit returned the
already-completed cached result in 33 ms. It created snapshot
`e90ee6af4ef04b1eb5ac8c4d46f71679`, retained row 426 with request ID
`cd6ca2e6-9a6e-45b4-821a-8e09a62bbc93`, 2,668 input and 16,838 output tokens,
cache hit, exact saved cost 5,089 micro-USD, zero charged cost, non-streaming
status, and `ok`. The page retained every prior section and contained exactly
three FAQ questions. The app again replayed the four progress events only after
completion; this is buffered UX proof, not token-streaming proof.

### Lifecycle correction

PromptGate commit `f6cd9fa335ebfed300018b5d8de9c156917e2a74`
(`fix: persist buffered disconnect outcomes`) makes non-streaming disconnect
settlement explicit. A client disconnect now aborts the upstream operation,
persists exactly one `client_aborted` row with conservative prompt-only
estimated metering when no completion was received, and reconciles the budget
only after durable logging. Buffered success and cache-hit flushes release
their lifecycle state. First-cause semantics preserve an earlier
`provider_error` or timeout if the client disconnects during cleanup. Adjacent
pre-header streaming timeout/provider-error cleanup received the same
first-cause protection.

Seven real-loopback regressions cover the corrected lifecycle paths. The final
focused suite passed 71/71, lint checked 179 files, the exact clean-build
repository run passed all 859 tests in 67 files, all packages built, Compose
configuration was valid, and diff checks were clean. Earlier non-authoritative
full runs encountered unrelated five-second load-test scheduling timeouts and,
once, stale/missing generated eval artifacts; the affected isolated tests were
green, and the clean build followed by the exact full test command is the
authoritative result.

Docker Desktop failed while the persistent deployment was being inspected and
the old container exited 255. A controlled Docker Desktop restart restored the
engine. Before rebuilding, the old image was started once and its admin API
proved the persistent database was intact: key 26 still had its exact $5 cap
and the two durable rows above. No host-side SQLite connection was opened while
the gateway was live. The exact corrected source was then rebuilt and
force-recreated as:

```text
commit=f6cd9fa335ebfed300018b5d8de9c156917e2a74
image_id=sha256:b0b39a7bffe71e7a4b7e3ffd9231d3ad470175edffca9ff362fcd12c61a4e0b8
container=promptgate-gateway-1
listen=127.0.0.1:8787
status=running
health=healthy
restart_count=0
database=existing persistent ./data/promptgate.db
```

The post-fix live edit used the unique prompt:

```text
Phase 8 post-fix accounting 2026-07-31-A: Add one short visible sentence reading exactly 'Walk-ins welcome.' immediately before the contact call to action. Preserve every existing section, including exactly three FAQ questions, and remain text-only.
```

The app remained in `Applying edit…` with no progress events while the
buffered call ran, then succeeded with snapshot
`18e7ea04b0ce487c9a6ef0937a4726fc`, parent
`e90ee6af4ef04b1eb5ac8c4d46f71679`. The page preserved exactly three FAQ
questions and visibly added `Walk-ins welcome.` in the requested position.
Only after completion did the UI replay `START`, provider `STATUS`,
`TOKEN_COUNT`, and `DONE`.

PromptGate durably retained row 427 with request ID
`f02b20d9-75c1-4320-a1ca-cf56f07bb2ad`, model
`deepseek-v4-flash`, 3,157 input and 15,968 output tokens, exact cost 4,913
micro-USD, cache miss, non-streaming status, `ok`, and 85,962 ms total latency.
The row's prompt ID/version are null as expected before step 4 introduces the
registry-backed request. Safe key metadata then showed the key enabled at its
unchanged 60 RPM and 5,000,000-micro-USD monthly cap with 7,222 micro-USD
retained month-to-date spend.

### Truthful accounting and direct comparison

At the step boundary, the live database therefore contains exactly three
durable dogfood rows: two uncached successful rows and one cached successful
row. Retained spend is 7,222 micro-USD. Known exact cache savings are 5,089
micro-USD, with zero estimated savings and zero unknown legacy cache-hit rows.
Separately, the known pre-fix orphaned provider completion cost 5,089
micro-USD, so known provider-priced completions total 12,311 micro-USD. The
retained month-to-date ledger omits that orphan; the two figures must not be
presented as equivalent.

A separate direct `deepseek/deepseek-chat` generation used the exact original
generation prompt and created project `541e5c1614324eacbd40da50c9e17b65`
with active snapshot `73ff498ff04c4ebca266860065952050`. It showed the same
buffered UX: no progress events while generating, then the four events replayed
after completion. Because the direct provider/model identity is not the same as
PromptGate's routed `deepseek-v4-flash`, this call is only a buffered-behavior
control and is excluded from the Amendment A matched p95 calculation.

A fresh independent read-only evidence/security audit verified the source,
clean-build 859-test gate, exact live image and persistent mount, safe key
metadata, rows 425–427, retained spend/savings, separate orphan disclosure,
untouched original repository, isolated timeout patch, p95 exclusion, and
closed observation window. It found no credential leakage or overclaim and
returned `APPROVE`.

Step 4 will now put `web_builder_request@prod` live, prove a version-label
canary and rollback with the next dogfood call, and only after the rolled-back
call succeeds may the seven-day observation window open.
