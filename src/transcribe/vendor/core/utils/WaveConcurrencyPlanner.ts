/**
 * Decide how many wave-groups to run in parallel based on the total audio duration.
 *
 * Note:
 * - This does not change the group sizes (which are planned separately).
 * - The return value is clamped to [1, min(totalGroups, maxConcurrencyCap)].
 */
export function planWaveConcurrency(
	totalDurationSeconds: number,
	totalGroups: number,
	maxConcurrencyCap: number
): number {
	const safeTotalGroups = Math.max(0, Math.floor(totalGroups));
	const cap = Math.max(1, Math.floor(maxConcurrencyCap));

	if (safeTotalGroups <= 1) {
		return 1;
	}

	// Heuristic thresholds:
	// - < 45min: keep it small (2) to avoid 429 bursts in typical usage
	// - >= 45min: allow 3 for noticeable speedup
	// - >= 120min: allow 4 for very long recordings
	const duration = Math.max(0, totalDurationSeconds);
	const target = duration >= 2 * 60 * 60 ? 4 : duration >= 45 * 60 ? 3 : 2;

	return Math.min(target, cap, safeTotalGroups);
}

