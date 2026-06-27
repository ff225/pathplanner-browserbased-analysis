"""
Fetch real environmental factors from external APIs (aligned with static/js/services/environmental.js).

APIs used (no key unless noted):
  - Open-Meteo: temperature, humidity, weather code, wind
  - OpenTopoData: elevation and slope estimate
  - OpenStreetMap Overpass: noise proxies, green-space proximity
  - OpenAQ: air quality (via air_quality_service)

Optional env vars:
  - OPENAQ_API_KEY
  - MAPBOX_ACCESS_TOKEN (fallback slope from Mapbox terrain)
"""

import math
import os
import random
import time
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

from .air_quality_service import air_quality_service
from .local_osm_poi_service import fetch_local_named_pois, has_local_osm_db

OPENMETEO_FORECAST = (
    'https://api.open-meteo.com/v1/forecast'
    '?latitude={lat}&longitude={lon}'
    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
    '&timezone=auto'
)
OPENMETEO_ELEVATION = (
    'https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}'
)
OPENTOPO_DATASETS = ('srtm30m', 'aster30m')
OVERPASS_URLS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
)
OVERPASS_HEADERS = {'User-Agent': 'PathPlanner-Research/1.0 (environmental routing)'}

DEFAULT_ENV = {
    'temperature': 22.0,
    'humidity': 50.0,
    'weather': 1.0,
    'windSpeed': 2.0,
    'airQuality': 5.0,
    'slope': 3.0,
    'noise': 4.0,
    'greenSpace': 3.0,
}

_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_CACHE_TTL = 20 * 60  # 20 minutes, same idea as frontend WeatherService


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    if key in _CACHE:
        ts, data = _CACHE[key]
        if time.time() - ts < _CACHE_TTL:
            return data
        del _CACHE[key]
    return None


def _cache_set(key: str, data: Dict[str, Any]) -> None:
    _CACHE[key] = (time.time(), data)


# --- Overpass resilience: circuit-breaker + backoff + geospatial cache ---
# env-A* fires 3 Overpass queries per route node (noise x2 + green-space x1).
# Without protection this rate-limits the public mirrors. We add: a shared
# circuit-breaker that short-circuits to cached/default values once Overpass is
# clearly down, exponential backoff+jitter with mirror rotation on retry, and a
# coarse geospatial cache so neighbouring nodes reuse a single fetch.
OVERPASS_TIMEOUT = 25  # seconds per mirror for the routing env-A* path (kept from the original)
OVERPASS_POI_TIMEOUT = 8  # seconds per mirror for the interactive map POI overlay
OVERPASS_BREAKER_THRESHOLD = 4  # consecutive failed calls before the breaker opens
OVERPASS_BREAKER_COOLDOWN = 60.0  # seconds the breaker stays open before a trial call
OVERPASS_BACKOFF_BASE = 0.5  # seconds, delay before the first retry
OVERPASS_BACKOFF_MAX = 8.0  # cap on a single backoff sleep
OVERPASS_GEO_PRECISION = 3  # decimals for the geo-cache grid (~110 m cell)


class _OverpassBreaker:
    """Circuit-breaker shared across the 3 Overpass mirrors.

    Closed (normal) until ``threshold`` consecutive fully-failed calls, then it
    opens for ``cooldown`` seconds — during which calls short-circuit instead of
    hammering the mirrors. After the cooldown it half-opens (one trial call); a
    success closes it again, another failure re-opens it.
    """

    def __init__(self, threshold: int, cooldown: float) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self.failures = 0
        self.opened_at: Optional[float] = None

    def is_open(self) -> bool:
        if self.opened_at is None:
            return False
        if time.time() - self.opened_at >= self.cooldown:
            # cooldown elapsed -> half-open: let the next call through as a trial
            self.opened_at = None
            self.failures = 0
            return False
        return True

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= self.threshold:
            self.opened_at = time.time()


_overpass_breaker = _OverpassBreaker(OVERPASS_BREAKER_THRESHOLD, OVERPASS_BREAKER_COOLDOWN)
# Separate breaker for the user-facing map POI overlay: the routing env-A* path
# fires 3 queries per node and can trip its breaker under load, but that must
# NOT blank out the interactive map overlay, which fires one query per request.
_overpass_poi_breaker = _OverpassBreaker(OVERPASS_BREAKER_THRESHOLD, OVERPASS_BREAKER_COOLDOWN)
_overpass_street_graph_breaker = _OverpassBreaker(OVERPASS_BREAKER_THRESHOLD, OVERPASS_BREAKER_COOLDOWN)
_overpass_mirror_index = 0  # rotates the starting mirror across calls


def _overpass_backoff_delay(attempt: int) -> float:
    """Exponential backoff with full jitter for a 0-based retry ``attempt``."""
    capped = min(OVERPASS_BACKOFF_MAX, OVERPASS_BACKOFF_BASE * (2 ** attempt))
    return random.uniform(0.0, capped)


def _geo_cache_key(prefix: str, lat: float, lon: float) -> str:
    """Coarse grid-cell key so nearby route nodes reuse the same Overpass fetch."""
    return f'{prefix}:{round(lat, OVERPASS_GEO_PRECISION)},{round(lon, OVERPASS_GEO_PRECISION)}'


def reset_overpass_state() -> None:
    """Reset breaker, mirror rotation, and cache — maintenance/test hook."""
    global _overpass_mirror_index
    _overpass_breaker.failures = 0
    _overpass_breaker.opened_at = None
    _overpass_poi_breaker.failures = 0
    _overpass_poi_breaker.opened_at = None
    _overpass_street_graph_breaker.failures = 0
    _overpass_street_graph_breaker.opened_at = None
    _overpass_mirror_index = 0
    _CACHE.clear()


def _wmo_to_weather_severity(code: Optional[int]) -> float:
    """Map WMO weather code to 0–5 severity (higher = worse for routing)."""
    if code is None:
        return DEFAULT_ENV['weather']
    if code in (0, 1):
        return 0.5
    if code in (2, 3):
        return 1.5
    if code in (45, 48):
        return 2.5
    if code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82):
        return 3.5
    if code in (71, 73, 75, 77, 85, 86):
        return 4.0
    if code in (95, 96, 99):
        return 5.0
    return 2.0


def _fetch_open_meteo_weather(lat: float, lon: float) -> Dict[str, Any]:
    url = OPENMETEO_FORECAST.format(lat=lat, lon=lon)
    r = requests.get(url, timeout=8)
    r.raise_for_status()
    current = r.json().get('current', {})
    code = current.get('weather_code')
    return {
        'temperature': float(current.get('temperature_2m', DEFAULT_ENV['temperature'])),
        'humidity': float(current.get('relative_humidity_2m', DEFAULT_ENV['humidity'])),
        'weather': _wmo_to_weather_severity(code),
        'windSpeed': float(current.get('wind_speed_10m', DEFAULT_ENV['windSpeed'])),
        'weatherCode': code,
        'sources': {
            'temperature': 'Open-Meteo',
            'humidity': 'Open-Meteo',
            'weather': 'Open-Meteo',
            'windSpeed': 'Open-Meteo',
        },
    }


def _elevation_opentopo(lat: float, lon: float) -> Optional[float]:
    for dataset in OPENTOPO_DATASETS:
        url = f'https://api.opentopodata.org/v1/{dataset}?locations={lat},{lon}'
        try:
            r = requests.get(url, timeout=10)
            if not r.ok:
                continue
            results = r.json().get('results', [])
            if results and results[0].get('elevation') is not None:
                return float(results[0]['elevation'])
        except Exception:
            continue
    return None


def _elevation_open_meteo(lat: float, lon: float) -> Optional[float]:
    url = OPENMETEO_ELEVATION.format(lat=lat, lon=lon)
    r = requests.get(url, timeout=8)
    r.raise_for_status()
    elev = r.json().get('elevation', [])
    if elev and elev[0] is not None:
        return float(elev[0])
    return None


def _fetch_slope(lat: float, lon: float) -> Tuple[Optional[float], str]:
    """Estimate slope % from elevation difference over ~111 m north."""
    try:
        e0 = _elevation_opentopo(lat, lon)
        source = 'OpenTopoData-srtm30m'
        if e0 is None:
            e0 = _elevation_open_meteo(lat, lon)
            source = 'Open-Meteo-Elevation'
        if e0 is None:
            token = os.getenv('MAPBOX_ACCESS_TOKEN')
            if token:
                url = (
                    f'https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/'
                    f'{lon},{lat}.json?layers=contour&access_token={token}'
                )
                r = requests.get(url, timeout=8)
                if r.ok:
                    feats = r.json().get('features', [])
                    elevs = [
                        f['properties'].get('ele', 0)
                        for f in feats
                        if f.get('properties', {}).get('ele') is not None
                    ]
                    if len(elevs) > 1:
                        slope = min(15.0, max(0.0, max(elevs) - min(elevs)))
                        return slope, 'Mapbox'
            return None, 'none'

        d_lat = 0.001  # ~111 m
        e1 = _elevation_opentopo(lat + d_lat, lon) or _elevation_open_meteo(lat + d_lat, lon)
        if e1 is not None:
            horizontal_m = 111_000 * d_lat
            slope_pct = abs(e1 - e0) / horizontal_m * 100.0
            return min(15.0, max(0.0, slope_pct)), source
        return 0.0, source
    except Exception as exc:
        print(f'[slope] {lat},{lon}: {exc}')
        return None, 'none'


def _overpass_post(
    query: str,
    breaker: Optional['_OverpassBreaker'] = None,
    timeout: Optional[float] = None,
    max_mirrors: Optional[int] = None,
) -> Optional[dict]:
    """POST an Overpass query, rotating mirrors with exponential backoff.

    Returns the parsed JSON on success, or ``None`` when every mirror fails or
    the circuit-breaker is open (callers then fall back to cached/default data).

    ``breaker`` and ``timeout`` default to the routing env-A* breaker / timeout.
    The interactive map POI overlay passes its own breaker and a shorter timeout
    so the routing flood cannot blank it out.
    """
    global _overpass_mirror_index

    if breaker is None:
        breaker = _overpass_breaker
    if timeout is None:
        timeout = OVERPASS_TIMEOUT

    if breaker.is_open():
        print('[overpass] circuit open — short-circuiting to cached/default values')
        return None

    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        **OVERPASS_HEADERS,
    }
    mirrors = OVERPASS_URLS
    n = len(mirrors)
    start = _overpass_mirror_index % n
    _overpass_mirror_index = (start + 1) % n  # rotate the starting mirror for next call

    attempts = n if max_mirrors is None else max(1, min(n, int(max_mirrors)))
    for attempt in range(attempts):
        base_url = mirrors[(start + attempt) % n]
        try:
            r = requests.post(
                base_url,
                data={'data': query},
                headers=headers,
                timeout=timeout,
            )
            if r.ok:
                breaker.record_success()
                return r.json()
            print(f'[overpass] {base_url} HTTP {r.status_code}')
        except Exception as exc:
            print(f'[overpass] {base_url}: {exc}')

        # this mirror failed: back off (with jitter) before trying the next one
        if attempt < attempts - 1:
            time.sleep(_overpass_backoff_delay(attempt))

    breaker.record_failure()
    return None


def _fetch_noise(lat: float, lon: float) -> Tuple[Optional[float], str]:
    """Noise level 1–10 from OSM road/rail/industrial density (mirrors environmental.js)."""
    cache_key = _geo_cache_key('overpass-noise', lat, lon)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached['value'], cached['source']

    radius = 50
    noise_query = f"""[out:json][timeout:15];(
        way["highway"~"motorway|trunk|primary|secondary"](around:{radius},{lat},{lon});
        way["railway"](around:{radius},{lat},{lon});
        node["amenity"~"bar|pub|nightclub"](around:{radius},{lat},{lon});
        way["industrial"](around:{radius},{lat},{lon});
    );out count;"""
    data = _overpass_post(noise_query)
    if not data or not data.get('elements'):
        return None, 'none'

    noise_level = 3.0
    tags = data['elements'][0].get('tags', {})
    for key, weight in (('highway', 2), ('railway', 3), ('amenity', 1), ('industrial', 2)):
        try:
            count = int(tags.get(key, 0) or 0)
        except (TypeError, ValueError):
            count = 0
        if count > 0:
            noise_level = min(10.0, noise_level + count * weight)

    quiet_query = (
        f'[out:json][timeout:15];(way["leisure"="park"](around:{radius},{lat},{lon}););out count;'
    )
    quiet = _overpass_post(quiet_query)
    if quiet and quiet.get('elements'):
        qtags = quiet['elements'][0].get('tags', {})
        if qtags.get('total') and int(qtags['total']) > 0:
            noise_level = max(1.0, noise_level - 2)

    value = min(10.0, max(1.0, noise_level))
    _cache_set(cache_key, {'value': value, 'source': 'OpenStreetMap-Overpass'})
    return value, 'OpenStreetMap-Overpass'


def _fetch_green_space(lat: float, lon: float) -> Tuple[Optional[float], str]:
    """Green-space score 1–10 from nearby parks/forests."""
    cache_key = _geo_cache_key('overpass-green', lat, lon)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached['value'], cached['source']

    radius = 200
    query = f"""[out:json][timeout:25];(
        way["leisure"="park"](around:{radius},{lat},{lon});
        way["landuse"="forest"](around:{radius},{lat},{lon});
        way["natural"="wood"](around:{radius},{lat},{lon});
    );out count;"""
    data = _overpass_post(query)
    if not data or not data.get('elements'):
        return None, 'none'
    tags = data['elements'][0].get('tags', {})
    total = 0
    for key in ('leisure', 'landuse', 'natural'):
        try:
            total += int(tags.get(key, 0) or 0)
        except (TypeError, ValueError):
            pass
    if total == 0:
        try:
            total = int(tags.get('ways', 0) or tags.get('total', 0) or 0)
        except (TypeError, ValueError):
            total = 0
    score = min(10.0, max(1.0, 2.0 + total * 1.2))
    _cache_set(cache_key, {'value': score, 'source': 'OpenStreetMap-Overpass'})
    return score, 'OpenStreetMap-Overpass'


# POI categories listable along a route. Each maps to Overpass element filters,
# the tag keys that describe its "kind", and the kinds worth listing even when
# unnamed (the route honestly passes the place). Other matches are listed only
# when they carry a real OSM name, to avoid flooding the panel with noise.
_POI_CATEGORIES = {
    'parks': {
        'filters': (
            'way["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"]',
            'relation["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"]',
            'way["landuse"~"^(forest|meadow|grass|village_green)$"]',
            'way["natural"~"^(wood|grassland|scrub)$"]',
            'node["leisure"~"^(park|garden)$"]',
        ),
        'kind_keys': ('leisure', 'landuse', 'natural'),
        'keep_unnamed_kinds': {'park', 'garden', 'nature_reserve', 'forest', 'wood'},
    },
    'hospitals': {
        'filters': (
            'node["amenity"="hospital"]',
            'way["amenity"="hospital"]',
            'relation["amenity"="hospital"]',
            'node["healthcare"="hospital"]',
            'way["healthcare"="hospital"]',
            'relation["healthcare"="hospital"]',
        ),
        'kind_keys': ('amenity', 'healthcare'),
        'keep_unnamed_kinds': {'hospital'},
    },
    'entertainment': {
        'filters': (
            'node["amenity"~"^(cinema|theatre|concert_hall|arts_centre)$"]',
            'way["amenity"~"^(cinema|theatre|concert_hall|arts_centre)$"]',
            'relation["amenity"~"^(cinema|theatre|concert_hall|arts_centre)$"]',
        ),
        'kind_keys': ('amenity',),
        'keep_unnamed_kinds': set(),
    },
    'nightlife': {
        'filters': (
            'node["amenity"~"^(bar|pub|nightclub)$"]',
            'way["amenity"~"^(bar|pub|nightclub)$"]',
            'relation["amenity"~"^(bar|pub|nightclub)$"]',
        ),
        'kind_keys': ('amenity',),
        'keep_unnamed_kinds': set(),
    },
    'tourism': {
        'filters': (
            'node["tourism"~"^(attraction|museum|viewpoint|gallery)$"]',
            'way["tourism"~"^(attraction|museum|viewpoint|gallery)$"]',
            'relation["tourism"~"^(attraction|museum|viewpoint|gallery)$"]',
        ),
        'kind_keys': ('tourism',),
        'keep_unnamed_kinds': {'attraction', 'viewpoint'},
    },
}
POI_CATEGORIES = tuple(_POI_CATEGORIES.keys())
_MAX_POI_BBOX_SPAN = 0.25  # ~25 km guard against oversized Overpass queries
OVERPASS_STREET_GRAPH_TIMEOUT = 10
_MAX_STREET_GRAPH_BBOX_SPAN = 0.22  # route-corridor guard; avoids city-scale road dumps
_MAX_STREET_GRAPH_WAYS = 12000
_MAX_STREET_GRAPH_NODES = 60000

_STREET_GRAPH_HIGHWAYS = {
    'walking': (
        'footway|path|pedestrian|steps|cycleway|residential|living_street|service|'
        'unclassified|tertiary|secondary|primary|track'
    ),
    'cycling': (
        'cycleway|path|residential|living_street|service|unclassified|tertiary|'
        'secondary|primary|track'
    ),
    'car': (
        'motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
        'living_street|service'
    ),
}


def _poi_kind(tags: Dict[str, Any], kind_keys) -> Optional[str]:
    for key in kind_keys:
        value = tags.get(key)
        if value:
            return value
    return None


def fetch_named_pois(
    category: str,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 120,
    *,
    timeout: Optional[float] = None,
    max_mirrors: Optional[int] = None,
) -> Dict[str, Any]:
    """Real OSM POIs of a category inside a bounding box.

    Returns only genuine OpenStreetMap elements (never synthetic). Each item has
    a real ``name`` from ``tags.name`` or ``None`` when the element is unnamed;
    the caller labels unnamed elements honestly and never invents a name.
    """
    config = _POI_CATEGORIES.get(category)
    if config is None:
        raise ValueError('unknown POI category')

    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    if (max_lat - min_lat) > _MAX_POI_BBOX_SPAN or (max_lon - min_lon) > _MAX_POI_BBOX_SPAN:
        raise ValueError('bounding box too large')

    if has_local_osm_db():
        local_result = fetch_local_named_pois(category, min_lat, min_lon, max_lat, max_lon, limit=limit)
        if local_result is not None:
            return local_result

    cache_key = f'pois:{category}:{round(min_lat,4)},{round(min_lon,4)},{round(max_lat,4)},{round(max_lon,4)}'
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    bbox = f'{min_lat},{min_lon},{max_lat},{max_lon}'
    body = ''.join(f'{f}({bbox});' for f in config['filters'])
    query_timeout = int(timeout or OVERPASS_POI_TIMEOUT)
    query = f'[out:json][timeout:{query_timeout}];({body});out tags center {int(limit)};'

    data = _overpass_post(
        query,
        breaker=_overpass_poi_breaker,
        timeout=timeout or OVERPASS_POI_TIMEOUT,
        max_mirrors=max_mirrors,
    )
    if data is None:
        raise RuntimeError('Overpass unavailable for POI lookup')

    elements = data.get('elements') if isinstance(data, dict) else None
    if not isinstance(elements, list):
        raise RuntimeError('Overpass returned an invalid POI payload')

    pois = []
    seen_names = set()
    keep_unnamed = config['keep_unnamed_kinds']
    kind_keys = config['kind_keys']
    for element in elements:
        tags = element.get('tags') or {}
        name = tags.get('name')
        kind = _poi_kind(tags, kind_keys)
        if not name and kind not in keep_unnamed:
            continue
        if element.get('type') == 'node':
            lat, lon = element.get('lat'), element.get('lon')
        else:
            center = element.get('center') or {}
            lat, lon = center.get('lat'), center.get('lon')
        if lat is None or lon is None:
            continue
        if name:
            dedup_key = name.strip().lower()
            if dedup_key in seen_names:
                continue
            seen_names.add(dedup_key)
        pois.append({
            'name': name or None,
            'lat': float(lat),
            'lon': float(lon),
            'kind': kind,
        })

    result = {
        'pois': pois,
        'category': category,
        'count': len(pois),
        'source': 'OpenStreetMap-Overpass',
    }
    _cache_set(cache_key, result)
    return result


def fetch_street_graph(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    mode: str = 'walking',
    *,
    timeout: Optional[float] = None,
    max_mirrors: Optional[int] = None,
) -> Dict[str, Any]:
    """Fetch a real OSM street graph inside a route corridor bbox.

    The result is intentionally not a persistent city cache. It is a short-lived,
    exact-bbox in-memory cache shared with other environmental calls so repeated
    clicks do not hammer Overpass, while a different city or route bbox triggers
    a fresh real lookup.
    """
    if max_lat < min_lat:
        min_lat, max_lat = max_lat, min_lat
    if max_lon < min_lon:
        min_lon, max_lon = max_lon, min_lon
    if (max_lat - min_lat) > _MAX_STREET_GRAPH_BBOX_SPAN or (
        max_lon - min_lon
    ) > _MAX_STREET_GRAPH_BBOX_SPAN:
        raise ValueError('street graph bounding box too large')

    mode = mode if mode in _STREET_GRAPH_HIGHWAYS else 'walking'
    cache_key = (
        f'street-graph:{mode}:'
        f'{round(min_lat,4)},{round(min_lon,4)},{round(max_lat,4)},{round(max_lon,4)}'
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    bbox = f'{min_lat},{min_lon},{max_lat},{max_lon}'
    highways = _STREET_GRAPH_HIGHWAYS[mode]
    access_filter = '["access"!~"^(private|no)$"]'
    if mode == 'walking':
        access_filter += '["foot"!~"^(private|no)$"]'
    elif mode == 'cycling':
        access_filter += '["bicycle"!~"^(private|no)$"]'
    else:
        access_filter += '["motor_vehicle"!~"^(private|no)$"]'

    query_timeout = int(timeout or OVERPASS_STREET_GRAPH_TIMEOUT)
    query = f"""
        [out:json][timeout:{query_timeout}];
        (
          way["highway"~"^({highways})$"]{access_filter}({bbox});
        );
        out body {_MAX_STREET_GRAPH_WAYS};
        >;
        out skel qt {_MAX_STREET_GRAPH_NODES};
    """
    data = _overpass_post(
        query,
        breaker=_overpass_street_graph_breaker,
        timeout=timeout or OVERPASS_STREET_GRAPH_TIMEOUT,
        max_mirrors=max_mirrors,
    )
    if data is None:
        raise RuntimeError('Overpass unavailable for street graph lookup')

    elements = data.get('elements') if isinstance(data, dict) else None
    if not isinstance(elements, list):
        raise RuntimeError('Overpass returned an invalid street graph payload')

    raw_nodes: Dict[int, Dict[str, float]] = {}
    raw_ways: List[Dict[str, Any]] = []
    required_node_ids: Set[int] = set()
    for element in elements:
        element_type = element.get('type')
        if element_type == 'node' and element.get('lat') is not None and element.get('lon') is not None:
            raw_nodes[int(element['id'])] = {
                'id': int(element['id']),
                'lat': float(element['lat']),
                'lon': float(element['lon']),
            }
        elif element_type == 'way':
            refs = [
                int(ref)
                for ref in element.get('nodes', [])
                if isinstance(ref, (int, float))
            ]
            if len(refs) < 2:
                continue
            required_node_ids.update(refs)
            tags = element.get('tags') or {}
            raw_ways.append({
                'id': int(element['id']),
                'nodes': refs,
                'highway': tags.get('highway'),
                'name': tags.get('name'),
                'oneway': tags.get('oneway'),
            })

    nodes = [node for node_id, node in raw_nodes.items() if node_id in required_node_ids]
    node_ids = {node['id'] for node in nodes}
    ways = [
        {**way, 'nodes': [node_id for node_id in way['nodes'] if node_id in node_ids]}
        for way in raw_ways
    ]
    ways = [way for way in ways if len(way['nodes']) >= 2]

    result = {
        'nodes': nodes,
        'ways': ways,
        'mode': mode,
        'source': 'OpenStreetMap-Overpass',
        'count': {'nodes': len(nodes), 'ways': len(ways)},
    }
    _cache_set(cache_key, result)
    return result


class EnvironmentalDataService:
    def get_environmental_data(self, lat: float, lon: float) -> Dict[str, Any]:
        cache_key = f'{round(lat, 4)},{round(lon, 4)}'
        cached = _cache_get(cache_key)
        if cached:
            return cached

        data_sources = {k: 'default' for k in DEFAULT_ENV}
        out = dict(DEFAULT_ENV)
        is_default = True

        # Weather (Open-Meteo)
        try:
            w = _fetch_open_meteo_weather(lat, lon)
            out['temperature'] = w['temperature']
            out['humidity'] = w['humidity']
            out['weather'] = w['weather']
            out['windSpeed'] = w['windSpeed']
            for k, src in w.get('sources', {}).items():
                data_sources[k] = src
            is_default = False
        except Exception as exc:
            print(f'[Open-Meteo] {lat},{lon}: {exc}')

        # Air quality (OpenAQ)
        try:
            aq = air_quality_service.get_air_quality_data(lat, lon)
            out['airQuality'] = float(aq.get('airQuality', DEFAULT_ENV['airQuality']))
            if not aq.get('isDefault'):
                data_sources['airQuality'] = 'OpenAQ'
                is_default = False
            else:
                data_sources['airQuality'] = 'OpenAQ-default'
        except Exception as exc:
            print(f'[OpenAQ] {lat},{lon}: {exc}')

        # Slope
        slope, slope_src = _fetch_slope(lat, lon)
        if slope is not None:
            out['slope'] = slope
            data_sources['slope'] = slope_src
            is_default = False

        # Noise
        noise, noise_src = _fetch_noise(lat, lon)
        if noise is not None:
            out['noise'] = noise
            data_sources['noise'] = noise_src
            is_default = False

        # Green space
        green, green_src = _fetch_green_space(lat, lon)
        if green is not None:
            out['greenSpace'] = green
            data_sources['greenSpace'] = green_src
            is_default = False

        result = {
            **out,
            'dataSources': data_sources,
            'isDefault': is_default,
            'timestamp': time.time(),
        }
        _cache_set(cache_key, result)
        return result

    def average_route_environment(
        self, start_lat: float, start_lon: float, end_lat: float, end_lon: float
    ) -> Dict[str, Any]:
        """Average environmental factors at route endpoints (for segment scoring)."""
        start = self.get_environmental_data(start_lat, start_lon)
        end = self.get_environmental_data(end_lat, end_lon)
        keys = list(DEFAULT_ENV.keys())
        averaged = {}
        for k in keys:
            averaged[k] = round((float(start[k]) + float(end[k])) / 2.0, 2)
        sources = {}
        for k in keys:
            s1 = start['dataSources'].get(k, 'default')
            s2 = end['dataSources'].get(k, 'default')
            sources[k] = s1 if s1 == s2 else f'{s1}+{s2}'
        return {
            **averaged,
            'dataSources': sources,
            'isDefault': start.get('isDefault') and end.get('isDefault'),
        }


environmental_data_service = EnvironmentalDataService()
