"""Real pollen data from the Open-Meteo Air Quality API.

Open-Meteo publishes pollen as a gridded forecast (grains/m3) over Europe, free
and without an API key. Outside Europe / off-season the variables are null — in
that case we return an honest "unavailable" payload with null values, NEVER
random or synthetic data.

A single Open-Meteo grid cell (~11 km) represents the whole urban area, so one
call per selected city is enough; the heatmap spreads that real value spatially
for visualization without inventing new numbers.
"""

import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests


OPEN_METEO_AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
REQUEST_TIMEOUT = (5, 10)
CACHE_TTL_SECONDS = 15 * 60
GEO_CACHE_PRECISION = 2  # ~1.1 km grid; pollen is an areal product

# Open-Meteo hourly variable name -> friendly type key exposed to the frontend.
POLLEN_TYPES: Tuple[Tuple[str, str], ...] = (
    ('alder_pollen', 'alder'),
    ('birch_pollen', 'birch'),
    ('grass_pollen', 'grass'),
    ('mugwort_pollen', 'mugwort'),
    ('olive_pollen', 'olive'),
    ('ragweed_pollen', 'ragweed'),
)
POLLEN_UNIT = 'grains/m³'

_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def clear_pollen_cache() -> None:
    _CACHE.clear()


def get_pollen_data(lat: float, lon: float) -> Dict[str, Any]:
    """Return real Open-Meteo pollen for a coordinate (15-min geo-cached)."""
    cache_key = f"v1:{round(lat, GEO_CACHE_PRECISION)}:{round(lon, GEO_CACHE_PRECISION)}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    result = _fetch_pollen(lat, lon)
    _cache_set(cache_key, result)
    return result


def _fetch_pollen(lat: float, lon: float) -> Dict[str, Any]:
    hourly_variables = [open_meteo_name for open_meteo_name, _ in POLLEN_TYPES]
    try:
        response = requests.get(
            OPEN_METEO_AIR_QUALITY_URL,
            params={
                'latitude': lat,
                'longitude': lon,
                'hourly': ','.join(hourly_variables),
                'timezone': 'UTC',
                'forecast_days': 1,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        return _unavailable(lat, lon, f'Open-Meteo request failed: {exc.__class__.__name__}')
    except ValueError:
        return _unavailable(lat, lon, 'Open-Meteo returned invalid JSON')

    hourly = data.get('hourly') or {}
    units = data.get('hourly_units') or {}
    times = hourly.get('time') or []
    if not times:
        return _unavailable(lat, lon, 'Open-Meteo returned no hourly timestamps')

    index = _nearest_hour_index(times)
    timestamp = times[index] if index < len(times) else None

    pollen: Dict[str, Dict[str, Any]] = {}
    available_types: List[str] = []
    total = 0.0
    dominant: Optional[Dict[str, Any]] = None

    for open_meteo_name, type_key in POLLEN_TYPES:
        values = hourly.get(open_meteo_name) or []
        value = values[index] if index < len(values) else None
        unit = units.get(open_meteo_name) or POLLEN_UNIT
        if value is None:
            pollen[type_key] = {'value': None, 'unit': unit}
            continue

        numeric = _safe_float(value)
        pollen[type_key] = {'value': numeric, 'unit': unit}
        available_types.append(type_key)
        total += numeric
        if dominant is None or numeric > dominant['value']:
            dominant = {'type': type_key, 'value': numeric}

    has_data = bool(available_types) and total > 0
    provider_lat = _safe_float(data.get('latitude'), lat)
    provider_lon = _safe_float(data.get('longitude'), lon)

    return {
        'status': 'available' if has_data else 'unavailable',
        'lat': provider_lat,
        'lon': provider_lon,
        'provider': 'Open-Meteo Air Quality API',
        'unit': POLLEN_UNIT,
        'timestamp': timestamp,
        'pollen': pollen,
        'available_types': available_types,
        'total': round(total, 2),
        'dominant': dominant,
        'reason': None if has_data else 'no pollen reported for this area/time (off-season or outside Europe)',
    }


def _unavailable(lat: float, lon: float, reason: str) -> Dict[str, Any]:
    return {
        'status': 'unavailable',
        'lat': lat,
        'lon': lon,
        'provider': 'Open-Meteo Air Quality API',
        'unit': POLLEN_UNIT,
        'timestamp': None,
        'pollen': {type_key: {'value': None, 'unit': POLLEN_UNIT} for _, type_key in POLLEN_TYPES},
        'available_types': [],
        'total': 0.0,
        'dominant': None,
        'reason': reason,
    }


def _nearest_hour_index(timestamps: List[str]) -> int:
    target = datetime.now(timezone.utc)
    best_index = 0
    best_delta: Optional[float] = None
    for index, value in enumerate(timestamps):
        parsed = _parse_timestamp(value)
        if parsed is None:
            continue
        delta = abs((parsed - target).total_seconds())
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_index = index
    return best_index


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    cached = _CACHE.get(key)
    if not cached:
        return None
    timestamp, value = cached
    if time.time() - timestamp > CACHE_TTL_SECONDS:
        _CACHE.pop(key, None)
        return None
    return value


def _cache_set(key: str, value: Dict[str, Any]) -> None:
    _CACHE[key] = (time.time(), value)
