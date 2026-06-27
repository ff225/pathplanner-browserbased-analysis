"""Local OSM-derived POI and walkability lookup.

The app still reads real OpenStreetMap data, but from a SQLite index extracted
from an explicit PBF file instead of querying public Overpass at route time.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


LOCAL_POI_SOURCE = 'OpenStreetMap local PBF SQLite'

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_DB_CANDIDATES = (
    _PROJECT_ROOT / 'runtime' / 'local_osm_pois' / 'pois.sqlite3',
    _PROJECT_ROOT / 'runtime' / 'local_osm_pois' / 'italy.sqlite3',
)

_LOCAL_OSM_DROP_INDEX_SQL = """
DROP INDEX IF EXISTS idx_poi_category_bbox;
DROP INDEX IF EXISTS idx_walkability_category_bbox;
DROP INDEX IF EXISTS idx_poi_category_lat_lon_cover;
DROP INDEX IF EXISTS idx_poi_category_lon_lat_cover;
DROP INDEX IF EXISTS idx_walkability_category_lat_lon_cover;
DROP INDEX IF EXISTS idx_walkability_category_lon_lat_cover;
DROP INDEX IF EXISTS idx_walkability_lat_lon_cover;
DROP INDEX IF EXISTS idx_walkability_lon_lat_cover;
"""

_LOCAL_OSM_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_poi_category_lat_lon_cover
    ON poi(category, lat, lon, name, kind, id);
CREATE INDEX IF NOT EXISTS idx_poi_category_lon_lat_cover
    ON poi(category, lon, lat, name, kind, id);
CREATE INDEX IF NOT EXISTS idx_walkability_category_lat_lon_cover
    ON walkability_feature(category, lat, lon, name, kind, id);
CREATE INDEX IF NOT EXISTS idx_walkability_category_lon_lat_cover
    ON walkability_feature(category, lon, lat, name, kind, id);
CREATE INDEX IF NOT EXISTS idx_walkability_lat_lon_cover
    ON walkability_feature(lat, lon, category, name, kind, id);
CREATE INDEX IF NOT EXISTS idx_walkability_lon_lat_cover
    ON walkability_feature(lon, lat, category, name, kind, id);
"""


def local_osm_db_path() -> Optional[Path]:
    configured = (os.getenv('LOCAL_OSM_POI_DB') or '').strip()
    if configured:
        return Path(configured).expanduser()
    if (os.getenv('LOCAL_OSM_POI_AUTO') or '').lower() not in {'1', 'true', 'yes'}:
        return None
    for candidate in _DEFAULT_DB_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


def has_local_osm_db() -> bool:
    path = local_osm_db_path()
    return bool(path and path.exists())


def _connect(db_path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        conn = sqlite3.connect(
            f'file:{db_path.resolve()}?mode=ro',
            uri=True,
        )
    else:
        conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS poi (
                id TEXT PRIMARY KEY,
                osm_type TEXT NOT NULL,
                osm_id INTEGER NOT NULL,
                category TEXT NOT NULL,
                name TEXT,
                kind TEXT,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                tags TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS walkability_feature (
                id TEXT PRIMARY KEY,
                osm_type TEXT NOT NULL,
                osm_id INTEGER NOT NULL,
                category TEXT NOT NULL,
                name TEXT,
                kind TEXT,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                tags TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def optimize_local_osm_db(db_path: Path) -> Dict[str, Any]:
    """Create query indexes and finalize a local OSM SQLite database."""
    db_path = Path(db_path)
    started = time.perf_counter()
    if not db_path.exists():
        raise FileNotFoundError(db_path)
    with _connect(db_path) as conn:
        conn.executescript(_LOCAL_OSM_DROP_INDEX_SQL)
        conn.executescript(_LOCAL_OSM_INDEX_SQL)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('optimized_at', ?)",
            (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),),
        )
        conn.commit()
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        try:
            conn.execute('PRAGMA journal_mode=DELETE')
        except sqlite3.OperationalError:
            pass
        conn.execute('ANALYZE')
        conn.execute('PRAGMA optimize')
        counts = {
            'poi': conn.execute('SELECT COUNT(*) FROM poi').fetchone()[0],
            'walkability_feature': conn.execute(
                'SELECT COUNT(*) FROM walkability_feature'
            ).fetchone()[0],
        }
        index_count = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'"
        ).fetchone()[0]
    return {
        'db_path': str(db_path),
        'counts': counts,
        'index_count': index_count,
        'duration_s': round(time.perf_counter() - started, 2),
    }


def _tags(obj: Any) -> Dict[str, str]:
    return {tag.k: tag.v for tag in obj.tags}


def _first(tags: Dict[str, str], keys: Iterable[str]) -> Optional[str]:
    for key in keys:
        value = tags.get(key)
        if value:
            return value
    return None


def classify_poi(tags: Dict[str, str]) -> Optional[Tuple[str, str]]:
    leisure = tags.get('leisure')
    landuse = tags.get('landuse')
    natural = tags.get('natural')
    amenity = tags.get('amenity')
    healthcare = tags.get('healthcare')
    tourism = tags.get('tourism')
    boundary = tags.get('boundary')

    if (
        leisure in {'park', 'garden', 'nature_reserve', 'recreation_ground'}
        or landuse in {'forest', 'meadow', 'grass', 'village_green', 'recreation_ground'}
        or natural in {'wood', 'grassland', 'scrub', 'heath'}
        or boundary == 'protected_area'
    ):
        return 'parks', _first(tags, ('leisure', 'landuse', 'natural', 'boundary')) or 'green'
    if amenity in {'hospital', 'clinic'} or healthcare in {'hospital', 'clinic'}:
        return 'hospitals', _first(tags, ('amenity', 'healthcare')) or 'healthcare'
    if amenity in {'cinema', 'theatre', 'concert_hall', 'arts_centre'}:
        return 'entertainment', amenity
    if amenity in {'bar', 'pub', 'nightclub'}:
        return 'nightlife', amenity
    if tourism in {'attraction', 'museum', 'viewpoint', 'gallery'}:
        return 'tourism', tourism
    if amenity == 'pharmacy' or healthcare == 'pharmacy':
        return 'pharmacies', 'pharmacy'
    if amenity in {'toilets', 'drinking_water', 'bench'}:
        return amenity, amenity
    return None


def classify_walkability(tags: Dict[str, str]) -> Optional[Tuple[str, str]]:
    highway = tags.get('highway')
    if highway == 'steps':
        return 'steps', 'steps'
    if tags.get('incline'):
        return 'incline', tags['incline']
    surface = tags.get('surface')
    if surface:
        return 'surface', surface
    smoothness = tags.get('smoothness')
    if smoothness:
        return 'smoothness', smoothness
    wheelchair = tags.get('wheelchair')
    if wheelchair:
        return 'wheelchair', wheelchair
    return None


def _node_location(node: Any) -> Optional[Tuple[float, float]]:
    try:
        return float(node.location.lat), float(node.location.lon)
    except Exception:
        return None


def _way_centroid(way: Any) -> Optional[Tuple[float, float]]:
    points = []
    for node in way.nodes:
        try:
            loc = node.location
            if loc.valid():
                points.append((float(loc.lat), float(loc.lon)))
        except Exception:
            continue
    if not points:
        return None
    return (
        sum(lat for lat, _ in points) / len(points),
        sum(lon for _, lon in points) / len(points),
    )


def _rows_to_payload(rows: Iterable[sqlite3.Row], category: str, source: str) -> Dict[str, Any]:
    pois = []
    seen_names = set()
    for row in rows:
        name = row['name']
        if name:
            dedup_key = name.strip().lower()
            if dedup_key in seen_names:
                continue
            seen_names.add(dedup_key)
        pois.append({
            'name': name,
            'lat': float(row['lat']),
            'lon': float(row['lon']),
            'kind': row['kind'],
        })
    return {
        'pois': pois,
        'category': category,
        'count': len(pois),
        'source': source,
    }


def fetch_local_named_pois(
    category: str,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 120,
    *,
    db_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    path = Path(db_path) if db_path else local_osm_db_path()
    if not path or not path.exists():
        return None
    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    with _connect(path, readonly=True) as conn:
        rows = conn.execute(
            """
            SELECT name, lat, lon, kind
            FROM poi
            WHERE category = ?
              AND lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
            ORDER BY CASE WHEN name IS NULL THEN 1 ELSE 0 END, name COLLATE NOCASE, id
            LIMIT ?
            """,
            (category, min_lat, max_lat, min_lon, max_lon, int(limit)),
        ).fetchall()
    return _rows_to_payload(rows, category, f'{LOCAL_POI_SOURCE}: {path.name}')


def fetch_local_walkability_features(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 500,
    *,
    category: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    path = Path(db_path) if db_path else local_osm_db_path()
    if not path or not path.exists():
        return None
    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    params: List[Any] = [min_lat, max_lat, min_lon, max_lon]
    category_clause = ''
    if category:
        category_clause = 'AND category = ?'
        params.append(category)
    params.append(int(limit))
    with _connect(path, readonly=True) as conn:
        rows = conn.execute(
            f"""
            SELECT category, name, lat, lon, kind
            FROM walkability_feature
            WHERE lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
              {category_clause}
            ORDER BY category, id
            LIMIT ?
            """,
            params,
        ).fetchall()
    features = [
        {
            'category': row['category'],
            'name': row['name'],
            'lat': float(row['lat']),
            'lon': float(row['lon']),
            'kind': row['kind'],
        }
        for row in rows
    ]
    return {
        'features': features,
        'count': len(features),
        'source': f'{LOCAL_POI_SOURCE}: {path.name}',
    }


class _PbfIndexHandler:
    def __init__(
        self,
        conn: sqlite3.Connection,
        batch_size: int = 5000,
        include_walkability: bool = True,
    ) -> None:
        self.conn = conn
        self.batch_size = batch_size
        self.include_walkability = include_walkability
        self.poi_rows: List[Tuple[Any, ...]] = []
        self.walk_rows: List[Tuple[Any, ...]] = []
        self.counts = {'poi': 0, 'walkability_feature': 0}

    def _add_poi(
        self,
        osm_type: str,
        osm_id: int,
        tags: Dict[str, str],
        location: Optional[Tuple[float, float]],
        classified: Optional[Tuple[str, str]] = None,
    ) -> None:
        classified = classified or classify_poi(tags)
        if not classified or location is None:
            return
        category, kind = classified
        lat, lon = location
        self.poi_rows.append((
            f'{osm_type}/{osm_id}/{category}',
            osm_type,
            int(osm_id),
            category,
            tags.get('name'),
            kind,
            lat,
            lon,
            json.dumps(tags, ensure_ascii=True, sort_keys=True),
        ))
        self.counts['poi'] += 1
        if len(self.poi_rows) >= self.batch_size:
            self.flush()

    def _add_walkability(
        self,
        osm_type: str,
        osm_id: int,
        tags: Dict[str, str],
        location: Optional[Tuple[float, float]],
        classified: Optional[Tuple[str, str]] = None,
    ) -> None:
        classified = classified or classify_walkability(tags)
        if not classified or location is None:
            return
        category, kind = classified
        lat, lon = location
        self.walk_rows.append((
            f'{osm_type}/{osm_id}/{category}',
            osm_type,
            int(osm_id),
            category,
            tags.get('name'),
            kind,
            lat,
            lon,
            json.dumps(tags, ensure_ascii=True, sort_keys=True),
        ))
        self.counts['walkability_feature'] += 1
        if len(self.walk_rows) >= self.batch_size:
            self.flush()

    def node(self, node: Any) -> None:
        if len(node.tags) == 0:
            return
        tags = _tags(node)
        classified = classify_poi(tags)
        if not classified:
            return
        location = _node_location(node)
        self._add_poi('node', node.id, tags, location, classified)

    def way(self, way: Any) -> None:
        if len(way.tags) == 0:
            return
        tags = _tags(way)
        poi_classified = classify_poi(tags)
        walk_classified = classify_walkability(tags) if self.include_walkability else None
        if not poi_classified and not walk_classified:
            return
        location = _way_centroid(way)
        self._add_poi('way', way.id, tags, location, poi_classified)
        if self.include_walkability:
            self._add_walkability('way', way.id, tags, location, walk_classified)

    def flush(self) -> None:
        if self.poi_rows:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO poi
                    (id, osm_type, osm_id, category, name, kind, lat, lon, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                self.poi_rows,
            )
            self.poi_rows.clear()
        if self.walk_rows:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO walkability_feature
                    (id, osm_type, osm_id, category, name, kind, lat, lon, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                self.walk_rows,
            )
            self.walk_rows.clear()


def build_local_osm_db(
    pbf_path: Path,
    db_path: Path,
    *,
    include_walkability: bool = True,
) -> Dict[str, Any]:
    import osmium

    pbf_path = Path(pbf_path)
    db_path = Path(db_path)
    if not pbf_path.exists():
        raise FileNotFoundError(pbf_path)
    for candidate in (db_path, db_path.with_name(db_path.name + '-wal'), db_path.with_name(db_path.name + '-shm')):
        if candidate.exists():
            candidate.unlink()
    init_db(db_path)
    started = time.perf_counter()
    with _connect(db_path) as conn:
        conn.execute('PRAGMA synchronous=OFF')
        class PbfIndexHandler(osmium.SimpleHandler, _PbfIndexHandler):
            def __init__(self, sqlite_conn: sqlite3.Connection) -> None:
                osmium.SimpleHandler.__init__(self)
                _PbfIndexHandler.__init__(
                    self,
                    sqlite_conn,
                    include_walkability=include_walkability,
                )

        handler = PbfIndexHandler(conn)
        handler.apply_file(str(pbf_path), locations=True)
        handler.flush()
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('pbf_path', ?), ('built_at', ?)",
            (str(pbf_path), time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())),
        )
        counts = dict(handler.counts)
    optimization = optimize_local_osm_db(db_path)
    return {
        'db_path': str(db_path),
        'pbf_path': str(pbf_path),
        'include_walkability': include_walkability,
        'counts': counts,
        'indexes': optimization['index_count'],
        'duration_s': round(time.perf_counter() - started, 2),
    }
