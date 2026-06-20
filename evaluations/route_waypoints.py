"""
Condition-specific waypoint patterns aligned with PathPlanner frontend
(pathplanner-app/static/js/services/routePlanner.js :: generateConditionSpecificWaypoints).

Used by the benchmark API to route smart paths through OpenRouteService (same role as
Mapbox routing in the web UI).
"""

from typing import Dict, List, Tuple

# Maps benchmark condition keys to routePlanner.js patientCondition.name
CONDITION_ALIASES = {
    'respiratory': 'respiratory',
    'cardiac': 'cardiac',
    'mobility': 'mobility',
    'mental': 'mental',
    'arthritis': 'arthritis',
    'diabetes': 'diabetes',
}


def _offset_context(
    start_lat: float, start_lon: float, end_lat: float, end_lon: float
) -> Tuple[float, float, float]:
    mid_lat = (start_lat + end_lat) / 2.0
    mid_lon = (start_lon + end_lon) / 2.0
    lat_diff = abs(start_lat - end_lat)
    lon_diff = abs(start_lon - end_lon)
    offset = max(lat_diff, lon_diff) * 0.4
    return mid_lat, mid_lon, offset


def generate_condition_waypoints(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    condition: str,
) -> List[Dict]:
    """
    Return route patterns: each item has name, description, waypoints [(lat, lon), ...].
    First pattern is direct (baseline geometry); others are condition-specific detours.
    """
    cond = CONDITION_ALIASES.get(condition, condition)
    mid_lat, mid_lon, off = _offset_context(start_lat, start_lon, end_lat, end_lon)
    s, e = (start_lat, start_lon), (end_lat, end_lon)

    patterns: List[Dict] = [
        {
            'name': 'Direct Route',
            'description': 'Shortest path between points',
            'waypoints': [s, e],
        }
    ]

    if cond == 'respiratory':
        patterns.extend([
            {
                'name': 'Green Air Route',
                'description': 'Detour through greener / lower-exposure areas',
                'waypoints': [s, (mid_lat + off * 0.7, mid_lon + off * 0.7), e],
            },
            {
                'name': 'Low Pollution Route',
                'description': 'Detour away from high-traffic corridors',
                'waypoints': [s, (mid_lat - off * 0.3, mid_lon + off * 0.9), e],
            },
            {
                'name': 'Low Exertion Route',
                'description': 'Flatter detour to reduce exertion',
                'waypoints': [s, (mid_lat + off * 0.2, mid_lon - off * 0.8), e],
            },
        ])
    elif cond == 'cardiac':
        patterns.extend([
            {
                'name': 'Heart-Friendly Flat Route',
                'description': 'Minimize elevation change',
                'waypoints': [s, (mid_lat, mid_lon + off * 0.9), e],
            },
            {
                'name': 'Medical Access Route',
                'description': 'Detour near medical-access corridors',
                'waypoints': [s, (mid_lat - off * 0.8, mid_lon - off * 0.2), e],
            },
            {
                'name': 'Rest Areas Route',
                'description': 'Detour via rest-friendly areas',
                'waypoints': [s, (mid_lat + off * 0.6, mid_lon - off * 0.5), e],
            },
        ])
    elif cond == 'mobility':
        patterns.extend([
            {
                'name': 'Wheelchair Accessible Route',
                'description': 'Accessibility-oriented detour',
                'waypoints': [s, (mid_lat + off * 0.1, mid_lon - off * 0.7), e],
            },
            {
                'name': 'Smooth Surface Route',
                'description': 'Prefer maintained corridors',
                'waypoints': [s, (mid_lat - off * 0.5, mid_lon + off * 0.5), e],
            },
            {
                'name': 'Zero-Slope Route',
                'description': 'Avoid inclines where possible',
                'waypoints': [s, (mid_lat, mid_lon + off * 0.8), e],
            },
        ])
    elif cond == 'mental':
        patterns.extend([
            {
                'name': 'Nature Therapy Route',
                'description': 'Detour through green spaces',
                'waypoints': [s, (mid_lat + off * 0.7, mid_lon + off * 0.4), e],
            },
            {
                'name': 'Quiet Zone Route',
                'description': 'Lower-noise detour',
                'waypoints': [s, (mid_lat - off * 0.6, mid_lon + off * 0.6), e],
            },
            {
                'name': 'Low Stimulation Route',
                'description': 'Avoid busy areas',
                'waypoints': [s, (mid_lat + off * 0.3, mid_lon - off * 0.9), e],
            },
        ])
    elif cond == 'arthritis':
        patterns.extend([
            {
                'name': 'Joint-Friendly Surface Route',
                'description': 'Smooth-surface detour',
                'waypoints': [s, (mid_lat - off * 0.4, mid_lon + off * 0.6), e],
            },
            {
                'name': 'Flat Terrain Route',
                'description': 'Minimize joint stress from slopes',
                'waypoints': [s, (mid_lat + off * 0.5, mid_lon - off * 0.3), e],
            },
            {
                'name': 'Rest Stops Route',
                'description': 'Frequent rest opportunities',
                'waypoints': [s, (mid_lat - off * 0.7, mid_lon - off * 0.4), e],
            },
        ])
    elif cond == 'diabetes':
        patterns.extend([
            {
                'name': 'Medical Services Route',
                'description': 'Proximity to medical services',
                'waypoints': [s, (mid_lat - off * 0.5, mid_lon - off * 0.5), e],
            },
            {
                'name': 'Moderate Exertion Route',
                'description': 'Balanced exertion detour',
                'waypoints': [s, (mid_lat + off * 0.4, mid_lon + off * 0.2), e],
            },
            {
                'name': 'Facility Access Route',
                'description': 'Access to facilities along the way',
                'waypoints': [s, (mid_lat - off * 0.3, mid_lon + off * 0.7), e],
            },
        ])
    else:
        patterns.append({
            'name': 'Generic Detour',
            'description': 'Condition-neutral detour',
            'waypoints': [s, (mid_lat + off * 0.5, mid_lon + off * 0.5), e],
        })

    return patterns
