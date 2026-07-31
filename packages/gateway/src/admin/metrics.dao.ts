import type Database from "better-sqlite3";

export const metricNames = [
	"cost",
	"request_count",
	"latency_p50",
	"latency_p95",
	"cache_rate",
	"cache_saved",
	"tokens",
] as const;
export type MetricName = (typeof metricNames)[number];

export const metricGroups = ["none", "model", "key", "feature"] as const;
export type MetricGroup = (typeof metricGroups)[number];

/** An RFC3339 bound normalized without discarding its 1–9 digit fraction. */
export interface MetricTimestampBound {
	epochSecond: number;
	nanoseconds: number;
	/** UTC timestamp formatted for the gateway's second-resolution `requests.ts`. */
	sqlSecond: string;
}

export interface MetricsPoint {
	bucket_start: string;
	group_value: string | null;
	value: number | null;
	exact_value: number | null;
	estimated_value: number | null;
	unknown_count: number;
}

export interface MetricsTimeseries {
	metric: MetricName;
	unit: "micro_usd" | "count" | "ms" | "ratio" | "tokens";
	interval: "hour";
	group_by: MetricGroup;
	points: MetricsPoint[];
}

interface MetricRow {
	id: number;
	ts: string;
	request_id: string | null;
	bucket_start: string;
	group_value: string | null;
	cache_hit: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_micro_usd: number | null;
	cost_estimated: number;
	cache_saved_micro_usd: number | null;
	cache_saved_estimated: number | null;
	total_ms: number | null;
}

const groupExpressions: Record<MetricGroup, string> = {
	none: "NULL",
	model: "r.model",
	key: "k.name",
	feature: "r.feature",
};

const units: Record<MetricName, MetricsTimeseries["unit"]> = {
	cost: "micro_usd",
	request_count: "count",
	latency_p50: "ms",
	latency_p95: "ms",
	cache_rate: "ratio",
	cache_saved: "micro_usd",
	tokens: "tokens",
};

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonnegativeSafeInteger(
	value: unknown,
): value is number | null {
	return value === null || isNonnegativeSafeInteger(value);
}

function isCanonicalBucket(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00:00Z$/.test(value)
	) {
		return false;
	}
	const parsed = new Date(value);
	return (
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString() === value.replace("Z", ".000Z")
	);
}

function isCanonicalRequestTimestamp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.test(value)
	) {
		return false;
	}
	const parsed = new Date(`${value.replace(" ", "T")}Z`);
	return (
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString().slice(0, 19).replace("T", " ") === value
	);
}

function assertAllRequestTimestampsAreCanonical(db: Database.Database): void {
	// `iterate()` keeps this fail-closed preflight constant-memory even when a
	// narrow dashboard interval sits beside a large retained request history.
	for (const value of db
		.prepare("SELECT id, ts FROM requests")
		.iterate() as Iterable<unknown>) {
		if (typeof value !== "object" || value === null) {
			throw new TypeError("Invalid metrics database row.");
		}
		const row = value as Record<string, unknown>;
		if (
			!Number.isSafeInteger(row.id) ||
			(row.id as number) <= 0 ||
			!isCanonicalRequestTimestamp(row.ts)
		) {
			throw new TypeError("Invalid metrics database row.");
		}
	}
}

/** Validates SQLite values before they become an admin-facing aggregate. */
function validateMetricRow(value: unknown): MetricRow {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Invalid metrics database row.");
	}
	const row = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) <= 0 ||
		!isCanonicalRequestTimestamp(row.ts) ||
		!isCanonicalBucket(row.bucket_start) ||
		(row.group_value !== null && typeof row.group_value !== "string") ||
		(row.request_id !== null && typeof row.request_id !== "string") ||
		(row.cache_hit !== 0 && row.cache_hit !== 1) ||
		!isNullableNonnegativeSafeInteger(row.input_tokens) ||
		!isNullableNonnegativeSafeInteger(row.output_tokens) ||
		!isNullableNonnegativeSafeInteger(row.cost_micro_usd) ||
		(row.cost_estimated !== 0 && row.cost_estimated !== 1) ||
		!isNullableNonnegativeSafeInteger(row.cache_saved_micro_usd) ||
		(row.cache_saved_estimated !== null &&
			row.cache_saved_estimated !== 0 &&
			row.cache_saved_estimated !== 1) ||
		(row.total_ms !== null &&
			(typeof row.total_ms !== "number" ||
				!Number.isFinite(row.total_ms) ||
				row.total_ms < 0))
	) {
		throw new TypeError("Invalid metrics database row.");
	}
	return row as unknown as MetricRow;
}

function orderedGroups(rows: MetricRow[]): MetricRow[][] {
	const buckets = new Map<string, Map<string | null, MetricRow[]>>();
	for (const row of rows) {
		const groups = buckets.get(row.bucket_start) ?? new Map();
		if (!buckets.has(row.bucket_start)) {
			buckets.set(row.bucket_start, groups);
		}
		const existing = groups.get(row.group_value);
		if (existing) existing.push(row);
		else groups.set(row.group_value, [row]);
	}
	return [...buckets.values()].flatMap((groups) => [...groups.values()]);
}

function sum(values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (total > Number.MAX_SAFE_INTEGER - value) {
			throw new RangeError("Metrics aggregate exceeds safe integer range.");
		}
		total += value;
	}
	return total;
}

function provenancePoint(
	rows: MetricRow[],
	field: "cost_micro_usd" | "cache_saved_micro_usd",
	estimateField: "cost_estimated" | "cache_saved_estimated",
	valueIsUnknownWhenIncomplete: boolean,
): MetricsPoint {
	const exact = rows
		.filter((row) => row[field] !== null && row[estimateField] === 0)
		.map((row) => row[field] as number);
	const estimated = rows
		.filter((row) => row[field] !== null && row[estimateField] === 1)
		.map((row) => row[field] as number);
	const unknownCount = rows.filter(
		(row) => row[field] === null || row[estimateField] === null,
	).length;
	const exactValue = sum(exact);
	const estimatedValue = sum(estimated);
	const knownValue = sum([exactValue, estimatedValue]);
	return {
		bucket_start: rows[0].bucket_start,
		group_value: rows[0].group_value,
		value: valueIsUnknownWhenIncomplete && unknownCount > 0 ? null : knownValue,
		exact_value: exactValue,
		estimated_value: estimatedValue,
		unknown_count: unknownCount,
	};
}

function percentilePoint(rows: MetricRow[], quantile: number): MetricsPoint {
	const known = rows
		.filter((row) => row.total_ms !== null)
		.sort(
			(left, right) =>
				(left.total_ms as number) - (right.total_ms as number) ||
				(left.request_id ?? "").localeCompare(right.request_id ?? "") ||
				left.id - right.id,
		);
	const value =
		known.length === 0
			? null
			: (known[Math.ceil(quantile * known.length) - 1].total_ms as number);
	return {
		bucket_start: rows[0].bucket_start,
		group_value: rows[0].group_value,
		value,
		exact_value: null,
		estimated_value: null,
		unknown_count: rows.length - known.length,
	};
}

function simplePoint(
	rows: MetricRow[],
	metric: "request_count" | "cache_rate" | "tokens",
): MetricsPoint {
	let value: number;
	let unknownCount = 0;
	if (metric === "request_count") {
		value = rows.length;
	} else if (metric === "cache_rate") {
		value = rows.filter((row) => row.cache_hit === 1).length / rows.length;
	} else {
		const complete = rows.filter(
			(row) => row.input_tokens !== null && row.output_tokens !== null,
		);
		value = sum(
			complete.map((row) =>
				sum([row.input_tokens as number, row.output_tokens as number]),
			),
		);
		unknownCount = rows.length - complete.length;
	}
	return {
		bucket_start: rows[0].bucket_start,
		group_value: rows[0].group_value,
		value,
		exact_value: null,
		estimated_value: null,
		unknown_count: unknownCount,
	};
}

/**
 * Reads only durable raw request rows. Group expressions are selected from a
 * closed map rather than interpolating caller input into SQL.
 */
export function readMetricsTimeseries(
	db: Database.Database,
	input: {
		metric: MetricName;
		group: MetricGroup;
		from?: MetricTimestampBound;
		to?: MetricTimestampBound;
	},
): MetricsTimeseries {
	const groupExpression = groupExpressions[input.group];
	// Bounds use lexical comparison because gateway timestamps are canonical
	// UTC second strings. Preflight every raw timestamp first so an invalid row
	// cannot disappear behind a bounded predicate and produce a false subtotal.
	assertAllRequestTimestampsAreCanonical(db);
	// Gateway-created request timestamps are second-resolution. A lower bound
	// with a fractional component excludes that exact second; an upper bound
	// with one includes it under the contract's [from, to) semantics.
	const lowerOperator = input.from?.nanoseconds === 0 ? ">=" : ">";
	const upperOperator = input.to?.nanoseconds === 0 ? "<" : "<=";
	const rows = db
		.prepare(
			`SELECT r.id, r.ts, r.request_id,
				strftime('%Y-%m-%dT%H:00:00Z', r.ts) AS bucket_start,
				${groupExpression} AS group_value,
				r.cache_hit, r.input_tokens, r.output_tokens,
				r.cost_micro_usd, r.cost_estimated,
				r.cache_saved_micro_usd, r.cache_saved_estimated, r.total_ms
			 FROM requests AS r
			 JOIN api_keys AS k ON k.id = r.api_key_id
			 WHERE (@from_second IS NULL OR r.ts ${lowerOperator} @from_second)
				AND (@to_second IS NULL OR r.ts ${upperOperator} @to_second)
			 ORDER BY bucket_start ASC, group_value ASC, r.id ASC`,
		)
		.all({
			from_second: input.from?.sqlSecond ?? null,
			to_second: input.to?.sqlSecond ?? null,
		})
		.map(validateMetricRow);

	const points = orderedGroups(rows).map((group) => {
		switch (input.metric) {
			case "cost":
				return provenancePoint(
					group,
					"cost_micro_usd",
					"cost_estimated",
					false,
				);
			case "cache_saved":
				return provenancePoint(
					group,
					"cache_saved_micro_usd",
					"cache_saved_estimated",
					true,
				);
			case "latency_p50":
				return percentilePoint(group, 0.5);
			case "latency_p95":
				return percentilePoint(group, 0.95);
			case "request_count":
			case "cache_rate":
			case "tokens":
				return simplePoint(group, input.metric);
			default:
				throw new Error("Unsupported metrics query.");
		}
	});

	return {
		metric: input.metric,
		unit: units[input.metric],
		interval: "hour",
		group_by: input.group,
		points,
	};
}
