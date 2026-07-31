import { api } from "./api";
import { escapeHtml } from "./overview";

export interface PromptLabel {
	label: string;
	version: number;
	updated_at?: string;
}

export interface PromptSummary {
	id: number;
	slug: string;
	description: string | null;
	created_at: string;
	latest_version: number | null;
	labels: PromptLabel[];
}

export interface PromptVersion {
	version: number;
	messages_json: unknown[];
	variables_json: unknown[];
	notes: string | null;
	created_at: string;
}

export interface PromptDetail extends Omit<PromptSummary, "latest_version"> {
	labels: Array<PromptLabel & { updated_at: string }>;
	versions: PromptVersion[];
}

let listRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;
let diffRequest: AbortController | undefined;
let actionRequest: AbortController | undefined;
let listenerController: AbortController | undefined;
let generation = 0;
let promptList: PromptSummary[] = [];
let selectedSlug: string | undefined;
let selectedDetail: PromptDetail | undefined;
let selectedVersions: number[] = [];
let actionPending = false;
let actionNotice: string | undefined;

function invalidResponse(): never {
	throw new Error("The gateway returned an invalid prompt response.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Prompt timestamps are server-generated SQLite UTC seconds, not browser-local dates. */
function isCanonicalTimestamp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
	)
		return false;
	const canonical = `${value.replace(" ", "T")}Z`;
	const date = new Date(canonical);
	return (
		!Number.isNaN(date.valueOf()) &&
		date.toISOString() === `${canonical.slice(0, -1)}.000Z`
	);
}

function isNonblankText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseLabels(
	value: unknown,
	includesUpdatedAt: boolean,
): PromptLabel[] {
	if (!Array.isArray(value)) invalidResponse();
	const seen = new Set<string>();
	return value.map((candidate) => {
		if (!isRecord(candidate)) invalidResponse();
		const keys = includesUpdatedAt
			? ["label", "updated_at", "version"]
			: ["label", "version"];
		if (
			!hasExactKeys(candidate, keys) ||
			!isNonblankText(candidate.label) ||
			!isPositiveSafeInteger(candidate.version) ||
			(includesUpdatedAt && !isCanonicalTimestamp(candidate.updated_at)) ||
			seen.has(candidate.label)
		)
			invalidResponse();
		seen.add(candidate.label);
		return includesUpdatedAt
			? {
					label: candidate.label,
					version: candidate.version,
					updated_at: candidate.updated_at as string,
				}
			: { label: candidate.label, version: candidate.version };
	});
}

function parseSummary(value: unknown): PromptSummary {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"created_at",
			"description",
			"id",
			"labels",
			"latest_version",
			"slug",
		]) ||
		!isPositiveSafeInteger(value.id) ||
		!isNonblankText(value.slug) ||
		(value.description !== null && typeof value.description !== "string") ||
		!isCanonicalTimestamp(value.created_at) ||
		(value.latest_version !== null &&
			!isPositiveSafeInteger(value.latest_version))
	)
		invalidResponse();
	const latestVersion = value.latest_version;
	const labels = parseLabels(value.labels, false);
	if (
		(latestVersion === null && labels.length !== 0) ||
		labels.some((label) =>
			latestVersion === null ? true : label.version > latestVersion,
		)
	)
		invalidResponse();
	return {
		id: value.id,
		slug: value.slug,
		description: value.description,
		created_at: value.created_at,
		latest_version: latestVersion,
		labels,
	};
}

export function parsePromptList(value: unknown): PromptSummary[] {
	if (!Array.isArray(value)) invalidResponse();
	const prompts = value.map(parseSummary);
	const seen = new Set<string>();
	const ids = new Set<number>();
	for (let index = 0; index < prompts.length; index += 1) {
		const prompt = prompts[index];
		if (!prompt || seen.has(prompt.slug) || ids.has(prompt.id)) {
			invalidResponse();
		}
		seen.add(prompt.slug);
		ids.add(prompt.id);
	}
	return prompts;
}

export function parsePromptDetail(value: unknown): PromptDetail {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"created_at",
			"description",
			"id",
			"labels",
			"slug",
			"versions",
		]) ||
		!isPositiveSafeInteger(value.id) ||
		!isNonblankText(value.slug) ||
		(value.description !== null && typeof value.description !== "string") ||
		!isCanonicalTimestamp(value.created_at) ||
		!Array.isArray(value.versions)
	)
		invalidResponse();
	const versions = value.versions.map((candidate) => {
		if (
			!isRecord(candidate) ||
			!hasExactKeys(candidate, [
				"created_at",
				"messages_json",
				"notes",
				"variables_json",
				"version",
			]) ||
			!isPositiveSafeInteger(candidate.version) ||
			!Array.isArray(candidate.messages_json) ||
			!Array.isArray(candidate.variables_json) ||
			(candidate.notes !== null && typeof candidate.notes !== "string") ||
			!isCanonicalTimestamp(candidate.created_at)
		)
			invalidResponse();
		return {
			version: candidate.version,
			messages_json: candidate.messages_json,
			variables_json: candidate.variables_json,
			notes: candidate.notes,
			created_at: candidate.created_at,
		};
	});
	for (let index = 0; index < versions.length; index += 1) {
		const version = versions[index];
		const previous = versions[index - 1];
		if (!version || (previous && previous.version >= version.version))
			invalidResponse();
	}
	const labels = parseLabels(value.labels, true) as Array<
		PromptLabel & { updated_at: string }
	>;
	const availableVersions = new Set(versions.map((version) => version.version));
	if (labels.some((label) => !availableVersions.has(label.version)))
		invalidResponse();
	return {
		id: value.id,
		slug: value.slug,
		description: value.description,
		created_at: value.created_at,
		labels,
		versions,
	};
}

/** Makes control characters visible without normalizing the underlying prompt identity. */
export function displayPromptText(value: string): string {
	let rendered = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (character === "\\") {
			rendered += "\\\\";
		} else if (codePoint !== undefined && /[\p{Cc}\p{Cf}]/u.test(character)) {
			rendered +=
				codePoint <= 0xffff
					? `\\u${codePoint.toString(16).padStart(4, "0")}`
					: `\\u{${codePoint.toString(16)}}`;
		} else rendered += character;
	}
	return rendered;
}

function safeText(value: string): string {
	return escapeHtml(displayPromptText(value));
}

/** Prose and serialized JSON retain printable characters such as backslashes. */
function safeContent(value: string): string {
	return escapeHtml(
		value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
			const point = character.codePointAt(0) ?? 0;
			return point <= 0xffff
				? `\\u${point.toString(16).padStart(4, "0")}`
				: `\\u{${point.toString(16)}}`;
		}),
	);
}

export function promptPath(slug: string): string {
	return `/admin/api/prompts/${encodeURIComponent(slug)}`;
}

export function promptDiffPath(
	slug: string,
	first: number,
	second: number,
): string {
	return `${promptPath(slug)}/versions/${first}/diff/${second}`;
}

export function promptLabelPath(slug: string, label: string): string {
	return `${promptPath(slug)}/labels/${encodeURIComponent(label)}`;
}

export function toggleVersionSelection(
	current: number[],
	version: number,
): number[] {
	if (!Number.isSafeInteger(version) || version < 1) return current;
	if (current.includes(version))
		return current.filter((candidate) => candidate !== version);
	if (current.length >= 2) return current;
	return [...current, version].sort((left, right) => left - right);
}

export function renderUnifiedDiff(diff: string): string {
	const lines = diff.split("\n");
	return `<pre class="prompt-diff" tabindex="0" aria-label="Unified prompt version diff"><code>${lines
		.map((line) => {
			const klass =
				line.startsWith("+") && !line.startsWith("+++")
					? " prompt-diff__line--added"
					: line.startsWith("-") && !line.startsWith("---")
						? " prompt-diff__line--removed"
						: "";
			return `<span class="prompt-diff__line${klass}">${safeContent(line)}</span>`;
		})
		.join("\n")}</code></pre>`;
}

function parseLabelMoveResponse(
	value: unknown,
	promptId: number,
	label: string,
	toVersion: number,
): number | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"from_version",
			"label",
			"prompt_id",
			"to_version",
		]) ||
		value.prompt_id !== promptId ||
		value.label !== label ||
		value.to_version !== toVersion ||
		(value.from_version !== null && !isPositiveSafeInteger(value.from_version))
	)
		invalidResponse();
	return value.from_version;
}

export async function requestPromptList(
	signal: AbortSignal,
	request: typeof api = api,
): Promise<PromptSummary[]> {
	const response = await request("/admin/api/prompts", {
		signal,
		cache: "no-store",
	});
	if (!response.ok) throw new Error("The gateway could not load prompts.");
	return parsePromptList(await response.json());
}

export async function requestPromptDetail(
	slug: string,
	signal: AbortSignal,
	request: typeof api = api,
): Promise<PromptDetail> {
	const response = await request(promptPath(slug), {
		signal,
		cache: "no-store",
	});
	if (!response.ok) throw new Error("The gateway could not load this prompt.");
	return parsePromptDetail(await response.json());
}

export async function requestPromptDiff(
	slug: string,
	versions: number[],
	signal: AbortSignal,
	request: typeof api = api,
): Promise<string> {
	if (versions.length !== 2)
		throw new Error("Select exactly two prompt versions.");
	const [first, second] = versions;
	if (!first || !second || first >= second)
		throw new Error("Select two distinct prompt versions.");
	const response = await request(promptDiffPath(slug, first, second), {
		signal,
		cache: "no-store",
	});
	if (!response.ok)
		throw new Error("The gateway could not load the version diff.");
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("text/plain")) invalidResponse();
	const patch = await response.text();
	const lines = patch.split("\n");
	const before = lines.findIndex((line) => line.startsWith("--- "));
	const after = lines.findIndex(
		(line, index) => index > before && line.startsWith("+++ "),
	);
	if (before < 0 || after !== before + 1) invalidResponse();
	return patch;
}

export async function movePromptLabel(
	promptId: number,
	slug: string,
	label: string,
	fromVersion: number,
	version: number,
	signal: AbortSignal,
	request: typeof api = api,
	confirm: (message: string) => boolean = window.confirm.bind(window),
): Promise<false | number | null> {
	if (fromVersion === version) return false;
	const verb = version > fromVersion ? "Promote" : "Roll back";
	if (
		!confirm(
			`${verb} @${displayPromptText(label)} from ${displayPromptText(slug)}@${fromVersion} to @${version}? The next gateway request using this label will resolve to version ${version}. Prompt history remains immutable.`,
		)
	) {
		return false;
	}
	const response = await request(promptLabelPath(slug, label), {
		method: "PUT",
		signal,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ version }),
	});
	if (!response.ok) throw new Error("The gateway could not move this label.");
	return parseLabelMoveResponse(
		await response.json(),
		promptId,
		label,
		version,
	);
}

function labelsMarkup(labels: PromptLabel[]): string {
	if (!labels.length)
		return '<p class="prompt-muted">No deployment labels are set.</p>';
	return `<ul class="prompt-labels">${labels
		.map(
			(label) =>
				`<li><code>@${safeText(label.label)}</code><span>version ${label.version}</span>${label.updated_at ? `<time datetime="${escapeHtml(`${label.updated_at.replace(" ", "T")}Z`)}">updated ${safeText(label.updated_at)} UTC</time>` : ""}</li>`,
		)
		.join("")}</ul>`;
}

function jsonMarkup(value: unknown[]): string {
	const json = JSON.stringify(value, null, 2)
		.split("\n")
		.map(safeContent)
		.join("\n");
	return `<pre class="prompt-json" tabindex="0"><code>${json}</code></pre>`;
}

function renderVersionCard(
	detail: PromptDetail,
	version: PromptVersion,
): string {
	const checked = selectedVersions.includes(version.version) ? " checked" : "";
	const disabled = actionPending ? " disabled" : "";
	const movableLabels = detail.labels
		.map((label, index) => ({ label, index }))
		.filter(({ label }) => label.version !== version.version);
	const action = movableLabels.length
		? `<div class="prompt-version__move"><span>Deployment action</span>${movableLabels.map(({ label, index }) => `<button class="button button--secondary" type="button" data-prompts-move-version="${version.version}" data-prompts-label-index="${index}"${disabled}>${actionPending ? "Moving label…" : `${version.version > label.version ? "Promote" : "Roll back"} @${safeText(label.label)} here`}</button>`).join("")}</div>`
		: detail.labels.length
			? '<p class="prompt-muted">All labels already point to this version.</p>'
			: "";
	return `<article class="prompt-version"><div class="prompt-version__heading"><h3>Version ${version.version}</h3><label class="prompt-version__select"><input type="checkbox" data-prompt-version="${version.version}"${checked}> Compare this version</label></div><p class="prompt-muted"><time datetime="${escapeHtml(`${version.created_at.replace(" ", "T")}Z`)}">Created ${safeText(version.created_at)} UTC</time>${version.notes === null ? "" : ` · ${safeContent(version.notes)}`}</p><details><summary>Messages</summary>${jsonMarkup(version.messages_json)}</details><details><summary>Variables</summary>${jsonMarkup(version.variables_json)}</details>${action}</article>`;
}

export function renderPromptsData(
	prompts: PromptSummary[],
	detail: PromptDetail | undefined,
	diff: string | undefined,
): string {
	const list = prompts.length
		? `<ul class="prompt-list">${prompts
				.map(
					(prompt) =>
						`<li><button type="button" class="prompt-list__item${prompt.slug === selectedSlug ? " prompt-list__item--active" : ""}" data-prompts-select="${prompt.id}"${prompt.slug === selectedSlug ? ' aria-current="true"' : ""}><strong>${safeText(prompt.slug)}</strong><span>${prompt.latest_version === null ? "No versions yet" : `Latest: v${prompt.latest_version}`}</span><small>${
							prompt.labels.length
								? prompt.labels
										.map(
											(label) =>
												`@${displayPromptText(label.label)} → v${label.version}`,
										)
										.map(escapeHtml)
										.join(" · ")
								: "No labels"
						}</small></button></li>`,
				)
				.join("")}</ul>`
		: '<p class="empty-state">No prompts have been registered yet.</p>';
	let main =
		'<section class="prompt-empty"><h2>Select a prompt</h2><p>Choose a prompt to inspect its immutable versions and current deployment labels.</p></section>';
	if (detail) {
		const diffBody =
			selectedVersions.length !== 2
				? `<p class="prompt-muted">Select exactly two versions to load their unified messages diff. ${selectedVersions.length}/2 selected.</p>`
				: diff === undefined
					? '<p class="prompt-muted" aria-live="polite">Loading version diff…</p>'
					: !/^@@ /m.test(diff)
						? '<p class="prompt-muted">No message changes.</p>'
						: renderUnifiedDiff(diff);
		main = `<section class="prompt-detail" aria-labelledby="prompt-detail-title"><div class="prompt-detail__heading"><div><p class="eyebrow">Prompt registry</p><h2 id="prompt-detail-title">${safeText(detail.slug)}</h2><p class="overview-subtitle">${detail.description === null ? "No description recorded." : safeContent(detail.description)}</p></div><p class="panel__stat">${detail.versions.length} immutable version${detail.versions.length === 1 ? "" : "s"}</p></div>${actionNotice ? `<p class="data-notice" role="status">${safeContent(actionNotice)}</p>` : ""}<div class="prompt-detail__grid"><section class="panel"><h2>Current labels</h2>${labelsMarkup(detail.labels)}</section><section class="panel"><h2>Version comparison</h2>${diffBody}<p class="prompt-muted">The unified diff compares messages only; variables and notes are shown with each immutable version below.</p></section></div><section class="prompt-versions" aria-label="Immutable prompt versions">${detail.versions.map((version) => renderVersionCard(detail, version)).join("") || '<p class="empty-state">This prompt has no versions yet.</p>'}</section></section>`;
	}
	return `<div class="prompts-layout"><aside class="panel prompt-sidebar" aria-label="Registered prompts"><div class="prompt-sidebar__heading"><div><p class="eyebrow">Registry</p><h2>Prompts</h2></div><button class="button button--secondary" type="button" data-prompts-retry>Refresh</button></div>${list}</aside><div class="prompts-main">${main}</div></div>`;
}

function shell(content: string): string {
	return `<div class="app-shell"><header class="app-header"><a class="brand" href="#overview" aria-label="PromptGate dashboard home"><span class="brand__mark" aria-hidden="true">P</span><span>PromptGate</span></a><nav aria-label="Dashboard sections"><a class="nav-link" href="#overview">Overview</a><a class="nav-link" href="#cost">Cost</a><a class="nav-link nav-link--active" href="#prompts" aria-current="page">Prompts</a><a class="nav-link" href="#quality">Quality</a></nav></header><main id="dashboard-content" tabindex="-1"><div class="overview-toolbar"><div><p class="eyebrow">Registry</p><h1 id="prompts-title">Prompt versions</h1><p class="overview-subtitle">Inspect immutable prompt history and move deployment labels deliberately.</p></div></div><div class="data-notice" role="note"><strong>Deployment labels are mutable pointers:</strong> moving a label changes future gateway resolution, while every version remains immutable.</div><p id="prompts-status" role="status" aria-live="polite" hidden></p><div id="prompts-results">${content}</div></main></div>`;
}

function setResults(root: HTMLElement, content: string): void {
	root.querySelector<HTMLElement>("#prompts-results")?.replaceChildren();
	const results = root.querySelector<HTMLElement>("#prompts-results");
	if (results) results.innerHTML = content;
}

function renderLoading(root: HTMLElement): void {
	setResults(
		root,
		'<section class="loading-state" aria-live="polite" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading prompts</h2><p>Requesting the authenticated prompt registry.</p></div></section>',
	);
}

function renderError(root: HTMLElement, message: string): void {
	setResults(
		root,
		`<section class="error-state" role="alert"><h2>Couldn’t load prompts</h2><p>${escapeHtml(message)}</p><button class="button" type="button" data-prompts-retry>Try again</button></section>`,
	);
}

function setPromptStatus(
	root: HTMLElement,
	message: string | undefined,
	isError = false,
): void {
	const status = root.querySelector<HTMLElement>("#prompts-status");
	if (!status) return;
	status.textContent = message ?? "";
	status.hidden = message === undefined;
	status.className = isError ? "prompt-action-error" : "data-notice";
	status.setAttribute("role", isError ? "alert" : "status");
}

function renderCurrent(
	root: HTMLElement,
	diff?: string,
	restoreSelector?: string,
): void {
	setResults(root, renderPromptsData(promptList, selectedDetail, diff));
	if (restoreSelector)
		root.querySelector<HTMLElement>(restoreSelector)?.focus();
}

export function disposePrompts(): void {
	generation += 1;
	listRequest?.abort();
	detailRequest?.abort();
	diffRequest?.abort();
	actionRequest?.abort();
	listRequest = undefined;
	detailRequest = undefined;
	diffRequest = undefined;
	actionRequest = undefined;
	actionPending = false;
	listenerController?.abort();
	listenerController = undefined;
}

export async function refreshPrompts(
	root: HTMLElement,
	request: typeof api = api,
	retainSelection = false,
): Promise<boolean> {
	const owner = ++generation;
	listRequest?.abort();
	const controller = new AbortController();
	listRequest = controller;
	selectedDetail = undefined;
	selectedVersions = [];
	actionNotice = undefined;
	if (!retainSelection) selectedSlug = undefined;
	setPromptStatus(root, undefined);
	renderLoading(root);
	try {
		const loaded = await requestPromptList(controller.signal, request);
		if (controller.signal.aborted || owner !== generation) return false;
		promptList = loaded;
		if (
			!selectedSlug ||
			!loaded.some((prompt) => prompt.slug === selectedSlug)
		) {
			selectedSlug = undefined;
			selectedDetail = undefined;
			selectedVersions = [];
		}
		renderCurrent(root);
		return true;
	} catch {
		if (!controller.signal.aborted && owner === generation) {
			renderError(
				root,
				"Check the gateway connection and admin token, then try again.",
			);
		}
		return false;
	} finally {
		if (listRequest === controller) listRequest = undefined;
	}
}

async function loadDiff(
	root: HTMLElement,
	detail: PromptDetail,
): Promise<void> {
	diffRequest?.abort();
	if (selectedVersions.length !== 2) return;
	const owner = ++generation;
	const controller = new AbortController();
	diffRequest = controller;
	const restoreSelector = `[data-prompt-version="${selectedVersions.at(-1)}"]`;
	renderCurrent(root, undefined, restoreSelector);
	try {
		const diff = await requestPromptDiff(
			detail.slug,
			selectedVersions,
			controller.signal,
		);
		if (
			controller.signal.aborted ||
			owner !== generation ||
			selectedDetail !== detail
		)
			return;
		renderCurrent(root, diff, restoreSelector);
	} catch {
		if (
			!controller.signal.aborted &&
			owner === generation &&
			selectedDetail === detail
		) {
			const target = root.querySelector<HTMLElement>(
				".prompt-detail .panel:nth-child(2)",
			);
			if (target)
				target.innerHTML =
					'<h2>Version comparison</h2><p class="prompt-action-error" role="alert">Couldn’t load the version diff.</p><button class="button button--secondary" type="button" data-prompts-diff-retry>Retry diff</button><p class="prompt-muted">The unified diff compares messages only; variables and notes are shown with each immutable version below.</p>';
		}
	} finally {
		if (diffRequest === controller) diffRequest = undefined;
	}
}

async function selectPrompt(
	root: HTMLElement,
	prompt: PromptSummary,
	request: typeof api = api,
): Promise<boolean> {
	const owner = ++generation;
	detailRequest?.abort();
	diffRequest?.abort();
	selectedSlug = prompt.slug;
	selectedDetail = undefined;
	selectedVersions = [];
	const restoreSelector = `[data-prompts-select="${prompt.id}"]`;
	renderCurrent(root, undefined, restoreSelector);
	const controller = new AbortController();
	detailRequest = controller;
	try {
		const detail = await requestPromptDetail(
			prompt.slug,
			controller.signal,
			request,
		);
		if (detail.id !== prompt.id || detail.slug !== prompt.slug)
			invalidResponse();
		if (
			controller.signal.aborted ||
			owner !== generation ||
			selectedSlug !== prompt.slug
		)
			return false;
		selectedDetail = detail;
		renderCurrent(root, undefined, restoreSelector);
		return true;
	} catch {
		if (
			!controller.signal.aborted &&
			owner === generation &&
			selectedSlug === prompt.slug
		) {
			renderError(
				root,
				"This prompt could not be loaded. Select it again to retry.",
			);
		}
		return false;
	} finally {
		if (detailRequest === controller) detailRequest = undefined;
	}
}

export async function reloadPromptAfterMove(
	root: HTMLElement,
	slug: string,
	request: typeof api = api,
): Promise<boolean> {
	selectedSlug = slug;
	if (!(await refreshPrompts(root, request, true))) return false;
	const refreshed = promptList.find((prompt) => prompt.slug === slug);
	if (!refreshed || selectedSlug !== slug) return false;
	return selectPrompt(root, refreshed, request);
}

async function performLabelMove(
	root: HTMLElement,
	version: number,
	labelIndex: number,
): Promise<void> {
	if (!selectedDetail) return;
	const detail = selectedDetail;
	if (actionPending) return;
	const label = detail.labels[labelIndex];
	if (!label) return;
	const controller = new AbortController();
	actionRequest = controller;
	actionPending = true;
	setPromptStatus(root, undefined);
	renderCurrent(root);
	let persistentError: string | undefined;
	try {
		const movedFrom = await movePromptLabel(
			detail.id,
			detail.slug,
			label.label,
			label.version,
			version,
			controller.signal,
		);
		if (movedFrom === false || controller.signal.aborted) return;
		const action =
			movedFrom === null
				? "Set"
				: movedFrom < version
					? "Promoted"
					: movedFrom > version
						? "Rolled back"
						: "Confirmed";
		if (await reloadPromptAfterMove(root, detail.slug)) {
			actionNotice = `${action} @${displayPromptText(label.label)} from version ${movedFrom ?? "none"} to version ${version}. The registry has been refreshed to confirm current state.`;
		} else {
			selectedSlug = undefined;
			selectedDetail = undefined;
			actionNotice = undefined;
			persistentError =
				"The label move succeeded, but the current registry state could not be reloaded. Refresh the registry before another move.";
		}
	} catch {
		if (!controller.signal.aborted)
			persistentError =
				"The label move could not be confirmed and may have succeeded. Refresh the registry before retrying.";
	} finally {
		if (actionRequest === controller) actionRequest = undefined;
		actionPending = false;
		if (!controller.signal.aborted) {
			renderCurrent(root);
			if (persistentError) setPromptStatus(root, persistentError, true);
		}
	}
}

export function renderPrompts(root: HTMLElement): void {
	disposePrompts();
	promptList = [];
	selectedSlug = undefined;
	selectedDetail = undefined;
	selectedVersions = [];
	actionPending = false;
	root.innerHTML = shell(
		'<section class="loading-state" aria-live="polite" aria-busy="true"><span class="loading-state__spinner" aria-hidden="true"></span><div><h2>Loading prompts</h2><p>Requesting the authenticated prompt registry.</p></div></section>',
	);
	listenerController = new AbortController();
	root.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-prompts-retry]")) {
				void refreshPrompts(root);
				return;
			}
			if (target.closest("[data-prompts-diff-retry]") && selectedDetail) {
				void loadDiff(root, selectedDetail);
				return;
			}
			const selection = target.closest<HTMLElement>("[data-prompts-select]");
			if (selection) {
				const id = Number(selection.dataset.promptsSelect);
				const prompt = promptList.find((candidate) => candidate.id === id);
				if (Number.isSafeInteger(id) && prompt) void selectPrompt(root, prompt);
				return;
			}
			const move = target.closest<HTMLElement>("[data-prompts-move-version]");
			if (move) {
				const version = Number(move.dataset.promptsMoveVersion);
				const labelIndex = Number(move.dataset.promptsLabelIndex);
				if (
					Number.isSafeInteger(version) &&
					version > 0 &&
					Number.isSafeInteger(labelIndex) &&
					labelIndex >= 0
				)
					void performLabelMove(root, version, labelIndex);
			}
		},
		{ signal: listenerController.signal },
	);
	root.addEventListener(
		"change",
		(event) => {
			const target = event.target;
			if (
				!(target instanceof HTMLInputElement) ||
				!target.dataset.promptVersion ||
				!selectedDetail
			)
				return;
			const version = Number(target.dataset.promptVersion);
			const next = toggleVersionSelection(selectedVersions, version);
			if (
				next.length === selectedVersions.length &&
				!selectedVersions.includes(version)
			) {
				target.checked = false;
				return;
			}
			selectedVersions = next;
			diffRequest?.abort();
			renderCurrent(root, undefined, `[data-prompt-version="${version}"]`);
			if (next.length === 2) void loadDiff(root, selectedDetail);
		},
		{ signal: listenerController.signal },
	);
	void refreshPrompts(root);
}
