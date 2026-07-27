import { spawnSync } from "node:child_process";

function buildPackage(packageName: string): void {
	const build = spawnSync("pnpm", ["--filter", packageName, "build"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	if (build.status !== 0) {
		throw new Error(
			`Pre-test build failed for ${packageName}: ${build.stderr || build.stdout}`,
		);
	}
}

/** Build native-runtime probe artifacts once before Vitest starts parallel files. */
export function setup(): void {
	buildPackage("@promptgate/shared");
	buildPackage("@promptgate/evals");
}
