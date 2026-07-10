export interface WaveGroupPlannerConfig {
	minGroupSize: number;
	maxGroupSize: number;
	/**
	 * If true, distributes the remainder to the later groups (end of the audio).
	 * Rationale: the last chunk is more likely to be shorter, so later groups can
	 * take one extra chunk without increasing wall time too much.
	 */
	distributeRemainderToEnd?: boolean;
}

/**
 * Plan group sizes for "wave" parallelization.
 *
 * Guarantees (when totalItems > 0):
 * - Returns an array of positive integers summing to totalItems.
 * - When totalItems > maxGroupSize, it will create the minimum number of groups
 *   needed so that no group exceeds maxGroupSize.
 */
export function planWaveGroupSizes(
	totalItems: number,
	config: WaveGroupPlannerConfig
): number[] {
	if (totalItems <= 0) {
		return [];
	}

	const minGroupSize = Math.max(1, Math.floor(config.minGroupSize));
	const maxGroupSize = Math.max(minGroupSize, Math.floor(config.maxGroupSize));

	if (totalItems <= maxGroupSize) {
		return [totalItems];
	}

	const groupCount = Math.ceil(totalItems / maxGroupSize);
	const baseSize = Math.floor(totalItems / groupCount);
	const remainder = totalItems % groupCount;

	const sizes = Array.from({ length: groupCount }, () => baseSize);
	const distributeToEnd = config.distributeRemainderToEnd !== false;

	for (let i = 0; i < remainder; i++) {
		const index = distributeToEnd ? (groupCount - 1 - i) : i;
		sizes[index] = (sizes[index] ?? 0) + 1;
	}

	// Safety: ensure no zero/negative sizes (shouldn't happen, but keep robust).
	for (const size of sizes) {
		if (size < 1) {
			return [totalItems];
		}
	}

	// Safety: ensure we don't violate the requested bounds (best-effort fallback).
	const min = Math.min(...sizes);
	const max = Math.max(...sizes);
	if (totalItems > maxGroupSize && (min < minGroupSize || max > maxGroupSize)) {
		return [totalItems];
	}

	return sizes;
}

