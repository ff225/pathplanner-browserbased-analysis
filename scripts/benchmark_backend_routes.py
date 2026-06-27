#!/usr/bin/env python
"""Benchmark backend route generation for known OD pairs.

This script is intentionally a smoke/diagnostic utility, not a unit test. It
uses whatever local services are configured in the environment.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evaluations.backend_astar import generate_backend_astar_routes


DEFAULT_CASES = {
    'modena-portali': (44.6398102, 10.9424172, 44.6444776, 10.9569078),
    'london-short': (51.5033, -0.1195, 51.5155, -0.1419),
    'new-york-short': (40.7484, -73.9857, 40.7580, -73.9855),
}


def run_case(name: str, coords: tuple[float, float, float, float], repeats: int, mode: str, tolerance: float) -> dict:
    timings = []
    payload = None
    for _ in range(repeats):
        started = time.perf_counter()
        payload = generate_backend_astar_routes(
            *coords,
            condition='respiratory',
            distance_tolerance=tolerance,
            transport_mode=mode,
            alternatives=3,
        )
        timings.append((time.perf_counter() - started) * 1000)
    routes = payload.get('routes') if payload else []
    first = routes[0] if routes else {}
    return {
        'case': name,
        'mode': mode,
        'tolerance': tolerance,
        'repeats': repeats,
        'source': payload.get('source') if payload else None,
        'route_count': payload.get('count') if payload else 0,
        'timing_ms': {
            'avg': round(statistics.mean(timings), 1),
            'best': round(min(timings), 1),
            'runs': [round(value, 1) for value in timings],
        },
        'first_route': {
            'distance_m': first.get('distance_m'),
            'duration_s': first.get('duration_s'),
            'env_score': first.get('env_score'),
            'data_sources': first.get('data_sources'),
            'explanation': first.get('explanation'),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=DEFAULT_CASES.keys(), default='modena-portali')
    parser.add_argument('--mode', choices=('walking', 'cycling', 'car'), default='walking')
    parser.add_argument('--tolerance', type=float, default=5.0)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()

    result = run_case(args.case, DEFAULT_CASES[args.case], args.repeats, args.mode, args.tolerance)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
