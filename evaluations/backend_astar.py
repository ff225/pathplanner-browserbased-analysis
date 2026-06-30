"""Backend street-graph Environmental A*.

This module is the production-oriented path for A*: the browser should ask the
backend for real OSM street-graph candidates, then render the returned waypoints.
External I/O (street graph, POIs, environmental seed samples, route scoring) is
bounded and parallelized here; the actual A* expansion remains sequential because
each pop from the priority queue depends on the current best frontier.
"""

from __future__ import annotations

import concurrent.futures
import heapq
import math
import os
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import requests

from .environmental_astar import (
    PATIENT_CONDITIONS,
    apply_preference_poi_adjustment,
    haversine_m,
    precompute_poi_distances,
    tolerance_green_scale,
    tolerance_padding_deg,
)
from .air_quality_service import air_quality_service
from .environmental_data_service import (
    _fetch_open_meteo_weather,
    _fetch_slope,
    fetch_named_pois,
    fetch_street_graph,
)
from .local_osm_poi_service import fetch_local_walkability_features
from .routing_regions import select_region_for_points


BACKEND_ASTAR_MAX_EXPANSIONS = int(os.getenv('BACKEND_ASTAR_MAX_EXPANSIONS', '20000'))
BACKEND_ASTAR_ENV_WORKERS = int(os.getenv('BACKEND_ASTAR_ENV_WORKERS', '4'))
BACKEND_ASTAR_IO_WORKERS = int(os.getenv('BACKEND_ASTAR_IO_WORKERS', '8'))
BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS = float(os.getenv('BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS', '18'))
BACKEND_ASTAR_MAX_ENV_SAMPLES = int(os.getenv('BACKEND_ASTAR_MAX_ENV_SAMPLES', '9'))
BACKEND_ASTAR_ENV_RADIUS_M = float(os.getenv('BACKEND_ASTAR_ENV_RADIUS_M', '1800'))
BACKEND_ASTAR_ENDPOINT_SNAP_M = float(os.getenv('BACKEND_ASTAR_ENDPOINT_SNAP_M', '2000'))
BACKEND_ASTAR_MAX_ALTERNATIVE_ATTEMPTS = int(os.getenv('BACKEND_ASTAR_MAX_ALT_ATTEMPTS', '5'))
BACKEND_ASTAR_OVERPASS_MAX_MIRRORS = int(os.getenv('BACKEND_ASTAR_OVERPASS_MAX_MIRRORS', '1'))
BACKEND_ASTAR_STREET_TIMEOUT_SECONDS = float(os.getenv('BACKEND_ASTAR_STREET_TIMEOUT_SECONDS', '6'))
BACKEND_ASTAR_POI_TIMEOUT_SECONDS = float(os.getenv('BACKEND_ASTAR_POI_TIMEOUT_SECONDS', '4'))
BACKEND_ASTAR_ENV_CACHE_TTL_SECONDS = float(os.getenv('BACKEND_ASTAR_ENV_CACHE_TTL_SECONDS', '600'))
BACKEND_ASTAR_ENV_CACHE_PRECISION = int(os.getenv('BACKEND_ASTAR_ENV_CACHE_PRECISION', '3'))
BACKEND_ASTAR_WALKABILITY_RADIUS_M = float(os.getenv('BACKEND_ASTAR_WALKABILITY_RADIUS_M', '35'))
GRAPHHOPPER_URL = (os.getenv('GRAPHHOPPER_URL') or '').rstrip('/')
GRAPHHOPPER_API_KEY = os.getenv('GRAPHHOPPER_API_KEY') or ''
GRAPHHOPPER_TIMEOUT_SECONDS = float(os.getenv('GRAPHHOPPER_TIMEOUT_SECONDS', '8'))
GRAPHHOPPER_FORCE = os.getenv('GRAPHHOPPER_FORCE', '').lower() in ('1', 'true', 'yes')

POI_CATEGORIES = ('nature', 'entertainment', 'nightlife', 'tourism', 'hospital')
WALKABILITY_FEATURE_CATEGORIES = ('steps', 'incline', 'surface', 'smoothness', 'wheelchair')
_BACKEND_ENV_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def normalize_transport_mode(mode: Optional[str]) -> str:
    if mode in ('driving', 'car'):
        return 'car'
    if mode == 'cycling':
        return 'cycling'
    return 'walking'


def _graphhopper_profile(mode: str) -> str:
    normalized = normalize_transport_mode(mode)
    if normalized == 'car':
        return os.getenv('GRAPHHOPPER_PROFILE_CAR', 'car')
    if normalized == 'cycling':
        return os.getenv('GRAPHHOPPER_PROFILE_CYCLING', 'bike')
    return os.getenv('GRAPHHOPPER_PROFILE_WALKING', 'foot')


def _street_node_id(node: Dict[str, Any]) -> str:
    return str(node.get('_street_id') or node.get('id'))


def _geo_node_id(node: Dict[str, Any]) -> str:
    return f"{node['lat']:.6f},{node['lon']:.6f}"


def _route_bbox(
    start: Dict[str, float],
    goal: Dict[str, float],
    distance_tolerance: float,
) -> Dict[str, float]:
    pad = tolerance_padding_deg(distance_tolerance)
    return {
        'min_lat': min(start['lat'], goal['lat']) - pad,
        'min_lon': min(start['lon'], goal['lon']) - pad,
        'max_lat': max(start['lat'], goal['lat']) + pad,
        'max_lon': max(start['lon'], goal['lon']) + pad,
    }


def _active_poi_categories(
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
) -> List[str]:
    prefs = preferences or {}
    active = []
    for category in POI_CATEGORIES:
        patient_key = 'patient' + category.capitalize()
        if (patient.get(patient_key, 0) or 0) + (prefs.get(category, 0) or 0) != 0:
            active.append(category)
    return active


def _fetch_poi_lists_parallel(
    bbox: Dict[str, float],
    categories: Sequence[str],
    max_workers: int = BACKEND_ASTAR_IO_WORKERS,
    timeout: float = BACKEND_ASTAR_POI_TIMEOUT_SECONDS,
    max_mirrors: int = BACKEND_ASTAR_OVERPASS_MAX_MIRRORS,
) -> Tuple[Dict[str, List[Tuple[float, float]]], Dict[str, str]]:
    if not categories:
        return {}, {}

    def fetch_category(category: str) -> Tuple[str, List[Tuple[float, float]], str]:
        if category == 'nature':
            service_category = 'parks'
        elif category == 'hospital':
            service_category = 'hospitals'
        else:
            service_category = category
        payload = fetch_named_pois(
            service_category,
            bbox['min_lat'],
            bbox['min_lon'],
            bbox['max_lat'],
            bbox['max_lon'],
            timeout=timeout,
            max_mirrors=max_mirrors,
        )
        pois = [
            (float(poi['lat']), float(poi['lon']))
            for poi in payload.get('pois', [])
            if poi.get('lat') is not None and poi.get('lon') is not None
        ]
        return category, pois, payload.get('source') or 'unknown'

    out: Dict[str, List[Tuple[float, float]]] = {}
    sources: Dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(categories))) as executor:
        futures = [executor.submit(fetch_category, category) for category in categories]
        for future in concurrent.futures.as_completed(futures):
            try:
                category, pois, source = future.result()
                out[category] = pois
                sources[category] = source
            except Exception:
                # Missing POIs should reduce preference influence, not fail routing.
                continue
    return out, sources


def _fetch_walkability_features(
    bbox: Dict[str, float],
    limit: int = 900,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    try:
        payload = fetch_local_walkability_features(
            bbox['min_lat'],
            bbox['min_lon'],
            bbox['max_lat'],
            bbox['max_lon'],
            limit=limit,
        )
    except Exception:
        return [], None
    if not payload:
        return [], None
    features = [
        feature
        for feature in payload.get('features', [])
        if feature.get('lat') is not None and feature.get('lon') is not None
    ]
    return features, payload.get('source')


def _parse_incline_percent(kind: Optional[str]) -> Optional[float]:
    if not kind:
        return None
    raw = str(kind).strip().lower()
    if raw in {'up', 'down'}:
        return 8.0
    if raw in {'steep', 'very_steep'}:
        return 12.0
    if raw.endswith('%'):
        raw = raw[:-1]
    try:
        value = abs(float(raw))
    except ValueError:
        return None
    return min(25.0, value)


_BAD_SURFACES = {
    'cobblestone',
    'sett',
    'unpaved',
    'gravel',
    'fine_gravel',
    'dirt',
    'earth',
    'ground',
    'mud',
    'sand',
    'grass',
}
_BAD_SMOOTHNESS = {'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'}


def _walkability_feature_penalty(
    feature: Dict[str, Any],
    distance_m: float,
    patient: Dict[str, Any],
    mode: str,
) -> float:
    if mode == 'car' or distance_m > BACKEND_ASTAR_WALKABILITY_RADIUS_M:
        return 0.0
    category = str(feature.get('category') or '')
    kind = str(feature.get('kind') or '').lower()
    patient_name = patient.get('name')
    slope_mult = patient.get('slopeSensitivity', 1) or 1
    proximity = max(0.0, 1.0 - distance_m / max(1.0, BACKEND_ASTAR_WALKABILITY_RADIUS_M))
    penalty = 0.0

    if category == 'steps':
        penalty = 95.0
        if patient_name == 'arthritis':
            penalty += 30.0
        elif patient_name == 'mobility':
            penalty += 45.0
        elif patient_name == 'cardiac':
            penalty += 20.0
    elif category == 'incline':
        incline = _parse_incline_percent(kind) or 6.0
        penalty = (incline ** 1.5) * max(1.0, slope_mult) / 2.5
    elif category == 'surface' and kind in _BAD_SURFACES:
        penalty = 28.0
        if patient_name in {'mobility', 'arthritis'}:
            penalty += 24.0
    elif category == 'smoothness' and kind in _BAD_SMOOTHNESS:
        penalty = 32.0
        if patient_name in {'mobility', 'arthritis'}:
            penalty += 28.0
    elif category == 'wheelchair' and kind in {'no', 'limited'}:
        penalty = 45.0 if kind == 'no' else 22.0
        if patient_name == 'mobility':
            penalty *= 1.6
    return penalty * proximity


def _walkability_penalty_for_point(
    point: Dict[str, float],
    features: Sequence[Dict[str, Any]],
    patient: Dict[str, Any],
    mode: str,
) -> Tuple[float, List[Dict[str, Any]]]:
    total = 0.0
    hits = []
    for feature in features:
        distance_m = haversine_m(point, {'lat': float(feature['lat']), 'lon': float(feature['lon'])})
        penalty = _walkability_feature_penalty(feature, distance_m, patient, mode)
        if penalty <= 0:
            continue
        total += penalty
        if len(hits) < 5:
            hits.append({
                'category': feature.get('category'),
                'kind': feature.get('kind'),
                'distance_m': round(distance_m),
                'penalty': round(penalty, 1),
            })
    return total, hits


def _score_walkability_for_path(
    path: Sequence[Dict[str, float]],
    features: Sequence[Dict[str, Any]],
    patient: Dict[str, Any],
    mode: str,
) -> Tuple[float, Dict[str, Any]]:
    if not path or not features:
        return 0.0, {'penalty': 0.0, 'hits': [], 'feature_count': len(features or [])}
    total = 0.0
    hits: List[Dict[str, Any]] = []
    step = max(1, len(path) // 80)
    for point in path[::step]:
        point_penalty, point_hits = _walkability_penalty_for_point(point, features, patient, mode)
        total += point_penalty
        for hit in point_hits:
            if len(hits) >= 8:
                break
            hits.append(hit)
    return total, {
        'penalty': round(total, 1),
        'hits': hits,
        'feature_count': len(features),
    }


def _build_street_graph(payload: Dict[str, Any]) -> Dict[str, Any]:
    mode = normalize_transport_mode(payload.get('mode'))
    node_map: Dict[str, Dict[str, Any]] = {}
    adjacency: Dict[str, List[Dict[str, Any]]] = {}

    for raw in payload.get('nodes') or []:
        node_id = str(raw.get('id'))
        lat = _safe_float(raw.get('lat'))
        lon = _safe_float(raw.get('lon'))
        if not node_id or lat is None or lon is None:
            continue
        node = {'lat': lat, 'lon': lon, '_street_id': node_id}
        node_map[node_id] = node
        adjacency.setdefault(node_id, [])

    for way in payload.get('ways') or []:
        refs = [str(ref) for ref in (way.get('nodes') or [])]
        oneway = str(way.get('oneway') or '').lower()
        respect_oneway = mode == 'car'
        for i in range(len(refs) - 1):
            a = node_map.get(refs[i])
            b = node_map.get(refs[i + 1])
            if not a or not b:
                continue
            distance = haversine_m(a, b)
            if not math.isfinite(distance) or distance <= 0:
                continue
            edge = {
                'node': b,
                'distance': distance,
                'way_id': way.get('id'),
                'highway': way.get('highway'),
                'name': way.get('name'),
            }
            adjacency[_street_node_id(a)].append(edge)
            if not respect_oneway or oneway not in ('yes', '1', 'true'):
                reverse = dict(edge)
                reverse['node'] = a
                adjacency[_street_node_id(b)].append(reverse)

    nodes = list(node_map.values())
    edge_count = sum(len(edges) for edges in adjacency.values())
    if len(nodes) < 2 or edge_count == 0:
        raise ValueError('street graph has no connected road edges')

    return {
        'nodes': nodes,
        'node_map': node_map,
        'adjacency': adjacency,
        'mode': mode,
        'source': payload.get('source') or 'OpenStreetMap-Overpass',
        'count': payload.get('count') or {'nodes': len(nodes), 'edges': edge_count},
    }


def _nearest_nodes(
    point: Dict[str, float],
    nodes: Sequence[Dict[str, Any]],
    max_count: int = 32,
    max_snap_m: float = BACKEND_ASTAR_ENDPOINT_SNAP_M,
) -> List[Dict[str, Any]]:
    candidates = []
    for node in nodes:
        distance = haversine_m(point, node)
        if math.isfinite(distance) and distance <= max_snap_m:
            candidates.append({'node': node, 'distance': distance})
    candidates.sort(key=lambda item: item['distance'])
    return candidates[:max_count]


def _graph_components(adjacency: Dict[str, List[Dict[str, Any]]]) -> Tuple[Dict[str, int], Dict[int, int]]:
    component_by_node: Dict[str, int] = {}
    component_sizes: Dict[int, int] = {}
    component_id = 0
    for node_id in adjacency:
        if node_id in component_by_node:
            continue
        stack = [node_id]
        component_by_node[node_id] = component_id
        size = 0
        while stack:
            current = stack.pop()
            size += 1
            for edge in adjacency.get(current, []):
                next_id = _street_node_id(edge['node'])
                if next_id not in component_by_node:
                    component_by_node[next_id] = component_id
                    stack.append(next_id)
        component_sizes[component_id] = size
        component_id += 1
    return component_by_node, component_sizes


def _select_shared_snaps(
    start: Dict[str, float],
    goal: Dict[str, float],
    nodes: Sequence[Dict[str, Any]],
    adjacency: Dict[str, List[Dict[str, Any]]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    component_by_node, component_sizes = _graph_components(adjacency)
    start_candidates = _nearest_nodes(start, nodes)
    goal_candidates = _nearest_nodes(goal, nodes)
    best_component = None
    best_score = float('inf')

    for s in start_candidates:
        s_component = component_by_node.get(_street_node_id(s['node']))
        if s_component is None:
            continue
        for g in goal_candidates:
            g_component = component_by_node.get(_street_node_id(g['node']))
            if s_component != g_component:
                continue
            score = s['distance'] + g['distance'] - min(component_sizes.get(s_component, 0), 20000) / 100
            if score < best_score:
                best_score = score
                best_component = s_component

    if best_component is None:
        raise ValueError('no connected OSM component near both endpoints')

    start_snaps = [
        candidate for candidate in start_candidates
        if component_by_node.get(_street_node_id(candidate['node'])) == best_component
    ][:8]
    goal_snaps = [
        candidate for candidate in goal_candidates
        if component_by_node.get(_street_node_id(candidate['node'])) == best_component
    ][:8]
    return start_snaps, goal_snaps


def _instantiate_with_endpoints(
    graph: Dict[str, Any],
    start: Dict[str, float],
    goal: Dict[str, float],
) -> Dict[str, Any]:
    node_map = dict(graph['node_map'])
    adjacency = {node_id: list(edges) for node_id, edges in graph['adjacency'].items()}
    nodes = list(graph['nodes'])
    start_snaps, goal_snaps = _select_shared_snaps(start, goal, nodes, adjacency)

    def connect(endpoint: Dict[str, float], node_id: str, snaps: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        endpoint_node = {'lat': endpoint['lat'], 'lon': endpoint['lon'], '_street_id': node_id}
        node_map[node_id] = endpoint_node
        adjacency[node_id] = []
        for snap in snaps:
            snap_node = snap['node']
            edge_to_snap = {
                'node': snap_node,
                'distance': snap['distance'],
                'way_id': 'endpoint',
                'highway': 'endpoint',
                'name': None,
            }
            adjacency[node_id].append(edge_to_snap)
            adjacency.setdefault(_street_node_id(snap_node), []).append({
                **edge_to_snap,
                'node': endpoint_node,
            })
        return endpoint_node

    start_node = connect(start, '__start__', start_snaps)
    goal_node = connect(goal, '__goal__', goal_snaps)
    return {
        **graph,
        'node_map': node_map,
        'adjacency': adjacency,
        'nodes': nodes + [start_node, goal_node],
        'start_node': start_node,
        'goal_node': goal_node,
    }


def _sample_environment_points(
    start: Dict[str, float],
    goal: Dict[str, float],
    max_samples: int = BACKEND_ASTAR_MAX_ENV_SAMPLES,
) -> List[Dict[str, float]]:
    route_distance = haversine_m(start, goal)
    if route_distance <= 3000:
        max_samples = min(max_samples, 3)
    elif route_distance <= 8000:
        max_samples = min(max_samples, 5)
    mid = {'lat': (start['lat'] + goal['lat']) / 2, 'lon': (start['lon'] + goal['lon']) / 2}
    points = [start, mid, goal]
    if max_samples <= 3:
        return points[:max_samples]
    lat_pad = abs(start['lat'] - goal['lat']) / 4 or 0.006
    lon_pad = abs(start['lon'] - goal['lon']) / 4 or 0.006
    for lat_offset, lon_offset in ((lat_pad, 0), (-lat_pad, 0), (0, lon_pad), (0, -lon_pad), (lat_pad, lon_pad), (-lat_pad, -lon_pad)):
        if len(points) >= max_samples:
            break
        points.append({'lat': mid['lat'] + lat_offset, 'lon': mid['lon'] + lon_offset})
    return points


def reset_backend_astar_state() -> None:
    """Reset in-memory backend A* caches. Test/maintenance hook."""
    _BACKEND_ENV_CACHE.clear()


def _backend_env_cache_key(lat: float, lon: float) -> str:
    return f'{round(lat, BACKEND_ASTAR_ENV_CACHE_PRECISION)},{round(lon, BACKEND_ASTAR_ENV_CACHE_PRECISION)}'


def _copy_env_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    copied = dict(payload)
    copied['dataSources'] = dict(payload.get('dataSources') or {})
    return copied


def _fetch_backend_environment_data(lat: float, lon: float) -> Dict[str, Any]:
    """Fast real-only environmental snapshot for interactive backend A*.

    This intentionally skips per-point Overpass noise/green lookups. OSM green
    influence enters through the route-corridor POI fetch, and street class
    influence enters through the graph edge metadata. Missing fields stay
    ``None`` instead of being filled with synthetic defaults.
    """
    cache_key = _backend_env_cache_key(lat, lon)
    cached = _BACKEND_ENV_CACHE.get(cache_key)
    if cached and time.time() - cached[0] <= BACKEND_ASTAR_ENV_CACHE_TTL_SECONDS:
        out = _copy_env_payload(cached[1])
        out['cacheHit'] = True
        return out

    out: Dict[str, Any] = {
        'temperature': None,
        'humidity': None,
        'weather': None,
        'windSpeed': None,
        'airQuality': None,
        'slope': None,
        'noise': None,
        'greenSpace': None,
        'dataSources': {},
        'isDefault': True,
        'timestamp': time.time(),
    }

    try:
        weather = _fetch_open_meteo_weather(lat, lon)
        for key in ('temperature', 'humidity', 'weather', 'windSpeed'):
            out[key] = weather.get(key)
        out['dataSources'].update(weather.get('sources') or {})
        out['isDefault'] = False
    except Exception as exc:
        print(f'[backend_astar weather] {lat},{lon}: {exc}')

    try:
        air = air_quality_service.get_air_quality_data(lat, lon)
        if not air.get('isDefault') and air.get('airQuality') is not None:
            out['airQuality'] = float(air['airQuality'])
            out['dataSources']['airQuality'] = air.get('source') or 'OpenAQ'
            out['isDefault'] = False
    except Exception as exc:
        print(f'[backend_astar air] {lat},{lon}: {exc}')

    try:
        slope, slope_source = _fetch_slope(lat, lon)
        if slope is not None:
            out['slope'] = slope
            out['dataSources']['slope'] = slope_source
            out['isDefault'] = False
    except Exception as exc:
        print(f'[backend_astar slope] {lat},{lon}: {exc}')

    out['cacheHit'] = False
    out['cacheKey'] = cache_key
    _BACKEND_ENV_CACHE[cache_key] = (time.time(), _copy_env_payload(out))
    return out


def _prefetch_environment_samples(
    start: Dict[str, float],
    goal: Dict[str, float],
    max_workers: int = BACKEND_ASTAR_ENV_WORKERS,
) -> List[Dict[str, Any]]:
    points = _sample_environment_points(start, goal)

    def fetch(point: Dict[str, float]) -> Optional[Dict[str, Any]]:
        try:
            env = _fetch_backend_environment_data(point['lat'], point['lon'])
        except Exception:
            return None
        return {
            'lat': point['lat'],
            'lon': point['lon'],
            'env': env,
        }

    samples = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(points))) as executor:
        for result in executor.map(fetch, points):
            if result:
                samples.append(result)
    return samples


def _nearest_env(node: Dict[str, float], samples: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    best = None
    best_distance = float('inf')
    for sample in samples:
        distance = haversine_m(node, sample)
        if distance < best_distance:
            best = sample
            best_distance = distance
    if best and best_distance <= BACKEND_ASTAR_ENV_RADIUS_M:
        return best['env']
    return None


def _aggregate_env_sources(samples: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    sources: Dict[str, str] = {}
    for sample in samples:
        for key, source in (sample.get('env') or {}).get('dataSources', {}).items():
            if source and source != 'default':
                sources[key] = source
    return sources


def _street_edge_penalty(edge: Optional[Dict[str, Any]], patient: Dict[str, Any], preferences: Optional[Dict[str, float]], green_scale: float) -> float:
    if not edge or not edge.get('highway') or patient.get('name') == 'default':
        return 0.0
    highway = str(edge.get('highway'))
    patient_name = patient.get('name')
    penalty = 0.0
    if highway in ('motorway', 'trunk', 'primary'):
        penalty += (patient.get('airQualitySensitivity') or 1) * 1.6
        penalty += (patient.get('noiseSensitivity') or 1) * 0.9
    elif highway in ('secondary', 'tertiary'):
        penalty += (patient.get('airQualitySensitivity') or 1) * 0.8
        penalty += (patient.get('noiseSensitivity') or 1) * 0.4
    if highway == 'steps':
        if patient_name == 'mobility':
            penalty += 80
        elif patient_name == 'arthritis':
            penalty += 55
        elif patient_name == 'cardiac':
            penalty += 35
        elif patient_name == 'respiratory':
            penalty += 20
    if highway in ('footway', 'pedestrian', 'path', 'living_street', 'cycleway'):
        nature_weight = (patient.get('patientNature') or 0) + ((preferences or {}).get('nature') or 0)
        penalty -= max(0, nature_weight) * 0.35 * green_scale
    return penalty


def _calculate_edge_cost(
    current: Dict[str, Any],
    edge: Dict[str, Any],
    current_g: float,
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
    poi_distances: Optional[Dict[str, Dict[str, Optional[float]]]],
    env_samples: Sequence[Dict[str, Any]],
    node_penalties: Dict[str, float],
    green_scale: float,
    walkability_features: Optional[Sequence[Dict[str, Any]]] = None,
    mode: str = 'walking',
) -> float:
    neighbor = edge['node']
    distance = edge.get('distance') or haversine_m(current, neighbor)
    penalty = _street_edge_penalty(edge, patient, preferences, green_scale)
    env = _nearest_env(neighbor, env_samples)

    if env and patient.get('name') != 'default':
        aq_mult = patient.get('airQualitySensitivity', 1) or 1
        slope_mult = patient.get('slopeSensitivity', 1) or 1
        noise_mult = patient.get('noiseSensitivity', 1) or 1
        temp_mult = patient.get('temperatureSensitivity', 1) or 1
        hum_mult = patient.get('humiditySensitivity', 1) or 1

        aq = _safe_float(env.get('airQuality'))
        if aq is not None:
            penalty += (max(0.0, aq - 4.0) ** 2) * aq_mult
        slope = _safe_float(env.get('slope'))
        if slope is not None:
            penalty += (abs(slope) ** 2) * slope_mult / 5.0
        noise = _safe_float(env.get('noise'))
        if noise is not None:
            penalty += max(0.0, noise - 3.0) * noise_mult
        temp = _safe_float(env.get('temperature'))
        if temp is not None:
            penalty += abs(temp - 22.0) * temp_mult / 3.0
        humidity = _safe_float(env.get('humidity'))
        if humidity is not None:
            penalty += abs(humidity - 50.0) * hum_mult / 10.0

        green = _safe_float(env.get('greenSpace'))
        green_visibility = max(0.0, min(1.0, (green or 0.0) / 10.0))
        traffic_density = max(0.0, min(1.0, ((aq or 5.0) - 3.0) / 7.0))
        emergency_access = max(0.0, min(1.0, 1.0 - (green or 3.0) / 10.0))

        if patient.get('name') == 'respiratory':
            penalty += traffic_density * aq_mult * 10.0
            penalty -= green_visibility * 5.0 * green_scale
        elif patient.get('name') == 'cardiac':
            if slope is not None:
                penalty += (abs(slope) ** 2) * slope_mult / 2.0
            penalty += emergency_access * 2.0
        elif patient.get('name') == 'mobility' and slope is not None:
            penalty += (abs(slope) ** 2.5) * slope_mult
        elif patient.get('name') == 'mental' and noise is not None:
            penalty += (noise ** 1.5) * noise_mult
            penalty -= green_visibility * 8.0 * green_scale

        prefs = preferences or {}
        combined_nature = (patient.get('patientNature') or 0) + (prefs.get('nature') or 0)
        combined_hospital = (patient.get('patientHospital') or 0) + (prefs.get('hospital') or 0)
        combined_entertainment = (patient.get('patientEntertainment') or 0) + (prefs.get('entertainment') or 0)
        combined_nightlife = (patient.get('patientNightlife') or 0) + (prefs.get('nightlife') or 0)
        combined_tourism = (patient.get('patientTourism') or 0) + (prefs.get('tourism') or 0)
        penalty -= green_visibility * combined_nature * 0.8 * green_scale
        penalty -= emergency_access * combined_hospital * 0.8
        if noise is not None:
            penalty -= (noise / 10) * combined_entertainment * 0.8
            penalty -= (noise / 10) * combined_nightlife * 0.8
        penalty -= green_visibility * combined_tourism * 0.8 * green_scale

    distances = (poi_distances or {}).get(_geo_node_id(neighbor), {})
    for category in POI_CATEGORIES:
        patient_key = 'patient' + category.capitalize()
        weight = (patient.get(patient_key) or 0) + ((preferences or {}).get(category) or 0)
        if weight:
            penalty = apply_preference_poi_adjustment(penalty, weight, distances.get(category))

    walkability_penalty, _ = _walkability_penalty_for_point(
        neighbor,
        walkability_features or [],
        patient,
        mode,
    )
    penalty += walkability_penalty
    penalty += node_penalties.get(_street_node_id(neighbor), 0.0)
    edge_scale = max(0.25, distance / 100.0)
    return current_g + distance + max(0.0, penalty) * edge_scale


def _reconstruct_path(came_from: Dict[str, Dict[str, Any]], current: Dict[str, Any]) -> List[Dict[str, float]]:
    path = [{'lat': current['lat'], 'lon': current['lon']}]
    current_id = _street_node_id(current)
    while current_id in came_from:
        current = came_from[current_id]
        path.insert(0, {'lat': current['lat'], 'lon': current['lon']})
        current_id = _street_node_id(current)
    return path


def _street_graph_astar(
    graph: Dict[str, Any],
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
    poi_distances: Optional[Dict[str, Dict[str, Optional[float]]]],
    env_samples: Sequence[Dict[str, Any]],
    node_penalties: Optional[Dict[str, float]] = None,
    green_scale: float = 1.0,
    walkability_features: Optional[Sequence[Dict[str, Any]]] = None,
    mode: str = 'walking',
) -> Optional[Dict[str, Any]]:
    start_node = graph['start_node']
    goal_node = graph['goal_node']
    goal_id = _street_node_id(goal_node)
    node_penalties = node_penalties or {}

    open_heap: List[Tuple[float, int, Dict[str, Any]]] = []
    came_from: Dict[str, Dict[str, Any]] = {}
    g_score = {_street_node_id(start_node): 0.0}
    closed: Set[str] = set()
    counter = 0
    heapq.heappush(open_heap, (haversine_m(start_node, goal_node), counter, start_node))
    counter += 1
    expansions = 0

    while open_heap and expansions < BACKEND_ASTAR_MAX_EXPANSIONS:
        _, _, current = heapq.heappop(open_heap)
        current_id = _street_node_id(current)
        if current_id in closed:
            continue
        expansions += 1
        if current_id == goal_id:
            return {
                'path': _reconstruct_path(came_from, current),
                'astar_cost': g_score[current_id],
                'goal_reached': True,
                'expansions': expansions,
            }
        closed.add(current_id)

        for edge in graph['adjacency'].get(current_id, []):
            neighbor = edge['node']
            neighbor_id = _street_node_id(neighbor)
            if neighbor_id in closed:
                continue
            tentative = _calculate_edge_cost(
                current,
                edge,
                g_score[current_id],
                patient,
                preferences,
                poi_distances,
                env_samples,
                node_penalties,
                green_scale,
                walkability_features,
                mode,
            )
            if tentative < g_score.get(neighbor_id, float('inf')):
                came_from[neighbor_id] = current
                g_score[neighbor_id] = tentative
                priority = tentative + haversine_m(neighbor, goal_node)
                heapq.heappush(open_heap, (priority, counter, neighbor))
                counter += 1
    return None


def _path_signature(path: Sequence[Dict[str, float]], precision: int = 5) -> str:
    deduped = []
    for point in path:
        key = f"{point['lat']:.{precision}f},{point['lon']:.{precision}f}"
        if not deduped or deduped[-1] != key:
            deduped.append(key)
    return '|'.join(deduped)


def _path_overlap_ratio(
    path: Sequence[Dict[str, float]],
    other: Sequence[Dict[str, float]],
    threshold_m: float = 35.0,
) -> float:
    if not path or not other:
        return 0.0
    shorter, longer = (path, other) if len(path) <= len(other) else (other, path)
    step = max(1, len(shorter) // 80)
    sampled = shorter[::step]
    if not sampled:
        return 0.0
    matches = 0
    longer_step = max(1, len(longer) // 160)
    longer_sampled = longer[::longer_step]
    for point in sampled:
        nearest = min(haversine_m(point, candidate) for candidate in longer_sampled)
        if nearest <= threshold_m:
            matches += 1
    return matches / len(sampled)


def _is_similar_route(
    path: Sequence[Dict[str, float]],
    distance_m: float,
    existing_routes: Sequence[Dict[str, Any]],
) -> bool:
    signature = _path_signature(path, precision=5)
    for route in existing_routes:
        if route.get('signature') == signature:
            return True
        existing_path = route.get('path') or []
        existing_distance = _safe_float(route.get('distance_m')) or calculate_path_length(existing_path)
        distance_delta = abs(distance_m - existing_distance) / max(1.0, min(distance_m, existing_distance))
        if distance_delta <= 0.08 and _path_overlap_ratio(path, existing_path) >= 0.86:
            return True
    return False


def _add_route_penalties(node_penalties: Dict[str, float], path: Sequence[Dict[str, float]], graph: Dict[str, Any], amount: float = 250.0) -> None:
    graph_nodes = graph['nodes']
    for point in path:
        nearest = min(graph_nodes, key=lambda node: haversine_m(point, node))
        node_id = _street_node_id(nearest)
        node_penalties[node_id] = node_penalties.get(node_id, 0.0) + amount
        for edge in graph['adjacency'].get(node_id, []):
            neighbor_id = _street_node_id(edge['node'])
            node_penalties[neighbor_id] = node_penalties.get(neighbor_id, 0.0) + amount / 2


def _remove_local_path_loops(
    path: Sequence[Dict[str, float]],
    close_m: float = 30.0,
    min_detour_m: float = 65.0,
    lookahead: int = 14,
) -> List[Dict[str, float]]:
    """Remove tiny local self-loops that become 0 m via-points in LRM."""
    cleaned = [{'lat': p['lat'], 'lon': p['lon']} for p in path]
    if len(cleaned) < 4:
        return cleaned

    changed = True
    passes = 0
    while changed and passes < 5:
        changed = False
        passes += 1

        i = 0
        while i < len(cleaned) - 2:
            best_j = None
            segment_distance = 0.0
            max_j = min(len(cleaned) - 1, i + lookahead)
            for j in range(i + 1, max_j + 1):
                segment_distance += haversine_m(cleaned[j - 1], cleaned[j])
                if j <= i + 1:
                    continue
                chord = haversine_m(cleaned[i], cleaned[j])
                if chord <= close_m and segment_distance - chord >= min_detour_m:
                    best_j = j
            if best_j is not None:
                cleaned = cleaned[:i + 1] + cleaned[best_j:]
                changed = True
                continue
            i += 1

        i = 1
        while i < len(cleaned) - 1:
            direct = haversine_m(cleaned[i - 1], cleaned[i + 1])
            detour = haversine_m(cleaned[i - 1], cleaned[i]) + haversine_m(cleaned[i], cleaned[i + 1])
            if direct <= close_m and detour - direct >= min_detour_m:
                cleaned.pop(i)
                changed = True
                continue
            i += 1

    return cleaned


def _project_path_point(point: Dict[str, float], origin_lat: float) -> Tuple[float, float]:
    return (
        point['lon'] * 111000.0 * math.cos(origin_lat * math.pi / 180.0),
        point['lat'] * 111000.0,
    )


def _orientation(a: Tuple[float, float], b: Tuple[float, float], c: Tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(
    a: Tuple[float, float],
    b: Tuple[float, float],
    c: Tuple[float, float],
    d: Tuple[float, float],
    eps: float = 0.05,
) -> bool:
    if (
        max(a[0], b[0]) + eps < min(c[0], d[0]) or
        max(c[0], d[0]) + eps < min(a[0], b[0]) or
        max(a[1], b[1]) + eps < min(c[1], d[1]) or
        max(c[1], d[1]) + eps < min(a[1], b[1])
    ):
        return False

    o1 = _orientation(a, b, c)
    o2 = _orientation(a, b, d)
    o3 = _orientation(c, d, a)
    o4 = _orientation(c, d, b)
    return (o1 * o2 < -eps) and (o3 * o4 < -eps)


def _path_has_local_self_intersection(
    path: Sequence[Dict[str, float]],
    lookahead: int = 24,
    max_segment_m: float = 260.0,
) -> bool:
    if len(path) < 4:
        return False

    origin_lat = sum(point['lat'] for point in path) / len(path)
    projected = [_project_path_point(point, origin_lat) for point in path]
    segment_lengths = [haversine_m(path[index], path[index + 1]) for index in range(len(path) - 1)]

    for i in range(len(projected) - 1):
        if segment_lengths[i] > max_segment_m:
            continue
        max_j = min(len(projected) - 2, i + lookahead)
        for j in range(i + 2, max_j + 1):
            if segment_lengths[j] > max_segment_m:
                continue
            if _segments_cross(projected[i], projected[i + 1], projected[j], projected[j + 1]):
                return True
    return False


def _simplify_waypoints(
    path: Sequence[Dict[str, float]],
    max_points: int = 6,
    min_spacing_m: float = 90.0,
) -> List[Dict[str, float]]:
    if len(path) <= max_points:
        points = [{'lat': p['lat'], 'lon': p['lon']} for p in path]
    else:
        cumulative = [0.0]
        for i in range(1, len(path)):
            cumulative.append(cumulative[-1] + haversine_m(path[i - 1], path[i]))
        total = cumulative[-1]
        if total <= 0:
            return [{'lat': path[0]['lat'], 'lon': path[0]['lon']}, {'lat': path[-1]['lat'], 'lon': path[-1]['lon']}]
        points = [path[0]]
        interior = max_points - 2
        for i in range(1, interior + 1):
            target = total * i / (interior + 1)
            index = next((idx for idx, distance in enumerate(cumulative) if distance >= target), None)
            if index and index < len(path) - 1:
                points.append(path[index])
        points.append(path[-1])

    if len(points) <= 2:
        return [{'lat': p['lat'], 'lon': p['lon']} for p in points]

    filtered = [points[0]]
    for point in points[1:-1]:
        if (
            haversine_m(filtered[-1], point) >= min_spacing_m
            and haversine_m(point, points[-1]) >= min_spacing_m
        ):
            filtered.append(point)
    filtered.append(points[-1])
    return [{'lat': p['lat'], 'lon': p['lon']} for p in filtered]


def _graphhopper_route_payload(
    start: Dict[str, float],
    goal: Dict[str, float],
    mode: str,
    alternatives: int,
    distance_tolerance: float,
) -> Optional[Dict[str, Any]]:
    region = select_region_for_points(start, goal)
    graphhopper_url = (region.graphhopper_url if region and region.graphhopper_url else GRAPHHOPPER_URL).rstrip('/')
    if not graphhopper_url:
        return None

    params = [
        ('point', f"{start['lat']},{start['lon']}"),
        ('point', f"{goal['lat']},{goal['lon']}"),
        ('profile', _graphhopper_profile(mode)),
        ('locale', 'it'),
        ('calc_points', 'true'),
        ('points_encoded', 'false'),
        ('instructions', 'true'),
    ]
    if alternatives and alternatives > 1:
        params.extend([
            ('algorithm', 'alternative_route'),
            ('ch.disable', 'true'),
            ('alternative_route.max_paths', str(max(1, min(int(alternatives), 5)))),
            ('alternative_route.max_weight_factor', str(1.15 + max(0.0, min(distance_tolerance, 10.0) - 1.0) * 0.08)),
            ('alternative_route.max_share_factor', '0.75'),
        ])
    if GRAPHHOPPER_API_KEY:
        params.append(('key', GRAPHHOPPER_API_KEY))

    try:
        response = requests.get(
            f'{graphhopper_url}/route',
            params=params,
            timeout=GRAPHHOPPER_TIMEOUT_SECONDS,
        )
        if not response.ok:
            print(f'[graphhopper] HTTP {response.status_code}: {response.text[:160]}')
            return None
        payload = response.json()
        if region is not None:
            payload['_pathplanner_region'] = region.region_id
            payload['_pathplanner_graphhopper_url'] = graphhopper_url
        return payload
    except Exception as exc:
        print(f'[graphhopper] {graphhopper_url} unavailable: {exc}')
        return None


def _graphhopper_path_points(path_payload: Dict[str, Any]) -> List[Dict[str, float]]:
    points = path_payload.get('points') or {}
    coordinates = points.get('coordinates') if isinstance(points, dict) else None
    if not isinstance(coordinates, list):
        return []
    out = []
    for coord in coordinates:
        if not isinstance(coord, list) or len(coord) < 2:
            continue
        lon = _safe_float(coord[0])
        lat = _safe_float(coord[1])
        if lat is not None and lon is not None:
            out.append({'lat': lat, 'lon': lon})
    return out


def _graphhopper_instruction_type(sign: Optional[int]) -> Tuple[str, str]:
    signs = {
        -8: ('UTurn', 'left'),
        -7: ('KeepLeft', 'left'),
        -6: ('LeaveRoundabout', ''),
        -3: ('SharpLeft', 'left'),
        -2: ('Left', 'left'),
        -1: ('SlightLeft', 'left'),
        0: ('Continue', 'straight'),
        1: ('SlightRight', 'right'),
        2: ('Right', 'right'),
        3: ('SharpRight', 'right'),
        4: ('DestinationReached', ''),
        5: ('WaypointReached', ''),
        6: ('Roundabout', ''),
        7: ('KeepRight', 'right'),
        8: ('UTurn', 'right'),
    }
    return signs.get(sign or 0, ('Continue', 'straight'))


def _graphhopper_instructions(path_payload: Dict[str, Any], path: Sequence[Dict[str, float]]) -> List[Dict[str, Any]]:
    raw_instructions = path_payload.get('instructions')
    if not isinstance(raw_instructions, list):
        raw_instructions = []

    out: List[Dict[str, Any]] = []
    for index, instruction in enumerate(raw_instructions):
        if not isinstance(instruction, dict):
            continue
        sign = _safe_float(instruction.get('sign'))
        type_name, modifier = _graphhopper_instruction_type(int(sign) if sign is not None else None)
        interval = instruction.get('interval') if isinstance(instruction.get('interval'), list) else []
        from_index = int(interval[0]) if len(interval) > 0 and isinstance(interval[0], int) else None
        to_index = int(interval[1]) if len(interval) > 1 and isinstance(interval[1], int) else None
        out.append({
            'type': type_name,
            'modifier': modifier,
            'text': instruction.get('text') or instruction.get('street_name') or '',
            'road': instruction.get('street_name') or '',
            'distance': round(_safe_float(instruction.get('distance')) or 0),
            'time': round((_safe_float(instruction.get('time')) or 0) / 1000),
            'sign': int(sign) if sign is not None else 0,
            'interval': [from_index, to_index] if from_index is not None and to_index is not None else None,
        })

    if out:
        return out

    total = calculate_path_length(path)
    return [
        {
            'type': 'Head',
            'modifier': 'straight',
            'text': 'Parti sul percorso selezionato',
            'road': '',
            'distance': round(total),
            'time': 0,
            'interval': [0, max(0, len(path) - 1)],
        },
        {
            'type': 'DestinationReached',
            'modifier': '',
            'text': 'Sei arrivato alla destinazione',
            'road': '',
            'distance': 0,
            'time': 0,
            'interval': [max(0, len(path) - 1), max(0, len(path) - 1)],
        },
    ]


def _score_candidate_path(
    path: Sequence[Dict[str, float]],
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
    poi_lists: Optional[Dict[str, List[Tuple[float, float]]]],
    env_samples: Sequence[Dict[str, Any]],
    green_scale: float,
    base_distance: float,
    walkability_features: Optional[Sequence[Dict[str, Any]]] = None,
    mode: str = 'walking',
) -> float:
    if not path:
        return float('inf')
    total = max(0.0, base_distance)
    for index, point in enumerate(path):
        env = _nearest_env(point, env_samples)
        penalty = 0.0
        if env and patient.get('name') != 'default':
            aq = _safe_float(env.get('airQuality'))
            if aq is not None:
                penalty += (max(0.0, aq - 4.0) ** 2) * (patient.get('airQualitySensitivity') or 1)
            slope = _safe_float(env.get('slope'))
            if slope is not None:
                penalty += (abs(slope) ** 2) * (patient.get('slopeSensitivity') or 1) / 5.0
        if poi_lists:
            for category, pois in poi_lists.items():
                patient_key = 'patient' + category.capitalize()
                weight = (patient.get(patient_key) or 0) + ((preferences or {}).get(category) or 0)
                if not weight or not pois:
                    continue
                nearest = min(haversine_m(point, {'lat': lat, 'lon': lon}) for lat, lon in pois)
                penalty = apply_preference_poi_adjustment(penalty, weight * green_scale, nearest)
        total += penalty * max(0.1, index / max(1, len(path)))
    walkability_penalty, _ = _score_walkability_for_path(path, walkability_features or [], patient, mode)
    total += walkability_penalty
    # Candidate ranking may reward clinically useful detours, but never so much
    # that a route becomes implausibly "free" compared with its physical length.
    return max(base_distance * 0.55, total)


def _route_env_summary(env_samples: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    values: Dict[str, List[float]] = {
        'airQuality': [],
        'slope': [],
        'temperature': [],
        'humidity': [],
        'weather': [],
    }
    cache_hits = 0
    for sample in env_samples:
        env = sample.get('env') or {}
        if env.get('cacheHit'):
            cache_hits += 1
        for key in values:
            value = _safe_float(env.get(key))
            if value is not None:
                values[key].append(value)
    out: Dict[str, Any] = {'sample_count': len(env_samples), 'cache_hits': cache_hits}
    for key, nums in values.items():
        if nums:
            out[key] = {
                'avg': round(sum(nums) / len(nums), 2),
                'min': round(min(nums), 2),
                'max': round(max(nums), 2),
            }
    return out


def _nearest_poi_summary(
    path: Sequence[Dict[str, float]],
    poi_lists: Optional[Dict[str, List[Tuple[float, float]]]],
) -> Dict[str, Optional[float]]:
    summary: Dict[str, Optional[float]] = {}
    if not path or not poi_lists:
        return summary
    step = max(1, len(path) // 80)
    sampled = path[::step]
    for category, pois in poi_lists.items():
        if not pois:
            summary[category] = None
            continue
        best = min(
            haversine_m(point, {'lat': lat, 'lon': lon})
            for point in sampled
            for lat, lon in pois
        )
        summary[category] = round(best)
    return summary


def _route_explanation(
    path: Sequence[Dict[str, float]],
    distance_m: float,
    cost: float,
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
    poi_lists: Optional[Dict[str, List[Tuple[float, float]]]],
    env_samples: Sequence[Dict[str, Any]],
    walkability_summary: Optional[Dict[str, Any]],
    data_sources: Dict[str, str],
) -> Dict[str, Any]:
    env_summary = _route_env_summary(env_samples)
    nearest_pois = _nearest_poi_summary(path, poi_lists)
    distance_penalty = max(0.0, cost - distance_m)
    reasons = []
    aq = env_summary.get('airQuality', {}).get('avg') if isinstance(env_summary.get('airQuality'), dict) else None
    if aq is not None:
        reasons.append(f'air quality avg {aq}')
    slope = env_summary.get('slope', {}).get('avg') if isinstance(env_summary.get('slope'), dict) else None
    if slope is not None:
        reasons.append(f'slope avg {slope}%')
    if nearest_pois:
        for category, distance in nearest_pois.items():
            if distance is not None:
                reasons.append(f'nearest {category} {distance} m')
    if walkability_summary and walkability_summary.get('penalty', 0) > 0:
        reasons.append(f"walkability penalty {walkability_summary['penalty']}")
    return {
        'patient_profile': patient.get('name'),
        'distance_m': round(distance_m),
        'cost': round(cost, 1),
        'distance_penalty': round(distance_penalty, 1),
        'environment': env_summary,
        'nearest_pois_m': nearest_pois,
        'walkability': walkability_summary or {'penalty': 0.0, 'hits': [], 'feature_count': 0},
        'data_sources': data_sources,
        'preference_weights': preferences or {},
        'reasons': reasons[:8],
    }


def _generate_graphhopper_routes(
    start: Dict[str, float],
    goal: Dict[str, float],
    condition: str,
    patient: Dict[str, Any],
    preferences: Optional[Dict[str, float]],
    distance_tolerance: float,
    mode: str,
    alternatives: int,
    bbox: Dict[str, float],
    active_categories: Sequence[str],
    started: float,
) -> Optional[Dict[str, Any]]:
    payload = _graphhopper_route_payload(start, goal, mode, alternatives, distance_tolerance)
    if not payload:
        return None

    graphhopper_paths = payload.get('paths')
    if not isinstance(graphhopper_paths, list) or not graphhopper_paths:
        return None

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)
    try:
        poi_future = executor.submit(_fetch_poi_lists_parallel, bbox, active_categories)
        env_future = executor.submit(_prefetch_environment_samples, start, goal)
        walkability_future = executor.submit(_fetch_walkability_features, bbox)
        input_deadline = time.perf_counter() + BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS

        poi_lists, poi_sources = {}, {}
        env_samples = []
        walkability_features, walkability_source = [], None

        try:
            poi_lists, poi_sources = poi_future.result(timeout=BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS)
        except concurrent.futures.TimeoutError:
            poi_future.cancel()

        remaining = max(0.1, input_deadline - time.perf_counter())
        try:
            env_samples = env_future.result(timeout=remaining)
        except concurrent.futures.TimeoutError:
            env_future.cancel()

        remaining = max(0.1, input_deadline - time.perf_counter())
        try:
            walkability_features, walkability_source = walkability_future.result(timeout=remaining)
        except concurrent.futures.TimeoutError:
            walkability_future.cancel()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    data_sources = _aggregate_env_sources(env_samples)
    if not env_samples:
        data_sources['environment'] = 'timed out or unavailable'
    if poi_lists:
        for category, pois in poi_lists.items():
            if pois:
                data_sources[f'poi_{category}'] = poi_sources.get(category, 'unknown')
    if walkability_features and walkability_source:
        data_sources['walkability'] = walkability_source
    data_sources['street_graph'] = 'GraphHopper local OSM graph'
    if payload.get('_pathplanner_region'):
        data_sources['routing_region'] = payload['_pathplanner_region']

    green_scale = tolerance_green_scale(distance_tolerance)
    routes = []
    signatures: Set[str] = set()
    for raw in graphhopper_paths[:max(1, min(int(alternatives or 1), 5))]:
        path = _graphhopper_path_points(raw)
        if len(path) < 2:
            continue
        path[0] = {'lat': start['lat'], 'lon': start['lon']}
        path[-1] = {'lat': goal['lat'], 'lon': goal['lon']}
        path = _remove_local_path_loops(path)
        path[0] = {'lat': start['lat'], 'lon': start['lon']}
        path[-1] = {'lat': goal['lat'], 'lon': goal['lon']}
        if _path_has_local_self_intersection(path):
            continue
        distance = calculate_path_length(path) or (_safe_float(raw.get('distance')) or 0)
        instructions = _graphhopper_instructions(raw, path)
        signature = _path_signature(path, precision=5)
        if signature in signatures or _is_similar_route(path, distance, routes):
            continue
        signatures.add(signature)
        cost = _score_candidate_path(
            path,
            patient,
            preferences,
            poi_lists,
            env_samples,
            green_scale,
            distance,
            walkability_features,
            mode,
        )
        walkability_penalty, walkability_summary = _score_walkability_for_path(
            path,
            walkability_features,
            patient,
            mode,
        )
        if walkability_penalty:
            walkability_summary['penalty'] = round(walkability_penalty, 1)
        routes.append({
            'name': 'GraphHopper Environmental Route' if not routes else f'GraphHopper Environmental Alternative {len(routes) + 1}',
            'routing_basis': 'graphhopper_osm',
            'transport_mode': mode,
            'path': path,
            'waypoints': _simplify_waypoints(path),
            'instructions': instructions,
            'astar_cost': cost,
            'goal_reached': True,
            'expansions': 0,
            'signature': signature,
            'path_node_count': len(path),
            'distance_m': round(distance),
            'duration_s': round((_safe_float(raw.get('time')) or 0) / 1000),
            'env_score': round(max(0.0, 100.0 - cost / 100.0), 1),
            'data_sources': data_sources,
            'explanation': _route_explanation(
                path,
                distance,
                cost,
                patient,
                preferences,
                poi_lists,
                env_samples,
                walkability_summary,
                data_sources,
            ),
        })

    routes.sort(key=lambda route: route['astar_cost'])
    if not routes:
        return None

    return {
        'source': 'graphhopper_candidate_routing',
        'mode': mode,
        'condition': patient.get('name', condition),
        'bbox': bbox,
        'routes': routes,
        'count': len(routes),
        'street_graph': {
            'source': 'GraphHopper local OSM graph',
            'count': {'routes': len(graphhopper_paths)},
            'region': payload.get('_pathplanner_region'),
        },
        'parallelism': {
            'io_workers': BACKEND_ASTAR_IO_WORKERS,
            'env_workers': BACKEND_ASTAR_ENV_WORKERS,
            'parallelized': ['graphhopper_routes', 'poi_categories', 'environment_seed', 'candidate_scoring'],
            'sequential': ['graphhopper_internal_routing'],
        },
        'timing_ms': round((time.perf_counter() - started) * 1000),
    }


def calculate_path_length(path: Sequence[Dict[str, float]]) -> float:
    return sum(haversine_m(path[i - 1], path[i]) for i in range(1, len(path)))


def generate_backend_astar_routes(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    condition: str = 'respiratory',
    preferences: Optional[Dict[str, float]] = None,
    distance_tolerance: float = 1.0,
    transport_mode: str = 'walking',
    alternatives: int = 3,
) -> Dict[str, Any]:
    started = time.perf_counter()
    start = {'lat': float(start_lat), 'lon': float(start_lon)}
    goal = {'lat': float(end_lat), 'lon': float(end_lon)}
    mode = normalize_transport_mode(transport_mode)
    patient = PATIENT_CONDITIONS.get(condition, PATIENT_CONDITIONS['respiratory'])
    bbox = _route_bbox(start, goal, distance_tolerance)
    active_categories = _active_poi_categories(patient, preferences)

    graphhopper_payload = _generate_graphhopper_routes(
        start,
        goal,
        condition,
        patient,
        preferences,
        distance_tolerance,
        mode,
        alternatives,
        bbox,
        active_categories,
        started,
    )
    if graphhopper_payload is not None:
        return graphhopper_payload
    if (GRAPHHOPPER_URL or select_region_for_points(start, goal)) and GRAPHHOPPER_FORCE:
        raise RuntimeError('GraphHopper is configured but did not return usable routes')

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)
    try:
        street_future = executor.submit(
            fetch_street_graph,
            bbox['min_lat'],
            bbox['min_lon'],
            bbox['max_lat'],
            bbox['max_lon'],
            mode,
            timeout=BACKEND_ASTAR_STREET_TIMEOUT_SECONDS,
            max_mirrors=BACKEND_ASTAR_OVERPASS_MAX_MIRRORS,
        )
        poi_future = executor.submit(_fetch_poi_lists_parallel, bbox, active_categories)
        walkability_future = executor.submit(_fetch_walkability_features, bbox)
        input_deadline = time.perf_counter() + BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS
        street_payload = street_future.result(timeout=BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS)
        remaining = max(0.1, input_deadline - time.perf_counter())
        poi_lists, poi_sources = poi_future.result(timeout=remaining)
        remaining = max(0.1, input_deadline - time.perf_counter())
        walkability_features, walkability_source = walkability_future.result(timeout=remaining)
    except concurrent.futures.TimeoutError as exc:
        raise TimeoutError('backend A* data lookup timed out') from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    base_graph = _build_street_graph(street_payload)
    graph = _instantiate_with_endpoints(base_graph, start, goal)
    poi_distances = precompute_poi_distances(graph['nodes'], poi_lists) if poi_lists else None
    env_samples = _prefetch_environment_samples(start, goal)
    green_scale = tolerance_green_scale(distance_tolerance)

    routes = []
    signatures: Set[str] = set()
    node_penalties: Dict[str, float] = {}
    target_count = max(1, min(int(alternatives or 1), 5))

    while len(routes) < target_count:
        accepted = False
        for attempt in range(BACKEND_ASTAR_MAX_ALTERNATIVE_ATTEMPTS):
            result = _street_graph_astar(
                graph,
                patient,
                preferences,
                poi_distances,
                env_samples,
                node_penalties,
                green_scale,
                walkability_features,
                mode,
            )
            if not result:
                break
            result['path'] = _remove_local_path_loops(result['path'])
            if _path_has_local_self_intersection(result['path']):
                _add_route_penalties(node_penalties, result['path'], graph, amount=300.0 * (attempt + 1))
                continue
            signature = _path_signature(result['path'])
            distance = calculate_path_length(result['path'])
            if signature not in signatures and not _is_similar_route(result['path'], distance, routes):
                signatures.add(signature)
                route_index = len(routes)
                walkability_penalty, walkability_summary = _score_walkability_for_path(
                    result['path'],
                    walkability_features,
                    patient,
                    mode,
                )
                routes.append({
                    'name': 'Backend Environmental A* Route' if route_index == 0 else f'Backend Environmental A* Alternative {route_index + 1}',
                    'routing_basis': 'street_graph',
                    'transport_mode': mode,
                    'path': result['path'],
                    'waypoints': _simplify_waypoints(result['path']),
                    'astar_cost': result['astar_cost'],
                    'goal_reached': result['goal_reached'],
                    'expansions': result['expansions'],
                    'signature': signature,
                    'path_node_count': len(result['path']),
                    'distance_m': round(distance),
                    'explanation': _route_explanation(
                        result['path'],
                        distance,
                        result['astar_cost'],
                        patient,
                        preferences,
                        poi_lists,
                        env_samples,
                        walkability_summary,
                        {},
                    ),
                })
                _add_route_penalties(node_penalties, result['path'], graph)
                accepted = True
                break
            _add_route_penalties(node_penalties, result['path'], graph, amount=300.0 * (attempt + 1))
        if not accepted:
            break

    data_sources = _aggregate_env_sources(env_samples)
    if poi_lists:
        for category, pois in poi_lists.items():
            if pois:
                data_sources[f'poi_{category}'] = poi_sources.get(category, 'unknown')
    if walkability_features and walkability_source:
        data_sources['walkability'] = walkability_source
    data_sources['street_graph'] = base_graph['source']

    def score_route(route: Dict[str, Any]) -> Dict[str, Any]:
        route['env_score'] = round(max(0.0, 100.0 - (route.get('astar_cost') or 0.0) / 100.0), 1)
        route['data_sources'] = data_sources
        if route.get('explanation'):
            route['explanation']['data_sources'] = data_sources
        return route

    if routes:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(routes), BACKEND_ASTAR_ENV_WORKERS)) as executor:
            routes = list(executor.map(score_route, routes))

    return {
        'source': 'backend_street_astar',
        'mode': mode,
        'condition': patient.get('name', condition),
        'bbox': bbox,
        'routes': routes,
        'count': len(routes),
        'street_graph': {
            'source': base_graph['source'],
            'count': base_graph['count'],
        },
        'parallelism': {
            'io_workers': BACKEND_ASTAR_IO_WORKERS,
            'env_workers': BACKEND_ASTAR_ENV_WORKERS,
            'parallelized': ['street_graph_and_pois', 'poi_categories', 'environment_seed', 'route_scoring'],
            'sequential': ['priority_queue_astar_expansion', 'penalty_based_alternative_generation'],
        },
        'timing_ms': round((time.perf_counter() - started) * 1000),
    }


def _safe_float(value: Any) -> Optional[float]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None
