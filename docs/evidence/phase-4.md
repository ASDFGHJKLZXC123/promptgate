# Phase 4 verification evidence

Date: 2026-07-26

Status: **pass — human-approved on 2026-07-26**. Phase 5 has not started.

## Commit sequence

Each numbered Phase 4 playbook step has one commit, in order:

```console
adf8de6 phase-4 step-1: add immutable prompt registry schema
a009614 phase-4 step-2: add deterministic template rendering
d7df33a phase-4 step-3: add transactional prompt registry DAO
e97c838 phase-4 step-4: add prompt registry admin API
7dc7cf8 phase-4 step-5: integrate prompt resolution pipeline
```

## Changed-file scope

Relative to the human-approved Phase 3 gate (`76ff040`), the five numbered
implementation commits changed 21 files: 2,521 insertions and 32 deletions.
This evidence file and the final `PROGRESS.md` update are the additional
completion records.

```console
M  PROGRESS.md
M  packages/gateway/package.json
A  packages/gateway/src/admin/prompts.test.ts
A  packages/gateway/src/admin/prompts.ts
A  packages/gateway/src/db/migrations/004_registry.sql
A  packages/gateway/src/db/registry.migration.test.ts
M  packages/gateway/src/pipeline/handler.test.ts
M  packages/gateway/src/pipeline/handler.ts
A  packages/gateway/src/pipeline/prompt-resolve.test.ts
A  packages/gateway/src/pipeline/prompt-resolve.ts
M  packages/gateway/src/pipeline/requests.dao.test.ts
M  packages/gateway/src/pipeline/requests.dao.ts
A  packages/gateway/src/registry/dao.test.ts
A  packages/gateway/src/registry/dao.ts
M  packages/gateway/src/server.ts
M  packages/shared/src/index.ts
A  packages/shared/src/template.test.ts
A  packages/shared/src/template.ts
M  packages/shared/src/wire/pg-extensions.test.ts
M  packages/shared/src/wire/pg-extensions.ts
M  pnpm-lock.yaml
```

No eval-harness, CI-gate, dashboard, dogfood, fifth-provider, or Phase 5
implementation was added.

## Verification setup

The exact final numbered Phase 4 commit was built before the live gate:

```console
$ git rev-parse HEAD
7dc7cf84cc0a6091760f20706a76ba43f91bd4d8

$ pnpm lint
Checked 114 files in 303ms. No fixes applied.

$ pnpm test
Test Files  42 passed (42)
Tests       593 passed (593)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/shared build: Done
packages/gateway build: Done

$ docker compose build gateway
Image promptgate-gateway Built
manifest list sha256:5fb8538c69fb6b3890f233d25b1c02611a589a230d3bfa2ceac491f2d8bb9efd

$ docker compose up -d --force-recreate --wait gateway
Container promptgate-gateway-1 Recreated
Container promptgate-gateway-1 Started
Container promptgate-gateway-1 Healthy

$ curl -i http://127.0.0.1:8787/healthz
HTTP/1.1 200 OK
{"ok":true}
```

The first sandboxed full-suite attempt passed 588 of 593 tests; the five
real-socket streaming tests could not bind `127.0.0.1` and reported
`listen EPERM`. The identical suite was rerun with local-loopback permission
and all 593 tests passed. This was an execution-sandbox restriction, not a
test assertion or product failure.

No credential value was printed or committed. `.env` remains ignored by Git.
Presence-only inspection returned:

```console
ADMIN_TOKEN: present
GEMINI_API_KEY: present
DEEPSEEK_API_KEY: present
OPENAI_API_KEY: absent
ANTHROPIC_API_KEY: absent
```

The registry list was empty before the literal fixture was created. All HTTP
verification traffic used the Compose loopback publication. Host SQLite reads
were made only after a graceful gateway stop so Docker Desktop checkpointed
the bind-mounted WAL; the exact same image was restarted and health-checked
afterward.

## Literal Phase 4 Verify output

### Create the prompt and immutable versions

The playbook's `greet` prompt, English v1, French v2, and initial `prod` label
were created in the documented order:

```bash
AT="x-admin-token: $ADMIN_TOKEN"; H='content-type: application/json'
curl -sS -i -X POST localhost:8787/admin/api/prompts \
  -H "$AT" -H "$H" -d '{"slug":"greet"}'
curl -sS -i -X POST localhost:8787/admin/api/prompts/greet/versions \
  -H "$AT" -H "$H" \
  -d '{"messages_json":[{"role":"system","content":"Reply in English. {{style}}"}],"variables_json":[{"name":"style","required":true}]}'
curl -sS -i -X POST localhost:8787/admin/api/prompts/greet/versions \
  -H "$AT" -H "$H" \
  -d '{"messages_json":[{"role":"system","content":"Reply in French. {{style}}"}],"variables_json":[{"name":"style","required":true}]}'
curl -sS -i -X PUT localhost:8787/admin/api/prompts/greet/labels/prod \
  -H "$AT" -H "$H" -d '{"version":2}'
```

The first command used the explicit equivalent loopback spelling
`http://127.0.0.1:8787`; the remaining literal admin commands used
`localhost:8787`. Both address the same Compose publication. The admin token
was expanded only inside the shell and was not captured.

Actual responses:

```console
$ POST /admin/api/prompts {"slug":"greet"}
HTTP/1.1 200 OK
{"id":1,"slug":"greet","description":null}

$ POST /admin/api/prompts/greet/versions
HTTP/1.1 200 OK
{"prompt_id":1,"version":1,"messages_json":"[{\"role\":\"system\",\"content\":\"Reply in English. {{style}}\"}]","variables_json":"[{\"name\":\"style\",\"required\":true}]","notes":null}

$ POST /admin/api/prompts/greet/versions
HTTP/1.1 200 OK
{"prompt_id":1,"version":2,"messages_json":"[{\"role\":\"system\",\"content\":\"Reply in French. {{style}}\"}]","variables_json":"[{\"name\":\"style\",\"required\":true}]","notes":null}

$ PUT /admin/api/prompts/greet/labels/prod {"version":2}
HTTP/1.1 200 OK
{"prompt_id":1,"label":"prod","from_version":null,"to_version":2}
```

### Same client body, label-only rollback

The authoritative rollback pair used `gemini-2.5-flash`,
`pg_prompt: "greet@prod"`, `pg_vars: {"style":"tersely"}`, and
`pg_no_cache: true`. Both calls used the exact same serialized client body:

```console
Identical rollback client-body SHA-256:
a5c402c9edf0785066693e7906c62ac4b7dbfe1a05de331373a51206ae6f4e1c

Deploy v2:
{"prompt_id":1,"label":"prod","from_version":1,"to_version":2}

Gemini greet@prod at v2: HTTP 200
{"model":"gemini-2.5-flash","content":"Salut.","usage":{"prompt_tokens":14,"completion_tokens":2,"total_tokens":37}}

Rollback to v1:
{"prompt_id":1,"label":"prod","from_version":2,"to_version":1}

Gemini unchanged body at v1: HTTP 200
{"model":"gemini-2.5-flash","content":"Hello.","usage":{"prompt_tokens":14,"completion_tokens":2,"total_tokens":38}}

Observed rollback behavior: v2=Salut. ; v1=Hello.
```

Only the server-side label changed between the two calls. The first answer was
French and the next was English, with no client-body or application deploy
change.

After a graceful WAL checkpoint, the playbook's literal SQLite query returned:

```console
$ sqlite3 data/promptgate.db \
  "SELECT prompt_id, prompt_version FROM requests ORDER BY id DESC LIMIT 2;"
1|1
1|2
```

The supplemental durable rows show exact model, version, usage, and
micro-USD attribution:

```console
id  provider  model             status  cache_hit  input_tokens  output_tokens  cost_micro_usd  prompt_id  prompt_version
53  gemini    gemini-2.5-flash  ok      0          14            24             64              1          1
52  gemini    gemini-2.5-flash  ok      0          14            23             62              1          2
```

The normalized output-token counts include Gemini's validated hidden-thinking
usage; the client response's visible `completion_tokens` alone does not.

### Registry list, label history, and unified diff

The list endpoint reports the latest immutable version separately from the
current mutable label:

```console
HTTP/1.1 200 OK
[{"id":1,"slug":"greet","description":null,"created_at":"2026-07-27 02:44:07","latest_version":2,"labels":[{"label":"prod","version":1}]}]
```

Every deployment and rollback was appended to `label_history`:

```console
prompt_id  label  from_version  to_version  moved_at
1          prod                 2           2026-07-27 02:44:36
1          prod   2             1           2026-07-27 02:47:02
1          prod   1             2           2026-07-27 02:47:47
1          prod   2             1           2026-07-27 02:47:48
```

The version diff endpoint returned HTTP 200, `text/plain`, and a stable,
line-based unified diff:

```diff
===================================================================
--- greet@1.messages.json
+++ greet@2.messages.json
@@ -1,6 +1,6 @@
 [
   {
-    "content": "Reply in English. {{style}}",
+    "content": "Reply in French. {{style}}",
     "role": "system"
   }
 ]
```

### Database-enforced immutability

Direct mutation attempts were blocked independently of the DAO:

```console
$ sqlite3 data/promptgate.db \
  "UPDATE prompt_versions SET notes = 'mutated' WHERE prompt_id = 1 AND version = 1;"
Error: stepping, prompt_versions is immutable (19)

$ sqlite3 data/promptgate.db \
  "DELETE FROM prompt_versions WHERE prompt_id = 1 AND version = 2;"
Error: stepping, prompt_versions is immutable (19)
```

Both immutable rows remained present with their original message and variable
JSON.

### Safe prompt-resolution failures

Two extra requests exercised the new error taxonomy before provider dispatch:

```console
Unknown prompt: HTTP 404
{"error":{"message":"Prompt not found.","type":"invalid_request_error","code":"prompt_not_found"}}

Missing required style: HTTP 400
{"error":{"message":"Missing prompt variables: style.","type":"invalid_request_error","code":"prompt_var_missing"}}
```

The durable rows contain no invented usage or cost. The resolved missing-var
failure retains exact v1 attribution; the unresolved reference does not:

```console
id  status           error_code          input_tokens  output_tokens  cost_micro_usd  prompt_id  prompt_version
55  rejected_prompt  prompt_var_missing                                               1          1
54  rejected_prompt  prompt_not_found
```

## Configured-provider activation matrix

The project owner supplied both configured provider keys and authorized this
bounded Verify window. Both available providers were exercised through prompt
registry resolution on the exact rebuilt image.

| Provider | Key state | Verification outcome |
|---|---|---|
| Gemini | configured | live rollback pair passed: v2 `Salut.`, v1 `Hello.`; exact prompt versions persisted |
| DeepSeek | configured | live registry-path call returned HTTP 200 and `Hello`; exact v1 attribution persisted |
| OpenAI | absent | explicitly deferred — missing `OPENAI_API_KEY` |
| Anthropic | absent | explicitly deferred — missing `ANTHROPIC_API_KEY` |

DeepSeek's bounded activation output and durable row were:

```console
DeepSeek registry-path check: HTTP 200
{"model":"deepseek-v4-flash","content":"Hello","usage":{"prompt_tokens":20,"completion_tokens":45,"total_tokens":65,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":20,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":43}}}

id  provider  model                status  input_tokens  output_tokens  cost_micro_usd  prompt_id  prompt_version
51  deepseek  deepseek-v4-flash    ok      20            45             16              1          1
```

Every disposable Phase 4 gateway key was disabled through the admin API.
Only non-secret metadata was inspected:

```console
id  disabled  month_to_date_spend_micro_usd
12  true      41
13  true      502
14  true      126
15  true      0
```

## Bounded verification adjustments

Two superseded prompt probes were retained in the durable audit trail and did
not require a code change:

1. A 16-token Gemini cap returned HTTP 200 with exact usage but `content:null`
   because hidden thinking exhausted the visible-output allowance. The
   disposable key was disabled automatically and the label never moved.
2. A later style string explicitly named both `Hello` and `Bonjour`; Gemini
   returned `Hello` for both correctly attributed prompt versions. That
   ambiguous verification wording was replaced with the playbook's literal
   `style: "tersely"` for the authoritative pair above.

The whole Verify window was bounded to five Gemini calls and one DeepSeek
call. No OpenAI or Anthropic call was attempted. No test makes network calls,
and no provider or gateway credential was written to the repository.

## Independent review

An independent GPT-5.6 Terra / high audit returned **APPROVE — code audit,
pending runtime gate** before the live run. It confirmed:

- the composite label foreign key and UPDATE/DELETE immutability triggers;
- deterministic, one-pass, escaped template expansion;
- transactional version allocation and label/history movement;
- authenticated, Zod-validated, DAO-backed admin routes and stable diff;
- prompt resolution after provider/pricing and before budget/cache;
- complete prompt attribution, `pg_*` scrubbing, and safe prototype-like
  variable handling.

The runtime evidence above closes every item the auditor left for the
completion gate.

## Final offline and runtime checks

The exact evidence/progress commit candidate was checked again after the
records were written:

```console
$ pnpm lint
Checked 114 files in 130ms. No fixes applied.

$ pnpm test
Test Files  42 passed (42)
Tests       593 passed (593)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/shared build: Done
packages/gateway build: Done

$ git diff --check
# no output; exit code 0

$ git grep <credential patterns>
# no matches; exit code 1

$ docker compose ps
NAME                   IMAGE                SERVICE   STATUS                   PORTS
promptgate-gateway-1   promptgate-gateway   gateway   Up 3 minutes (healthy)   127.0.0.1:8787->8787/tcp

$ curl -i http://127.0.0.1:8787/healthz
HTTP/1.1 200 OK
{"ok":true}
```

## Acceptance status

| Phase 4 criterion | Evidence | Result |
|---|---|---|
| Immutable prompt versions | Both SQLite UPDATE and DELETE rejected; DAO exposes append, not mutation | pass |
| Mutable labels are deployments with history | v1/v2 moves and rollbacks all appended to `label_history` | pass |
| `slug@version` / `slug@label` server resolution | DAO and integration tests plus live `greet@prod` calls | pass |
| Required variable validation and deterministic rendering | Unit/integration coverage plus safe live `prompt_var_missing` | pass |
| Label-only change alters the next unchanged request | Identical body hash produced French at v2, English at v1 | pass |
| Exact request attribution | Literal newest-first rows are `1|1`, then `1|2` | pass |
| Admin create/list/version/label API | Literal fixture creation, list summary, and label responses | pass |
| Sane unified diff | HTTP 200 text diff changes only English to French | pass |
| Safe unknown prompt | HTTP 404 `prompt_not_found`, no usage/cost/provider dispatch | pass |
| Every configured provider activated | Gemini and DeepSeek live passed; missing OpenAI/Anthropic named deferred | pass |
| Strict TypeScript, Zod boundaries, DAO separation, no secrets | 593 tests, lint/build, code audit, and final repository checks | pass |
| Phase 5 not started | No eval-harness implementation was added | pass |

All Phase 4 acceptance criteria pass. There is no remaining product blocker.
The project owner explicitly approved the Phase 4 completion gate on
2026-07-26. Phase 5 has not started.
