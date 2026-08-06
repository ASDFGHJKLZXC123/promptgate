import { appendFile } from "node:fs/promises";

import { renderContractSummary, runNightlyContracts } from "./nightly.js";

const result = await runNightlyContracts({
	environment: process.env,
	report: (line) => console.log(line),
});
const summary = renderContractSummary(result);
console.log(`\n${summary}`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
	await appendFile(summaryPath, summary, "utf8");
}

if (!result.ok) {
	process.exitCode = 1;
}
