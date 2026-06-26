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

POI_CATEGORIES = ('nature', 'entertainment', 'nightlife', 'tourism', 'hospital')


def normalize_transport_mode(mode: Optional[str]) -> str:
    if mode in ('driving', 'car'):
        return 'car'
    if mode == 'cycling':
        return 'cycling'
    return 'walking'


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
) -> Dict[str, List[Tuple[float, float]]]:
    if not categories:
        return {}

    def fetch_category(category: str) -> Tuple[str, List[Tuple[float, float]]]:
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
        return category, pois

    out: Dict[str, List[Tuple[float, float]]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(categories))) as executor:
        futures = [executor.submit(fetch_category, category) for category in categories]
        for future in concurrent.futures.as_completed(futures):
            try:
                category, pois = future.result()
                out[category] = pois
            except Exception:
                # Missing POIs should reduce preference influence, not fail routing.
                continue
    return out


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


def _fetch_backend_environment_data(lat: float, lon: float) -> Dict[str, Any]:
    """Fast real-only environmental snapshot for interactive backend A*.

    This intentionally skips per-point Overpass noise/green lookups. OSM green
    influence enters through the route-corridor POI fetch, and street class
    influence enters through the graph edge metadata. Missing fields stay
    ``None`` instead of being filled with synthetic defaults.
    """
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


def _add_route_penalties(node_penalties: Dict[str, float], path: Sequence[Dict[str, float]], graph: Dict[str, Any], amount: float = 250.0) -> None:
    graph_nodes = graph['nodes']
    for point in path:
        nearest = min(graph_nodes, key=lambda node: haversine_m(point, node))
        node_id = _street_node_id(nearest)
        node_penalties[node_id] = node_penalties.get(node_id, 0.0) + amount
        for edge in graph['adjacency'].get(node_id, []):
            neighbor_id = _street_node_id(edge['node'])
            node_penalties[neighbor_id] = node_penalties.get(neighbor_id, 0.0) + amount / 2


def _simplify_waypoints(path: Sequence[Dict[str, float]], max_points: int = 8) -> List[Dict[str, float]]:
    if len(path) <= max_points:
        return [{'lat': p['lat'], 'lon': p['lon']} for p in path]
    cumulative = [0.0]
    for i in range(1, len(path)):
        cumulative.append(cumulative[-1] + haversine_m(path[i - 1], path[i]))
    total = cumulative[-1]
    if total <= 0:
        return [{'lat': path[0]['lat'], 'lon': path[0]['lon']}, {'lat': path[-1]['lat'], 'lon': path[-1]['lon']}]
    out = [path[0]]
    interior = max_points - 2
    for i in range(1, interior + 1):
        target = total * i / (interior + 1)
        index = next((idx for idx, distance in enumerate(cumulative) if distance >= target), None)
        if index and index < len(path) - 1:
            out.append(path[index])
    out.append(path[-1])
    return [{'lat': p['lat'], 'lon': p['lon']} for p in out]


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

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
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
        input_deadline = time.perf_counter() + BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS
        street_payload = street_future.result(timeout=BACKEND_ASTAR_INPUT_TIMEOUT_SECONDS)
        remaining = max(0.1, input_deadline - time.perf_counter())
        poi_lists = poi_future.result(timeout=remaining)
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
            )
            if not result:
                break
            signature = _path_signature(result['path'])
            if signature not in signatures:
                signatures.add(signature)
                route_index = len(routes)
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
                data_sources[f'poi_{category}'] = 'OpenStreetMap-Overpass'
    data_sources['street_graph'] = base_graph['source']

    def score_route(route: Dict[str, Any]) -> Dict[str, Any]:
        route['env_score'] = round(max(0.0, 100.0 - (route.get('astar_cost') or 0.0) / 100.0), 1)
        route['data_sources'] = data_sources
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
