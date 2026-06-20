"""
Grid-based Environmental A* pathfinding (port of pathplanner-app/static/js/algorithms/environmentalAStar.js).

Used for research benchmarks comparing algorithmic smart routing vs the production
waypoint + Mapbox/ORS flow in routePlanner.js.
"""

import heapq
import math
import os
from typing import Any, Dict, List, Optional, Tuple

from .environmental_data_service import environmental_data_service
from .multifactor_scoring import calculate_multifactor_score

# Mirrors pathplanner-app/static/js/enums/patientCondition.js
PATIENT_CONDITIONS: Dict[str, Dict[str, Any]] = {
    'respiratory': {
        'name': 'respiratory',
        'airQualitySensitivity': 10,
        'slopeSensitivity': 7,
        'noiseSensitivity': 3,
        'temperatureSensitivity': 8,
        'humiditySensitivity': 9,
    },
    'cardiac': {
        'name': 'cardiac',
        'airQualitySensitivity': 7,
        'slopeSensitivity': 9,
        'noiseSensitivity': 4,
        'temperatureSensitivity': 8,
        'humiditySensitivity': 5,
    },
    'mobility': {
        'name': 'mobility',
        'airQualitySensitivity': 2,
        'slopeSensitivity': 10,
        'noiseSensitivity': 2,
        'temperatureSensitivity': 3,
        'humiditySensitivity': 3,
    },
    'mental': {
        'name': 'mental',
        'airQualitySensitivity': 5,
        'slopeSensitivity': 2,
        'noiseSensitivity': 9,
        'temperatureSensitivity': 4,
        'humiditySensitivity': 2,
    },
    'arthritis': {
        'name': 'arthritis',
        'airQualitySensitivity': 3,
        'slopeSensitivity': 10,
        'noiseSensitivity': 2,
        'temperatureSensitivity': 9,
        'humiditySensitivity': 10,
    },
    'diabetes': {
        'name': 'diabetes',
        'airQualitySensitivity': 4,
        'slopeSensitivity': 6,
        'noiseSensitivity': 3,
        'temperatureSensitivity': 5,
        'humiditySensitivity': 4,
    },
}

_env_cache: Dict[str, Dict[str, float]] = {}
_MAX_GRID_NODES = int(os.getenv('ASTAR_MAX_GRID_NODES', '6000'))
_MAX_EXPANSIONS = int(os.getenv('ASTAR_MAX_EXPANSIONS', '4000'))
_GOAL_RADIUS_M = 50.0


def _node_id(node: Dict[str, float]) -> str:
    return f"{node['lat']:.6f},{node['lon']:.6f}"


def haversine_m(a: Dict[str, float], b: Dict[str, float]) -> float:
    r = 6371000.0
    lat1, lon1 = math.radians(a['lat']), math.radians(a['lon'])
    lat2, lon2 = math.radians(b['lat']), math.radians(b['lon'])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    x = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def _get_env(lat: float, lon: float) -> Dict[str, float]:
    key = f"{lat:.5f},{lon:.5f}"
    if key in _env_cache:
        return _env_cache[key]
    raw = environmental_data_service.get_environmental_data(lat, lon)
    env = {
        'airQuality': float(raw.get('airQuality', 5.0)),
        'temperature': float(raw.get('temperature', 22.0)),
        'humidity': float(raw.get('humidity', 50.0)),
        'noise': float(raw.get('noise', 4.0)),
        'slope': float(raw.get('slope', 3.0)),
        'greenSpace': float(raw.get('greenSpace', 3.0)),
        'weather': float(raw.get('weather', 1.0)),
        # Proxies when JS-specific fields are absent
        'trafficDensity': max(0.0, min(1.0, (float(raw.get('airQuality', 5.0)) - 3.0) / 7.0)),
        'greenVisibility': max(0.0, min(1.0, float(raw.get('greenSpace', 3.0)) / 10.0)),
        'emergencyAccessibility': max(0.0, min(1.0, 1.0 - float(raw.get('greenSpace', 3.0)) / 10.0)),
        'surfaceQuality': max(0.0, min(1.0, float(raw.get('slope', 3.0)) / 10.0)),
        'sensoryLoad': max(0.0, min(1.0, float(raw.get('noise', 4.0)) / 10.0)),
    }
    _env_cache[key] = env
    return env


def clear_env_cache() -> None:
    _env_cache.clear()


def create_search_grid(
    start: Dict[str, float],
    goal: Dict[str, float],
    resolution_m: float = 100.0,
) -> List[Dict[str, float]]:
    """Same bounding-box grid as environmentalAStar.js createSearchGrid."""
    min_lat = min(start['lat'], goal['lat']) - 0.01
    max_lat = max(start['lat'], goal['lat']) + 0.01
    min_lon = min(start['lon'], goal['lon']) - 0.01
    max_lon = max(start['lon'], goal['lon']) + 0.01

    mid_lat = (start['lat'] + goal['lat']) / 2.0
    lat_mpd = 111320.0
    lon_mpd = 111320.0 * math.cos(math.radians(mid_lat))
    lat_step = resolution_m / lat_mpd
    lon_step = resolution_m / lon_mpd

    grid: List[Dict[str, float]] = []
    lat = min_lat
    while lat <= max_lat:
        lon = min_lon
        while lon <= max_lon:
            grid.append({'lat': lat, 'lon': lon})
            lon += lon_step
        lat += lat_step
    return grid


def _adaptive_resolution(start: Dict[str, float], goal: Dict[str, float], base: float = 100.0) -> float:
    dist = haversine_m(start, goal)
    res = base
    if dist > 2500:
        res = 125.0
    if dist > 5000:
        res = 150.0
    if dist > 8000:
        res = 200.0
    while True:
        n = len(create_search_grid(start, goal, res))
        if n <= _MAX_GRID_NODES or res >= 300:
            return res
        res += 25.0


def get_neighbors(
    node: Dict[str, float],
    grid: List[Dict[str, float]],
    resolution_m: float,
) -> List[Dict[str, float]]:
    lat_mpd = 111320.0
    lon_mpd = 111320.0 * math.cos(math.radians(node['lat']))
    lat_radius = resolution_m / lat_mpd
    lon_radius = resolution_m / lon_mpd
    out = []
    for g in grid:
        lat_diff = abs(g['lat'] - node['lat'])
        lon_diff = abs(g['lon'] - node['lon'])
        if lat_diff <= lat_radius and lon_diff <= lon_radius and (lat_diff > 0 or lon_diff > 0):
            out.append(g)
    return out


def calculate_edge_cost(
    current: Dict[str, float],
    neighbor: Dict[str, float],
    current_g: float,
    patient: Dict[str, Any],
) -> float:
    """Port of environmentalAStar.js calculateCost (g-score increment)."""
    cost = current_g + haversine_m(current, neighbor)
    env = _get_env(neighbor['lat'], neighbor['lon'])
    name = patient.get('name', 'default')

    if name == 'default':
        return cost

    aq_mult = patient.get('airQualitySensitivity', 1) or 1
    slope_mult = patient.get('slopeSensitivity', 1) or 1
    noise_mult = patient.get('noiseSensitivity', 1) or 1
    temp_mult = patient.get('temperatureSensitivity', 1) or 1
    hum_mult = patient.get('humiditySensitivity', 1) or 1

    aq = env['airQuality']
    cost += (max(0.0, aq - 4.0) ** 2) * aq_mult

    slope = env['slope']
    cost += (abs(slope) ** 2) * slope_mult / 5.0

    noise = env['noise']
    cost += max(0.0, noise - 3.0) * noise_mult

    temp_diff = abs(env['temperature'] - 22.0)
    cost += temp_diff * temp_mult / 3.0

    hum_diff = abs(env['humidity'] - 50.0)
    cost += hum_diff * hum_mult / 10.0

    if name == 'respiratory':
        cost += env['trafficDensity'] * aq_mult * 10.0
        cost -= env['greenVisibility'] * 5.0
    elif name == 'cardiac':
        cost += (abs(slope) ** 2) * slope_mult / 2.0
        cost += env['emergencyAccessibility'] * 2.0
    elif name == 'mobility':
        cost += (abs(slope) ** 2.5) * slope_mult
        cost += env['surfaceQuality'] * 15.0
    elif name == 'mental':
        cost += (noise ** 1.5) * noise_mult
        cost += env['sensoryLoad'] * 2.0
        cost -= env['greenVisibility'] * 8.0

    return cost


def estimate_heuristic(node: Dict[str, float], goal: Dict[str, float]) -> float:
    return haversine_m(node, goal)


def is_goal_reached(node: Dict[str, float], goal: Dict[str, float]) -> bool:
    return haversine_m(node, goal) < _GOAL_RADIUS_M


def reconstruct_path(came_from: Dict[str, Dict[str, float]], current: Dict[str, float]) -> List[Dict[str, float]]:
    path = [current]
    cid = _node_id(current)
    while cid in came_from:
        current = came_from[cid]
        path.insert(0, current)
        cid = _node_id(current)
    return path


def find_optimal_route(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    condition: str = 'respiratory',
    grid_resolution_m: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Environmental A* search. Returns grid path, internal astar_cost (lower=better),
    and path nodes for downstream ORS / multifactor scoring.
    """
    clear_env_cache()
    start = {'lat': start_lat, 'lon': start_lon}
    goal = {'lat': end_lat, 'lon': end_lon}
    patient = PATIENT_CONDITIONS.get(condition, PATIENT_CONDITIONS['respiratory'])

    resolution = grid_resolution_m or _adaptive_resolution(start, goal)
    grid = create_search_grid(start, goal, resolution)

    open_heap: List[Tuple[float, int, Dict[str, float]]] = []
    counter = 0
    g_score: Dict[str, float] = {}
    f_score: Dict[str, float] = {}
    came_from: Dict[str, Dict[str, float]] = {}
    in_open: Dict[str, bool] = {}

    sid = _node_id(start)
    g_score[sid] = 0.0
    f_score[sid] = estimate_heuristic(start, goal)
    heapq.heappush(open_heap, (f_score[sid], counter, start))
    in_open[sid] = True
    counter += 1

    closed: set = set()
    best_cost = float('inf')
    best_partial: Optional[List[Dict[str, float]]] = None
    expansions = 0
    direct_dist = haversine_m(start, goal)

    while open_heap and expansions < _MAX_EXPANSIONS:
        _, _, current = heapq.heappop(open_heap)
        cid = _node_id(current)
        in_open.pop(cid, None)
        expansions += 1

        if is_goal_reached(current, goal):
            path = reconstruct_path(came_from, current)
            return {
                'path': path,
                'astar_cost': g_score[cid],
                'goal_reached': True,
                'grid_resolution_m': resolution,
                'grid_nodes': len(grid),
                'expansions': expansions,
            }

        closed.add(cid)

        for neighbor in get_neighbors(current, grid, resolution):
            nid = _node_id(neighbor)
            if nid in closed:
                continue

            tentative = calculate_edge_cost(current, neighbor, g_score[cid], patient)

            if nid not in g_score or tentative < g_score[nid]:
                came_from[nid] = current
                g_score[nid] = tentative
                f_score[nid] = tentative + estimate_heuristic(neighbor, goal)
                if nid not in in_open:
                    heapq.heappush(open_heap, (f_score[nid], counter, neighbor))
                    in_open[nid] = True
                    counter += 1

                if tentative < best_cost and haversine_m(neighbor, goal) < direct_dist * 0.2:
                    best_cost = tentative
                    best_partial = reconstruct_path(came_from, neighbor)

    path = best_partial or [start, goal]
    return {
        'path': path,
        'astar_cost': best_cost if best_partial else None,
        'goal_reached': False,
        'grid_resolution_m': resolution,
        'grid_nodes': len(grid),
        'expansions': expansions,
    }


def simplify_path_for_routing(path: List[Dict[str, float]], max_points: int = 12) -> List[Tuple[float, float]]:
    """Down-sample A* polyline for ORS multi-waypoint limits."""
    if len(path) <= max_points:
        return [(p['lat'], p['lon']) for p in path]
    step = max(1, len(path) // (max_points - 1))
    sampled = [path[i] for i in range(0, len(path), step)]
    if sampled[-1] != path[-1]:
        sampled.append(path[-1])
    return [(p['lat'], p['lon']) for p in sampled]


def score_path_multifactor(
    path: List[Dict[str, float]],
    condition: str,
    optimized: bool = True,
    max_samples: int = 20,
) -> Tuple[float, Dict[str, str]]:
    """Benchmark-comparable env score (higher=better) along the A* path."""
    if not path:
        return 5.0, {}
    step = max(1, len(path) // max_samples)
    scores = []
    sources: Dict[str, str] = {}
    for i in range(0, len(path), step):
        p = path[i]
        env = environmental_data_service.get_environmental_data(p['lat'], p['lon'])
        factors = {
            'airQuality': env['airQuality'],
            'temperature': env['temperature'],
            'humidity': env['humidity'],
            'noise': env['noise'],
            'slope': env['slope'],
            'greenSpace': env['greenSpace'],
            'weather': env['weather'],
        }
        result = calculate_multifactor_score(factors, condition, optimized)
        scores.append(result['score'])
        for k, v in env.get('dataSources', {}).items():
            sources[k] = v
    mean = sum(scores) / len(scores) if scores else 5.0
    return round(mean, 1), sources
