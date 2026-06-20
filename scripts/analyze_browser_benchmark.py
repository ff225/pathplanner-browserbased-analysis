#!/usr/bin/env python3
"""
Three main analyses for browser benchmark CSVs (DCOSS paper, RQs 1–3).

Usage:
  python3 scripts/analyze_browser_benchmark.py pathplanner_browser_tokyo_full_v4.csv
  python3 scripts/analyze_browser_benchmark.py --glob "pathplanner_browser_*_full*.csv"

Outputs: analysis_outputs/
"""
import argparse
import csv
import glob
import math
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'analysis_outputs'
CONDITIONS = [
    'respiratory', 'cardiac', 'mobility', 'mental', 'arthritis', 'diabetes',
]
ENV_EPS = 0.02
_FALLBACK_DETOUR = frozenset({
    'fallback_direct',
    'no_env_improvement_over_direct',
    'mapbox_collapsed_to_direct',
})


def fnum(x, default=None):
    try:
        if x is None or x == '':
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


def load_rows(paths: List[Path]) -> List[dict]:
    rows = []
    for p in paths:
        with p.open(newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                err = (row.get('error') or '').strip()
                if err:
                    continue
                row['_source'] = p.name
                rows.append(row)
    return rows


def mapbox_collapse(row: dict) -> bool:
    """Same distance as direct + fallback detour reason (geometry collapse)."""
    raw = (row.get('mapbox_collapse') or '').strip().lower()
    if raw in ('true', '1', 'yes'):
        return True
    if raw in ('false', '0', 'no'):
        return False
    sd = fnum(row.get('standard_distance_m'))
    od = fnum(row.get('optimized_distance_m'))
    if sd is None or od is None:
        return False
    if abs(sd - od) > 0.5:
        return False
    det = (row.get('detour_selection') or '').strip().lower()
    return det in _FALLBACK_DETOUR


def enrich(rows: List[dict]) -> List[dict]:
    out = []
    for r in rows:
        s_env = fnum(r.get('standard_env_score'))
        o_env = fnum(r.get('optimized_env_score'))
        s_dur = fnum(r.get('standard_duration_s'))
        o_dur = fnum(r.get('optimized_duration_s'))
        if s_env is None or o_env is None:
            continue
        # Signed env improvement (no max(0,...) clamp): regressions stay negative so
        # the mean is not inflated. Matches env_improvement_pct_signed in the
        # post-processing step. Set ANALYZE_CLAMP_EI=1 to restore the old clamped metric.
        if s_env:
            ei_raw = (o_env - s_env) / s_env * 100.0
            ei = max(0.0, ei_raw) if os.getenv('ANALYZE_CLAMP_EI') == '1' else ei_raw
        else:
            ei = 0.0
        tp = ((o_dur - s_dur) / s_dur * 100.0) if s_dur and o_dur is not None else 0.0
        eff = ei - tp
        r = dict(r)
        r['_ei'] = ei
        r['_tp'] = tp
        r['_eff'] = eff
        r['_cs'] = 2 * ei - tp
        r['_strict_gain'] = o_env > s_env + ENV_EPS
        r['_fallback'] = 'Fallback' in (r.get('optimized_route_name') or '')
        r['_mapbox_collapse'] = mapbox_collapse(r)
        out.append(r)
    return out


def mean(xs: List[float]) -> float:
    return sum(xs) / len(xs) if xs else float('nan')


def ci95(xs: List[float]) -> Tuple[float, float, float]:
    if not xs:
        return float('nan'), float('nan'), float('nan')
    m = mean(xs)
    if len(xs) < 2:
        return m, m, m
    var = sum((x - m) ** 2 for x in xs) / (len(xs) - 1)
    se = math.sqrt(var) / math.sqrt(len(xs))
    return m, m - 1.96 * se, m + 1.96 * se


def pearson(xs: List[float], ys: List[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 3:
        return float('nan')
    mx, my = mean(xs[:n]), mean(ys[:n])
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = math.sqrt(sum((xs[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ys[i] - my) ** 2 for i in range(n)))
    if dx == 0 or dy == 0:
        return float('nan')
    return num / (dx * dy)


def try_op_by_city() -> Dict[str, dict]:
    try:
        sys.path.insert(0, str(ROOT))
        from research_based_factors import CITY_DATA, calculate_optimization_potential
    except Exception:
        return {}
    out = {}
    for city, data in CITY_DATA.items():
        eis = [calculate_optimization_potential(data, c).get('env_improvement_pct', 0) for c in CONDITIONS]
        out[city] = {
            'mean_op_ei': mean(eis),
            'baseline_pm25': data.get('baseline_pm25'),
            'connectivity': data.get('connectivity'),
        }
    return out


def write_csv(path: Path, header: List[str], data: List[dict]) -> None:
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction='ignore')
        w.writeheader()
        for row in data:
            w.writerow(row)


def analysis_exploitable_diversity(rows: List[dict]) -> List[dict]:
    """
    Metrics conditional on exploitable route diversity (non mapbox-collapse rows).
    """
    collapsed = [r for r in rows if r['_mapbox_collapse']]
    active = [r for r in rows if not r['_mapbox_collapse']]
    n = len(rows)
    na = len(active)

    def block(grp: List[dict], label: str) -> dict:
        if not grp:
            return {
                'subset': label,
                'n': 0,
                'mean_env_improvement_pct': '',
                'pct_strict_env_gain': '',
            }
        ei = [r['_ei'] for r in grp]
        return {
            'subset': label,
            'n': len(grp),
            'mean_env_improvement_pct': round(mean(ei), 3),
            'pct_strict_env_gain': round(
                100 * sum(1 for r in grp if r['_strict_gain']) / len(grp), 2,
            ),
            'pct_mapbox_collapse': round(100 * sum(1 for r in grp if r['_mapbox_collapse']) / n, 2) if n else 0,
            'mean_time_penalty_pct': round(mean([r['_tp'] for r in grp]), 3),
            'mean_efficiency_index': round(mean([r['_eff'] for r in grp]), 3),
        }

    out = [
        block(rows, 'all_rows'),
        block(active, 'non_collapsed_exploitable'),
        block(collapsed, 'mapbox_collapsed_only'),
    ]
    by_city = defaultdict(list)
    for r in active:
        by_city[r['city']].append(r)
    for city in sorted(by_city):
        out.append(block(by_city[city], 'non_collapsed:' + city))
    return out


def analysis1(rows: List[dict], op_map: Dict[str, dict]) -> List[dict]:
    by_city = defaultdict(list)
    for r in rows:
        by_city[r['city']].append(r)
    result = []
    for city, grp in sorted(by_city.items()):
        ei = [r['_ei'] for r in grp]
        tp = [r['_tp'] for r in grp]
        eff = [r['_eff'] for r in grp]
        m_ei, lo_ei, hi_ei = ci95(ei)
        m_tp, lo_tp, hi_tp = ci95(tp)
        m_eff, lo_eff, hi_eff = ci95(eff)
        detours = [fnum(r.get('optimized_detour_m'), 0) for r in grp]
        row = {
            'city': city,
            'city_name': grp[0].get('city_name', city),
            'n_routes': len(grp),
            'mean_detour_m': round(mean(detours), 1),
            'mean_env_improvement_pct': round(m_ei, 3),
            'ci95_ei_low': round(lo_ei, 3),
            'ci95_ei_high': round(hi_ei, 3),
            'mean_time_penalty_pct': round(m_tp, 3),
            'ci95_tp_low': round(lo_tp, 3),
            'ci95_tp_high': round(hi_tp, 3),
            'mean_efficiency_index': round(m_eff, 3),
            'ci95_eff_low': round(lo_eff, 3),
            'ci95_eff_high': round(hi_eff, 3),
            'pct_eff_positive': round(100 * sum(1 for e in eff if e > 0) / len(eff), 2),
            'pct_strict_env_gain': round(100 * sum(1 for r in grp if r['_strict_gain']) / len(grp), 2),
            'pct_fallback_direct': round(100 * sum(1 for r in grp if r['_fallback']) / len(grp), 2),
        }
        if city in op_map:
            row['mean_op_predicted_ei'] = round(op_map[city]['mean_op_ei'], 2)
            row['baseline_pm25'] = op_map[city].get('baseline_pm25')
        result.append(row)
    result.sort(key=lambda x: x['mean_efficiency_index'], reverse=True)
    return result


def block_metrics(grp: List[dict], label: str) -> dict:
    ei = [r['_ei'] for r in grp]
    tp = [r['_tp'] for r in grp]
    eff = [r['_eff'] for r in grp]
    m_ei, lo_ei, hi_ei = ci95(ei)
    m_tp, lo_tp, hi_tp = ci95(tp)
    m_eff, lo_eff, hi_eff = ci95(eff)
    r_val = pearson(ei, tp)
    return {
        'group': label,
        'n': len(grp),
        'mean_ei': round(m_ei, 3),
        'ci95_ei_low': round(lo_ei, 3),
        'ci95_ei_high': round(hi_ei, 3),
        'mean_tp': round(m_tp, 3),
        'ci95_tp_low': round(lo_tp, 3),
        'ci95_tp_high': round(hi_tp, 3),
        'mean_eff': round(m_eff, 3),
        'ci95_eff_low': round(lo_eff, 3),
        'ci95_eff_high': round(hi_eff, 3),
        'pearson_ei_tp': round(r_val, 4) if r_val == r_val else '',
        'pct_eff_positive': round(100 * sum(1 for e in eff if e > 0) / len(eff), 2),
        'pct_strict_env_gain': round(100 * sum(1 for r in grp if r['_strict_gain']) / len(grp), 2),
    }


def classify_quadrant(r: dict) -> str:
    if r['_fallback']:
        return 'no_change'
    if r['_strict_gain'] and r['_eff'] > 0:
        return 'win'
    if r['_strict_gain']:
        return 'env_only'
    if r['_tp'] > 5.0:
        return 'time_only'
    return 'no_change'


def analysis2(rows: List[dict]) -> List[dict]:
    out = [block_metrics(rows, 'ALL')]
    by_city = defaultdict(list)
    for r in rows:
        by_city[r['city']].append(r)
    for city in sorted(by_city):
        out.append(block_metrics(by_city[city], 'city:' + city))
    by_rt = defaultdict(list)
    for r in rows:
        by_rt[r.get('route_type', 'unknown')].append(r)
    for rt in sorted(by_rt):
        out.append(block_metrics(by_rt[rt], 'route_type:' + rt))
    return out


def analysis2_quadrants(rows: List[dict]) -> List[dict]:
    """Per-city deployability: win = strict env gain and EI > 0."""
    by_city = defaultdict(list)
    for r in rows:
        by_city[r['city']].append(r)
    out = []
    for city, grp in sorted(by_city.items()):
        counts = defaultdict(int)
        for r in grp:
            counts[classify_quadrant(r)] += 1
        n = len(grp)
        out.append({
            'city': city,
            'n': n,
            'pct_win': round(100 * counts['win'] / n, 2),
            'pct_env_only': round(100 * counts['env_only'] / n, 2),
            'pct_time_only': round(100 * counts['time_only'] / n, 2),
            'pct_no_change': round(100 * counts['no_change'] / n, 2),
            'deployability_rate': round(100 * counts['win'] / n, 2),
        })
    out.sort(key=lambda x: x['deployability_rate'], reverse=True)
    return out


def analysis3(rows: List[dict]) -> Tuple[List[dict], List[dict]]:
    by_cc = defaultdict(list)
    for r in rows:
        by_cc[(r['city'], r['condition'])].append(r)
    cond_out = []
    for (city, cond), grp in sorted(by_cc.items()):
        eff = [r['_eff'] for r in grp]
        m, lo, hi = ci95(eff)
        cond_out.append({
            'city': city,
            'condition': cond,
            'condition_name': grp[0].get('condition_name', cond),
            'n': len(grp),
            'mean_efficiency_index': round(m, 3),
            'ci95_eff_low': round(lo, 3),
            'ci95_eff_high': round(hi, 3),
            'mean_env_improvement_pct': round(mean([r['_ei'] for r in grp]), 3),
            'mean_time_penalty_pct': round(mean([r['_tp'] for r in grp]), 3),
            'pct_eff_positive': round(100 * sum(1 for e in eff if e > 0) / len(eff), 2),
        })
    csi_out = []
    by_city = defaultdict(dict)
    for row in cond_out:
        by_city[row['city']][row['condition']] = row['mean_efficiency_index']
    for city, means in sorted(by_city.items()):
        vals = [(c, means[c]) for c in CONDITIONS if c in means]
        if not vals:
            continue
        best_c, best_v = max(vals, key=lambda x: x[1])
        worst_c, worst_v = min(vals, key=lambda x: x[1])
        csi_out.append({
            'city': city,
            'csi': round(best_v - worst_v, 3),
            'best_condition': best_c,
            'best_mean_eff': best_v,
            'worst_condition': worst_c,
            'worst_mean_eff': worst_v,
            'mean_eff_across_conditions': round(mean([v for _, v in vals]), 3),
        })
    csi_out.sort(key=lambda x: x['csi'])
    return cond_out, csi_out


def write_report(
    path: Path,
    sources: List[str],
    n: int,
    a1: List[dict],
    a2: List[dict],
    a3c: List[dict],
    a3csi: List[dict],
    exploitable: Optional[List[dict]] = None,
) -> None:
    lines = [
        '# Browser benchmark — three main analyses',
        '',
        'Generated: ' + datetime.now().isoformat(timespec='seconds'),
        'Inputs: ' + ', '.join(sources),
        'Valid rows: ' + str(n),
        '',
    ]
    if exploitable:
        nc = next((r for r in exploitable if r['subset'] == 'non_collapsed_exploitable'), None)
        if nc and nc.get('n'):
            lines.extend([
                '## Exploitable route diversity (non mapbox-collapse)',
                'Mean EI (non-collapsed only): **{mean_env_improvement_pct}%**'.format(**nc),
                'Strict gain rate (non-collapsed only): **{pct_strict_env_gain}%**'.format(**nc),
                'See analysis_exploitable_diversity.csv',
                '',
            ])
    lines.extend([
        '## Analysis 1 — Cross-city (RQ1)',
        'See analysis1_city_performance.csv',
        '',
        '## Analysis 2 — Trade-off (RQ2)',
        'See analysis2_tradeoff_by_group.csv and analysis2_quadrants_by_city.csv',
        '',
        '## Analysis 3 — CSI (RQ3)',
        'See analysis3_csi_by_city.csv and analysis3_csi_and_conditions.csv',
        '',
    ])
    if a3csi:
        lines.append('### CSI ranking (low = more robust across conditions)')
        for row in a3csi:
            lines.append(
                '- {city}: CSI={csi} (best {best_condition} {best_mean_eff}, worst {worst_condition} {worst_mean_eff})'.format(**row)
            )
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('csvs', nargs='*')
    parser.add_argument('--glob', default='')
    parser.add_argument('--out-dir', default=str(OUT_DIR))
    args = parser.parse_args()

    paths = [Path(p) for p in args.csvs]
    if args.glob:
        paths.extend(Path(p) for p in glob.glob(str(ROOT / args.glob)))
    paths = sorted({p.resolve() for p in paths if p.exists()})
    if not paths:
        sys.exit('No CSV files found.')

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = enrich(load_rows(paths))
    op_map = try_op_by_city()
    a1 = analysis1(rows, op_map)
    a2 = analysis2(rows)
    a2q = analysis2_quadrants(rows)
    a3c, a3csi = analysis3(rows)
    exploitable = analysis_exploitable_diversity(rows)

    if exploitable:
        write_csv(
            out_dir / 'analysis_exploitable_diversity.csv',
            list(exploitable[0].keys()),
            exploitable,
        )

    if a1:
        write_csv(out_dir / 'analysis1_city_performance.csv', list(a1[0].keys()), a1)
    if a2:
        write_csv(out_dir / 'analysis2_tradeoff_by_group.csv', list(a2[0].keys()), a2)
    if a2q:
        write_csv(out_dir / 'analysis2_quadrants_by_city.csv', list(a2q[0].keys()), a2q)
    if a3c:
        write_csv(out_dir / 'analysis3_csi_and_conditions.csv', list(a3c[0].keys()), a3c)
    if a3csi:
        write_csv(out_dir / 'analysis3_csi_by_city.csv', list(a3csi[0].keys()), a3csi)

    write_report(
        out_dir / 'ANALYSIS_REPORT.md',
        [p.name for p in paths],
        len(rows),
        a1,
        a2,
        a3c,
        a3csi,
        exploitable,
    )

    print('Wrote', out_dir)
    print('Rows', len(rows), '| Cities', len({r['city'] for r in rows}))
    nc = next((r for r in exploitable if r['subset'] == 'non_collapsed_exploitable'), None)
    if nc and nc.get('n'):
        print(
            'Non-collapsed (exploitable): n={n} | mean EI={mean_env_improvement_pct}% | '
            'strict gain={pct_strict_env_gain}%'.format(**nc),
        )
    if a1 and len(a1) == 1:
        r0 = a1[0]
        print('Tokyo-only preview: mean Eff', r0.get('mean_efficiency_index'), '| EI>0%', r0.get('pct_eff_positive'))


if __name__ == '__main__':
    main()
