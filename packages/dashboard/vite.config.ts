import { defineConfig } from "vite";

export default defineConfig({
	server: {
		proxy: {
			"/admin/api": {
				target: "http://localhost:8787",
			},
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
