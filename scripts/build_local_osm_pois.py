#!/usr/bin/env python
"""Build the local OSM POI/walkability SQLite index from a PBF extract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evaluations.local_osm_poi_service import build_local_osm_db, optimize_local_osm_db


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pbf', type=Path, help='Input OSM .pbf extract')
    parser.add_argument('--db', required=True, type=Path, help='Output SQLite database')
    parser.add_argument(
        '--poi-only',
        action='store_true',
        help='Extract route-scoring POIs only; skip surface/smoothness/incline features.',
    )
    parser.add_argument(
        '--optimize-only',
        action='store_true',
        help='Create/refresh SQLite indexes on an existing DB without reading a PBF.',
    )
    args = parser.parse_args()

    if args.optimize_only:
        result = optimize_local_osm_db(args.db)
    else:
        if args.pbf is None:
            parser.error('--pbf is required unless --optimize-only is set')
        result = build_local_osm_db(args.pbf, args.db, include_walkability=not args.poi_only)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
