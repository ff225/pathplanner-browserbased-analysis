#!/usr/bin/env python3
"""
Test-retest Pearson r for browser benchmark CSVs (same OD + condition keys).

Pairs run A vs run B on:
  (city, condition, route_type, start_lat, start_lon, end_lat, end_lon)

Usage:
  python3 scripts/benchmark_test_retest.py \\
    --run-a-glob 'pathplanner_browser_*_full.csv' \\
    --run-b-glob 'pathplanner_browser_*_full_v2.csv'

  # Export fixed ODs from run A for a reproducible re-run:
  python3 scripts/benchmark_test_retest.py --export-ods \\
    --run-a-glob 'pathplanner_browser_*_full.csv' \\
    -o benchmark_od_pairs_run1.json
"""
import argparse
import csv
import glob
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'analysis_outputs'

CITIES = ['barcelona', 'jakarta', 'london', 'newyork', 'shanghai', 'tokyo']


def fnum(x, default=None):
    try:
        if x is None or x == '':
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


def row_key(r: dict) -> Tuple:
    return (
        r.get('city'),
        r.get('condition'),
        r.get('route_type', ''),
        round(fnum(r.get('start_lat'), 0) or 0, 5),
        round(fnum(r.get('start_lon'), 0) or 0, 5),
        round(fnum(r.get('end_lat'), 0) or 0, 5),
        round(fnum(r.get('end_lon'), 0) or 0, 5),
    )


def od_key(r: dict) -> Tuple:
    """Physical OD only (no condition)."""
    return row_key(r)[:1] + row_key(r)[3:]


def load_index(paths: List[Path]) -> Dict[Tuple, dict]:
    idx = {}
    for p in paths:
        with p.open(newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if (row.get('error') or '').strip():
                    continue
                idx[row_key(row)] = row
    return idx


def pearson(xs: List[float], ys: List[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 3:
        return float('nan')
    mx = sum(xs[:n]) / n
    my = sum(ys[:n]) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = math.sqrt(sum((xs[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ys[i] - my) ** 2 for i in range(n)))
    if dx == 0 or dy == 0:
        return float('nan')
    return num / (dx * dy)


def resolve_glob(pattern: str) -> List[Path]:
    if not pattern:
        return []
    paths = sorted(Path(p) for p in glob.glob(str(ROOT / pattern)))
    return [p for p in paths if p.is_file()]


def default_run_paths(suffix_a: str, suffix_b: str) -> Tuple[List[Path], List[Path]]:
    run_a, run_b = [], []
    for city in CITIES:
        p_a = ROOT / 'pathplanner_browser_{0}_full{1}.csv'.format(city, suffix_a)
        p_b = ROOT / 'pathplanner_browser_{0}_full{1}.csv'.format(city, suffix_b)
        if p_a.exists():
            run_a.append(p_a)
        if p_b.exists():
            run_b.append(p_b)
    return run_a, run_b


def export_fixed_ods(index: Dict[Tuple, dict], out_path: Path) -> None:
    by_city: Dict[str, Dict[Tuple, dict]] = defaultdict(dict)
    for key, row in index.items():
        city = row['city']
        ok = od_key(row)
        if ok in by_city[city]:
            continue
        by_city[city][ok] = {
            'type': row.get('route_type', 'pedestrian_fixed'),
            'start': [fnum(row['start_lat']), fnum(row['start_lon'])],
            'end': [fnum(row['end_lat']), fnum(row['end_lon'])],
            'estimated_km': fnum(row.get('estimated_km'), 0.0),
        }
    payload = {
        city: list(ods.values())
        for city, ods in sorted(by_city.items())
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    print('Wrote', out_path, '—', sum(len(v) for v in payload.values()), 'unique ODs')


def compute_retest(run_a: Dict[Tuple, dict], run_b: Dict[Tuple, dict]) -> dict:
    keys_a = set(run_a)
    keys_b = set(run_b)
    common = sorted(keys_a & keys_b)
    report = {
        'n_run_a': len(run_a),
        'n_run_b': len(run_b),
        'n_matched_pairs': len(common),
        'pearson_standard_env_score': float('nan'),
        'pearson_optimized_env_score': float('nan'),
        'by_city': [],
    }
    if len(common) < 3:
        return report

    std_a, std_b, opt_a, opt_b = [], [], [], []
    by_city = defaultdict(lambda: {'std_a': [], 'std_b': [], 'opt_a': [], 'opt_b': []})
    for k in common:
        ra, rb = run_a[k], run_b[k]
        sa = fnum(ra.get('standard_env_score'))
        sb = fnum(rb.get('standard_env_score'))
        oa = fnum(ra.get('optimized_env_score'))
        ob = fnum(rb.get('optimized_env_score'))
        if None in (sa, sb, oa, ob):
            continue
        std_a.append(sa)
        std_b.append(sb)
        opt_a.append(oa)
        opt_b.append(ob)
        city = k[0]
        by_city[city]['std_a'].append(sa)
        by_city[city]['std_b'].append(sb)
        by_city[city]['opt_a'].append(oa)
        by_city[city]['opt_b'].append(ob)

    report['n_scored_pairs'] = len(std_a)
    report['pearson_standard_env_score'] = round(pearson(std_a, std_b), 4)
    report['pearson_optimized_env_score'] = round(pearson(opt_a, opt_b), 4)

    for city in sorted(by_city):
        blk = by_city[city]
        n = len(blk['std_a'])
        report['by_city'].append({
            'city': city,
            'n': n,
            'pearson_standard_env_score': round(pearson(blk['std_a'], blk['std_b']), 4) if n >= 3 else '',
            'pearson_optimized_env_score': round(pearson(blk['opt_a'], blk['opt_b']), 4) if n >= 3 else '',
        })
    return report


def write_report(report: dict, path_a: str, path_b: str, out_md: Path) -> None:
    lines = [
        '# Benchmark test-retest (Pearson r)',
        '',
        'Run A: ' + path_a,
        'Run B: ' + path_b,
        '',
        '| Metric | Value |',
        '|--------|-------|',
        '| Matched OD+condition pairs | {n_matched_pairs} |'.format(**report),
        '| Scored pairs (valid env scores) | {n_scored_pairs} |'.format(
            n_scored_pairs=report.get('n_scored_pairs', 0),
        ),
        '| Pearson r (standard_env_score) | {pearson_standard_env_score} |'.format(**report),
        '| Pearson r (optimized_env_score) | {pearson_optimized_env_score} |'.format(**report),
        '',
    ]
    if report['n_matched_pairs'] < 3:
        lines.extend([
            '**Warning:** Fewer than 3 matched pairs. Run B likely used a new random OD grid.',
            'Export run A ODs (`--export-ods`) and re-run with:',
            '`python3 scripts/automated_city_tester_browser.py --routes-json benchmark_od_pairs_run1.json ...`',
            '',
        ])
    if report.get('by_city'):
        lines.append('## By city')
        lines.append('')
        lines.append('| City | n | r(std) | r(opt) |')
        lines.append('|------|---|--------|--------|')
        for row in report['by_city']:
            lines.append(
                '| {city} | {n} | {pearson_standard_env_score} | {pearson_optimized_env_score} |'.format(
                    **row,
                ),
            )
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description='Test-retest correlation for browser benchmark CSVs')
    parser.add_argument('--run-a-glob', default='pathplanner_browser_*_full.csv')
    parser.add_argument('--run-b-glob', default='pathplanner_browser_*_full_v2.csv')
    parser.add_argument('--export-ods', action='store_true', help='Export run A ODs to JSON and exit')
    parser.add_argument('-o', '--output-json', default=str(ROOT / 'benchmark_od_pairs_run1.json'))
    parser.add_argument('--out-dir', default=str(OUT_DIR))
    args = parser.parse_args()

    paths_a = resolve_glob(args.run_a_glob)
    paths_b = resolve_glob(args.run_b_glob)
    if not paths_a:
        paths_a, _ = default_run_paths('', '')
    if not paths_b and not args.export_ods:
        _, paths_b = default_run_paths('', '_v2')

    idx_a = load_index(paths_a)
    if args.export_ods:
        export_fixed_ods(idx_a, Path(args.output_json))
        return

    idx_b = load_index(paths_b)
    report = compute_retest(idx_a, idx_b)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    csv_path = out_dir / 'test_retest_correlation.csv'
    with csv_path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['metric', 'value'])
        w.writerow(['n_run_a', report['n_run_a']])
        w.writerow(['n_run_b', report['n_run_b']])
        w.writerow(['n_matched_pairs', report['n_matched_pairs']])
        w.writerow(['n_scored_pairs', report.get('n_scored_pairs', 0)])
        w.writerow(['pearson_standard_env_score', report['pearson_standard_env_score']])
        w.writerow(['pearson_optimized_env_score', report['pearson_optimized_env_score']])
        w.writerow([])
        w.writerow(['city', 'n', 'pearson_standard', 'pearson_optimized'])
        for row in report.get('by_city', []):
            w.writerow([row['city'], row['n'], row['pearson_standard_env_score'], row['pearson_optimized_env_score']])

    md_path = out_dir / 'TEST_RETEST_REPORT.md'
    write_report(
        report,
        ', '.join(p.name for p in paths_a),
        ', '.join(p.name for p in paths_b),
        md_path,
    )

    print('Run A rows:', report['n_run_a'], '| Run B rows:', report['n_run_b'])
    print('Matched pairs:', report['n_matched_pairs'])
    print('Pearson r standard_env_score:', report['pearson_standard_env_score'])
    print('Pearson r optimized_env_score:', report['pearson_optimized_env_score'])
    print('Wrote', csv_path)
    print('Wrote', md_path)

    if report['n_matched_pairs'] < 3:
        print(
            '\nWARNING: No coordinate overlap between runs (random OD grid differed).',
            'Export run A ODs and re-run for valid test-retest:',
            '  python3 scripts/benchmark_test_retest.py --export-ods',
            '  python3 scripts/automated_city_tester_browser.py --routes-json benchmark_od_pairs_run1.json ...',
            file=sys.stderr,
        )


if __name__ == '__main__':
    main()
