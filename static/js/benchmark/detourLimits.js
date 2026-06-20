/**
 * Detour policy for smart routes (browser benchmark + aligned with API).
 * - Max extra distance vs direct baseline: 5 km
 * - If a candidate beats the best within 5 km on env score, allow up to +500 m more detour (5.5 km total)
 */

export const MAX_DETOUR_M = 5000;
export const BETTER_SCORE_ENV_TOLERANCE_M = 500;

export function detourMetres(routeDistanceM, baselineDistanceM) {
    const base = Number(baselineDistanceM) || 0;
    const route = Number(routeDistanceM) || 0;
    return Math.max(0, route - base);
}

/**
 * Pick best candidate by environmental score (higher = better).
 * Each candidate: { distance_m, env_score, ... }
 */
const ENV_SCORE_EPSILON = 0.02;
const MIN_MEANINGFUL_DETOUR_M = 80;

/**
 * True if candidate could improve EI vs direct (not just a tie on the same path).
 */
export function isMeaningfulImprovement(candidate, baselineEnvScore) {
    if (baselineEnvScore == null || candidate?.env_score == null) return true;
    if (candidate.env_score > baselineEnvScore + ENV_SCORE_EPSILON) return true;
    if (
        candidate.detour_m >= MIN_MEANINGFUL_DETOUR_M &&
        candidate.env_score >= baselineEnvScore - ENV_SCORE_EPSILON
    ) {
        return true;
    }
    return false;
}

export function selectBestWithinDetourPolicy(
    candidates,
    baselineDistanceM,
    baselineEnvScore = null,
) {
    if (!candidates?.length || !baselineDistanceM) {
        return { chosen: null, reason: 'no_candidates' };
    }

    const withDetour = candidates.map((c) => ({
        ...c,
        detour_m: detourMetres(c.distance_m, baselineDistanceM),
    }));

    let pool = withDetour;
    if (baselineEnvScore != null) {
        const improving = withDetour.filter((c) =>
            isMeaningfulImprovement(c, baselineEnvScore),
        );
        if (improving.length > 0) {
            pool = improving;
        } else {
            return { chosen: null, reason: 'no_env_improvement_over_direct' };
        }
    }

    const withinHard = pool.filter((c) => c.detour_m <= MAX_DETOUR_M);
    const bestHard =
        withinHard.length > 0
            ? withinHard.reduce((a, b) => ((a.env_score ?? -1) >= (b.env_score ?? -1) ? a : b))
            : null;

    const hardScore = bestHard?.env_score ?? -Infinity;
    const softCap = MAX_DETOUR_M + BETTER_SCORE_ENV_TOLERANCE_M;
    const withinSoft = pool.filter(
        (c) =>
            c.detour_m <= softCap &&
            c.detour_m > MAX_DETOUR_M &&
            typeof c.env_score === 'number' &&
            c.env_score > hardScore,
    );

    if (withinSoft.length > 0) {
        const chosen = withinSoft.reduce((a, b) => (a.env_score >= b.env_score ? a : b));
        return {
            chosen,
            reason: 'soft_cap_better_env',
            max_detour_m: softCap,
            best_hard_detour_m: bestHard?.detour_m ?? null,
        };
    }

    if (bestHard) {
        return {
            chosen: bestHard,
            reason: 'within_5km_detour',
            max_detour_m: MAX_DETOUR_M,
        };
    }

    const withinSoftCap = pool.filter((c) => c.detour_m <= softCap);
    if (withinSoftCap.length > 0) {
        const chosen = withinSoftCap.reduce((a, b) =>
            (a.env_score ?? -1) >= (b.env_score ?? -1) ? a : b,
        );
        return {
            chosen,
            reason: 'within_5_5km_best_env',
            max_detour_m: softCap,
        };
    }

    return {
        chosen: null,
        reason: 'all_exceed_detour_cap',
        max_detour_m: softCap,
    };
}
