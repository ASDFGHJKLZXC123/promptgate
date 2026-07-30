import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

const workflowUrl = new URL(
	"../../../.github/workflows/eval-gate.yml",
	import.meta.url,
);
const ciWorkflowUrl = new URL(
	"../../../.github/workflows/ci.yml",
	import.meta.url,
);

describe("Phase 6 eval-gate workflow", () => {
	test("always publishes one stable required check for pull requests", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const workflow = parse(source);

		expect(workflow).toMatchObject({
			name: "eval-gate",
			on: { pull_request: null },
			permissions: { contents: "read" },
			jobs: {
				detect: {
					name: "detect-eval-scope",
					"runs-on": "ubuntu-latest",
				},
				evaluate: {
					name: "live-evaluation",
					needs: "detect",
					if: "needs.detect.outputs.relevant == 'true' && needs.detect.outputs.trusted == 'true'",
					"runs-on": "ubuntu-latest",
					"timeout-minutes": 60,
				},
				gate: {
					name: "eval-gate",
					if: "always()",
					needs: ["detect", "evaluate"],
					"runs-on": "ubuntu-latest",
				},
			},
		});
		expect(source).not.toMatch(/^\s+paths:/m);
	});

	test("pins every action and keeps secrets out of third-party setup steps", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const uses = [...source.matchAll(/^\s+uses:\s*([^@\s]+)@([^\s]+)$/gm)];

		expect(uses.map((match) => `${match[1]}@${match[2]}`)).toEqual([
			"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
			"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
			"pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
			"actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
		]);
		for (const match of uses) {
			expect(match[2]).toMatch(/^[a-f0-9]{40}$/);
		}
		expect(source.indexOf("secrets.OPENAI_API_KEY")).toBeGreaterThan(
			source.lastIndexOf("uses:"),
		);
		expect(source).toContain("persist-credentials: false");
		expect(source).toContain("Detect evaluation scope and trust boundary");
		expect(source).toMatch(
			/PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/,
		);
		expect(source).toMatch(/PR_ACTOR: \$\{\{ github\.actor \}\}/);
		expect(source).toContain('"$PR_HEAD_REPOSITORY" == "$CURRENT_REPOSITORY"');
		expect(source).toContain('"$PR_AUTHOR" != "dependabot[bot]"');
		expect(source).toContain('"$PR_ACTOR" != "dependabot[bot]"');
		expect(source).toContain(
			"Relevant changes require a trusted same-repository branch.",
		);
	});

	test("uses the approved fail-closed relevance allowlist", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const approvedPatterns = [
			"packages/gateway/*",
			"packages/evals/*",
			"packages/shared/*",
			"Dockerfile",
			"docker-compose.yml",
			".dockerignore",
			".nvmrc",
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"tsconfig.base.json",
			".github/workflows/eval-gate.yml",
			".github/workflows/ci.yml",
			".github/actions/*",
		];
		for (const path of approvedPatterns) {
			expect(source).toContain(path);
		}
		const caseMatch = source.match(
			/case "\$changed_file" in\n([\s\S]*?)\n\s+relevant=true/,
		);
		expect(caseMatch).not.toBeNull();
		const normalizedPatterns = caseMatch?.[1]
			.replace(/ \| \\\n\s*/g, " | ")
			.trim();
		expect(normalizedPatterns).toBe(`${approvedPatterns.join(" | ")})`);
		expect(source).toContain(
			'git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA"',
		);
		expect(source).toContain(
			"The pull-request diff could not be resolved; running the live gate fail-closed.",
		);
		expect(source).toContain(
			"No live provider evaluation was required for this pull request.",
		);
		expect(source).toContain(
			"Evaluation scope detection returned invalid outputs.",
		);
		expect(source).toContain(
			"An irrelevant change produced an unexpected live-evaluation result.",
		);
		expect(source).toContain('if [[ "$EVALUATE_RESULT" != "success" ]]');
	});

	test("executes the aggregate gate truth table fail-closed", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const workflow = parse(source) as {
			jobs: {
				gate: {
					steps: Array<{ run?: string }>;
				};
			};
		};
		const gateScript = workflow.jobs.gate.steps[0]?.run;
		expect(gateScript).toBeTypeOf("string");
		if (!gateScript) {
			throw new Error("eval-gate aggregate script is missing");
		}

		const cases = [
			{
				name: "irrelevant trusted",
				detect: "success",
				relevant: "false",
				trusted: "true",
				evaluate: "skipped",
				passes: true,
			},
			{
				name: "irrelevant untrusted",
				detect: "success",
				relevant: "false",
				trusted: "false",
				evaluate: "skipped",
				passes: true,
			},
			{
				name: "relevant trusted live pass",
				detect: "success",
				relevant: "true",
				trusted: "true",
				evaluate: "success",
				passes: true,
			},
			{
				name: "detector failure",
				detect: "failure",
				relevant: "true",
				trusted: "true",
				evaluate: "skipped",
				passes: false,
			},
			{
				name: "invalid relevance",
				detect: "success",
				relevant: "",
				trusted: "true",
				evaluate: "skipped",
				passes: false,
			},
			{
				name: "invalid trust",
				detect: "success",
				relevant: "true",
				trusted: "",
				evaluate: "skipped",
				passes: false,
			},
			{
				name: "irrelevant unexpected live result",
				detect: "success",
				relevant: "false",
				trusted: "true",
				evaluate: "success",
				passes: false,
			},
			{
				name: "relevant untrusted",
				detect: "success",
				relevant: "true",
				trusted: "false",
				evaluate: "skipped",
				passes: false,
			},
			{
				name: "relevant trusted live failure",
				detect: "success",
				relevant: "true",
				trusted: "true",
				evaluate: "failure",
				passes: false,
			},
			{
				name: "relevant trusted live skipped",
				detect: "success",
				relevant: "true",
				trusted: "true",
				evaluate: "skipped",
				passes: false,
			},
		] as const;

		for (const gateCase of cases) {
			const directory = await mkdtemp(join(tmpdir(), "promptgate-eval-gate-"));
			try {
				let passed = true;
				try {
					await execFileAsync("bash", ["-c", gateScript], {
						env: {
							...process.env,
							GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
							DETECT_RESULT: gateCase.detect,
							RELEVANT: gateCase.relevant,
							TRUSTED: gateCase.trusted,
							EVALUATE_RESULT: gateCase.evaluate,
						},
					});
				} catch {
					passed = false;
				}
				expect(passed, gateCase.name).toBe(gateCase.passes);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	});

	test("preserves the fresh paired gate and secure one-time key handoff", async () => {
		const source = await readFile(workflowUrl, "utf8");

		for (const name of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"DEEPSEEK_API_KEY",
		]) {
			expect(source).toContain(`secrets.${name}`);
			expect(source).toContain(`printf '${name}=%s\\n'`);
		}

		expect(source).toContain("chmod 600 .env");
		expect(source).toContain("PG_ADMIN_TOKEN");
		expect(source).toContain("PG_EVAL_KEY_FILE");
		expect(source).toMatch(/echo "::add-mask::\$\{eval_key\}"/);
		expect(source.indexOf("docker compose build")).toBeLessThan(
			source.indexOf("secrets.OPENAI_API_KEY"),
		);
		expect(source).toContain("docker compose up -d --no-build --wait");
		expect(source).toContain("./node_modules/.bin/pg-eval seed-ci");
		expect(source).toContain("--dataset safety_screening");
		expect(source).toContain("--prompt safety_screen@candidate");
		expect(source).toContain("--baseline prod");
		expect(source).toContain("--min-request-interval-ms 15000");
		expect(source).toContain("$GITHUB_STEP_SUMMARY");
		expect(source).toMatch(/pipeline_status=\("\$\{PIPESTATUS\[@\]\}"\)/);
		expect(source).toContain(
			"timeout 180s docker compose down --timeout 150 --volumes --remove-orphans",
		);
		expect(source).toContain("the ephemeral database was left untouched");
		expect(source).not.toContain("rm -f data/");
		expect(source).not.toContain("--baseline-from-history");
		expect(source).not.toContain("pg-eval comment");
		expect(source).not.toContain("pull_request_target");
	});

	test("gives the ordinary CI workflow the stable required-check name", async () => {
		const source = await readFile(ciWorkflowUrl, "utf8");
		const workflow = parse(source);

		expect(workflow).toMatchObject({
			name: "ci",
			jobs: {
				"lint-test-build": {
					name: "ci",
					"runs-on": "ubuntu-latest",
				},
			},
		});
		expect(source).toContain(
			"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
		);
		expect(source).toContain("persist-credentials: false");
	});
});
