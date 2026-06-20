#!/usr/bin/env python3
"""
Generate publication figures for paper_overleaf.tex.

Outputs (figures/):
  - fig_architecture_pipeline.pdf
  - fig_benchmark_workflow.pdf
  - fig_city_efficiency.pdf
  - fig_quadrants_stacked.pdf
  - fig_test_retest_city.pdf
"""
from pathlib import Path
import csv

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch


ROOT = Path(__file__).resolve().parent.parent
FIG_DIR = ROOT / "figures"
ANALYSIS = ROOT / "analysis_outputs"


def _read_csv(path: Path):
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _save(fig, name: str):
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    out = FIG_DIR / name
    fig.tight_layout()
    fig.savefig(out, dpi=300, bbox_inches="tight")
    plt.close(fig)
    print("wrote", out)


def architecture_pipeline():
    fig, ax = plt.subplots(figsize=(10, 2.8))
    ax.axis("off")
    labels = [
        "Playwright\ncontroller",
        "PathPlanner map\n(benchmark mode)",
        "Hybrid candidates\n(A* + waypoints)",
        "Mapbox routing\nfor each candidate",
        "scores.js\n(env utility)",
        "Detour policy\n(5.0 km + 0.5 km)",
        "CSV artifact\n+ metrics",
    ]
    x0 = 0.02
    w = 0.12
    h = 0.58
    gap = 0.02
    y = 0.22
    for i, label in enumerate(labels):
        x = x0 + i * (w + gap)
        patch = FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.02",
            linewidth=1.2,
            edgecolor="#334155",
            facecolor="#e2e8f0",
        )
        ax.add_patch(patch)
        ax.text(x + w / 2, y + h / 2, label, ha="center", va="center", fontsize=8)
        if i < len(labels) - 1:
            arrow = FancyArrowPatch(
                (x + w, y + h / 2),
                (x + w + gap, y + h / 2),
                arrowstyle="->",
                mutation_scale=10,
                linewidth=1.0,
                color="#0f172a",
            )
            ax.add_patch(arrow)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    _save(fig, "fig_architecture_pipeline.pdf")


def benchmark_workflow():
    fig, ax = plt.subplots(figsize=(8.6, 3.8))
    ax.axis("off")
    steps = [
        ("OD pair + condition", (0.08, 0.78)),
        ("Direct route\n(Mapbox)", (0.30, 0.78)),
        ("Generate candidates\n(A* + waypoint patterns)", (0.54, 0.78)),
        ("Route + sample\nenvironment points", (0.78, 0.78)),
        ("Compute utility\nU_c(pi)", (0.30, 0.38)),
        ("Select best under\ndetour policy", (0.54, 0.38)),
        ("Fallback direct\nif no gain", (0.78, 0.38)),
    ]
    for label, (x, y) in steps:
        patch = FancyBboxPatch(
            (x - 0.09, y - 0.11),
            0.18,
            0.22,
            boxstyle="round,pad=0.02",
            linewidth=1.1,
            edgecolor="#1e293b",
            facecolor="#f1f5f9",
        )
        ax.add_patch(patch)
        ax.text(x, y, label, ha="center", va="center", fontsize=8)
    arrows = [
        ((0.17, 0.78), (0.21, 0.78)),
        ((0.39, 0.78), (0.45, 0.78)),
        ((0.63, 0.78), (0.69, 0.78)),
        ((0.78, 0.67), (0.30, 0.49)),
        ((0.39, 0.38), (0.45, 0.38)),
        ((0.63, 0.38), (0.69, 0.38)),
    ]
    for s, e in arrows:
        ax.add_patch(FancyArrowPatch(s, e, arrowstyle="->", mutation_scale=10, linewidth=1.0))
    ax.text(0.08, 0.16, "Logged fields: env scores, durations, detour reason, EI, TP, Eff, mapbox_collapse", fontsize=8)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    _save(fig, "fig_benchmark_workflow.pdf")


def city_efficiency():
    rows = _read_csv(ANALYSIS / "analysis1_city_performance.csv")
    cities = [r["city_name"] for r in rows]
    eff = [float(r["mean_efficiency_index"]) for r in rows]
    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    colors = ["#2563eb" if v > -20 else "#dc2626" for v in eff]
    ax.bar(cities, eff, color=colors)
    ax.axhline(0, color="black", linewidth=1)
    ax.set_ylabel("Mean Eff")
    ax.set_title("City-level mean efficiency index (run 1)")
    ax.tick_params(axis="x", rotation=30)
    _save(fig, "fig_city_efficiency.pdf")


def quadrants_stacked():
    rows = _read_csv(ANALYSIS / "analysis2_quadrants_by_city.csv")
    cities = [r["city"] for r in rows]
    win = [float(r["pct_win"]) for r in rows]
    env_only = [float(r["pct_env_only"]) for r in rows]
    time_only = [float(r["pct_time_only"]) for r in rows]
    no_change = [float(r["pct_no_change"]) for r in rows]

    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    ax.bar(cities, win, label="win", color="#16a34a")
    ax.bar(cities, env_only, bottom=win, label="env_only", color="#84cc16")
    b2 = [win[i] + env_only[i] for i in range(len(win))]
    ax.bar(cities, time_only, bottom=b2, label="time_only", color="#f97316")
    b3 = [b2[i] + time_only[i] for i in range(len(win))]
    ax.bar(cities, no_change, bottom=b3, label="no_change", color="#64748b")
    ax.set_ylim(0, 100)
    ax.set_ylabel("Share of routes (%)")
    ax.set_title("Deployability quadrants by city")
    ax.legend(ncol=4, fontsize=8, loc="upper center", bbox_to_anchor=(0.5, 1.2))
    _save(fig, "fig_quadrants_stacked.pdf")


def test_retest_city():
    path = ANALYSIS / "test_retest_correlation.csv"
    cities, r_std, r_opt = [], [], []
    with path.open(encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    # Find second-table header: city,n,pearson_standard,pearson_optimized
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("city,n,pearson_standard,pearson_optimized"):
            start = i + 1
            break
    if start is None:
        return
    for ln in lines[start:]:
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) != 4:
            continue
        cities.append(parts[0])
        r_std.append(float(parts[2]))
        r_opt.append(float(parts[3]))

    fig, ax = plt.subplots(figsize=(7.0, 3.8))
    x = range(len(cities))
    width = 0.36
    ax.bar([i - width / 2 for i in x], r_std, width=width, label="standard_env_score", color="#1d4ed8")
    ax.bar([i + width / 2 for i in x], r_opt, width=width, label="optimized_env_score", color="#0ea5e9")
    ax.set_xticks(list(x))
    ax.set_xticklabels(cities, rotation=20)
    ax.set_ylim(0.75, 1.0)
    ax.set_ylabel("Pearson r")
    ax.set_title("Test-retest reliability by city (run 1 vs retest v3)")
    ax.legend(fontsize=8)
    _save(fig, "fig_test_retest_city.pdf")


def main():
    architecture_pipeline()
    benchmark_workflow()
    city_efficiency()
    quadrants_stacked()
    test_retest_city()


if __name__ == "__main__":
    main()
