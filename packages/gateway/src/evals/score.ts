/**
 * Compares a declared arithmetic mean with scores that may have been read in a
 * different stable order. Floating-point addition is order-sensitive, so the
 * tolerance scales with the number of scored results while remaining near
 * machine precision.
 */
export function scoreAverageMatches(
	expected: number,
	scores: readonly number[],
): boolean {
	if (scores.length === 0) return false;
	const computed =
		scores.reduce((sum, score) => sum + score, 0) / scores.length;
	const scale = Math.max(1, Math.abs(expected), Math.abs(computed));
	const tolerance = Number.EPSILON * Math.max(1, scores.length) * scale;
	return Math.abs(expected - computed) <= tolerance;
}
