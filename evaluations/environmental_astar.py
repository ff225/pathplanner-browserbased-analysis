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
        'patientNature': 10,
        'patientEntertainment': 0,
        'patientNightlife': -4,
        'patientTourism': 0,
        'patientHospital': 6,
    },
    'cardiac': {
        'name': 'cardiac',
        'airQualitySensitivity': 7,
        'slopeSensitivity': 9,
        'noiseSensitivity': 4,
        'temperatureSensitivity': 8,
        'humiditySensitivity': 5,
        'patientNature': 5,
        'patientEntertainment': 0,
        'patientNightlife': -3,
        'patientTourism': 0,
        'patientHospital': 10,
    },
    'mobility': {
        'name': 'mobility',
        'airQualitySensitivity': 2,
        'slopeSensitivity': 10,
        'noiseSensitivity': 2,
        'temperatureSensitivity': 3,
        'humiditySensitivity': 3,
        'patientNature': 3,
        'patientEntertainment': 0,
        'patientNightlife': -2,
        'patientTourism': 0,
        'patientHospital': 5,
    },
    'mental': {
        'name': 'mental',
        'airQualitySensitivity': 5,
        'slopeSensitivity': 2,
        'noiseSensitivity': 9,
        'temperatureSensitivity': 4,
        'humiditySensitivity': 2,
        'patientNature': 10,
        'patientEntertainment': 2,
        'patientNightlife': -3,
        'patientTourism': 3,
        'patientHospital': 4,
    },
    'arthritis': {
        'name': 'arthritis',
        'airQualitySensitivity': 3,
        'slopeSensitivity': 10,
        'noiseSensitivity': 2,
        'temperatureSensitivity': 9,
        'humiditySensitivity': 10,
        'patientNature': 3,
        'patientEntertainment': 0,
        'patientNightlife': -2,
        'patientTourism': 0,
        'patientHospital': 5,
    },
    'diabetes': {
        'name': 'diabetes',
        'airQualitySensitivity': 4,
        'slopeSensitivity': 6,
        'noiseSensitivity': 3,
        'temperatureSensitivity': 5,
        'humiditySensitivity': 4,
        'patientNature': 5,
        'patientEntertainment': 0,
        'patientNightlife': -2,
        'patientTourism': 0,
        'patientHospital': 8,
    },
    'default': {
        'name': 'default',
        'airQualitySensitivity': 0,
        'slopeSensitivity': 0,
        'noiseSensitivity': 0,
        'temperatureSensitivity': 0,
        'humiditySensitivity': 0,
        'patientNature': 0,
        'patientEntertainment': 0,
        'patientNightlife': 0,
        'patientTourism': 0,
        'patientHospital': 0,
    },
}

_env_cache: Dict[str, Dict[str, float]] = {}
_MAX_GRID_NODES = int(os.getenv('ASTAR_MAX_GRID_NODES', '6000'))
_MAX_EXPANSIONS = int(os.getenv('ASTAR_MAX_EXPANSIONS', '4000'))
_GOAL_RADIUS_M = 50.0

PREFERENCE_POI_DECAY_M = 200.0
PREFERENCE_POI_SCALE = 5.0

# Distance-tolerance slider (UI #percentageSlider, 1..10; 1 = baseline). Mirrors
# environmentalAStar.js: higher tolerance widens the search bbox so green detours
# are reachable, and amplifies the green/nature reward so longer green paths win.
# Slider = 1 keeps the legacy 0.01 deg bbox and unscaled reward (bit-identical).
_TOLERANCE_BASE_PADDING_DEG = 0.01
_TOLERANCE_BBOX_GAIN = 0.12   # +12% bbox padding per slider step above 1
_TOLERANCE_GREEN_GAIN = 0.30  # +30% green reward per slider step above 1


def _clamp_tolerance(distance_tolerance: float) -> float:
    try:
        t = float(distance_tolerance)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(t) or t <= 1.0:
        return 1.0
    return min(t, 10.0)


def tolerance_padding_deg(distance_tolerance: float = 1.0) -> float:
    """Search-bbox half-padding (degrees), scaled by the distance-tolerance slider."""
    t = _clamp_tolerance(distance_tolerance)
    return _TOLERANCE_BASE_PADDING_DEG * (1.0 + (t - 1.0) * _TOLERANCE_BBOX_GAIN)


def tolerance_green_scale(distance_tolerance: float = 1.0) -> float:
    """Multiplier (>=1) on the green/nature reward, scaled by the slider."""
    t = _clamp_tolerance(distance_tolerance)
    return 1.0 + (t - 1.0) * _TOLERANCE_GREEN_GAIN


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
    distance_tolerance: float = 1.0,
) -> List[Dict[str, float]]:
    """Same bounding-box grid as environmentalAStar.js createSearchGrid.

    The distance-tolerance slider widens the padding so higher tolerance exposes
    green detours off the straight line as reachable grid nodes (baseline 0.01).
    """
    pad = tolerance_padding_deg(distance_tolerance)
    min_lat = min(start['lat'], goal['lat']) - pad
    max_lat = max(start['lat'], goal['lat']) + pad
    min_lon = min(start['lon'], goal['lon']) - pad
    max_lon = max(start['lon'], goal['lon']) + pad

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


def _adaptive_resolution(
    start: Dict[str, float],
    goal: Dict[str, float],
    base: float = 100.0,
    distance_tolerance: float = 1.0,
) -> float:
    dist = haversine_m(start, goal)
    res = base
    if dist > 2500:
        res = 125.0
    if dist > 5000:
        res = 150.0
    if dist > 8000:
        res = 200.0
    while True:
        n = len(create_search_grid(start, goal, res, distance_tolerance))
        if n <= _MAX_GRID_NODES or res >= 300:
            return res
        res += 25.0


def get_poi_lists_for_grid(grid: List[Dict[str, float]]) -> Dict[str, List[Tuple[float, float]]]:
    """Query real DB POI locations (Hospital + Stazione categories) inside the grid bbox."""
    if not grid:
        return {}

    min_lat = min(node['lat'] for node in grid)
    max_lat = max(node['lat'] for node in grid)
    min_lon = min(node['lon'] for node in grid)
    max_lon = max(node['lon'] for node in grid)

    # Lazy import so the module can be imported without a configured Django app.
    from .models import Hospital, Stazione

    poi_lists: Dict[str, List[Tuple[float, float]]] = {}

    hospitals = list(
        Hospital.objects.filter(
            lat__gte=min_lat, lat__lte=max_lat, lng__gte=min_lon, lng__lte=max_lon
        ).values('lat', 'lng')
    )
    poi_lists['hospital'] = [(h['lat'], h['lng']) for h in hospitals]

    for category in ['nature', 'entertainment', 'tourism', 'nightlife']:
        stations = list(
            Stazione.objects.filter(
                latitudine__gte=min_lat,
                latitudine__lte=max_lat,
                longitudine__gte=min_lon,
                longitudine__lte=max_lon,
                **{category + '__gt': 0},
            ).values('latitudine', 'longitudine')
        )
        poi_lists[category] = [(s['latitudine'], s['longitudine']) for s in stations]

    return poi_lists


def _poi_cell_size_meters_to_degrees(cell_size_m: float, lat: float) -> Tuple[float, float]:
    """Approximate lat/lon cell sizes in degrees for a given metric cell size."""
    lat_step = cell_size_m / 111320.0
    lon_step = cell_size_m / (111320.0 * math.cos(math.radians(lat)))
    return lat_step, lon_step


def build_poi_spatial_index(
    poi_list: List[Tuple[float, float]], cell_size_m: float = 200
) -> Optional[Dict[str, Any]]:
    """Bucket POIs by lat/lon cells for fast nearest-neighbor lookups."""
    if not poi_list:
        return None
    first_lat = poi_list[0][0]
    lat_step, lon_step = _poi_cell_size_meters_to_degrees(cell_size_m, first_lat)
    cells: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}
    for lat, lon in poi_list:
        key = (math.floor(lat / lat_step), math.floor(lon / lon_step))
        cells.setdefault(key, []).append((lat, lon))
    return {'cells': cells, 'lat_step': lat_step, 'lon_step': lon_step}


def nearest_poi_distance_indexed(
    node: Dict[str, float], spatial_index: Optional[Dict[str, Any]]
) -> Optional[float]:
    """Return min distance to a POI using the spatial index (checks own + neighbor cells)."""
    if not spatial_index or not spatial_index['cells']:
        return None
    lat = node['lat']
    lon = node['lon']
    lat_step = spatial_index['lat_step']
    lon_step = spatial_index['lon_step']
    i = math.floor(lat / lat_step)
    j = math.floor(lon / lon_step)
    min_dist = float('inf')
    found = False
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            cell = spatial_index['cells'].get((i + di, j + dj))
            if not cell:
                continue
            for plat, plon in cell:
                d = haversine_m(node, {'lat': plat, 'lon': plon})
                if d < min_dist:
                    min_dist = d
                    found = True
    return min_dist if found else None


def nearest_poi_distance(node: Dict[str, float], poi_list: List[Tuple[float, float]]) -> Optional[float]:
    """Return the minimum haversine distance in meters from node to any POI."""
    if not poi_list:
        return None
    return min(
        haversine_m(node, {'lat': lat, 'lon': lon}) for lat, lon in poi_list
    )


def precompute_poi_distances(
    grid: List[Dict[str, float]],
    poi_lists: Dict[str, List[Tuple[float, float]]],
    cell_size_m: float = 200,
) -> Dict[str, Dict[str, Optional[float]]]:
    """Precompute nearest-POI distances for every grid node using a spatial index."""
    if not grid or not poi_lists:
        return {}

    spatial_indices = {
        category: build_poi_spatial_index(poi_list, cell_size_m)
        for category, poi_list in poi_lists.items()
    }

    result: Dict[str, Dict[str, Optional[float]]] = {}
    for node in grid:
        distances: Dict[str, Optional[float]] = {}
        for category, index in spatial_indices.items():
            distances[category] = nearest_poi_distance_indexed(node, index)
        result[_node_id(node)] = distances
    return result


def apply_preference_poi_adjustment(cost: float, weight: float, distance_m: Optional[float]) -> float:
    """Positive weights prefer closeness; negative weights penalize closeness."""
    if weight and distance_m is not None and distance_m >= 0:
        closeness = math.exp(-distance_m / PREFERENCE_POI_DECAY_M)
        if weight > 0:
            cost += abs(weight) * PREFERENCE_POI_SCALE * (1.0 - closeness)
        else:
            cost += abs(weight) * PREFERENCE_POI_SCALE * closeness
    return cost


# Mirrors environmentalAStar.js getNeighbors NEIGHBOR_TOLERANCE. Without it two
# float pitfalls return too few (often a single) neighbor, so the open set drains
# after the start node and A* never reaches the goal:
#   1) adjacent rows differ by exactly one lat_step, but accumulated float makes the
#      diff a sub-ULP larger than lat_radius, so a bare `<=` rejects it;
#   2) the grid builds lon_step from cos(mid_lat) while this fn computes lon_radius
#      from cos(node['lat']) — off-centre rows never match.
# A 1.5x tolerance restores correct 8-connectivity without over-connecting: the
# next-but-one node is 2 steps away (diff 2*step > 1.5*step) and stays excluded.
_NEIGHBOR_TOLERANCE = 1.5


def get_neighbors(
    node: Dict[str, float],
    grid: List[Dict[str, float]],
    resolution_m: float,
) -> List[Dict[str, float]]:
    lat_mpd = 111320.0
    lon_mpd = 111320.0 * math.cos(math.radians(node['lat']))
    lat_radius = (resolution_m / lat_mpd) * _NEIGHBOR_TOLERANCE
    lon_radius = (resolution_m / lon_mpd) * _NEIGHBOR_TOLERANCE
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
    preferences: Optional[Dict[str, float]] = None,
    poi_lists: Optional[Dict[str, List[Tuple[float, float]]]] = None,
    poi_distances: Optional[Dict[str, Dict[str, Optional[float]]]] = None,
    green_reward_scale: float = 1.0,
) -> float:
    """Port of environmentalAStar.js calculateCost (g-score increment).

    ``green_reward_scale`` (>=1, from the distance-tolerance slider) amplifies the
    green/nature reward so higher tolerance prefers greener (and thus longer) paths.

    P0 audit fix: the green/POI rewards accumulate into a NET ``penalty`` that is
    floored at 0, so the edge increment is always ``distance + max(0, penalty)`` —
    i.e. ALWAYS >= the physical distance and never negative. This keeps the
    straight-line heuristic admissible/consistent (no negative arc weights), while
    greener arcs are still cheaper down to the physical-distance floor.
    """
    distance = haversine_m(current, neighbor)
    env = _get_env(neighbor['lat'], neighbor['lon'])
    name = patient.get('name', 'default')

    if name == 'default':
        return current_g + distance

    penalty = 0.0

    aq_mult = patient.get('airQualitySensitivity', 1) or 1
    slope_mult = patient.get('slopeSensitivity', 1) or 1
    noise_mult = patient.get('noiseSensitivity', 1) or 1
    temp_mult = patient.get('temperatureSensitivity', 1) or 1
    hum_mult = patient.get('humiditySensitivity', 1) or 1

    aq = env['airQuality']
    penalty += (max(0.0, aq - 4.0) ** 2) * aq_mult

    slope = env['slope']
    penalty += (abs(slope) ** 2) * slope_mult / 5.0

    noise = env['noise']
    penalty += max(0.0, noise - 3.0) * noise_mult

    temp_diff = abs(env['temperature'] - 22.0)
    penalty += temp_diff * temp_mult / 3.0

    hum_diff = abs(env['humidity'] - 50.0)
    penalty += hum_diff * hum_mult / 10.0

    if name == 'respiratory':
        penalty += env['trafficDensity'] * aq_mult * 10.0
        penalty -= env['greenVisibility'] * 5.0 * green_reward_scale
    elif name == 'cardiac':
        penalty += (abs(slope) ** 2) * slope_mult / 2.0
        penalty += env['emergencyAccessibility'] * 2.0
    elif name == 'mobility':
        penalty += (abs(slope) ** 2.5) * slope_mult
        penalty += env['surfaceQuality'] * 15.0
    elif name == 'mental':
        penalty += (noise ** 1.5) * noise_mult
        penalty += env['sensoryLoad'] * 2.0
        penalty -= env['greenVisibility'] * 8.0 * green_reward_scale

    # Preference-weight adjustments (combined pathology + user preference)
    prefs = preferences or {}
    combined_nature = patient.get('patientNature', 0) + prefs.get('nature', 0)
    if combined_nature and 'greenVisibility' in env:
        penalty -= env['greenVisibility'] * combined_nature * 0.8 * green_reward_scale

    combined_hospital = patient.get('patientHospital', 0) + prefs.get('hospital', 0)
    if combined_hospital and 'emergencyAccessibility' in env:
        penalty -= env['emergencyAccessibility'] * combined_hospital * 0.8

    combined_entertainment = patient.get('patientEntertainment', 0) + prefs.get('entertainment', 0)
    if combined_entertainment and 'noise' in env:
        penalty -= (env['noise'] / 10) * combined_entertainment * 0.8

    combined_nightlife = patient.get('patientNightlife', 0) + prefs.get('nightlife', 0)
    if combined_nightlife and 'noise' in env:
        penalty -= (env['noise'] / 10) * combined_nightlife * 0.8

    combined_tourism = patient.get('patientTourism', 0) + prefs.get('tourism', 0)
    if combined_tourism and 'greenVisibility' in env:
        penalty -= env['greenVisibility'] * combined_tourism * 0.8 * green_reward_scale

    # Real POI-based preference adjustments (fallback to proxies above when POI data is missing)
    if poi_lists:
        neighbor_id = _node_id(neighbor)
        cached_distances = poi_distances.get(neighbor_id, {}) if poi_distances else {}

        def _poi_distance(category: str) -> Optional[float]:
            if cached_distances:
                return cached_distances.get(category)
            return nearest_poi_distance(neighbor, poi_lists.get(category, []))

        penalty = apply_preference_poi_adjustment(
            penalty,
            patient.get('patientNature', 0) + prefs.get('nature', 0),
            _poi_distance('nature'),
        )
        penalty = apply_preference_poi_adjustment(
            penalty,
            patient.get('patientHospital', 0) + prefs.get('hospital', 0),
            _poi_distance('hospital'),
        )
        penalty = apply_preference_poi_adjustment(
            penalty,
            patient.get('patientEntertainment', 0) + prefs.get('entertainment', 0),
            _poi_distance('entertainment'),
        )
        penalty = apply_preference_poi_adjustment(
            penalty,
            patient.get('patientNightlife', 0) + prefs.get('nightlife', 0),
            _poi_distance('nightlife'),
        )
        penalty = apply_preference_poi_adjustment(
            penalty,
            patient.get('patientTourism', 0) + prefs.get('tourism', 0),
            _poi_distance('tourism'),
        )

    # P0 audit fix: floor the net penalty at 0 so the arc is never below the
    # physical distance and never negative.
    return current_g + distance + max(0.0, penalty)


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


_ENDPOINT_SNAP_TOLERANCE_M = 0.5


def force_exact_endpoints(
    path: List[Dict[str, float]],
    start: Dict[str, float],
    goal: Dict[str, float],
) -> List[Dict[str, float]]:
    """Force the EXACT requested A (start) / B (goal) as the first/last path nodes.

    A* runs on a free grid whose nodes never coincide with the real endpoints, and
    goal is "reached" at any grid node within ``_GOAL_RADIUS_M`` of B. Without this
    snap the corridor would begin/end on an off-target grid node, so the downstream
    ORS/Mapbox snapping would route from/to the wrong point. We snap an endpoint
    already within 0.5 m to the exact coordinate, otherwise append/prepend the exact
    endpoint so the corridor is completed to A/B.
    """
    start_node = {'lat': start['lat'], 'lon': start['lon']}
    goal_node = {'lat': goal['lat'], 'lon': goal['lon']}
    if not path:
        return [start_node, goal_node]

    result = list(path)
    if haversine_m(result[0], start_node) > _ENDPOINT_SNAP_TOLERANCE_M:
        result.insert(0, start_node)
    else:
        result[0] = start_node

    if haversine_m(result[-1], goal_node) > _ENDPOINT_SNAP_TOLERANCE_M:
        result.append(goal_node)
    else:
        result[-1] = goal_node

    return result


def find_optimal_route(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    condition: str = 'respiratory',
    grid_resolution_m: Optional[float] = None,
    preferences: Optional[Dict[str, float]] = None,
    distance_tolerance: float = 1.0,
) -> Dict[str, Any]:
    """
    Environmental A* search. Returns grid path, internal astar_cost (lower=better),
    and path nodes for downstream ORS / multifactor scoring.

    ``distance_tolerance`` is the UI #percentageSlider value (1..10; 1 = baseline):
    higher tolerance widens the search bbox and amplifies the green reward so the
    route is willing to take longer detours through greener areas.
    """
    clear_env_cache()
    start = {'lat': start_lat, 'lon': start_lon}
    goal = {'lat': end_lat, 'lon': end_lon}
    patient = PATIENT_CONDITIONS.get(condition, PATIENT_CONDITIONS['respiratory'])
    green_scale = tolerance_green_scale(distance_tolerance)

    resolution = grid_resolution_m or _adaptive_resolution(start, goal, distance_tolerance=distance_tolerance)
    grid = create_search_grid(start, goal, resolution, distance_tolerance)
    poi_lists = get_poi_lists_for_grid(grid)
    poi_distances = precompute_poi_distances(grid, poi_lists) if poi_lists else None

    # Lazy-deletion binary heap: a node may appear multiple times with different
    # priorities; the stale (already-expanded) copies are skipped on pop. This is
    # the correct decrease-key for heapq, which has no in-place key update.
    open_heap: List[Tuple[float, int, Dict[str, float]]] = []
    counter = 0
    g_score: Dict[str, float] = {}
    f_score: Dict[str, float] = {}
    came_from: Dict[str, Dict[str, float]] = {}

    sid = _node_id(start)
    g_score[sid] = 0.0
    f_score[sid] = estimate_heuristic(start, goal)
    heapq.heappush(open_heap, (f_score[sid], counter, start))
    counter += 1

    closed: set = set()
    best_cost = float('inf')
    best_partial: Optional[List[Dict[str, float]]] = None
    expansions = 0
    direct_dist = haversine_m(start, goal)

    while open_heap and expansions < _MAX_EXPANSIONS:
        _, _, current = heapq.heappop(open_heap)
        cid = _node_id(current)
        # Skip stale heap entries: a node re-pushed with a better priority leaves
        # its worse copy behind, and once expanded (in `closed`) any later pop of
        # it is obsolete. Skipping before counting keeps `expansions` = real work.
        if cid in closed:
            continue
        expansions += 1

        if is_goal_reached(current, goal):
            # Force the EXACT A/B endpoints: goal is reached at a grid node within
            # _GOAL_RADIUS_M of B, so snap/append B (and guarantee A).
            path = force_exact_endpoints(reconstruct_path(came_from, current), start, goal)
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

            tentative = calculate_edge_cost(current, neighbor, g_score[cid], patient, preferences, poi_lists, poi_distances, green_scale)

            if nid not in g_score or tentative < g_score[nid]:
                came_from[nid] = current
                g_score[nid] = tentative
                f_score[nid] = tentative + estimate_heuristic(neighbor, goal)
                # Correct decrease-key for a lazy-deletion heap: ALWAYS push the
                # improved entry. The previous `if nid not in in_open` guard left
                # the heap holding only the OLD (worse) priority, so the better
                # path was recorded in g_score/came_from but never re-prioritized
                # for expansion — breaking A*'s ordering.
                heapq.heappush(open_heap, (f_score[nid], counter, neighbor))
                counter += 1

                if tentative < best_cost and haversine_m(neighbor, goal) < direct_dist * 0.2:
                    best_cost = tentative
                    best_partial = reconstruct_path(came_from, neighbor)

    path = force_exact_endpoints(best_partial or [start, goal], start, goal)
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
