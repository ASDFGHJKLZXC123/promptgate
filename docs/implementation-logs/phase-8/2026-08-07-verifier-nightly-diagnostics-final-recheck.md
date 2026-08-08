# Phase 8 — Nightly diagnostics final independent recheck

Date: 2026-08-07
Verifier: fresh independent Codex verification sub-agent
Branch/base: codex/phase8-nightly-diagnostics at
3c330a8d4da829481ea7c9a341b7f2c3b740900a
Final status: **APPROVE**

## Review scope and constraints

I independently rechecked the complete current tracked diff, all four Phase 8
nightly-diagnostics records that existed before this record, the corrected
authoritative fields in PROGRESS.md, the relevant current and base source,
the provider error construction paths, the workflow/CLI boundary, current Git
state, and every protected path named below.

I read ../AGENTS.md before reviewing the change. In accordance with the task,
I made no product, source, test, PROGRESS, implementation-record, prior-verifier,
workflow, provider, authority, registry, runtime-data, or other protected-file
edit. This final-recheck record is my only source-tree write.

Files inspected directly included:

- ../AGENTS.md
- PROGRESS.md
- docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md
- docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics.md
- docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-recheck.md
- docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-final.md
- packages/gateway/src/contracts/nightly.ts
- packages/gateway/src/contracts/nightly.test.ts
- packages/gateway/src/contracts/nightly-cli.ts
- packages/gateway/src/contracts/nightly-workflow.test.ts
- packages/gateway/src/providers/provider-error.ts
- packages/gateway/src/providers/types.ts
- the non-streaming and streaming ProviderError construction sites in the
  OpenAI-compatible and Anthropic adapters
- .github/workflows/contract-nightly.yml
- the root and gateway package manifests
- the complete tracked/untracked changed-file set

All checks were offline. I made no provider or other external network call,
workflow invocation, credential access, Docker action, commit, push, registry
mutation, runtime-data read/write, or live-state query. Every credential-like
probe value was a synthetic literal.

## Findings

### 1. The final generic-error evidence correction is exact

The corrected evidence no longer claims that all non-ProviderError behavior is
unchanged.

PROGRESS.md now says that non-ProviderError dispatch and base-message
construction are unchanged while the shared overlap-safe redactor protects
every error kind. The implementation record makes the same distinction in its
pass-1 clarification and correction-pass section.

That wording matches the source:

- ProviderError alone enters structured allowlist extraction.
- Plain Error still builds exactly Name: message.
- An unknown thrown value still builds exactly Unknown contract failure.
- All branches still pass their resulting text through the same redact call.
- The replacement redactor intentionally changes generic Error output for
  contained, overlapping, self-overlapping, or adjacent configured-secret spans;
  ordinary separated matches retain the same base construction and redaction.

A fresh source-path probe used configured synthetic values sk-overlap and
sk-overlap-extended and threw a plain Error containing the longer value in
both modes. All four resulting details were exactly:

~~~text
Error: generic [REDACTED]
~~~

The equivalent compiled-output probe produced the same exact result. This
confirms both halves of the evidence statement: dispatch/base construction are
preserved, and overlap-safe redaction intentionally improves every error
branch.

### 2. The authoritative PROGRESS current state is refreshed and internally consistent

The Position, Last session, Repo state, last-green gates, Phase 8 status row,
current Phase 8 blocker, and 2026-08-07 history row now describe the current
state rather than the August 6 pre-merge state.

Fresh local Git inspection confirms:

- branch: codex/phase8-nightly-diagnostics;
- HEAD: 3c330a8d4da829481ea7c9a341b7f2c3b740900a;
- local master: the same exact revision;
- local origin/master tracking ref: the same exact revision; and
- commit subject: Merge pull request #13 from
  ASDFGHJKLZXC123/codex/phase8-dogfood.

The current tree independently reproduces the stated 31/31 focused gate,
890/890 full gate across 69 files, 185-file lint gate, gateway build, full
workspace build, adversarial source/compiled checks, raw-control scans, diff
check, and protected-scope check.

The exact tracked numstat is now:

~~~text
7       6       PROGRESS.md
424     0       packages/gateway/src/contracts/nightly.test.ts
157     7       packages/gateway/src/contracts/nightly.ts
~~~

The added-test count is exactly 16: nightly.test.ts has 27 test declarations
now versus 11 at HEAD, and the unchanged workflow test has 4, yielding the
focused total of 31.

The PR checks and schedule-run facts are historical/live process evidence that
this no-network task was explicitly prohibited from querying. The supplied
task facts and repository records consistently identify merged PR #13,
scheduled run 31169217048, its configured-red provider results, and the absence
of a green scheduled run. I found no contradictory repository evidence and do
not overstate these as freshly queried live facts.

### 3. The diagnostic implementation is safe and narrowly dispatched

The formatter reads only scalar type, code, param, status, and message fields
from the body or one nested body.error object. Nested scalar values take
per-field precedence; an invalid nested value falls back to a valid top-level
scalar. Objects, arrays, null, undefined, non-finite numbers, and unknown fields
are omitted.

Extraction is shallow. Cyclic bodies do not recurse, and any throwing body,
error, or field access is caught so the formatter falls back to the local base
ProviderError message. The outer shared redactor still protects that fallback.

Each emitted field is normalized and capped at 200 UTF-16 code units. The final
detail is capped at 1,000 code units. Fresh independent assertions reproduced a
200-unit field value, exact 1,000-unit total results in both modes, safe cyclic
and hostile-getter results, scalar precedence/fallback, unknown-field omission,
adapter-setup formatting, and the unchanged unknown-thrown-value result.

The real adapter sites preserve parsed upstream bodies in ProviderError for
both non-streaming and streaming HTTP failures. The nightly adapter-setup,
complete, and stream catches all reach the same safe formatter. A failed
non-streaming mode still does not suppress the streaming attempt.

### 4. Both prior security blockers remain resolved

The redactor finds every occurrence of every nonempty configured secret against
the original scalar, advancing one UTF-16 unit so self-overlapping occurrences
are included. It sorts and unions containment, adjacency, arbitrary
cross-secret overlap, and self-overlap before rendering markers. Replacement
order therefore cannot destroy a later match or expose a suffix/fragment.

Fresh source and compiled probes used synthetic arbitrary-overlap secrets
abc123def and 123def456 plus the self-overlapping secret aaa. Three providers
failed in both modes with the same ProviderError. Across six returned details,
six callback reports, and the rendered summary:

- no complete secret or tested overlap fragment survived;
- token=abc123def456 became token=[REDACTED];
- self=aaaaa became self=[REDACTED]; and
- both modes contained message=token=[REDACTED] self=[REDACTED] left right.

The control predicate covers 32 C0 code points, DEL, and all 32 C1 code points.
Both source and compiled probes injected all 65 values programmatically into
the diagnostic and confirmed none survived returned details or callback
reports. The Markdown summary was checked for secret containment separately
because its table rendering legitimately contains structural line feeds.

The committed tests directly exercise ordinary C0 whitespace normalization and
the complete C1 range; the independent all-65 source/compiled probes also cover
DEL and every remaining C0 value. Together they substantiate the recorded
C0/DEL/C1 behavior.

### 5. Scope is clean

The tracked diff contains only PROGRESS.md and the two intended nightly
contract files. Before this record there were exactly four untracked files, all
nightly-diagnostics evidence records in docs/implementation-logs/phase-8. This
record is the fifth.

There is no diff in provider adapters, model pins, endpoints, request
construction, workflow triggers/permissions, package scripts/dependencies,
lockfile, environment template, README, project idea, authority documents,
pricing, registry, database/pipeline code, or evidence/runtime-data paths.
Within nightly.ts the model table, buildRequest, complete/stream contract
logic, suite policy, reporting flow, and summary renderer are unchanged. The
source diff is confined to the ProviderError import, redaction/diagnostic
helpers, and safeError dispatch.

### 6. The no-live-green limitation is explicit

PROGRESS.md and the implementation record both say this change makes a future
provider failure safely diagnosable; it does not identify or fix the actual
provider-side causes of run 31169217048. They explicitly state that no green
schedule-triggered run exists and that publication, diagnostic-only live
rerun, proven provider corrections, and later scheduled-green/final-closeout
steps remain.

No live provider or workflow run was needed or authorized to approve this
offline diagnostic patch and its evidence corrections.

## Verification commands and exact outcomes

1. Repository instructions, records, complete diff, and surrounding source:

~~~text
sed -n '1,240p' ../AGENTS.md
nl -ba docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md | sed -n '1,120p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md | sed -n '121,219p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-claude-code-nightly-diagnostics.md | sed -n '220,430p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics.md | sed -n '1,120p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics.md | sed -n '121,240p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-recheck.md | sed -n '1,160p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-recheck.md | sed -n '161,320p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-final.md | sed -n '1,180p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-final.md | sed -n '150,270p'
nl -ba docs/implementation-logs/phase-8/2026-08-07-verifier-nightly-diagnostics-final.md | sed -n '181,360p'
git diff -- PROGRESS.md
git diff -- packages/gateway/src/contracts/nightly.ts
git diff -- packages/gateway/src/contracts/nightly.test.ts
nl -ba packages/gateway/src/contracts/nightly.ts | sed -n '1,560p'
git show HEAD:packages/gateway/src/contracts/nightly.ts | nl -ba | sed -n '90,145p'
~~~

All four pre-existing records were read through EOF. The three tracked diffs
were read in full. The source/context inspection confirmed findings 1–6.

2. Revision and branch check:

~~~text
git rev-parse HEAD
git rev-parse master
git rev-parse origin/master
git branch --show-current
git log -1 --oneline --decorate
~~~

All three revisions were
3c330a8d4da829481ea7c9a341b7f2c3b740900a; the branch was
codex/phase8-nightly-diagnostics; the subject was the PR #13 merge.

3. Test declaration counts:

~~~text
git diff -U0 HEAD -- packages/gateway/src/contracts/nightly.test.ts | rg '^\+\s*test\(' | wc -l
rg '^\s*test\(' packages/gateway/src/contracts/nightly.test.ts | wc -l
git show HEAD:packages/gateway/src/contracts/nightly.test.ts | rg '^\s*test\(' | wc -l
rg '^\s*test\(' packages/gateway/src/contracts/nightly-workflow.test.ts | wc -l
~~~

Results: 16 added, 27 current nightly, 11 base nightly, and 4 workflow tests.

4. Focused gate:

~~~text
pnpm test packages/gateway/src/contracts/nightly.test.ts packages/gateway/src/contracts/nightly-workflow.test.ts
~~~

Exit 0: 2 files passed; 31/31 tests passed.

5. Full gate:

~~~text
pnpm test
~~~

Exit 0: 69 files passed; 890/890 tests passed.

6. Lint:

~~~text
pnpm lint
~~~

Exit 0: 185 files checked; no fixes applied.

7. Required gateway build:

~~~text
pnpm --filter @promptgate/gateway build
~~~

Exit 0: TypeScript compilation, packaged migrations/pricing copy, and scripts
type-check passed.

8. Additional verification of the authoritative root build field:

~~~text
pnpm build
~~~

Exit 0: all four built workspace packages passed. The dashboard Vite build and
the shared, evals, and gateway TypeScript builds completed successfully.

9. Source-path overlap/control/generic probe:

~~~text
pnpm exec tsx -e '<offline source-path synthetic harness>'
~~~

The corrected invocation exited 0 with:

~~~text
{"overlapDetails":6,"reports":6,"controls":65,"genericDetails":4,"genericValue":"Error: generic [REDACTED]"}
~~~

Assertions covered arbitrary cross-secret overlap, self-overlap, both modes,
all 65 C0/DEL/C1 values, returned details, callback reports, Markdown-summary
secret containment, and overlapping-secret redaction for plain Error.

10. Equivalent compiled-output probe after build:

~~~text
node --input-type=module -e '<equivalent offline compiled harness>'
~~~

Exit 0 with the same exact JSON result and assertions against
packages/gateway/dist.

11. Extended independent source-path behavior probe:

~~~text
pnpm exec tsx -e '<offline allowlist/hostile/cyclic/cap/setup/unknown harness>'
~~~

Exit 0:

~~~text
{"scalarModes":2,"cyclicModes":2,"hostileModes":2,"fieldLengths":[241,241],"totalLengths":[1000,1000],"setupModesIdentical":true,"unknownModes":2}
~~~

The 241-character field details contain the fixed base/suffix plus exactly 200
message-value units. Both total-cap results were exactly 1,000.

12. Raw C0/DEL file scan:

~~~text
rg -nUaP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' PROGRESS.md packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts docs/implementation-logs/phase-8/*.md
~~~

Exit 1 with no output, the expected clean result.

13. Raw C1 file scan:

~~~text
rg -nUaP '[\x{80}-\x{9F}]' PROGRESS.md packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts docs/implementation-logs/phase-8/*.md
~~~

Exit 1 with no output, the expected clean result.

14. Diff, counts, and status:

~~~text
git diff --check
git diff --name-status HEAD
git diff --numstat HEAD
git diff --stat HEAD
git status --short --branch
git ls-files --others --exclude-standard
~~~

git diff --check exited 0 with no output. Tracked files were exactly the three
listed in Scope. Numstat was 7/6, 424/0, and 157/7. Tracked stat was 588
insertions and 13 deletions across three files. Status otherwise contained only
the five Phase 8 nightly-diagnostics records after this record was written.

15. Protected-scope audit:

~~~text
git diff --exit-code HEAD -- .github/workflows package.json pnpm-lock.yaml .env.example README.md PromptGate_PROJECT_IDEA.md BUILD_PLAYBOOK.md IMPLEMENTATION_GUIDE.md ORCHESTRATOR.md packages/gateway/package.json packages/gateway/pricing.json packages/gateway/src/config.ts packages/gateway/src/providers packages/gateway/src/registry packages/gateway/src/db packages/gateway/src/pipeline docs/evidence
~~~

Exit 0 with no output.

16. Exact source/test hunk audit:

~~~text
git diff -U0 HEAD -- packages/gateway/src/contracts/nightly.ts packages/gateway/src/contracts/nightly.test.ts | rg --pcre2 '^(@@|[+-](?![+-]))'
~~~

Exit 0. The hunks match the scope described above.

## Successful checks

- The two requested final evidence-only corrections are present and exact.
- Both previously rejected security behaviors remain corrected in source and
  compiled output.
- Focused tests: 31/31.
- Full tests: 890/890 across 69 files.
- Lint: 185 files clean.
- Gateway build and full workspace build: clean.
- Exactly 16 added diagnostic tests and exact current numstat confirmed.
- Source/compiled overlap, self-overlap, generic-error, and all-control probes:
  clean.
- Allowlist, precedence, primitive/non-finite omission, hostile/cyclic safety,
  adapter-setup behavior, and output caps: clean.
- Raw C0/DEL and C1 scans: clean.
- Diff whitespace, current Git state, and protected-scope checks: clean.
- The absence of a live green scheduled run is stated clearly.

## Failed checks and suspected causes

One first invocation of the source adversarial harness incorrectly applied its
no-control assertion to the complete Markdown summary. It reported control 10
because renderContractSummary deliberately uses structural line feeds between
table rows. This was a verifier-harness scope error, not product output leakage:
the summary was never expected to be a single line.

The corrected harness checked injected controls in returned details and
single-line callback reports, while continuing to check the rendered summary
for every secret/overlap fragment. It passed. The equivalent compiled harness
also passed. No repository test, lint, build, product-behavior, raw-file,
diff, or scope check failed.

## Residual risks and limitations

- The output caps do not cap input allocation. Provider adapters read an entire
  upstream error response with Response.text before this formatter runs, and
  redaction/normalization inspect complete scalar values before slicing.
  Extremely large hostile inputs can therefore consume work and memory
  proportional to input size. The adapter body read predates this patch; this
  narrow change does not worsen disclosure and bounds emitted diagnostics.
- UTF-16 slicing can split a supplementary Unicode scalar at a field or total
  boundary. This can leave a lone surrogate but does not bypass redaction or
  either cap.
- The deliberately shallow scalar allowlist will omit diagnostics from a future
  provider envelope that uses another nesting shape or non-scalar fields.
- Historical agent-service interruptions, PR checks, and schedule-run facts
  cannot be replayed from the repository under this task's no-network rule.
  Fresh reproducible source/test/build evidence is clean, and no contradictory
  local evidence was found.
- The actual provider-side causes of scheduled run 31169217048 remain unknown
  and unfixed. This approval establishes no live provider success and no green
  schedule-triggered run.

None of these residual limitations is a blocker for the bounded offline
diagnostic remediation.

## Final status

**APPROVE.** The source/test patch, implementation record, PROGRESS correction,
and historical verifier chain now agree with the current tree. The exact
dispatch/redaction wording and authoritative current-state fields requested by
the preceding evidence verifier are corrected; all required offline gates and
fresh adversarial checks pass; protected scope is clean; and the no-live-green
limitation is honest. No further product, test, progress, or evidence correction
is requested before protected publication.
