# Phase 8 evidence

Date started: 2026-07-30

Status: **in progress — step 2 complete; step 3 requires an owner-approved
truthfulness/Verify amendment**.

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

The inspection also exposed an authority mismatch. The finished app's OpenAI
Chat client uses a buffered string response and does not send `stream: true`.
Its documented SSE endpoint replays progress events only after synchronous
generation has completed; it is not provider-token streaming. Therefore Phase
8 step 3 cannot truthfully claim a live token-streaming UX check as currently
worded. Separately, Phase 8 has no literal final Verify block even though the
orchestrator requires one for every phase.

Before step 3, the owner must approve a narrow synchronized amendment that:

- verifies the existing buffered generation/progress UX without claiming
  provider-token streaming; and
- adds a literal Phase 8 Verify block covering at least seven days of durable
  `web_builder_llm` rows, normal generate/edit success through PromptGate,
  registry `pg_prompt` use plus rollback proof, Overview/Drift screenshots and
  required figures, the scheduled contract result with missing credentials
  named deferred, and README deliverable links.

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

This is an advisory verdict, not authority to edit the playbook or guide.
