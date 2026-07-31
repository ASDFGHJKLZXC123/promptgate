import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sendError } from "../errors.js";
import {
	type MetricTimestampBound,
	metricGroups,
	metricNames,
	readMetricsTimeseries,
} from "./metrics.dao.js";

const utcTimestamp = z.string().transform((value, ctx) => {
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
			value,
		);
	if (!match) {
		ctx.addIssue({ code: "custom", message: "Expected an RFC3339 timestamp." });
		return z.NEVER;
	}
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map(Number);
	const local = new Date(
		`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
	);
	const offset = match[7];
	if (
		local.getUTCFullYear() !== year ||
		local.getUTCMonth() + 1 !== month ||
		local.getUTCDate() !== day ||
		local.getUTCHours() !== hour ||
		local.getUTCMinutes() !== minute ||
		local.getUTCSeconds() !== second ||
		(offset !== "Z" &&
			(Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
	) {
		ctx.addIssue({
			code: "custom",
			message: "Expected a valid RFC3339 timestamp.",
		});
		return z.NEVER;
	}
	const offsetSeconds =
		offset === "Z"
			? 0
			: (offset.startsWith("+") ? 1 : -1) *
				(Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) *
				60;
	const epochSecond = local.getTime() / 1_000 - offsetSeconds;
	const normalized = new Date(epochSecond * 1_000);
	if (
		!Number.isSafeInteger(epochSecond) ||
		Number.isNaN(normalized.valueOf())
	) {
		ctx.addIssue({
			code: "custom",
			message: "Expected a valid RFC3339 timestamp.",
		});
		return z.NEVER;
	}
	const fraction = value.match(/\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
	const bound: MetricTimestampBound = {
		epochSecond,
		nanoseconds: Number(fraction.padEnd(9, "0")),
		sqlSecond: normalized.toISOString().slice(0, 19).replace("T", " "),
	};
	return bound;
});

const querySchema = z
	.object({
		metric: z.enum(metricNames),
		group: z.enum(metricGroups).default("none"),
		from: utcTimestamp.optional(),
		to: utcTimestamp.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.from !== undefined &&
			value.to !== undefined &&
			(value.from.epochSecond > value.to.epochSecond ||
				(value.from.epochSecond === value.to.epochSecond &&
					value.from.nanoseconds >= value.to.nanoseconds))
		) {
			ctx.addIssue({
				code: "custom",
				message: "from must be earlier than to.",
			});
		}
	});

export function registerAdminMetricsRoutes(
	server: FastifyInstance,
	db: Database.Database,
): void {
	server.get("/api/metrics/timeseries", (request, reply) => {
		const query = querySchema.safeParse(request.query);
		if (!query.success) {
			return sendError(
				reply,
				400,
				"Invalid metrics query.",
				"invalid_request_error",
			);
		}
		return reply.send(readMetricsTimeseries(db, query.data));
	});
}
