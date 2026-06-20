#!/usr/bin/env python3
"""
Sensitivity analysis for browser scoring constants (mirrors scores.js active path).

Sweeps Tier-C parameters:
  (a) weight tiers [0.7,1.4,2.1] and [1.3,2.6,3.9] vs baseline [1,2,3]
  (b) poiScaleFactor 1.5 and 3.5 vs baseline 2 (env ranks unchanged; reported for completeness)
  (c) temperature comfortC 20 and 24 vs baseline 22

Outputs:
  docs/scoring_sensitivity_results.csv
  Scoring Validation summary on stdout (for paper methods section)

Usage (repo root):
  python3 scripts/scoring_sensitivity.py
"""
import csv
import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
CONSTANTS_PATH = ROOT / "static" / "data" / "scoring_constants.json"
OUT_CSV = ROOT / "docs" / "scoring_sensitivity_results.csv"

# Representative urban-walk factor profiles (typical magnitudes from browser CSVs)
BASE_SCENARIOS: List[Tuple[str, Dict[str, float]]] = [
    ("mild_day", {"temperature": 22, "humidity": 50, "airQuality": 4, "noise": 3, "slope": 2}),
    ("hot_humid", {"temperature": 30, "humidity": 75, "airQuality": 5, "noise": 4, "slope": 3}),
    ("noisy_polluted", {"temperature": 24, "humidity": 55, "airQuality": 7, "noise": 6, "slope": 4}),
    ("cold_dry", {"temperature": 12, "humidity": 35, "airQuality": 5, "noise": 4, "slope": 1}),
    ("hilly", {"temperature": 20, "humidity": 48, "airQuality": 4, "noise": 3, "slope": 7}),
    ("humid_coastal", {"temperature": 26, "humidity": 82, "airQuality": 6, "noise": 5, "slope": 2}),
]

# Slope sensitivities used in patientCondition profiles (browser default 5; mobility/cardiac often higher)
SLOPE_SENSITIVITIES = {"default": 5, "mobility": 8, "cardiac": 7, "arthritis": 6}

STABILITY_RHO_THRESHOLD = 0.80


def load_constants() -> dict:
    with CONSTANTS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def temperature_score(avg_c: float, cfg: dict) -> float:
    dev = abs(avg_c - cfg["comfortC"])
    bands = cfg["bands"]
    if dev <= bands["comfort"]["maxDeviationC"]:
        return bands["comfort"]["score"]
    if dev <= bands["moderate"]["maxDeviationC"]:
        return bands["moderate"]["score"]
    return bands["stress"]["score"]


def humidity_score(avg_rh: float, cfg: dict) -> float:
    dev = abs(avg_rh - cfg["comfortPct"])
    bands = cfg["bands"]
    if dev <= bands["comfort"]["maxDeviationPct"]:
        return bands["comfort"]["score"]
    if dev <= bands["moderate"]["maxDeviationPct"]:
        return bands["moderate"]["score"]
    return bands["stress"]["score"]


def slope_score(avg_pct: float, sensitivity: int, cfg: dict) -> float:
    sweet = max(0, cfg["sweetSpotBase"] - sensitivity)
    max_bad = sweet + cfg["gradeSpanPct"]
    if avg_pct <= sweet:
        return cfg["maxScore"]
    if avg_pct >= max_bad:
        return cfg["minScore"]
    span = cfg["maxScore"] - cfg["minScore"]
    return cfg["maxScore"] - span * (avg_pct - sweet) / (max_bad - sweet)


def remap_condition_weights(constants: dict, tier_map: Dict[int, float]) -> dict:
    """Map stored tier integers 1/2/3 to perturbed tier magnitudes."""
    out = deepcopy(constants)
    for _cond, wmap in out["conditionEnvWeights"].items():
        for key, tier in list(wmap.items()):
            if tier in tier_map:
                wmap[key] = tier_map[tier]
    return out


def env_utility(
    factors: Dict[str, float],
    condition: str,
    constants: dict,
    slope_sensitivity: int = 5,
) -> float:
    weights = {k: 1.0 for k in ("temperature", "airQuality", "slope", "noise", "humidity")}
    weights.update(constants["conditionEnvWeights"].get(condition, {}))
    fcfg = constants["factors"]
    scores = {
        "temperature": temperature_score(factors["temperature"], fcfg["temperature"]),
        "humidity": humidity_score(factors["humidity"], fcfg["humidity"]),
        "airQuality": max(0, fcfg["airQuality"]["scaleMax"] - factors["airQuality"]),
        "noise": max(0, fcfg["noise"]["scaleMax"] - factors["noise"]),
        "slope": slope_score(factors["slope"], slope_sensitivity, fcfg["slope"]),
    }
    total, wsum = 0.0, 0.0
    for key, w in weights.items():
        if w <= 0:
            continue
        total += scores[key] * w
        wsum += w
    return total / wsum if wsum else 0.0


def spearman_rho(x: Sequence[float], y: Sequence[float]) -> float:
    """Spearman rank correlation (no scipy dependency)."""
    n = len(x)
    if n < 2:
        return 1.0

    def ranks(vals: Sequence[float]) -> List[float]:
        order = sorted(range(n), key=lambda i: vals[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg_rank = (i + j) / 2.0 + 1.0
            for k in range(i, j + 1):
                r[order[k]] = avg_rank
            i = j + 1
        return r

    rx, ry = ranks(x), ranks(y)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    den_x = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)))
    den_y = math.sqrt(sum((ry[i] - my) ** 2 for i in range(n)))
    if den_x == 0 or den_y == 0:
        return 1.0
    return num / (den_x * den_y)


def build_od_groups() -> List[Tuple[str, str, List[Dict[str, float]]]]:
    """
    Each OD group: (od_id, dominant_condition_hint, candidate_factor_profiles).
    Candidates mimic direct vs detour alternatives along one factor axis.
    """
    groups: List[Tuple[str, str, List[Dict[str, float]]]] = []
    for scen_name, base in BASE_SCENARIOS:
        candidates = [
            base,
            {**base, "airQuality": min(10, base["airQuality"] + 2)},
            {**base, "airQuality": max(1, base["airQuality"] - 1)},
            {**base, "noise": min(10, base["noise"] + 2)},
            {**base, "slope": base["slope"] + 3},
            {**base, "temperature": base["temperature"] + 5},
            {**base, "humidity": min(95, base["humidity"] + 20)},
        ]
        groups.append((scen_name, "mixed", candidates))
    return groups


def score_candidates_for_od(
    candidates: List[Dict[str, float]],
    condition: str,
    constants: dict,
) -> List[float]:
    sens = SLOPE_SENSITIVITIES.get(condition, SLOPE_SENSITIVITIES["default"])
    return [env_utility(c, condition, constants, sens) for c in candidates]


def best_index(scores: List[float]) -> int:
    return max(range(len(scores)), key=lambda i: scores[i])


def evaluate_constants(
    baseline_constants: dict,
    perturbed_constants: dict,
    conditions: List[str],
    od_groups: List[Tuple[str, str, List[Dict[str, float]]]],
) -> Tuple[float, float, int, int]:
    """
    Returns (spearman_rho, flip_rate_pct, n_routes, n_od_decisions).
    """
    base_scores_all: List[float] = []
    pert_scores_all: List[float] = []
    flips = 0
    decisions = 0

    for od_id, _hint, candidates in od_groups:
        for condition in conditions:
            base_s = score_candidates_for_od(candidates, condition, baseline_constants)
            pert_s = score_candidates_for_od(candidates, condition, perturbed_constants)
            base_scores_all.extend(base_s)
            pert_scores_all.extend(pert_s)
            b_idx = best_index(base_s)
            p_idx = best_index(pert_s)
            decisions += 1
            if b_idx != p_idx:
                flips += 1

    rho = spearman_rho(base_scores_all, pert_scores_all)
    flip_pct = 100.0 * flips / decisions if decisions else 0.0
    return rho, flip_pct, len(base_scores_all), decisions


def apply_weight_tier_sweep(constants: dict, tiers: Tuple[float, float, float]) -> dict:
    tier_map = {1: tiers[0], 2: tiers[1], 3: tiers[2]}
    return remap_condition_weights(constants, tier_map)


def apply_temperature_center(constants: dict, comfort_c: float) -> dict:
    out = deepcopy(constants)
    out["factors"]["temperature"]["comfortC"] = comfort_c
    return out


def apply_poi_scale(constants: dict, scale: float) -> dict:
    out = deepcopy(constants)
    out["poiScaleFactor"] = scale
    return out


def run_sweeps(constants: dict) -> List[dict]:
    conditions = list(constants["conditionEnvWeights"].keys())
    od_groups = build_od_groups()
    rows: List[dict] = []

    sweeps = [
        ("weight_tiers", "baseline", (1.0, 2.0, 3.0), lambda c, v: apply_weight_tier_sweep(c, v)),
        ("weight_tiers", "low_30pct", (0.7, 1.4, 2.1), lambda c, v: apply_weight_tier_sweep(c, v)),
        ("weight_tiers", "high_30pct", (1.3, 2.6, 3.9), lambda c, v: apply_weight_tier_sweep(c, v)),
        ("poiScaleFactor", "baseline", 2.0, lambda c, v: apply_poi_scale(c, v)),
        ("poiScaleFactor", "1.5", 1.5, lambda c, v: apply_poi_scale(c, v)),
        ("poiScaleFactor", "3.5", 3.5, lambda c, v: apply_poi_scale(c, v)),
        ("temperature.comfortC", "baseline", 22.0, lambda c, v: apply_temperature_center(c, v)),
        ("temperature.comfortC", "20C", 20.0, lambda c, v: apply_temperature_center(c, v)),
        ("temperature.comfortC", "24C", 24.0, lambda c, v: apply_temperature_center(c, v)),
    ]

    for sweep_type, variant, value, apply_fn in sweeps:
        if variant == "baseline":
            pert = deepcopy(constants)
        else:
            pert = apply_fn(constants, value)
        rho, flip_pct, n_routes, n_od = evaluate_constants(constants, pert, conditions, od_groups)
        rows.append(
            {
                "sweep_type": sweep_type,
                "variant": variant,
                "parameter_value": json.dumps(value) if isinstance(value, tuple) else value,
                "spearman_rho_env_scores": round(rho, 4),
                "route_selection_flip_rate_pct": round(flip_pct, 2),
                "n_route_scores": n_routes,
                "n_od_condition_decisions": n_od,
                "notes": (
                    "env scores invariant to poiScaleFactor"
                    if sweep_type == "poiScaleFactor" and variant != "baseline"
                    else ""
                ),
            }
        )
    return rows


def weight_perturbation_summary(rows: List[dict]) -> Tuple[float, float]:
    """Min Spearman rho and max flip rate over non-baseline weight-tier sweeps."""
    weight_rows = [
        r
        for r in rows
        if r["sweep_type"] == "weight_tiers" and r["variant"] != "baseline"
    ]
    if not weight_rows:
        return 1.0, 0.0
    min_rho = min(r["spearman_rho_env_scores"] for r in weight_rows)
    max_flip = max(r["route_selection_flip_rate_pct"] for r in weight_rows)
    return min_rho, max_flip


def write_csv(rows: List[dict]) -> None:
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "sweep_type",
        "variant",
        "parameter_value",
        "spearman_rho_env_scores",
        "route_selection_flip_rate_pct",
        "n_route_scores",
        "n_od_condition_decisions",
        "notes",
    ]
    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def print_validation_summary(rows: List[dict]) -> None:
    min_rho, max_flip = weight_perturbation_summary(rows)
    stable = min_rho > STABILITY_RHO_THRESHOLD
    result = "STABLE" if stable else "UNSTABLE"
    print()
    print("--- Scoring Validation ---")
    print(
        "Weight perturbation rank stability: {:.3f}. Route selection flip rate: {:.1f}%. "
        "Result: {}.".format(min_rho, max_flip, result)
    )
    print("(Threshold: STABLE if Spearman rho > {:.2f} on ±30% tier sweeps.)".format(STABILITY_RHO_THRESHOLD))
    print("Full table: {}".format(OUT_CSV))


def main() -> None:
    constants = load_constants()
    print("PathPlanner scoring sensitivity")
    print("Constants:", CONSTANTS_PATH)
    print("OD groups:", len(build_od_groups()), "×", len(constants["conditionEnvWeights"]), "conditions")
    print("Output:", OUT_CSV)

    rows = run_sweeps(constants)
    write_csv(rows)

    print("\nResults:")
    for r in rows:
        print(
            "  {sweep_type:22} {variant:12} rho={spearman_rho_env_scores:.4f} "
            "flip={route_selection_flip_rate_pct:.1f}%".format(**r)
        )

    print_validation_summary(rows)


if __name__ == "__main__":
    main()
