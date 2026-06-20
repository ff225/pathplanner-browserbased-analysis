#!/usr/bin/env python3
"""
Defensible metrics for the browser benchmark.

Replaces the three weak points of the legacy metrics (see docs/DEFENSIBLE_METRICS.md):

  1. No `max(0, ...)` clamp on the environmental gain  -> regressions stay visible.
  2. Environmental benefit reported as an ABSOLUTE delta in score points
     (Delta_env on the 1-10 scale), not as a percent of a bounded ordinal score.
  3. Benefit and cost are kept in their own units. Instead of the dimensionally
     mixed `Eff = EI% - TP%`, the trade-off is made explicit:
        - a "win" requires Delta_env >= ENV_MIN_POINTS AND time_penalty <= TP_MAX_PCT
        - an optional scalar `net(lambda) = Delta_env - lambda * TP%` is reported
          ONLY together with a lambda-sensitivity sweep, so the exchange rate is
          stated, not hidden.

Per-row columns added (units in the name):
  env_delta_points        optimized_env_score - standard_env_score   (signed)
  time_penalty_pct        (opt_dur - std_dur) / std_dur * 100         (signed)
  time_delta_s            opt_dur - std_dur                           (absolute seconds)
  detour_m                optimized_detour_m (or opt_dist - std_dist) (absolute metres)
  is_strict_gain          env_delta_points > ENV_EPS
  is_win                  strict gain AND time_penalty_pct <= TP_MAX_PCT
                          AND env_delta_points >= ENV_MIN_POINTS
  is_fallback             optimizer returned the direct leg (legitimate zero-gain)

Outputs (analysis_outputs/):
  defensible_rows.csv               per-row enriched
  defensible_by_city.csv            city aggregates with 95% CI
  defensible_by_condition.csv       condition aggregates with 95% CI
  defensible_lambda_sensitivity.csv net trade-off vs exchange rate lambda
  DEFENSIBLE_METRICS_SUMMARY.md     short narrative + headline numbers

Usage (repo root, venv):
  ./.venv/bin/python scripts/defensible_metrics.py pathplanner_comparison_browser_20260609_161448_clean.csv
  ./.venv/bin/python scripts/defensible_metrics.py --glob "pathplanner_comparison_browser_*_clean.csv"
"""
from __future__ import annotations

import argparse
import glob as globmod
import math
import sys
from pathlib import Path
from typing import List, Optional

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'analysis_outputs'

# --- Declared decision thresholds (engineering choices, stated openly) ---
ENV_EPS = 0.02            # strict-gain epsilon on the 1-10 score (matches paper)
ENV_MIN_POINTS = 0.20     # minimum env benefit worth a detour (1-10 points)
TP_MAX_PCT = 10.0         # maximum acceptable added walking time (%)
LAMBDA_GRID = [0.0, 0.02, 0.05, 0.10, 0.20]  # env points "paid" per 1% extra time

_FALLBACK_DETOUR = {
    'fallback_direct', 'no_env_improvement_over_direct',
    'mapbox_collapsed_to_direct', 'fallback_direct_detour_cap', 'no_candidates',
}


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors='coerce')


def _col(df: pd.DataFrame, name: str, default=None) -> pd.Series:
    return df[name] if name in df.columns else pd.Series([default] * len(df), index=df.index)


def ci95(series: pd.Series) -> tuple:
    x = series.dropna()
    n = len(x)
    if n == 0:
        return (float('nan'), float('nan'), float('nan'), 0)
    m = x.mean()
    if n < 2:
        return (m, m, m, n)
    se = x.std(ddof=1) / math.sqrt(n)
    return (m, m - 1.96 * se, m + 1.96 * se, n)


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    s_env = _num(_col(df, 'standard_env_score'))
    o_env = _num(_col(df, 'optimized_env_score'))
    s_dur = _num(_col(df, 'standard_duration_s'))
    o_dur = _num(_col(df, 'optimized_duration_s'))
    s_dist = _num(_col(df, 'standard_distance_m'))
    o_dist = _num(_col(df, 'optimized_distance_m'))

    df['env_delta_points'] = o_env - s_env
    df['time_penalty_pct'] = ((o_dur - s_dur) / s_dur) * 100.0
    df.loc[(s_dur.isna()) | (s_dur <= 0), 'time_penalty_pct'] = pd.NA
    df['time_delta_s'] = o_dur - s_dur

    detour = _num(_col(df, 'optimized_detour_m'))
    detour = detour.where(detour.notna(), (o_dist - s_dist))
    df['detour_m'] = detour

    df['is_strict_gain'] = df['env_delta_points'] > ENV_EPS

    det = _col(df, 'detour_selection').astype(str).str.strip().str.lower()
    collapse = _col(df, 'mapbox_collapse').astype(str).str.lower().isin(['true', '1', '1.0'])
    name = _col(df, 'optimized_route_name').astype(str)
    df['is_fallback'] = det.isin(_FALLBACK_DETOUR) | collapse | name.str.contains('Fallback', case=False, na=False)

    tp = _num(df['time_penalty_pct'])
    df['is_win'] = (
        df['is_strict_gain']
        & (df['env_delta_points'] >= ENV_MIN_POINTS)
        & (tp <= TP_MAX_PCT)
    ).fillna(False)

    for lam in LAMBDA_GRID:
        df[f'net_lambda_{lam:g}'] = df['env_delta_points'] - lam * tp
    return df


def _agg(df: pd.DataFrame, group: Optional[str]) -> pd.DataFrame:
    rows = []
    groups = [('ALL', df)] if group is None else list(df.groupby(group))
    for key, g in groups:
        n = len(g)
        env_m, env_lo, env_hi, _ = ci95(g['env_delta_points'])
        tp_m, tp_lo, tp_hi, _ = ci95(_num(g['time_penalty_pct']))
        td_m, _, _, _ = ci95(g['time_delta_s'])
        det_m, _, _, _ = ci95(g['detour_m'])
        row = {
            (group or 'scope'): key,
            'n': n,
            'mean_env_delta_points': round(env_m, 4),
            'ci95_env_lo': round(env_lo, 4),
            'ci95_env_hi': round(env_hi, 4),
            'mean_time_penalty_pct': round(tp_m, 3),
            'ci95_tp_lo': round(tp_lo, 3),
            'ci95_tp_hi': round(tp_hi, 3),
            'mean_time_delta_s': round(td_m, 1),
            'mean_detour_m': round(det_m, 1),
            'pct_strict_env_gain': round(100 * g['is_strict_gain'].mean(), 2),
            'pct_fallback': round(100 * g['is_fallback'].mean(), 2),
            'win_rate_pct': round(100 * g['is_win'].mean(), 2),
        }
        rows.append(row)
    out = pd.DataFrame(rows)
    if group is not None:
        out = out.sort_values('win_rate_pct', ascending=False)
    return out


def lambda_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for lam in LAMBDA_GRID:
        col = df[f'net_lambda_{lam:g}']
        m, lo, hi, n = ci95(col)
        rows.append({
            'lambda_points_per_pct_time': lam,
            'mean_net': round(m, 4),
            'ci95_lo': round(lo, 4),
            'ci95_hi': round(hi, 4),
            'pct_net_positive': round(100 * (col > 0).mean(), 2),
            'n': n,
        })
    return pd.DataFrame(rows)


def resolve_inputs(args) -> List[Path]:
    paths = [Path(p) for p in args.inputs]
    for g in (args.glob or []):
        paths += [Path(p) for p in sorted(globmod.glob(str(ROOT / g))) + sorted(globmod.glob(g))]
    seen, out = set(), []
    for p in paths:
        rp = p.resolve()
        if rp not in seen and rp.exists():
            seen.add(rp)
            out.append(p)
    return out


def write_summary_md(scope: pd.DataFrame, by_city: pd.DataFrame, lam: pd.DataFrame, inputs: List[Path]) -> str:
    s = scope.iloc[0]
    lines = [
        '# Defensible metrics — summary',
        '',
        f'Inputs: {", ".join(p.name for p in inputs)}',
        f'Rows: {int(s["n"])}',
        '',
        '## Headline (benefit and cost kept separate)',
        f'- Mean environmental benefit: **{s["mean_env_delta_points"]:+.3f} points** '
        f'(95% CI {s["ci95_env_lo"]:+.3f}, {s["ci95_env_hi"]:+.3f}) on the 1-10 scale.',
        f'- Mean time cost: **{s["mean_time_penalty_pct"]:.1f}%** '
        f'(~{s["mean_time_delta_s"]:.0f} s; mean detour {s["mean_detour_m"]:.0f} m).',
        f'- Strict env-gain rate: **{s["pct_strict_env_gain"]:.1f}%**; '
        f'fallback-to-direct: **{s["pct_fallback"]:.1f}%**.',
        f'- Deployable win rate (Delta_env >= {ENV_MIN_POINTS} pts AND time penalty <= {TP_MAX_PCT}%): '
        f'**{s["win_rate_pct"]:.1f}%**.',
        '',
        '## Explicit trade-off (no hidden 1:1 exchange)',
        'net(lambda) = Delta_env(points) - lambda * time_penalty(%). '
        'A reader can pick the exchange rate; the sign of the mean is reported for each:',
        '',
        '| lambda (pts per 1% time) | mean net | % net > 0 |',
        '|---|---|---|',
    ]
    for _, r in lam.iterrows():
        lines.append(f'| {r["lambda_points_per_pct_time"]:g} | {r["mean_net"]:+.3f} | {r["pct_net_positive"]:.1f}% |')
    lines += [
        '',
        '## Per-city',
        '',
        '| city | n | Δenv (pts) | time penalty (%) | detour (m) | strict gain % | win % |',
        '|---|---|---|---|---|---|---|',
    ]
    for _, r in by_city.iterrows():
        lines.append(
            f'| {r["city"]} | {int(r["n"])} | {r["mean_env_delta_points"]:+.3f} '
            f'| {r["mean_time_penalty_pct"]:.1f} | {r["mean_detour_m"]:.0f} '
            f'| {r["pct_strict_env_gain"]:.1f} | {r["win_rate_pct"]:.1f} |'
        )
    lines += [
        '',
        '_See docs/DEFENSIBLE_METRICS.md for the rationale and how to report these in the paper._',
    ]
    return '\n'.join(lines)


def main() -> None:
    global ENV_MIN_POINTS, TP_MAX_PCT
    ap = argparse.ArgumentParser(description='Defensible metrics for browser benchmark CSVs')
    ap.add_argument('inputs', nargs='*')
    ap.add_argument('--glob', nargs='+')
    ap.add_argument('--out-dir', default=str(OUT_DIR))
    ap.add_argument('--env-min-points', type=float, default=ENV_MIN_POINTS)
    ap.add_argument('--tp-max-pct', type=float, default=TP_MAX_PCT)
    args = ap.parse_args()

    ENV_MIN_POINTS = args.env_min_points
    TP_MAX_PCT = args.tp_max_pct

    files = resolve_inputs(args)
    if not files:
        sys.exit('No input CSVs found. Pass files or --glob.')
    print('Inputs:', *[f.name for f in files])

    frames = []
    for f in files:
        d = enrich(pd.read_csv(f))
        d['source_file'] = f.name
        frames.append(d)
    df = pd.concat(frames, ignore_index=True)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    scope = _agg(df, None)
    by_city = _agg(df, 'city') if 'city' in df.columns else pd.DataFrame()
    by_cond = _agg(df, 'condition') if 'condition' in df.columns else pd.DataFrame()
    lam = lambda_sensitivity(df)

    df.to_csv(out_dir / 'defensible_rows.csv', index=False)
    by_city.to_csv(out_dir / 'defensible_by_city.csv', index=False)
    by_cond.to_csv(out_dir / 'defensible_by_condition.csv', index=False)
    lam.to_csv(out_dir / 'defensible_lambda_sensitivity.csv', index=False)
    md = write_summary_md(scope, by_city if len(by_city) else scope.rename(columns={'scope': 'city'}), lam, files)
    (out_dir / 'DEFENSIBLE_METRICS_SUMMARY.md').write_text(md + '\n', encoding='utf-8')

    print('\n' + md)
    print('\nWrote ->', out_dir)


if __name__ == '__main__':
    main()
