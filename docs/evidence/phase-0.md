# Phase 0 verification evidence

Date: 2026-07-16

Status: **pass** — human-approved on 2026-07-16. Phase 1 has not started.

## Literal Verify block

```console
$ pnpm test

> PromptGate@1.0.0 test /Users/f8fq/coding projects/Unfinished/PromptGate
> vitest run


 RUN  v4.1.10 /Users/f8fq/coding projects/Unfinished/PromptGate


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  15:56:42
   Duration  361ms (transform 38ms, setup 0ms, import 26ms, tests 207ms, environment 0ms)
```

Exit code: `0`

```console
$ docker compose up -d --wait && curl -s localhost:8787/healthz
 Network promptgate_default Creating
 Network promptgate_default Created
 Container promptgate-gateway-1 Creating
 Container promptgate-gateway-1 Created
 Container promptgate-gateway-1 Starting
 Container promptgate-gateway-1 Started
 Container promptgate-gateway-1 Waiting
 Container promptgate-gateway-1 Healthy
{"ok":true}
```

Exit code: `0`

Supplemental health evidence:

```console
health HTTP status=200
container health=healthy published=127.0.0.1:8787
```

## Local quality and CI checks

```console
$ pnpm install --frozen-lockfile
Scope: all 5 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

$ pnpm lint
Checked 21 files in 61ms. No fixes applied.

$ pnpm test
Test Files  1 passed (1)
Tests       1 passed (1)

$ pnpm build
Scope: 4 of 5 workspace projects
packages/dashboard build: Done
packages/evals build: Done
packages/gateway build: Done
packages/shared build: Done

$ go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/ci.yml
# no output; exit code 0
```

The Node 22 Corepack bootstrap also returned pnpm `10.33.0`, matching the root `packageManager` field. Official tag resolution confirmed these immutable action pins:

```console
df4cb1c069e1874edd31b4311f1884172cec0e10  refs/tags/v6.0.3^{}
249970729cb0ef3589644e2896645e5dc5ba9c38  refs/tags/v6.5.0
```

## Acceptance status

- `docker compose up` and `GET /healthz` HTTP 200: **pass**.
- GitHub Actions `ci` green: **pass** — [run 29550460258](https://github.com/ASDFGHJKLZXC123/promptgate/actions/runs/29550460258) completed successfully for the warning-free v6 action pins, with install, lint, test, and build green and zero annotations.

The human-approved Fable 5 / high conflict review changed the Compose host mapping to `127.0.0.1:8787:8787`; the literal Verify block remains compatible.

The required GPT-5.6 Terra / medium final integration audit independently confirmed strict commit order, one numbered commit per step, no committed secrets or provider calls, all local checks green, literal Compose health green, a clean worktree, and no remaining local defect.
