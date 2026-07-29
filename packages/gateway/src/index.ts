import { config } from "./config.js";
import { buildServer } from "./server.js";
import { registerSignalShutdown } from "./shutdown.js";

const server = buildServer();
const unregisterSignalShutdown = registerSignalShutdown(
	process,
	() => server.close(),
	(signal, error) => {
		console.error(`Failed to shut down gateway after ${signal}`, error);
	},
);

try {
	await server.listen({
		port: config.PORT,
		host: "0.0.0.0",
	});
} catch (error) {
	console.error("Failed to start gateway server", error);
	unregisterSignalShutdown();
	process.exit(1);
}
