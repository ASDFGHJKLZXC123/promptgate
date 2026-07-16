import { config } from "./config.js";
import { buildServer } from "./server.js";

const server = buildServer();

try {
	await server.listen({
		port: config.PORT,
		host: "0.0.0.0",
	});
} catch (error) {
	console.error("Failed to start gateway server", error);
	process.exit(1);
}
