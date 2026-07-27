import type { ChatRequest } from "@promptgate/shared";
import { z } from "zod";

import type { ModelPricingRow } from "../providers/pricing.dao.js";

/** A monotonic clock dedicated to briefly memoizing settled SQLite spend. */
export type BudgetMemoClock = () => number;

const KeyIdSchema = z.number().int().positive();
const MicroUsdSchema = z.number().int().nonnegative();
const ClockReadingSchema = z.number().finite();

/**
 * Admission token. It is intentionally not exported as a value: only this
 * module can create it, and its unique identity supports exactly-once release.
 */
class BudgetReservationToken {
	readonly #opaque = true;

	public constructor(
		readonly keyId: number,
		readonly reservedMicroUsd: number,
	) {}

	public isOpaqueReservation(): boolean {
		return this.#opaque;
	}
}

/** Opaque reservation returned by BudgetGuard.reserve(). */
export type BudgetReservation = BudgetReservationToken;

interface SettledMemo {
	spendMicroUsd: number;
	readAtMs: number;
}

export interface BudgetGuardOptions {
	/** Reads current-month durable request cost for exactly one API key. */
	settledSpend: (keyId: number) => number;
	/** Kept separate from latency and rate-limit clocks for deterministic tests. */
	now?: BudgetMemoClock;
	/** Tiny cache only; inserts and successful admin PATCHes explicitly invalidate. */
	memoTtlMs?: number;
}

/**
 * Single-process reserve-then-reconcile circuit breaker. It deliberately
 * estimates chars/4 rather than claiming a tokenizer hard cap; provider-side
 * spend limits remain the absolute monetary wall.
 */
export class BudgetGuard {
	private readonly settledMemo = new Map<number, SettledMemo>();
	private readonly active = new Map<
		number,
		Map<BudgetReservationToken, number>
	>();
	private readonly debt = new Map<number, number>();
	private readonly now: BudgetMemoClock;
	private readonly memoTtlMs: number;

	public constructor(private readonly options: BudgetGuardOptions) {
		this.now = options.now ?? (() => performance.now());
		this.memoTtlMs = options.memoTtlMs ?? 250;
		if (!Number.isFinite(this.memoTtlMs) || this.memoTtlMs < 0) {
			throw new Error("Budget memo TTL must be a nonnegative finite number.");
		}
	}

	/**
	 * Synchronously admits only when durable spend, active reservations, fail-
	 * closed debt, and the new estimate fit. Equality is intentionally allowed.
	 */
	public reserve(
		keyId: number,
		budgetMicroUsdMonth: number,
		estimatedMicroUsd: number,
	): BudgetReservation | "over_budget" {
		const validatedKeyId = KeyIdSchema.parse(keyId);
		const budget = MicroUsdSchema.parse(budgetMicroUsdMonth);
		const estimate = MicroUsdSchema.parse(estimatedMicroUsd);
		const settled = this.currentSettledSpend(validatedKeyId);
		const active = this.activeSpend(validatedKeyId);
		const debt = this.debt.get(validatedKeyId) ?? 0;

		if (settled + active + debt + estimate > budget) {
			return "over_budget";
		}

		const reservation = new BudgetReservationToken(validatedKeyId, estimate);
		const reservations = this.active.get(validatedKeyId) ?? new Map();
		reservations.set(reservation, estimate);
		this.active.set(validatedKeyId, reservations);
		return reservation;
	}

	/**
	 * Releases one active reservation only after the request row containing the
	 * supplied actual cost is durable. Actual is validated here as part of the
	 * completion boundary; the next admission re-reads SQLite after invalidation.
	 */
	public reconcileAfterDurableLog(
		reservation: BudgetReservation,
		actualMicroUsd: number | null | undefined,
	): void {
		MicroUsdSchema.parse(actualMicroUsd ?? 0);
		if (!this.takeActive(reservation)) {
			return;
		}
		this.invalidate(reservation.keyId);
	}

	/**
	 * Logging failure must never reopen capacity. Convert exactly one active
	 * reservation into permanent fail-closed debt, retaining the larger of the
	 * reservation and known actual cost.
	 */
	public retainDebt(
		reservation: BudgetReservation,
		knownActualMicroUsd: number | null | undefined,
	): void {
		// Validate before mutating active state. A malformed actual must leave the
		// reservation counted, which is the fail-closed outcome.
		const knownActual = MicroUsdSchema.parse(knownActualMicroUsd ?? 0);
		const activeAmount = this.takeActive(reservation);
		if (activeAmount === undefined) {
			return;
		}
		const retained = Math.max(activeAmount, knownActual);
		this.debt.set(
			reservation.keyId,
			(this.debt.get(reservation.keyId) ?? 0) + retained,
		);
		this.invalidate(reservation.keyId);
	}

	/** Clears only durable-spend memoization; active reservations/debt remain. */
	public invalidate(keyId: number): void {
		this.settledMemo.delete(KeyIdSchema.parse(keyId));
	}

	private currentSettledSpend(keyId: number): number {
		const now = this.readNow();
		const cached = this.settledMemo.get(keyId);
		if (cached && now - cached.readAtMs <= this.memoTtlMs) {
			return cached.spendMicroUsd;
		}
		const spend = MicroUsdSchema.parse(this.options.settledSpend(keyId));
		this.settledMemo.set(keyId, { spendMicroUsd: spend, readAtMs: now });
		return spend;
	}

	private activeSpend(keyId: number): number {
		let total = 0;
		for (const amount of this.active.get(keyId)?.values() ?? []) {
			total += amount;
		}
		return total;
	}

	private takeActive(reservation: BudgetReservation): number | undefined {
		if (!reservation.isOpaqueReservation()) {
			return undefined;
		}
		const reservations = this.active.get(reservation.keyId);
		if (!reservations) {
			return undefined;
		}
		const amount = reservations.get(reservation);
		if (amount === undefined) {
			return undefined;
		}
		reservations.delete(reservation);
		if (reservations.size === 0) {
			this.active.delete(reservation.keyId);
		}
		return amount;
	}

	private readNow(): number {
		return ClockReadingSchema.parse(this.now());
	}
}

function messageChars(
	content: ChatRequest["messages"][number]["content"],
): number {
	if (typeof content === "string") {
		return content.length;
	}
	return Array.isArray(content) ? JSON.stringify(content).length : 0;
}

function componentCostWithMeterRounding(
	tokens: number,
	rateMicroUsdPerMtok: number,
): number {
	return Math.round((tokens * rateMicroUsdPerMtok) / 1_000_000);
}

/**
 * The documented pre-dispatch reservation: chars/4 input at ordinary input
 * pricing plus client max_tokens (or config default) at output pricing. Each
 * component uses the same independent integer micro-USD rounding as durable
 * ordinary metering, so a reservation never overstates a component that would
 * persist as zero actual cost.
 */
export function estimateBudgetReservation(
	body: ChatRequest,
	pricing: Pick<
		ModelPricingRow,
		"input_micro_usd_per_mtok" | "output_micro_usd_per_mtok"
	>,
	defaultMaxTokens: number,
): number {
	const chars = body.messages.reduce(
		(total, message) => total + messageChars(message.content),
		0,
	);
	const inputTokens = Math.ceil(chars / 4);
	const outputTokens = body.max_tokens ?? defaultMaxTokens;
	const inputRate = MicroUsdSchema.parse(pricing.input_micro_usd_per_mtok);
	const outputRate = MicroUsdSchema.parse(pricing.output_micro_usd_per_mtok);
	const boundedOutputTokens = z.number().int().positive().parse(outputTokens);
	return (
		componentCostWithMeterRounding(inputTokens, inputRate) +
		componentCostWithMeterRounding(boundedOutputTokens, outputRate)
	);
}
