#!/usr/bin/env python
"""Smoke-test backend routing across known city OD pairs.

The script can test the running Django API, which is the recommended server
check, or call the backend Python function directly. It intentionally uses real
configured services and should be run as a deploy/runtime smoke test rather than
as a hermetic unit test.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_runtime_config import check_runtime_config


@dataclass(frozen=True)
class RouteCase:
    key: str
    region: str
    city: str
    start: tuple[float, float]
    end: tuple[float, float]
    mode: str = 'walking'
    condition: str = 'respiratory'
    tolerance: float = 5.0
    alternatives: int = 3


CASES: tuple[RouteCase, ...] = (
    RouteCase(
        key='modena-portali',
        region='italy',
        city='Modena',
        start=(44.6398102, 10.9424172),
        end=(44.6444776, 10.9569078),
    ),
    RouteCase(
        key='bologna-center',
        region='italy',
        city='Bologna',
        start=(44.494887, 11.342616),
        end=(44.496231, 11.345686),
        tolerance=4.0,
    ),
    RouteCase(
        key='florence-station',
        region='italy',
        city='Florence',
        start=(43.776674, 11.249118),
        end=(43.769562, 11.255814),
        tolerance=4.0,
    ),
    RouteCase(
        key='rome-villa-borghese',
        region='italy',
        city='Rome',
        start=(41.902782, 12.496366),
        end=(41.914197, 12.492348),
        tolerance=6.0,
    ),
    RouteCase(
        key='london-westminster',
        region='london',
        city='London',
        start=(51.5033, -0.1195),
        end=(51.5155, -0.1419),
        tolerance=5.0,
    ),
    RouteCase(
        key='new-york-midtown',
        region='new-york',
        city='New York',
        start=(40.7484, -73.9857),
        end=(40.7580, -73.9855),
        tolerance=5.0,
    ),
)


def _http_json(url: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode('utf-8')
        return json.loads(payload)


def _fetch_graphhopper_bbox(graphhopper_url: str, timeout: float) -> tuple[float, float, float, float] | None:
    if not graphhopper_url:
        return None
    try:
        payload = _http_json(f'{graphhopper_url.rstrip("/")}/info', timeout)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    bbox = payload.get('bbox')
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    min_lon, min_lat, max_lon, max_lat = [float(value) for value in bbox]
    return min_lat, min_lon, max_lat, max_lon


def _case_inside_bbox(case: RouteCase, bbox: tuple[float, float, float, float] | None) -> bool:
    if bbox is None:
        return True
    min_lat, min_lon, max_lat, max_lon = bbox
    for lat, lon in (case.start, case.end):
        if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
            return False
    return True


def _api_url(base_url: str, case: RouteCase) -> str:
    params = urllib.parse.urlencode({
        'start': f'{case.start[0]},{case.start[1]}',
        'end': f'{case.end[0]},{case.end[1]}',
        'condition': case.condition,
        'transport_mode': case.mode,
        'distance_tolerance': case.tolerance,
        'alternatives': case.alternatives,
    })
    return f'{base_url.rstrip("/")}/api/backend_astar/?{params}'


def _run_case_http(base_url: str, case: RouteCase, timeout: float) -> dict[str, Any]:
    return _http_json(_api_url(base_url, case), timeout)


def _run_case_direct(case: RouteCase) -> dict[str, Any]:
    from evaluations.backend_astar import generate_backend_astar_routes

    return generate_backend_astar_routes(
        case.start[0],
        case.start[1],
        case.end[0],
        case.end[1],
        condition=case.condition,
        distance_tolerance=case.tolerance,
        transport_mode=case.mode,
        alternatives=case.alternatives,
    )


def _source_contains(data_sources: dict[str, Any], needle: str) -> bool:
    needle = needle.lower()
    return any(needle in str(value).lower() for value in data_sources.values())


def validate_payload(
    case: RouteCase,
    payload: dict[str, Any],
    *,
    require_local_data: bool,
    require_walkability: bool,
) -> list[str]:
    errors: list[str] = []
    routes = payload.get('routes')
    if not isinstance(routes, list) or not routes:
        return [f'{case.key}: no routes returned ({payload.get("error") or payload.get("source")})']

    first = routes[0]
    path = first.get('path')
    if not isinstance(path, list) or len(path) < 2:
        errors.append(f'{case.key}: first route path has fewer than 2 points')
    if float(first.get('distance_m') or 0) <= 0:
        errors.append(f'{case.key}: first route distance_m is missing/zero')
    if float(first.get('duration_s') or 0) <= 0:
        errors.append(f'{case.key}: first route duration_s is missing/zero')

    explanation = first.get('explanation') or {}
    environment = explanation.get('environment') or {}
    if int(environment.get('sample_count') or 0) <= 0:
        errors.append(f'{case.key}: explanation.environment.sample_count is missing/zero')
    if 'reasons' not in explanation:
        errors.append(f'{case.key}: explanation.reasons missing')

    data_sources = first.get('data_sources') or explanation.get('data_sources') or {}
    if not data_sources:
        errors.append(f'{case.key}: data_sources missing')
    if require_local_data:
        street_graph = str(data_sources.get('street_graph') or '')
        if 'graphhopper' not in street_graph.lower():
            errors.append(f'{case.key}: street_graph is not GraphHopper ({street_graph})')
        if not _source_contains(data_sources, 'OpenStreetMap local PBF SQLite'):
            errors.append(f'{case.key}: no local SQLite source found in data_sources')
    if require_walkability:
        walkability = explanation.get('walkability') or {}
        if int(walkability.get('feature_count') or 0) <= 0:
            errors.append(f'{case.key}: walkability.feature_count is missing/zero')
        if 'walkability' not in data_sources:
            errors.append(f'{case.key}: walkability source missing')
    return errors


def _selected_cases(regions: set[str], keys: set[str]) -> list[RouteCase]:
    selected = []
    for case in CASES:
        if regions and case.region not in regions:
            continue
        if keys and case.key not in keys:
            continue
        selected.append(case)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('PP_BASE_URL', 'http://127.0.0.1:8765'))
    parser.add_argument(
        '--graphhopper-url',
        default=os.getenv('GRAPHHOPPER_URL', ''),
        help='Optional single GraphHopper URL used only to skip cases outside its bbox.',
    )
    parser.add_argument('--direct', action='store_true', help='Call backend Python directly instead of HTTP API')
    parser.add_argument('--region', action='append', choices=sorted({case.region for case in CASES}))
    parser.add_argument('--case', action='append', dest='case_keys', choices=sorted(case.key for case in CASES))
    parser.add_argument('--timeout', type=float, default=90.0)
    parser.add_argument('--no-skip-outside-graphhopper-bbox', action='store_true')
    parser.add_argument('--require-local-data', action='store_true')
    parser.add_argument('--require-walkability', action='store_true')
    parser.add_argument('--skip-config-check', action='store_true')
    parser.add_argument('--env-file', action='append', type=Path, default=[])
    parser.add_argument('--require-mapbox', action='store_true')
    parser.add_argument('--require-openaq', action='store_true')
    parser.add_argument('--require-pbf', action='store_true')
    parser.add_argument('--json', action='store_true', help='Print machine-readable JSON summary')
    args = parser.parse_args()

    cases = _selected_cases(set(args.region or []), set(args.case_keys or []))
    if not cases:
        parser.error('no route cases selected')

    config_result = None
    config_failed = False
    if not args.skip_config_check:
        config_result = check_runtime_config(
            env_files=args.env_file or [ROOT / '.env'],
            require_mapbox=args.require_mapbox,
            require_openaq=args.require_openaq,
            require_pbf=args.require_pbf,
            check_graphhopper=True,
            check_local_db=True,
            graphhopper_timeout=min(args.timeout, 10.0),
        )
        config_failed = not config_result['ok']

    graphhopper_bbox = None
    if args.graphhopper_url and not args.no_skip_outside_graphhopper_bbox:
        graphhopper_bbox = _fetch_graphhopper_bbox(
            args.graphhopper_url,
            min(args.timeout, 10.0),
        )
    results = []
    failures = 0

    for case in cases:
        if not args.no_skip_outside_graphhopper_bbox and not _case_inside_bbox(case, graphhopper_bbox):
            results.append({
                'case': case.key,
                'city': case.city,
                'region': case.region,
                'status': 'skipped',
                'reason': 'outside active GraphHopper bbox',
            })
            continue

        started = time.perf_counter()
        try:
            payload = _run_case_direct(case) if args.direct else _run_case_http(args.base_url, case, args.timeout)
            errors = validate_payload(
                case,
                payload,
                require_local_data=args.require_local_data,
                require_walkability=args.require_walkability,
            )
        except Exception as exc:  # noqa: BLE001 - smoke test should report any runtime failure
            payload = {}
            errors = [f'{case.key}: {type(exc).__name__}: {exc}']
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        routes = payload.get('routes') or []
        first = routes[0] if routes else {}
        explanation = first.get('explanation') or {}
        result = {
            'case': case.key,
            'city': case.city,
            'region': case.region,
            'status': 'failed' if errors else 'passed',
            'elapsed_ms': elapsed_ms,
            'source': payload.get('source'),
            'routing_region': (first.get('data_sources') or {}).get('routing_region'),
            'route_count': payload.get('count') or len(routes),
            'distance_m': first.get('distance_m'),
            'duration_s': first.get('duration_s'),
            'environment_samples': (explanation.get('environment') or {}).get('sample_count'),
            'walkability_feature_count': (explanation.get('walkability') or {}).get('feature_count'),
            'errors': errors,
        }
        if errors:
            failures += 1
        results.append(result)

    summary = {
        'base_url': args.base_url if not args.direct else None,
        'direct': args.direct,
        'graphhopper_bbox': graphhopper_bbox,
        'passed': sum(1 for result in results if result['status'] == 'passed'),
        'failed': failures + (1 if config_failed else 0),
        'skipped': sum(1 for result in results if result['status'] == 'skipped'),
        'config': config_result,
        'results': results,
    }

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        if config_result:
            print(f"CONFIG {'PASS' if config_result['ok'] else 'FAIL'}")
            for error in config_result['errors']:
                print(f'CONFIG ERROR {error}')
            for warning in config_result['warnings']:
                print(f'CONFIG WARN {warning}')
        for result in results:
            if result['status'] == 'skipped':
                print(f"SKIP {result['case']} ({result['city']}): {result['reason']}")
            elif result['status'] == 'passed':
                print(
                    f"PASS {result['case']} ({result['city']}): "
                    f"{result['route_count']} route(s), {result['distance_m']} m, "
                    f"{result['elapsed_ms']} ms, walkability={result['walkability_feature_count']}"
                )
            else:
                print(f"FAIL {result['case']} ({result['city']}): {'; '.join(result['errors'])}")
        print(f"Summary: {summary['passed']} passed, {summary['failed']} failed, {summary['skipped']} skipped")
    return 1 if summary['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
