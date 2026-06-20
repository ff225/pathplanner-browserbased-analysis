"""Detour limits for smart-route selection (API benchmark, mirrors browser policy)."""

from typing import Any, Dict, List, Optional

MAX_DETOUR_M = 5000
BETTER_SCORE_ENV_TOLERANCE_M = 500


def detour_metres(route_distance_m: float, baseline_distance_m: float) -> float:
    return max(0.0, float(route_distance_m or 0) - float(baseline_distance_m or 0))


def select_best_within_detour_policy(
    candidates: List[Dict[str, Any]],
    baseline_distance_m: float,
) -> Dict[str, Any]:
    if not candidates or not baseline_distance_m:
        return {'chosen': None, 'reason': 'no_candidates'}

    enriched = []
    for c in candidates:
        d_m = float(c.get('distance_m') or 0)
        enriched.append({**c, 'detour_m': detour_metres(d_m, baseline_distance_m)})

    within_hard = [c for c in enriched if c['detour_m'] <= MAX_DETOUR_M]
    best_hard = (
        max(within_hard, key=lambda c: float(c.get('env_score') or -1))
        if within_hard
        else None
    )
    hard_score = float(best_hard['env_score']) if best_hard else float('-inf')
    soft_cap = MAX_DETOUR_M + BETTER_SCORE_ENV_TOLERANCE_M
    within_soft = [
        c
        for c in enriched
        if c['detour_m'] <= soft_cap
        and c['detour_m'] > MAX_DETOUR_M
        and float(c.get('env_score') or -1) > hard_score
    ]

    if within_soft:
        chosen = max(within_soft, key=lambda c: float(c.get('env_score') or -1))
        return {
            'chosen': chosen,
            'reason': 'soft_cap_better_env',
            'max_detour_m': soft_cap,
        }

    if best_hard:
        return {
            'chosen': best_hard,
            'reason': 'within_5km_detour',
            'max_detour_m': MAX_DETOUR_M,
        }

    within_soft_cap = [c for c in enriched if c['detour_m'] <= soft_cap]
    if within_soft_cap:
        chosen = max(within_soft_cap, key=lambda c: float(c.get('env_score') or -1))
        return {
            'chosen': chosen,
            'reason': 'within_5_5km_best_env',
            'max_detour_m': soft_cap,
        }

    return {
        'chosen': None,
        'reason': 'all_exceed_detour_cap',
        'max_detour_m': soft_cap,
    }
