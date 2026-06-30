"""Region selection for local routing artifacts.

Each configured region ties together a GraphHopper service and the matching
local OSM SQLite database. Coordinates are WGS84 lat/lon.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class RoutingRegion:
    region_id: str
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float
    graphhopper_url: str = ''
    local_osm_poi_db: str = ''

    def contains_point(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon

    def contains_bbox_center(self, min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> bool:
        center_lat = (min_lat + max_lat) / 2
        center_lon = (min_lon + max_lon) / 2
        return self.contains_point(center_lat, center_lon)


_DEFAULT_REGIONS = (
    RoutingRegion(
        'italy',
        32.90,
        -5.52,
        47.26,
        21.72,
        'http://graphhopper-italy:8989',
        '/app/runtime/local_osm_pois/italy.sqlite3',
    ),
    RoutingRegion(
        'london',
        51.20,
        -0.65,
        51.75,
        0.45,
        'http://graphhopper-london:8989',
        '/app/runtime/local_osm_pois/london.sqlite3',
    ),
    RoutingRegion(
        'new-york',
        40.40,
        -74.35,
        41.05,
        -73.55,
        'http://graphhopper-new-york:8989',
        '/app/runtime/local_osm_pois/new-york.sqlite3',
    ),
)


def _parse_region(raw: str) -> Optional[RoutingRegion]:
    parts = [part.strip() for part in raw.split('|')]
    if len(parts) < 4:
        return None
    region_id, bbox_raw, graphhopper_url, local_osm_poi_db = parts[:4]
    bbox_parts = [part.strip() for part in bbox_raw.split(',')]
    if len(bbox_parts) != 4 or not region_id:
        return None
    try:
        min_lat, min_lon, max_lat, max_lon = [float(part) for part in bbox_parts]
    except ValueError:
        return None
    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    return RoutingRegion(
        region_id=region_id,
        min_lat=min_lat,
        min_lon=min_lon,
        max_lat=max_lat,
        max_lon=max_lon,
        graphhopper_url=graphhopper_url.rstrip('/'),
        local_osm_poi_db=local_osm_poi_db,
    )


def configured_regions() -> list[RoutingRegion]:
    raw = (os.getenv('PATHPLANNER_ROUTING_REGIONS') or '').strip()
    if not raw:
        return []
    regions = []
    for item in raw.split(';'):
        region = _parse_region(item.strip())
        if region is not None:
            regions.append(region)
    return regions


def default_regions() -> list[RoutingRegion]:
    return list(_DEFAULT_REGIONS)


def routing_regions() -> list[RoutingRegion]:
    return configured_regions()


def select_region_for_points(
    start: dict[str, float],
    goal: dict[str, float],
) -> Optional[RoutingRegion]:
    for region in routing_regions():
        if (
            region.contains_point(float(start['lat']), float(start['lon']))
            and region.contains_point(float(goal['lat']), float(goal['lon']))
        ):
            return region
    return None


def select_region_for_bbox(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> Optional[RoutingRegion]:
    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    for region in routing_regions():
        if region.contains_bbox_center(min_lat, min_lon, max_lat, max_lon):
            return region
    return None


def local_osm_db_for_bbox(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> Optional[Path]:
    region = select_region_for_bbox(min_lat, min_lon, max_lat, max_lon)
    if not region or not region.local_osm_poi_db:
        return None
    return Path(region.local_osm_poi_db).expanduser()
