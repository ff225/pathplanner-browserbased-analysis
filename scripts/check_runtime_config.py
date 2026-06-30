#!/usr/bin/env python
"""Check runtime configuration without printing secret values.

This is a deploy/readiness check. It verifies that required environment keys are
present, local OSM artifacts are readable, and optional external providers are
configured when requested.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


SECRET_NAMES = {
    'DJANGO_SECRET_KEY',
    'MAPBOX_ACCESS_TOKEN',
    'OPENAQ_API_KEY',
    'GRAPHHOPPER_API_KEY',
    'LOCATIONIQ_ACCESS_TOKEN',
    'ORS_API_KEY',
}

DJANGO_REQUIRED = (
    'DJANGO_SECRET_KEY',
    'DJANGO_ALLOWED_HOSTS',
)

ROUTING_REQUIRED = (
    'GRAPHHOPPER_URL',
    'LOCAL_OSM_POI_DB',
)

ROUTING_OPTIONAL_DEFAULTS = {
    'GRAPHHOPPER_TIMEOUT_SECONDS': '8',
    'GRAPHHOPPER_FORCE': 'false',
    'GRAPHHOPPER_PROFILE_WALKING': 'foot',
    'GRAPHHOPPER_PROFILE_CYCLING': 'bike',
    'GRAPHHOPPER_PROFILE_CAR': 'car',
    'LOCAL_OSM_POI_BUILD_MODE': 'full',
    'LOCAL_OSM_POI_MIN_ROWS': '1',
    'LOCAL_OSM_WALKABILITY_MIN_ROWS': '1',
    'PATHPLANNER_ROUTING_REGIONS': 'unset',
}

FRONTEND_RECOMMENDED = (
    'MAPBOX_ACCESS_TOKEN',
)

ENVIRONMENT_OPTIONAL = (
    'OPENAQ_API_KEY',
    'LOCATIONIQ_ACCESS_TOKEN',
    'ORS_API_KEY',
)


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def merged_env(env_files: list[Path]) -> dict[str, str]:
    values: dict[str, str] = {}
    for path in env_files:
        values.update(load_env_file(path))
    values.update({key: value for key, value in os.environ.items()})
    return values


def _is_set(values: dict[str, str], key: str) -> bool:
    return bool((values.get(key) or '').strip())


def _safe_status(values: dict[str, str], key: str) -> dict[str, Any]:
    value = values.get(key)
    status = {'key': key, 'set': bool(value)}
    if key not in SECRET_NAMES and value:
        status['value'] = value
    return status


def _resolve_path(raw_path: str | None) -> Path | None:
    if not raw_path:
        return None
    path = Path(raw_path).expanduser()
    return path if path.is_absolute() else ROOT / path


def _parse_region_specs(raw: str | None) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []
    if not raw:
        return specs
    for item in raw.split(';'):
        parts = [part.strip() for part in item.split('|')]
        if len(parts) < 4:
            continue
        region_id, bbox_raw, graphhopper_url, local_db = parts[:4]
        bbox_parts = [part.strip() for part in bbox_raw.split(',')]
        if len(bbox_parts) != 4:
            continue
        try:
            bbox = [float(part) for part in bbox_parts]
        except ValueError:
            continue
        specs.append({
            'id': region_id,
            'bbox': bbox,
            'graphhopper_url': graphhopper_url,
            'local_osm_poi_db': local_db,
        })
    return specs


def _check_sqlite_db(path: Path, min_poi_rows: int, min_walkability_rows: int) -> dict[str, Any]:
    if not path.exists():
        return {'ok': False, 'path': str(path), 'reason': 'missing'}
    try:
        with sqlite3.connect(f'file:{path.resolve()}?mode=ro', uri=True) as conn:
            quick_check = conn.execute('PRAGMA quick_check').fetchone()[0]
            poi_count = int(conn.execute('SELECT COUNT(*) FROM poi').fetchone()[0])
            walkability_count = int(conn.execute('SELECT COUNT(*) FROM walkability_feature').fetchone()[0])
    except (sqlite3.Error, OSError) as exc:
        return {'ok': False, 'path': str(path), 'reason': 'unreadable', 'error': str(exc)}
    if quick_check != 'ok':
        return {'ok': False, 'path': str(path), 'reason': 'quick_check_failed', 'quick_check': quick_check}
    if poi_count < min_poi_rows:
        return {'ok': False, 'path': str(path), 'reason': 'too_few_pois', 'poi': poi_count}
    if walkability_count < min_walkability_rows:
        return {
            'ok': False,
            'path': str(path),
            'reason': 'too_few_walkability_features',
            'walkability_feature': walkability_count,
        }
    return {
        'ok': True,
        'path': str(path),
        'poi': poi_count,
        'walkability_feature': walkability_count,
    }


def _check_graphhopper(url: str, timeout: float) -> dict[str, Any]:
    if not url:
        return {'ok': False, 'reason': 'missing_url'}
    try:
        request = urllib.request.Request(f'{url.rstrip("/")}/info', headers={'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {'ok': False, 'url': url, 'reason': 'unreachable', 'error': str(exc)}
    profiles = [profile.get('name') for profile in payload.get('profiles') or [] if isinstance(profile, dict)]
    bbox = payload.get('bbox')
    return {
        'ok': True,
        'url': url,
        'profiles': profiles,
        'bbox': bbox,
        'version': payload.get('version'),
    }


def check_runtime_config(
    *,
    env_files: list[Path],
    require_mapbox: bool = False,
    require_openaq: bool = False,
    require_pbf: bool = False,
    check_graphhopper: bool = True,
    check_local_db: bool = True,
    graphhopper_timeout: float = 10.0,
) -> dict[str, Any]:
    values = merged_env(env_files)
    errors: list[str] = []
    warnings: list[str] = []

    for key in DJANGO_REQUIRED:
        if not _is_set(values, key):
            errors.append(f'{key} is required')
    region_specs = _parse_region_specs(values.get('PATHPLANNER_ROUTING_REGIONS'))
    if not region_specs:
        for key in ROUTING_REQUIRED:
            if not _is_set(values, key):
                errors.append(f'{key} is required for local real-data routing')
    for key, default in ROUTING_OPTIONAL_DEFAULTS.items():
        if not _is_set(values, key):
            warnings.append(f'{key} not set; app default is {default}')
    for key in FRONTEND_RECOMMENDED:
        if not _is_set(values, key):
            message = f'{key} is required for browser address suggestions and Mapbox routing UI'
            if require_mapbox:
                errors.append(message)
            else:
                warnings.append(message)
    if require_openaq and not _is_set(values, 'OPENAQ_API_KEY'):
        errors.append('OPENAQ_API_KEY is required by --require-openaq')
    elif not _is_set(values, 'OPENAQ_API_KEY'):
        warnings.append('OPENAQ_API_KEY missing; Open-Meteo AQ can still work, OpenAQ station fallback cannot')
    for key in ('LOCATIONIQ_ACCESS_TOKEN', 'ORS_API_KEY'):
        if not _is_set(values, key):
            warnings.append(f'{key} missing; only legacy/optional paths should depend on it')

    local_db = None
    db_path = _resolve_path(values.get('LOCAL_OSM_POI_DB'))
    if check_local_db and db_path:
        local_db = _check_sqlite_db(
            db_path,
            min_poi_rows=int(values.get('LOCAL_OSM_POI_MIN_ROWS') or '1'),
            min_walkability_rows=int(values.get('LOCAL_OSM_WALKABILITY_MIN_ROWS') or '1'),
        )
        if not local_db['ok']:
            errors.append(f"LOCAL_OSM_POI_DB invalid: {local_db.get('reason')}")

    regional_local_dbs = []
    if check_local_db and region_specs:
        for region in region_specs:
            region_db_path = _resolve_path(region.get('local_osm_poi_db'))
            if not region_db_path:
                result = {'ok': False, 'path': None, 'reason': 'missing_path'}
            else:
                result = _check_sqlite_db(
                    region_db_path,
                    min_poi_rows=int(values.get('LOCAL_OSM_POI_MIN_ROWS') or '1'),
                    min_walkability_rows=int(values.get('LOCAL_OSM_WALKABILITY_MIN_ROWS') or '1'),
                )
            result['region'] = region.get('id')
            regional_local_dbs.append(result)
            if not result['ok']:
                errors.append(f"{region.get('id')} local DB invalid: {result.get('reason')}")

    pbf = None
    pbf_path = _resolve_path(values.get('LOCAL_OSM_PBF_PATH'))
    if require_pbf or _is_set(values, 'LOCAL_OSM_PBF_PATH'):
        if not pbf_path or not pbf_path.exists():
            errors.append('LOCAL_OSM_PBF_PATH is required/readable for DB bootstrap')
            pbf = {'ok': False, 'path': str(pbf_path) if pbf_path else None}
        else:
            pbf = {'ok': True, 'path': str(pbf_path), 'size_bytes': pbf_path.stat().st_size}

    graphhopper = None
    if check_graphhopper:
        if region_specs:
            graphhopper = []
            for region in region_specs:
                result = _check_graphhopper(region.get('graphhopper_url') or '', graphhopper_timeout)
                result['region'] = region.get('id')
                graphhopper.append(result)
                if not result['ok']:
                    errors.append(f"{region.get('id')} GraphHopper invalid: {result.get('reason')}")
        else:
            graphhopper = _check_graphhopper(values.get('GRAPHHOPPER_URL') or '', graphhopper_timeout)
            if not graphhopper['ok']:
                errors.append(f"GRAPHHOPPER_URL invalid: {graphhopper.get('reason')}")

    checked_keys = [
        *DJANGO_REQUIRED,
        *ROUTING_REQUIRED,
        *ROUTING_OPTIONAL_DEFAULTS.keys(),
        *FRONTEND_RECOMMENDED,
        *ENVIRONMENT_OPTIONAL,
        'LOCAL_OSM_PBF_PATH',
        'PATHPLANNER_ENSURE_LOCAL_OSM_DB',
        'PATHPLANNER_ROUTING_REGIONS',
    ]
    return {
        'ok': not errors,
        'errors': errors,
        'warnings': warnings,
        'keys': [_safe_status(values, key) for key in checked_keys],
        'local_db': local_db,
        'regional_local_dbs': regional_local_dbs,
        'pbf': pbf,
        'graphhopper': graphhopper,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--env-file',
        action='append',
        type=Path,
        default=[],
        help='Env file to load before process env. May be passed more than once.',
    )
    parser.add_argument('--require-mapbox', action='store_true')
    parser.add_argument('--require-openaq', action='store_true')
    parser.add_argument('--require-pbf', action='store_true')
    parser.add_argument('--skip-graphhopper', action='store_true')
    parser.add_argument('--skip-local-db', action='store_true')
    parser.add_argument('--graphhopper-timeout', type=float, default=10.0)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    env_files = args.env_file or [ROOT / '.env']
    result = check_runtime_config(
        env_files=env_files,
        require_mapbox=args.require_mapbox,
        require_openaq=args.require_openaq,
        require_pbf=args.require_pbf,
        check_graphhopper=not args.skip_graphhopper,
        check_local_db=not args.skip_local_db,
        graphhopper_timeout=args.graphhopper_timeout,
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print('Runtime config:', 'ok' if result['ok'] else 'failed')
        for error in result['errors']:
            print(f'ERROR {error}')
        for warning in result['warnings']:
            print(f'WARN {warning}')
        if isinstance(result['graphhopper'], list):
            ok_count = sum(1 for item in result['graphhopper'] if item.get('ok'))
            print(f"GraphHopper regions: {ok_count}/{len(result['graphhopper'])} ok")
        elif result['graphhopper']:
            print(f"GraphHopper: {'ok' if result['graphhopper']['ok'] else 'failed'}")
        if result['local_db']:
            print(f"Local DB: {'ok' if result['local_db']['ok'] else 'failed'}")
        if result['regional_local_dbs']:
            ok_count = sum(1 for item in result['regional_local_dbs'] if item.get('ok'))
            print(f"Local DB regions: {ok_count}/{len(result['regional_local_dbs'])} ok")
        if result['pbf']:
            print(f"PBF: {'ok' if result['pbf']['ok'] else 'failed'}")
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
