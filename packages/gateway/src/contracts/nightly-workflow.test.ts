import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const workflowPath = fileURLToPath(
	new URL(
		"../../../../.github/workflows/contract-nightly.yml",
		import.meta.url,
	),
);
const workflow = readFileSync(workflowPath, "utf8");

describe("contract-nightly workflow policy", () => {
	test("is both scheduled and manually dispatchable with read-only repository access", () => {
		expect(workflow).toMatch(/\n {2}schedule:\n {4}- cron: "17 9 \* \* \*"\n/);
		expect(workflow).toMatch(/\n {2}workflow_dispatch:\s*\n/);
		expect(workflow).toContain("permissions:\n  contents: read");
		expect(workflow).not.toMatch(/:\s*write(?:\s|$)/);
	});

	test("SHA-pins every third-party action and disables checkout credential persistence", () => {
		const uses = workflow
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("uses:"));
		expect(uses).toHaveLength(3);
		for (const line of uses) {
			expect(line).toMatch(/^uses: [^@\s]+@[a-f0-9]{40}$/);
		}
		expect(workflow).toContain("persist-credentials: false");
	});

	test("injects all four provider secrets only into the final runner step", () => {
		const runnerMarker = "      - name: Run live provider contracts";
		const runnerIndex = workflow.indexOf(runnerMarker);
		expect(runnerIndex).toBeGreaterThan(0);
		expect(workflow.slice(0, runnerIndex)).not.toContain("secrets.");
		expect(workflow.match(/^\s+env:\s*$/gm)).toHaveLength(1);

		for (const name of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"DEEPSEEK_API_KEY",
		]) {
			const expression = `\${{ secrets.${name} }}`;
			expect(workflow.split(expression)).toHaveLength(2);
		}
		expect(workflow.slice(runnerIndex)).toContain(
			"run: pnpm --filter @promptgate/gateway contract-nightly",
		);
	});

	test("builds before the credential-bearing step and cannot silently skip all providers", () => {
		const buildIndex = workflow.indexOf("      - name: Build");
		const runnerIndex = workflow.indexOf(
			"      - name: Run live provider contracts",
		);
		expect(buildIndex).toBeGreaterThan(0);
		expect(runnerIndex).toBeGreaterThan(buildIndex);
		expect(workflow).toContain("run: pnpm build");
		// The runner exits nonzero for zero configured providers; no shell fallback
		// or continue-on-error is allowed to turn that exit into workflow green.
		expect(workflow).not.toContain("continue-on-error");
		expect(workflow).not.toMatch(/contract-nightly\s*(?:\|\||;)\s*true/);
	});
});
