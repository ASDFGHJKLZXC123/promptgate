import http from "node:http";

const upstreamHost = "127.0.0.1";
const upstreamPort = Number(process.env.VERIFY_UPSTREAM_PORT ?? "8787");
const listenPort = Number(process.env.VERIFY_PROXY_PORT ?? "8788");
const adminToken = process.env.VERIFY_ADMIN_TOKEN;

if (!adminToken) {
	throw new Error("VERIFY_ADMIN_TOKEN is required.");
}

const server = http.createServer((request, response) => {
	const headers = {
		...request.headers,
		host: `${upstreamHost}:${upstreamPort}`,
	};
	if (request.url?.startsWith("/admin/api")) {
		headers["x-admin-token"] = adminToken;
	}

	const upstream = http.request(
		{
			host: upstreamHost,
			port: upstreamPort,
			method: request.method,
			path: request.url,
			headers,
		},
		(upstreamResponse) => {
			response.writeHead(
				upstreamResponse.statusCode ?? 502,
				upstreamResponse.headers,
			);
			upstreamResponse.pipe(response);
		},
	);

	upstream.on("error", (error) => {
		if (!response.headersSent) {
			response.writeHead(502, {
				"content-type": "text/plain; charset=utf-8",
			});
		}
		response.end(`Local verification proxy error: ${error.message}`);
	});
	request.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
	console.log(`Phase 7 local verification proxy ready on port ${listenPort}.`);
});

const close = () => server.close(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);
