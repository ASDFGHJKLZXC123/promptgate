import type Database from "better-sqlite3";

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface EvalDatasetInput {
	slug: string;
	filePath: string;
	description: string | null;
}

export interface StoredEvalDataset {
	id: number;
	slug: string;
	file_path: string;
	description: string | null;
}

export interface EvalResultInput {
	caseId: string;
	passed: boolean;
	score: number | null;
	detail: JsonValue;
	latencyMs: number | null;
	costMicroUsd: number | null;
}

export interface EvalRunInput {
	datasetId: number;
	datasetHash: string;
	promptId: number | null;
	promptVersion: number | null;
	promptRef: string | null;
	model: string;
	gitSha: string | null;
	trigger: "ci" | "manual";
	casesTotal: number;
	casesPassed: number;
	scoreAvg: number | null;
	costMicroUsd: number;
	durationMs: number;
	results: readonly EvalResultInput[];
}

export interface StoredEvalResult {
	run_id: number;
	case_id: string;
	passed: boolean;
	score: number | null;
	detail_json: JsonValue;
	latency_ms: number | null;
	cost_micro_usd: number | null;
}

export interface StoredEvalRun {
	id: number;
	ts: string;
	dataset_id: number;
	dataset_slug: string;
	dataset_hash: string;
	prompt_id: number | null;
	prompt_version: number | null;
	prompt_ref: string | null;
	model: string;
	git_sha: string | null;
	trigger: "ci" | "manual";
	cases_total: number;
	cases_passed: number;
	score_avg: number | null;
	cost_micro_usd: number;
	duration_ms: number;
}

interface EvalRunRow {
	id: unknown;
	ts: unknown;
	dataset_id: unknown;
	dataset_slug: unknown;
	dataset_hash: unknown;
	prompt_id: unknown;
	prompt_version: unknown;
	prompt_ref: unknown;
	model: unknown;
	git_sha: unknown;
	trigger: unknown;
	cases_total: unknown;
	cases_passed: unknown;
	score_avg: unknown;
	cost_micro_usd: unknown;
	duration_ms: unknown;
}

interface EvalResultRow {
	run_id: unknown;
	case_id: unknown;
	passed: unknown;
	score: unknown;
	detail_json: unknown;
	latency_ms: unknown;
	cost_micro_usd: unknown;
}

function parseStoredDetail(json: unknown): JsonValue {
	if (typeof json !== "string") {
		throw new Error("Stored eval result detail_json is not text");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("Stored eval result detail_json is invalid JSON");
	}
	if (!isJsonValue(parsed)) {
		throw new Error("Stored eval result detail_json is not a JSON value");
	}
	return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return false;
	}
	return Object.values(value).every(isJsonValue);
}

function isSafePositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNullableScore(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 1)
	);
}

function isNullableSafeNonNegativeInteger(
	value: unknown,
): value is number | null {
	return value === null || isSafeNonNegativeInteger(value);
}

function mapRun(row: EvalRunRow): StoredEvalRun {
	if (
		!isSafePositiveInteger(row.id) ||
		!isNonEmptyString(row.ts) ||
		!isSafePositiveInteger(row.dataset_id) ||
		!isNonEmptyString(row.dataset_slug) ||
		typeof row.dataset_hash !== "string" ||
		!/^[a-fA-F0-9]{64}$/.test(row.dataset_hash) ||
		!isNonEmptyString(row.model) ||
		(row.trigger !== "ci" && row.trigger !== "manual") ||
		!isSafePositiveInteger(row.cases_total) ||
		!isSafeNonNegativeInteger(row.cases_passed) ||
		row.cases_passed > row.cases_total ||
		!isNullableScore(row.score_avg) ||
		!isSafeNonNegativeInteger(row.cost_micro_usd) ||
		!isSafeNonNegativeInteger(row.duration_ms)
	) {
		throw new Error("Stored eval run is invalid");
	}

	const hasPromptId = row.prompt_id !== null;
	const hasPromptVersion = row.prompt_version !== null;
	const hasPromptRef = row.prompt_ref !== null;
	if (
		hasPromptId !== hasPromptVersion ||
		hasPromptId !== hasPromptRef ||
		(hasPromptId && !isSafePositiveInteger(row.prompt_id)) ||
		(hasPromptVersion && !isSafePositiveInteger(row.prompt_version)) ||
		(hasPromptRef && !isNonEmptyString(row.prompt_ref))
	) {
		throw new Error("Stored eval run prompt attribution is invalid");
	}
	if (
		row.git_sha !== null &&
		(typeof row.git_sha !== "string" ||
			!/^[a-fA-F0-9]{7,64}$/.test(row.git_sha))
	) {
		throw new Error("Stored eval run git_sha is invalid");
	}

	return row as StoredEvalRun;
}

function mapResult(row: EvalResultRow): StoredEvalResult {
	if (
		!isSafePositiveInteger(row.run_id) ||
		!isNonEmptyString(row.case_id) ||
		(row.passed !== 0 && row.passed !== 1) ||
		!isNullableScore(row.score) ||
		!isNullableSafeNonNegativeInteger(row.latency_ms) ||
		!isNullableSafeNonNegativeInteger(row.cost_micro_usd)
	) {
		throw new Error("Stored eval result is invalid");
	}
	return {
		run_id: row.run_id,
		case_id: row.case_id,
		passed: row.passed === 1,
		score: row.score,
		detail_json: parseStoredDetail(row.detail_json),
		latency_ms: row.latency_ms,
		cost_micro_usd: row.cost_micro_usd,
	};
}

function assertStoredAggregates(
	run: StoredEvalRun,
	results: readonly StoredEvalResult[],
): void {
	const passed = results.filter((result) => result.passed).length;
	const scores = results.flatMap((result) =>
		result.score === null ? [] : [result.score],
	);
	const cost = results.reduce(
		(sum, result) => sum + (result.cost_micro_usd ?? 0),
		0,
	);
	const average =
		scores.length === 0
			? null
			: scores.reduce((sum, score) => sum + score, 0) / scores.length;
	if (
		run.cases_total !== results.length ||
		run.cases_passed !== passed ||
		run.cost_micro_usd !== cost ||
		(run.score_avg === null) !== (average === null) ||
		(average !== null &&
			Math.abs((run.score_avg ?? 0) - average) >
				Number.EPSILON * Math.max(1, Math.abs(average)))
	) {
		throw new Error("Stored eval run aggregates do not match its results");
	}
}

/** Creates or updates the dataset metadata while preserving its stable id. */
export function upsertEvalDataset(
	db: Database.Database,
	input: EvalDatasetInput,
): StoredEvalDataset {
	const row = db
		.prepare(
			`INSERT INTO eval_datasets (slug, file_path, description)
			 VALUES (@slug, @file_path, @description)
			 ON CONFLICT(slug) DO UPDATE SET
			 file_path = excluded.file_path,
			 description = excluded.description
			 RETURNING id, slug, file_path, description`,
		)
		.get({
			slug: input.slug,
			file_path: input.filePath,
			description: input.description,
		}) as StoredEvalDataset | undefined;
	if (!row) throw new Error("Failed to persist eval dataset");
	return row;
}

/** Writes a single-model run and every case result as one SQLite transaction. */
export function createEvalRun(
	db: Database.Database,
	input: EvalRunInput,
): { run: StoredEvalRun; results: StoredEvalResult[] } {
	return db.transaction(() => {
		const inserted = db
			.prepare(
				`INSERT INTO eval_runs (
					dataset_id, dataset_hash, prompt_id, prompt_version, prompt_ref, model,
					git_sha, trigger, cases_total, cases_passed, score_avg,
					cost_micro_usd, duration_ms
				) VALUES (
					@dataset_id, @dataset_hash, @prompt_id, @prompt_version, @prompt_ref, @model,
					@git_sha, @trigger, @cases_total, @cases_passed, @score_avg,
					@cost_micro_usd, @duration_ms
				)
				RETURNING id`,
			)
			.get({
				dataset_id: input.datasetId,
				dataset_hash: input.datasetHash,
				prompt_id: input.promptId,
				prompt_version: input.promptVersion,
				prompt_ref: input.promptRef,
				model: input.model,
				git_sha: input.gitSha,
				trigger: input.trigger,
				cases_total: input.casesTotal,
				cases_passed: input.casesPassed,
				score_avg: input.scoreAvg,
				cost_micro_usd: input.costMicroUsd,
				duration_ms: input.durationMs,
			}) as { id: number } | undefined;
		if (!inserted) throw new Error("Failed to persist eval run");

		const insertResult = db.prepare(
			`INSERT INTO eval_results (
				run_id, case_id, passed, score, detail_json, latency_ms, cost_micro_usd
			) VALUES (
				@run_id, @case_id, @passed, @score, @detail_json, @latency_ms, @cost_micro_usd
			)`,
		);
		for (const result of input.results) {
			insertResult.run({
				run_id: inserted.id,
				case_id: result.caseId,
				passed: result.passed ? 1 : 0,
				score: result.score,
				detail_json: JSON.stringify(result.detail),
				latency_ms: result.latencyMs,
				cost_micro_usd: result.costMicroUsd,
			});
		}
		const run = findEvalRun(db, inserted.id);
		if (!run) throw new Error("Failed to read persisted eval run");
		const results = listEvalResults(db, run.id);
		assertStoredAggregates(run, results);
		return { run, results };
	})();
}

export function listEvalRuns(
	db: Database.Database,
	filters: {
		dataset?: string;
		promptRef?: string;
		model?: string;
		limit?: number;
	},
): StoredEvalRun[] {
	const where: string[] = [];
	const values: Record<string, string | number> = {};
	if (filters.dataset) {
		where.push("d.slug = @dataset");
		values.dataset = filters.dataset;
	}
	if (filters.promptRef) {
		where.push("r.prompt_ref = @prompt_ref");
		values.prompt_ref = filters.promptRef;
	}
	if (filters.model) {
		where.push("r.model = @model");
		values.model = filters.model;
	}
	if (filters.limit !== undefined) values.limit = filters.limit;
	const predicate = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const limit = filters.limit === undefined ? "" : "LIMIT @limit";
	const rows = db
		.prepare(
			`SELECT r.id, r.ts, r.dataset_id, r.dataset_hash, r.prompt_id, r.prompt_version,
			r.prompt_ref, r.model, r.git_sha, r.trigger, r.cases_total, r.cases_passed,
			r.score_avg, r.cost_micro_usd, r.duration_ms, d.slug AS dataset_slug
		 FROM eval_runs r JOIN eval_datasets d ON d.id = r.dataset_id
		 ${predicate} ORDER BY r.ts DESC, r.id DESC ${limit}`,
		)
		.all(values) as EvalRunRow[];
	return rows.map(mapRun);
}

export function findEvalRun(
	db: Database.Database,
	id: number,
): StoredEvalRun | null {
	const row = db
		.prepare(
			`SELECT r.id, r.ts, r.dataset_id, r.dataset_hash, r.prompt_id,
			r.prompt_version, r.prompt_ref, r.model, r.git_sha, r.trigger,
			r.cases_total, r.cases_passed, r.score_avg, r.cost_micro_usd,
			r.duration_ms, d.slug AS dataset_slug
		 FROM eval_runs r JOIN eval_datasets d ON d.id = r.dataset_id
		 WHERE r.id = ?`,
		)
		.get(id) as EvalRunRow | undefined;
	return row ? mapRun(row) : null;
}

export function listEvalResults(
	db: Database.Database,
	runId: number,
): StoredEvalResult[] {
	return (
		db
			.prepare(
				`SELECT run_id, case_id, passed, score, detail_json, latency_ms, cost_micro_usd
		 FROM eval_results WHERE run_id = ? ORDER BY case_id ASC`,
			)
			.all(runId) as EvalResultRow[]
	).map(mapResult);
}

export function findEvalRunWithResults(
	db: Database.Database,
	id: number,
): { run: StoredEvalRun; results: StoredEvalResult[] } | null {
	const run = findEvalRun(db, id);
	if (!run) return null;
	const results = listEvalResults(db, id);
	assertStoredAggregates(run, results);
	return { run, results };
}
