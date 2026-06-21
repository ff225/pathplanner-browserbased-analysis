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
import time
from typing import Any, Dict, Optional, Tuple

import requests

from .air_quality_service import air_quality_service

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


def _overpass_post(query: str) -> Optional[dict]:
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        **OVERPASS_HEADERS,
    }
    for base_url in OVERPASS_URLS:
        try:
            r = requests.post(
                base_url,
                data={'data': query},
                headers=headers,
                timeout=25,
            )
            if r.ok:
                return r.json()
            print(f'[overpass] {base_url} HTTP {r.status_code}')
        except Exception as exc:
            print(f'[overpass] {base_url}: {exc}')
    return None


def _fetch_noise(lat: float, lon: float) -> Tuple[Optional[float], str]:
    """Noise level 1–10 from OSM road/rail/industrial density (mirrors environmental.js)."""
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

    return min(10.0, max(1.0, noise_level)), 'OpenStreetMap-Overpass'


def _fetch_green_space(lat: float, lon: float) -> Tuple[Optional[float], str]:
    """Green-space score 1–10 from nearby parks/forests."""
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
}
POI_CATEGORIES = tuple(_POI_CATEGORIES.keys())
_MAX_POI_BBOX_SPAN = 0.25  # ~25 km guard against oversized Overpass queries


def _poi_kind(tags: Dict[str, Any], kind_keys) -> Optional[str]:
    for key in kind_keys:
        value = tags.get(key)
        if value:
            return value
    return None


def fetch_named_pois(
    category: str, min_lat: float, min_lon: float, max_lat: float, max_lon: float, limit: int = 120
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

    cache_key = f'pois:{category}:{round(min_lat,4)},{round(min_lon,4)},{round(max_lat,4)},{round(max_lon,4)}'
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    bbox = f'{min_lat},{min_lon},{max_lat},{max_lon}'
    body = ''.join(f'{f}({bbox});' for f in config['filters'])
    query = f'[out:json][timeout:25];({body});out tags center {int(limit)};'

    data = _overpass_post(query)
    pois = []
    seen_names = set()
    keep_unnamed = config['keep_unnamed_kinds']
    kind_keys = config['kind_keys']
    if data and isinstance(data.get('elements'), list):
        for element in data['elements']:
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
