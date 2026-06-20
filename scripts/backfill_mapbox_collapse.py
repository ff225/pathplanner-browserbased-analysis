#!/usr/bin/env python3
"""Add mapbox_collapse column to existing benchmark CSVs (in-place)."""
import argparse
import csv
import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_FALLBACK = frozenset({
    'fallback_direct',
    'no_env_improvement_over_direct',
    'mapbox_collapsed_to_direct',
})


def collapse(row: dict) -> bool:
    try:
        sd = float(row['standard_distance_m'])
        od = float(row['optimized_distance_m'])
    except (KeyError, TypeError, ValueError):
        return False
    if abs(sd - od) > 0.5:
        return False
    det = (row.get('detour_selection') or '').strip().lower()
    return det in _FALLBACK


def backfill(path: Path) -> int:
    with path.open(newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []
    if 'mapbox_collapse' not in fieldnames:
        fieldnames.append('mapbox_collapse')
    n_true = 0
    for row in rows:
        val = collapse(row)
        row['mapbox_collapse'] = 'True' if val else 'False'
        if val:
            n_true += 1
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    return n_true


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--glob', default='pathplanner_browser_*_full*.csv')
    args = parser.parse_args()
    paths = sorted(ROOT.glob(args.glob))
    for p in paths:
        with p.open(newline='', encoding='utf-8') as f:
            n_rows = sum(1 for _ in csv.DictReader(f))
        n = backfill(p)
        print(p.name, '— mapbox_collapse True:', n, '/', n_rows)


if __name__ == '__main__':
    main()
