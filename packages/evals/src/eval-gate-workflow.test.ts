import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const workflowUrl = new URL(
	"../../../.github/workflows/eval-gate.yml",
	import.meta.url,
);

describe("Phase 6 eval-gate workflow", () => {
	test("parses and retains the approved pull-request scope", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const workflow = parse(source);

		expect(workflow).toMatchObject({
			name: "eval-gate",
			on: {
				pull_request: {
					paths: [
						"packages/gateway/**",
						"packages/evals/**",
						"packages/shared/**",
					],
				},
			},
			permissions: { contents: "read" },
			jobs: {
				evals: {
					name: "eval-gate",
					"runs-on": "ubuntu-latest",
					"timeout-minutes": 60,
				},
			},
		});
	});

	test("pins every action and keeps secrets out of third-party setup steps", async () => {
		const source = await readFile(workflowUrl, "utf8");
		const uses = [...source.matchAll(/^\s+uses:\s*([^@\s]+)@([^\s]+)$/gm)];

		expect(uses.map((match) => `${match[1]}@${match[2]}`)).toEqual([
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
		expect(source).toContain("Enforce trusted pull-request source");
		expect(source).toContain(
			"Run this change from a trusted same-repository branch before merge.",
		);
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
});
