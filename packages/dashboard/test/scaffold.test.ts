import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, test } from "vitest";

import config from "../vite.config";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

describe("dashboard scaffold", () => {
	test("pins its local Vite and Chart.js dependencies with the Vite scripts", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
			scripts: Record<string, string>;
		};

		expect(packageJson.dependencies["chart.js"]).toBe("4.5.1");
		expect(packageJson.devDependencies.vite).toBe("8.1.4");
		expect(packageJson.scripts).toMatchObject({
			dev: "vite",
			build: "tsc -p tsconfig.json --noEmit && vite build",
			preview: "vite preview",
		});
	});

	test("keeps the local gateway proxy and production output configuration", () => {
		expect(config.server?.proxy?.["/admin/api"]).toMatchObject({
			target: "http://localhost:8787",
		});
		expect(config.build).toMatchObject({
			outDir: "dist",
			emptyOutDir: true,
		});
	});

	test("loads Chart.js from the installed package into a local browser entry", async () => {
		const [entry, document] = await Promise.all([
			readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
			readFile(new URL("../index.html", import.meta.url), "utf8"),
		]);

		expect(entry).toContain('from "chart.js"');
		expect(entry).toContain("Chart.register(...registerables)");
		expect(entry).toContain('import "./style.css"');
		expect(document).toContain('src="/src/main.ts"');
		expect(document).not.toMatch(/https?:\/\//);
	});

	test("creates a write-free production bundle with local hashed assets", async () => {
		const result = await build({
			root: dashboardRoot,
			logLevel: "silent",
			build: {
				write: false,
			},
		});
		const builds = Array.isArray(result) ? result : [result];
		const outputs = builds.flatMap((buildResult) => {
			if (!("output" in buildResult)) {
				throw new Error("Expected Vite build output, not a watcher.");
			}

			return buildResult.output;
		});
		const fileNames = outputs.map(({ fileName }) => fileName);
		const indexHtml = outputs.find(({ fileName }) => fileName === "index.html");

		expect(fileNames).toContain("index.html");
		expect(fileNames).toContainEqual(
			expect.stringMatching(/^assets\/.+-[A-Za-z0-9_-]+\.js$/),
		);
		expect(fileNames).toContainEqual(
			expect.stringMatching(/^assets\/.+-[A-Za-z0-9_-]+\.css$/),
		);
		expect(indexHtml?.type).toBe("asset");
		if (indexHtml?.type === "asset") {
			expect(indexHtml.source).toMatch(/assets\/.+-[A-Za-z0-9_-]+\.(js|css)/);
			expect(String(indexHtml.source)).not.toMatch(/https?:\/\//);
		}
	});
});
