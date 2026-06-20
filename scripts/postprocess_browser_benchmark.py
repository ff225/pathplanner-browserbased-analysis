#!/usr/bin/env python3
"""
Post-process browser benchmark CSVs into an honest, analysis-ready dataset.

It does NOT re-run routing or scoring. It takes the
`pathplanner_comparison_browser_*.csv` files produced by
`automated_city_tester_browser.py` and:

  1. Recomputes the environmental gain WITHOUT the `max(0.0, ...)` clamp that
     `_metrics()` applies, so genuine regressions (optimized worse than direct)
     are visible and the mean is not inflated. New columns:
        - env_delta                  = optimized_env_score - standard_env_score
        - env_improvement_pct_signed = env_delta / standard_env_score * 100
        - efficiency_index_signed    = env_improvement_pct_signed - time_penalty_pct
     Original clamped columns are kept side by side for comparison.

  2. Attributes each optimized route to the winning algorithm:
        - winning_engine  (environmental_astar | condition_waypoints |
                           fallback_direct | unknown)
     Uses the upstream `optimized_engine` column when present; otherwise falls
     back to a name-based heuristic for older CSVs.

  3. Flags data-quality issues:
        - valid_for_analysis (bool) + exclusion_reason (str)
          False only for genuinely unreliable rows (errors, out-of-range scores,
          fallback default score 5.0, score warnings).
        - is_fallback_direct  -> optimizer returned the direct route (a LEGITIMATE
          zero-gain outcome; kept valid so results are not cherry-picked).
        - low_env_samples     -> env score averaged over very few points.

  4. Writes `<input>_clean.csv` (or a combined file with --combined) and prints
     a diagnostic summary (also saved to postprocess_summary.txt).

Usage (repo root, venv):
  ./.venv/bin/python scripts/postprocess_browser_benchmark.py \
      --glob "pathplanner_comparison_browser_*.csv"
  ./.venv/bin/python scripts/postprocess_browser_benchmark.py file1.csv file2.csv --combined clean_all.csv
"""
from __future__ import annotations

import argparse
import glob as globmod
import sys
from pathlib import Path
from typing import List, Optional

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent

# Fixed waypoint pattern names (route_waypoints.py / generateConditionSpecificWaypoints).
# Used only as a fallback when the `optimized_engine` column is absent (old CSVs).
WAYPOINT_NAMES = {
    'green air route', 'low pollution route', 'low exertion route',
    'heart-friendly flat route', 'medical access route', 'rest areas route',
    'wheelchair accessible route', 'smooth surface route', 'zero-slope route',
    'nature therapy route', 'quiet zone route', 'low stimulation route',
    'joint-friendly surface route', 'flat terrain route', 'rest stops route',
    'medical services route', 'moderate exertion route', 'facility access route',
    'generic detour',
}
FALLBACK_DETOUR_REASONS = {
    'fallback_direct', 'no_env_improvement_over_direct',
    'mapbox_collapsed_to_direct', 'fallback_direct_detour_cap', 'no_candidates',
}
LOW_ENV_SAMPLES = 4          # below this, the env mean is shaky
SCORE_MIN, SCORE_MAX = 1.0, 10.0


def _col(df: pd.DataFrame, name: str, default=None) -> pd.Series:
    """Return df[name] if present, else a full-length Series of `default`."""
    if name in df.columns:
        return df[name]
    return pd.Series([default] * len(df), index=df.index)


def _to_num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors='coerce')


def classify_engine(row: pd.Series) -> str:
    """Clean from optimized_engine; otherwise heuristic on the route name."""
    eng = row.get('optimized_engine')
    if isinstance(eng, str) and eng.strip():
        return eng.strip()
    name = str(row.get('optimized_route_name', '') or '').strip().lower()
    if not name:
        return 'unknown'
    if 'fallback' in name or name == 'direct route':
        return 'fallback_direct'
    if name in WAYPOINT_NAMES:
        return 'condition_waypoints'
    return 'environmental_astar'


def process_frame(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    std = _to_num(_col(df, 'standard_env_score'))
    opt = _to_num(_col(df, 'optimized_env_score'))
    tpp = _to_num(_col(df, 'time_penalty_pct'))

    # 1) Unclamped gain
    df['env_delta'] = opt - std
    df['env_improvement_pct_signed'] = (df['env_delta'] / std) * 100.0
    df.loc[std <= 0, 'env_improvement_pct_signed'] = pd.NA
    df['efficiency_index_signed'] = df['env_improvement_pct_signed'] - tpp

    # 2) Winning engine
    df['winning_engine'] = df.apply(classify_engine, axis=1)

    # 3a) Hard validity
    err = _col(df, 'error')
    has_error = err.notna() & err.astype(str).str.strip().ne('') if 'error' in df.columns else pd.Series(False, index=df.index)
    warn = _col(df, 'score_warning')
    has_warning = warn.notna() & warn.astype(str).str.strip().ne('') if 'score_warning' in df.columns else pd.Series(False, index=df.index)
    std_method = _col(df, 'standard_scoring_method').astype(str)
    opt_method = _col(df, 'optimized_scoring_method').astype(str)
    fallback_score = std_method.eq('browser_fallback_default') | opt_method.eq('browser_fallback_default')
    score_missing = std.isna() | opt.isna()
    score_oob = (
        (std < SCORE_MIN) | (std > SCORE_MAX) | (opt < SCORE_MIN) | (opt > SCORE_MAX)
    ).fillna(False)

    reasons: List[List[str]] = [[] for _ in range(len(df))]
    for flag, label in [
        (has_error, 'error'),
        (score_missing, 'env_score_missing'),
        (score_oob, 'env_score_out_of_1_10'),
        (fallback_score, 'fallback_default_score'),
        (has_warning, 'score_warning'),
    ]:
        for i, bad in zip(df.index, flag):
            if bool(bad):
                reasons[df.index.get_loc(i)].append(label)
    df['exclusion_reason'] = [';'.join(r) for r in reasons]
    df['valid_for_analysis'] = df['exclusion_reason'].eq('')

    # 3b) Soft diagnostic flags (kept valid)
    det = _col(df, 'detour_selection').astype(str).str.strip().str.lower()
    collapse = _col(df, 'mapbox_collapse')
    collapse_bool = collapse.astype(str).str.lower().isin(['true', '1', '1.0']) if 'mapbox_collapse' in df.columns else pd.Series(False, index=df.index)
    df['is_fallback_direct'] = det.isin(FALLBACK_DETOUR_REASONS) | collapse_bool | df['winning_engine'].eq('fallback_direct')
    opt_samples = _to_num(_col(df, 'optimized_env_samples'))
    df['low_env_samples'] = opt_samples.lt(LOW_ENV_SAMPLES).fillna(False)

    return df


def summarize(df: pd.DataFrame) -> str:
    lines: List[str] = []
    n = len(df)
    valid = df[df['valid_for_analysis']]
    nv = len(valid)
    lines.append('=== Post-processing summary ===')
    lines.append(f'Total rows: {n}')
    lines.append(f'Valid rows: {nv}  ({100*nv/n:.1f}%)' if n else 'Valid rows: 0')
    excl = df[~df['valid_for_analysis']]
    if len(excl):
        lines.append('Excluded by reason:')
        counts: dict = {}
        for r in excl['exclusion_reason']:
            for tok in str(r).split(';'):
                if tok:
                    counts[tok] = counts.get(tok, 0) + 1
        for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
            lines.append(f'  {k:28} {v}')

    if nv:
        gain = valid['env_delta']
        pos = (gain > 0).sum()
        fb = valid['is_fallback_direct'].sum()
        lines.append('')
        lines.append('Among VALID rows:')
        lines.append(f'  mean env_delta (points 1-10):     {gain.mean():+.3f}')
        lines.append(f'  % strict env gain (delta>0):      {100*pos/nv:.1f}%')
        lines.append(f'  % fallback to direct (no gain):   {100*fb/nv:.1f}%')
        orig_ei = _to_num(_col(valid, 'efficiency_index'))
        lines.append(f'  mean EI (original, clamped):      {orig_ei.mean():+.2f}%')
        lines.append(f'  mean EI (signed, unclamped):      {valid["efficiency_index_signed"].mean():+.2f}%')
        lines.append(f'  -> clamp inflated mean EI by:     {orig_ei.mean() - valid["efficiency_index_signed"].mean():+.2f} pts')
        lines.append('')
        lines.append('  Winning engine (valid rows):')
        for eng, c in valid['winning_engine'].value_counts().items():
            lines.append(f'    {eng:22} {c}  ({100*c/nv:.1f}%)')
        # engine that actually produced a gain (exclude fallback / no-gain)
        gained = valid[valid['env_delta'] > 0]
        if len(gained):
            lines.append('')
            lines.append('  Among rows WITH a real gain, winning engine:')
            for eng, c in gained['winning_engine'].value_counts().items():
                lines.append(f'    {eng:22} {c}  ({100*c/len(gained):.1f}%)')
        if 'condition' in valid.columns:
            lines.append('')
            lines.append('  Mean signed EI by condition (valid):')
            for cond, sub in valid.groupby('condition'):
                lines.append(f'    {str(cond):14} {sub["efficiency_index_signed"].mean():+.2f}%  (n={len(sub)})')
    return '\n'.join(lines)


def resolve_inputs(args) -> List[Path]:
    paths: List[Path] = []
    for p in args.inputs:
        paths.append(Path(p))
    if args.glob:
        for g in args.glob:
            paths.extend(Path(p) for p in sorted(globmod.glob(str(ROOT / g))) + sorted(globmod.glob(g)))
    # de-dup, keep order
    seen = set()
    out = []
    for p in paths:
        rp = p.resolve()
        if rp not in seen and rp.exists():
            seen.add(rp)
            out.append(p)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description='Honest post-processing of browser benchmark CSVs')
    ap.add_argument('inputs', nargs='*', help='CSV files')
    ap.add_argument('--glob', nargs='+', help='Glob(s) relative to repo root, e.g. "pathplanner_comparison_browser_*.csv"')
    ap.add_argument('--combined', help='Write a single combined clean CSV to this path instead of per-file')
    ap.add_argument('--summary-out', default=str(ROOT / 'postprocess_summary.txt'))
    args = ap.parse_args()

    files = resolve_inputs(args)
    if not files:
        sys.exit('No input CSVs found. Pass files or --glob.')

    print('Input files:')
    for f in files:
        print('  ', f)

    frames = []
    for f in files:
        df = pd.read_csv(f)
        out = process_frame(df)
        out['source_file'] = f.name
        frames.append(out)
        if not args.combined:
            clean_path = f.with_name(f.stem + '_clean.csv')
            out.to_csv(clean_path, index=False)
            print('  ->', clean_path.name)

    alldf = pd.concat(frames, ignore_index=True)
    if args.combined:
        combined_path = Path(args.combined)
        if not combined_path.is_absolute():
            combined_path = ROOT / combined_path
        alldf.to_csv(combined_path, index=False)
        print('Combined clean CSV ->', combined_path)

    report = summarize(alldf)
    print('\n' + report)
    Path(args.summary_out).write_text(report + '\n', encoding='utf-8')
    print('\nSummary saved ->', args.summary_out)


if __name__ == '__main__':
    main()
