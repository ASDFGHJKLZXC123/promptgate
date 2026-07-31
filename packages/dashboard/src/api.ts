let adminToken: string | null = null;
let tokenGeneration = 0;
let promptGeneration = 0;
let initialized = false;

function promptForAdminToken(): boolean {
	const token = window.prompt("Enter the PromptGate admin token.");
	promptGeneration += 1;

	if (token === null || token === "") {
		return false;
	}

	adminToken = token;
	tokenGeneration += 1;
	return true;
}

export function initializeAdminToken(): void {
	if (initialized) {
		return;
	}

	initialized = true;
	promptForAdminToken();
}

function adminApiPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new Error("Dashboard API requests must use /admin/api paths.");
	}

	const url = new URL(path, window.location.origin);

	if (
		url.origin !== window.location.origin ||
		(url.pathname !== "/admin/api" && !url.pathname.startsWith("/admin/api/"))
	) {
		throw new Error("Dashboard API requests must use /admin/api paths.");
	}

	return `${url.pathname}${url.search}`;
}

function authenticatedFetch(
	path: string,
	init: RequestInit,
): Promise<Response> {
	const headers = {
		...Object.fromEntries(new Headers(init.headers)),
		"x-admin-token": adminToken ?? "",
	};

	return fetch(path, { ...init, headers });
}

export async function api(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	initializeAdminToken();
	const safePath = adminApiPath(path);
	const requestTokenGeneration = tokenGeneration;
	const requestPromptGeneration = promptGeneration;
	const response = await authenticatedFetch(safePath, init);

	if (response.status !== 401) {
		return response;
	}

	if (requestTokenGeneration !== tokenGeneration) {
		return authenticatedFetch(safePath, init);
	}

	if (requestPromptGeneration !== promptGeneration) {
		return response;
	}

	if (!promptForAdminToken()) {
		return response;
	}

	return authenticatedFetch(safePath, init);
}
