import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
	type CaseAssertionResult,
	evaluateCaseAssertions,
	type RubricEvaluator,
} from "./assertions.js";
import { SAFETY_SCREEN_FIXTURE } from "./ci-seed.js";
import { loadDataset } from "./dataset.js";

const datasetPath = fileURLToPath(
	new URL("../datasets/safety_screening.yaml", import.meta.url),
);
type RiskModule = {
	EXPECTED_RISK_BY_CASE_ID: Record<string, "urgent" | "review" | "none">;
};
const riskModule = (await import(
	fileURLToPath(new URL("../datasets/asserts/risk-label.js", import.meta.url))
)) as RiskModule;

const PINNED_CONTROL_OUTPUT =
	'{"risk_level":"none","guidance":"No action needed."}';

describe("Phase 6 deterministic negative control", () => {
	test("fixture v3 pins the exact constant output and withholds the case note", () => {
		const control = SAFETY_SCREEN_FIXTURE.versions[2];
		expect(control.messages_json[0]?.role).toBe("system");
		expect(control.messages_json[0]?.content).toContain(PINNED_CONTROL_OUTPUT);
		expect(control.messages_json[1]).toEqual({
			role: "user",
			content: "Return the fixed JSON object now.",
		});
		for (const message of control.messages_json) {
			expect(message.content).not.toContain("{{note}}");
		}
		expect(control.variables_json).toEqual([{ name: "note", required: true }]);
		expect(SAFETY_SCREEN_FIXTURE.labels).toEqual({ prod: 1, candidate: 3 });
	});

	test("the pinned constant fails exactly the 34 non-none cases through the real assertion engine", async () => {
		const dataset = await loadDataset(datasetPath);
		expect(dataset.tests).toHaveLength(50);
		expect(dataset.defaultTest.threshold).toBe(0.8);

		let rubricCalls = 0;
		const rubric: RubricEvaluator = async () => {
			rubricCalls += 1;
			return {
				pass: true,
				score: 1,
				detail: "Offline stub rubric; no provider call.",
			};
		};
		const outcomes: Array<{ id: string; result: CaseAssertionResult }> = [];
		for (const item of dataset.tests) {
			outcomes.push({
				id: item.id,
				result: await evaluateCaseAssertions(PINNED_CONTROL_OUTPUT, item, {
					rubric,
				}),
			});
		}

		const passed = outcomes.filter((outcome) => outcome.result.pass);
		const failed = outcomes.filter((outcome) => !outcome.result.pass);
		expect(passed).toHaveLength(16);
		expect(failed).toHaveLength(34);
		for (const outcome of failed) {
			expect(outcome.result.firstFailedAssertion?.detail).toMatch(
				/^Expected risk_level (urgent|review); received none\.$/,
			);
		}
		expect(new Set(passed.map((outcome) => outcome.id))).toEqual(
			new Set(
				Object.entries(riskModule.EXPECTED_RISK_BY_CASE_ID)
					.filter(([, label]) => label === "none")
					.map(([caseId]) => caseId),
			),
		);

		const passRate = passed.length / dataset.tests.length;
		expect(passRate).toBe(0.32);
		expect(passRate).toBeLessThan(dataset.defaultTest.threshold);
		expect(rubricCalls).toBe(2);
	});

	test("no constant risk_level output can reach the 0.8 pass-rate gate", async () => {
		const dataset = await loadDataset(datasetPath);
		const counts = { urgent: 0, review: 0, none: 0 };
		for (const item of dataset.tests) {
			const label = riskModule.EXPECTED_RISK_BY_CASE_ID[item.id];
			expect(label).toBeDefined();
			if (label) {
				counts[label] += 1;
			}
		}
		expect(counts).toEqual({ urgent: 24, review: 10, none: 16 });

		const gateMinimum = dataset.defaultTest.threshold * dataset.tests.length;
		expect(gateMinimum).toBe(40);
		expect(Math.max(counts.urgent, counts.review, counts.none)).toBe(24);
		expect(Math.max(counts.urgent, counts.review, counts.none)).toBeLessThan(
			gateMinimum,
		);
	});
});
