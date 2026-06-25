import concurrent.futures
import time
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests
from django.conf import settings


OPEN_METEO_AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
OPENAQ_LOCATIONS_URL = 'https://api.openaq.org/v3/locations'
# Explicit (connect, read) timeout so a slow/dead upstream can't hang the request.
REQUEST_TIMEOUT_SECONDS = (5, 10)
CACHE_TTL_SECONDS = 15 * 60
OPENAQ_RADIUS_M = 25_000
OPENAQ_LOCATION_LIMIT = 5
MAX_WAYPOINTS = 12
# Bound on concurrent per-waypoint env lookups (each does blocking HTTP I/O).
ENV_MAX_WORKERS = 8

OPEN_METEO_VARIABLES = (
    'european_aqi',
    'us_aqi',
    'pm10',
    'pm2_5',
    'carbon_monoxide',
    'nitrogen_dioxide',
    'sulphur_dioxide',
    'ozone',
    'alder_pollen',
    'birch_pollen',
    'grass_pollen',
    'mugwort_pollen',
    'olive_pollen',
    'ragweed_pollen',
)

POLLEN_VARIABLES = (
    'alder_pollen',
    'birch_pollen',
    'grass_pollen',
    'mugwort_pollen',
    'olive_pollen',
    'ragweed_pollen',
)

PATHOLOGY_ALIASES = {
    '': 'default',
    'none': 'default',
    'default': 'default',
    'standard': 'default',
    'respiratory': 'respiratory',
    'respiratory_condition': 'respiratory',
    'respiratoria': 'respiratory',
    'respiratorio': 'respiratory',
    'asthma': 'respiratory',
    'asma': 'respiratory',
    'allergy': 'allergy',
    'allergies': 'allergy',
    'allergia': 'allergy',
    'allergie': 'allergy',
    'cardiac': 'cardiac',
    'cardiopathy': 'cardiac',
    'cardiopatie': 'cardiac',
    'cardiopatia': 'cardiac',
    'cardiaca': 'cardiac',
    'cardiaco': 'cardiac',
    'copd': 'copd',
    'bpco': 'copd',
    'arthritis': 'arthritis',
    'mental': 'mental',
    'mental_health': 'mental',
    'mobility': 'mobility',
    'limited_mobility': 'mobility',
    'diabetes': 'diabetes',
    'diabete': 'diabetes',
}

PATHOLOGY_POLLUTANTS = {
    'default': ('pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide'),
    'respiratory': ('pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide'),
    'allergy': POLLEN_VARIABLES,
    'cardiac': ('pm2_5', 'carbon_monoxide', 'nitrogen_dioxide'),
    'copd': ('pm10', 'ozone', 'sulphur_dioxide'),
    'arthritis': ('pm2_5', 'ozone'),
    'mental': ('pm2_5', 'nitrogen_dioxide'),
    'mobility': ('pm10', 'nitrogen_dioxide'),
    'diabetes': ('pm2_5', 'nitrogen_dioxide', 'ozone'),
}

OPENAQ_PARAMETER_MAP = {
    'pm25': 'pm2_5',
    'pm2.5': 'pm2_5',
    'pm2_5': 'pm2_5',
    'pm10': 'pm10',
    'o3': 'ozone',
    'ozone': 'ozone',
    'no2': 'nitrogen_dioxide',
    'nitrogen_dioxide': 'nitrogen_dioxide',
    'so2': 'sulphur_dioxide',
    'sulphur_dioxide': 'sulphur_dioxide',
    'sulfur_dioxide': 'sulphur_dioxide',
    'co': 'carbon_monoxide',
    'carbon_monoxide': 'carbon_monoxide',
}

_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def clear_environment_cache() -> None:
    _CACHE.clear()


def normalize_pathologies(raw_pathologies: Any) -> List[str]:
    tokens: List[str] = []
    if raw_pathologies is None:
        tokens = ['default']
    elif isinstance(raw_pathologies, str):
        tokens = [part.strip() for part in raw_pathologies.split(',')]
    elif isinstance(raw_pathologies, Iterable):
        for item in raw_pathologies:
            if item is None:
                continue
            tokens.extend(str(item).split(','))
        tokens = [part.strip() for part in tokens]
    else:
        tokens = [str(raw_pathologies).strip()]

    normalized: List[str] = []
    unknown: List[str] = []
    for token in tokens:
        key = token.strip().lower().replace('-', '_').replace(' ', '_')
        pathology = PATHOLOGY_ALIASES.get(key)
        if not pathology:
            unknown.append(token)
            continue
        if pathology not in normalized:
            normalized.append(pathology)

    if unknown:
        raise ValueError(f"unknown pathologies: {', '.join(unknown)}")
    return normalized or ['default']


def relevant_pollutants(pathologies: Sequence[str]) -> List[str]:
    requested = {'european_aqi'}
    for pathology in pathologies:
        requested.update(PATHOLOGY_POLLUTANTS.get(pathology, PATHOLOGY_POLLUTANTS['default']))
    return [name for name in OPEN_METEO_VARIABLES if name in requested]


def build_environment_payload(
    waypoints: Sequence[Tuple[float, float]],
    raw_pathologies: Any,
) -> Dict[str, Any]:
    if not waypoints:
        raise ValueError('at least one lat/lon point is required')
    if len(waypoints) > MAX_WAYPOINTS:
        raise ValueError(f'a maximum of {MAX_WAYPOINTS} waypoints is supported')

    pathologies = normalize_pathologies(raw_pathologies)
    pollutants = relevant_pollutants(pathologies)
    points = _environment_for_points(waypoints, pollutants)
    available_points = [point for point in points if point['status'] == 'available']

    payload = {
        'status': 'available' if available_points else 'unavailable',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'pathologies': pathologies,
        'relevant_pollutants': pollutants,
        'points': points,
    }
    if len(points) == 1:
        payload['lat'] = points[0]['lat']
        payload['lon'] = points[0]['lon']
        payload['pollutants'] = points[0]['pollutants']
        payload['overall_aqi'] = points[0]['overall_aqi']
    return payload


def _environment_for_points(
    waypoints: Sequence[Tuple[float, float]],
    pollutants: Sequence[str],
) -> List[Dict[str, Any]]:
    """Fetch env data for every waypoint, parallelizing the blocking HTTP I/O.

    A single point stays inline (no thread pool) so the common one-point case
    keeps deterministic call ordering. For multiple points each lookup runs on
    its own thread; results are collected by submission index, so the returned
    list always matches the input waypoint order regardless of completion order.
    """
    if len(waypoints) == 1:
        lat, lon = waypoints[0]
        return [_environment_for_point(lat, lon, pollutants)]

    max_workers = min(ENV_MAX_WORKERS, len(waypoints))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(_environment_for_point, lat, lon, pollutants)
            for lat, lon in waypoints
        ]
        return [future.result() for future in futures]


def _environment_for_point(lat: float, lon: float, pollutants: Sequence[str]) -> Dict[str, Any]:
    cache_key = f"v1:{round(lat, 4)}:{round(lon, 4)}:{','.join(pollutants)}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    open_meteo = _fetch_open_meteo(lat, lon, pollutants)
    openaq = _fetch_openaq(lat, lon, pollutants)

    pollutant_payload: Dict[str, Dict[str, Any]] = {}
    for pollutant in pollutants:
        model_value = open_meteo.get(pollutant) or _unavailable(
            pollutant,
            'Open-Meteo Air Quality API',
            lat,
            lon,
            'Open-Meteo did not return this variable',
        )
        station_value = openaq.get(pollutant) or _unavailable(
            pollutant,
            'OpenAQ',
            lat,
            lon,
            'no nearby station measurement for this variable',
        )

        primary = model_value
        if primary['status'] != 'available' and station_value['status'] == 'available':
            primary = station_value.copy()

        pollutant_payload[pollutant] = {
            **primary,
            'model': model_value,
            'nearest_observation': station_value,
        }

    available = any(item['status'] == 'available' for item in pollutant_payload.values())
    result = {
        'status': 'available' if available else 'unavailable',
        'lat': lat,
        'lon': lon,
        'pollutants': pollutant_payload,
        'overall_aqi': pollutant_payload.get('european_aqi'),
        'sources': {
            'open_meteo': 'Open-Meteo Air Quality API',
            'openaq': 'OpenAQ v3 locations/latest',
        },
    }
    _cache_set(cache_key, result)
    return result


def _fetch_open_meteo(
    lat: float,
    lon: float,
    variables: Sequence[str],
) -> Dict[str, Dict[str, Any]]:
    try:
        response = requests.get(
            OPEN_METEO_AIR_QUALITY_URL,
            params={
                'latitude': lat,
                'longitude': lon,
                'current': ','.join(variables),
                'timezone': 'auto',
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        return {
            variable: _unavailable(
                variable,
                'Open-Meteo Air Quality API',
                lat,
                lon,
                f'Open-Meteo request failed: {exc.__class__.__name__}',
            )
            for variable in variables
        }
    except ValueError:
        return {
            variable: _unavailable(
                variable,
                'Open-Meteo Air Quality API',
                lat,
                lon,
                'Open-Meteo returned invalid JSON',
            )
            for variable in variables
        }

    current = data.get('current') or {}
    units = data.get('current_units') or {}
    timestamp = _open_meteo_timestamp(data)
    provider_lat = _safe_float(data.get('latitude'), lat)
    provider_lon = _safe_float(data.get('longitude'), lon)

    parsed: Dict[str, Dict[str, Any]] = {}
    for variable in variables:
        value = current.get(variable)
        if value is None:
            parsed[variable] = _unavailable(
                variable,
                'Open-Meteo Air Quality API',
                provider_lat,
                provider_lon,
                'variable unavailable for this coordinate/time',
                unit=units.get(variable),
                timestamp=timestamp,
            )
            continue

        parsed[variable] = {
            'key': variable,
            'value': value,
            'unit': units.get(variable),
            'source': 'Open-Meteo Air Quality API',
            'provider': 'Open-Meteo',
            'timestamp': timestamp,
            'lat': provider_lat,
            'lon': provider_lon,
            'status': 'available',
        }
    return parsed


def _fetch_openaq(
    lat: float,
    lon: float,
    variables: Sequence[str],
) -> Dict[str, Dict[str, Any]]:
    api_key = getattr(settings, 'OPENAQ_API_KEY', '')
    requested = {variable for variable in variables if variable != 'european_aqi' and variable not in POLLEN_VARIABLES}
    unavailable = {
        variable: _unavailable(
            variable,
            'OpenAQ',
            lat,
            lon,
            'OpenAQ does not publish this variable through nearby station observations'
            if variable in POLLEN_VARIABLES or variable == 'european_aqi'
            else 'no nearby station measurement for this variable',
        )
        for variable in variables
    }
    if not requested:
        return unavailable
    if not api_key:
        for variable in requested:
            unavailable[variable] = _unavailable(
                variable,
                'OpenAQ',
                lat,
                lon,
                'OPENAQ_API_KEY is not configured',
            )
        return unavailable

    headers = {'X-API-Key': api_key}
    try:
        locations_response = requests.get(
            OPENAQ_LOCATIONS_URL,
            params={
                'coordinates': f'{lat},{lon}',
                'radius': OPENAQ_RADIUS_M,
                'limit': OPENAQ_LOCATION_LIMIT,
            },
            headers=headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        locations_response.raise_for_status()
        locations = (locations_response.json().get('results') or [])
    except requests.RequestException as exc:
        for variable in requested:
            unavailable[variable] = _unavailable(
                variable,
                'OpenAQ',
                lat,
                lon,
                f'OpenAQ request failed: {exc.__class__.__name__}',
            )
        return unavailable
    except ValueError:
        for variable in requested:
            unavailable[variable] = _unavailable(variable, 'OpenAQ', lat, lon, 'OpenAQ returned invalid JSON')
        return unavailable

    observations = dict(unavailable)
    for location in locations:
        missing = requested - {
            variable for variable, item in observations.items() if item.get('status') == 'available'
        }
        if not missing:
            break

        location_id = location.get('id')
        if not location_id:
            continue
        sensor_map = {
            sensor.get('id'): sensor
            for sensor in (location.get('sensors') or [])
            if sensor.get('id') is not None
        }
        try:
            latest_response = requests.get(
                f'{OPENAQ_LOCATIONS_URL}/{location_id}/latest',
                headers=headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            latest_response.raise_for_status()
            latest = latest_response.json().get('results') or []
        except (requests.RequestException, ValueError):
            continue

        for measurement in latest:
            sensor = sensor_map.get(measurement.get('sensorsId'))
            parameter = (sensor or {}).get('parameter') or {}
            canonical = _canonical_openaq_parameter(parameter.get('name'))
            if canonical not in missing:
                continue
            value = measurement.get('value')
            if value is None:
                continue
            coordinates = measurement.get('coordinates') or location.get('coordinates') or {}
            station_lat = _safe_float(coordinates.get('latitude'), lat)
            station_lon = _safe_float(coordinates.get('longitude'), lon)
            observations[canonical] = {
                'key': canonical,
                'value': value,
                'unit': parameter.get('units'),
                'source': 'OpenAQ',
                'provider': 'OpenAQ',
                'timestamp': _openaq_timestamp(measurement),
                'lat': station_lat,
                'lon': station_lon,
                'status': 'available',
                'station': {
                    'id': location_id,
                    'name': location.get('name'),
                    'distance_m': location.get('distance'),
                },
            }
    return observations


def _canonical_openaq_parameter(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    return OPENAQ_PARAMETER_MAP.get(name.lower().replace(' ', '_'))


def _open_meteo_timestamp(data: Dict[str, Any]) -> Optional[str]:
    current = data.get('current') or {}
    value = current.get('time')
    if not value:
        return None
    try:
        offset = int(data.get('utc_offset_seconds') or 0)
        return datetime.fromisoformat(value).replace(
            tzinfo=timezone(timedelta(seconds=offset))
        ).isoformat()
    except (TypeError, ValueError):
        return value


def _openaq_timestamp(measurement: Dict[str, Any]) -> Optional[str]:
    datetime_value = measurement.get('datetime') or {}
    return datetime_value.get('utc') or datetime_value.get('local')


def _unavailable(
    key: str,
    source: str,
    lat: float,
    lon: float,
    reason: str,
    unit: Optional[str] = None,
    timestamp: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        'key': key,
        'value': None,
        'unit': unit,
        'source': source,
        'provider': source.split()[0],
        'timestamp': timestamp,
        'lat': lat,
        'lon': lon,
        'status': 'unavailable',
        'reason': reason,
    }


def _safe_float(value: Any, fallback: float) -> float:
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
