from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from users.models import UserPreferences
from .models import Stazione, Misurazione
from .utils import calculate_route  # Assuming you have a utility function for route calculation
from .air_quality_service import air_quality_service
from .environmental_data_service import environmental_data_service, fetch_named_green_areas
from .real_environment_service import build_environment_payload
from .multifactor_scoring import calculate_multifactor_score
from .route_waypoints import generate_condition_waypoints
from .environmental_astar import find_optimal_route, simplify_path_for_routing, score_path_multifactor
from .detour_limits import select_best_within_detour_policy, detour_metres, MAX_DETOUR_M, BETTER_SCORE_ENV_TOLERANCE_M
import os, time, requests, json, math
from functools import lru_cache

# Retrieve all stations from the database
def stazioni_dati(request):
    stazioni = Stazione.objects.all()
    data = []
    for stazione in stazioni:
        try:
            # Get the latest measurement for the current station
            misurazione = Misurazione.objects.filter(stazione=stazione).latest('data')
             # Append station data and latest measurements to the data list
            data.append({
                'nome': stazione.nome,
                'prov': stazione.provincia,
                'ind': stazione.indirizzo,
                'com': stazione.comune,
                'cod': stazione.codice,
                'lat': stazione.latitudine,
                'lng': stazione.longitudine,
                'pm10': misurazione.pm10,
                'pm25': misurazione.pm25,
                'no2': misurazione.no2,
                'o3': misurazione.o3
            })
        # If no measurement exists, append station data with None for measurement fields
        except Misurazione.DoesNotExist:
            data.append({
                'nome': stazione.nome,
                'prov': stazione.provincia,
                'ind': stazione.indirizzo,
                'com': stazione.comune,
                'cod': stazione.codice,
                'lat': stazione.latitudine,
                'lng': stazione.longitudine,
                'pm10': None,
                'pm25': None,
                'no2': None,
                'o3': None
            })
    # Return the collected data as a JSON response
    return JsonResponse(data, safe=False)

# obtains the preference set chosen by the user when creating a customised route
def get_preferences(request, preference_id):
    preference = UserPreferences.objects.get(id=preference_id)
    data = {
        'nature': preference.nature, 
        'entertainment': preference.entertainment,
        'tourism': preference.tourism,
        'nightlife': preference.nightlife,
        'hospital': preference.hospital,
        # add other preferences if necessary
    }
    return JsonResponse(data)

def _parse_lat_lon_pair(start_location, end_location):
    try:
        s_lat, s_lon = map(float, start_location.split(','))
        e_lat, e_lon = map(float, end_location.split(','))
        return s_lat, s_lon, e_lat, e_lon
    except ValueError:
        return None


def _extract_preferences(request):
    """Build a preferences dict from GET params or JSON body, returning None if absent."""
    keys = ['nature', 'entertainment', 'tourism', 'nightlife', 'hospital']
    prefs = {}
    for key in keys:
        value = request.GET.get(key)
        if value is not None:
            try:
                prefs[key] = float(value)
            except ValueError:
                pass
    if prefs:
        return prefs

    if request.method == 'POST':
        try:
            body = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return None
        for key in keys:
            value = body.get(key)
            if value is not None:
                try:
                    prefs[key] = float(value)
                except (ValueError, TypeError):
                    pass
    return prefs if prefs else None


def _ors_decode_summary(ors_data):
    if 'features' in ors_data and ors_data['features']:
        summary = ors_data['features'][0].get('properties', {}).get('summary', {})
        return summary.get('distance', 0), summary.get('duration', 0)
    if 'routes' in ors_data and ors_data['routes']:
        summary = ors_data['routes'][0]['summary']
        return summary['distance'], summary['duration']
    return None, None


def _ors_request_coords(coords_lat_lon):
    """
    ORS foot-walking route through ordered (lat, lon) waypoints.
    coords_lat_lon: list of (lat, lon)
    """
    key = tuple(coords_lat_lon)
    now = time.time()
    if key in _ors_cache and now - _ors_cache[key][0] < CACHE_TTL:
        return _ors_cache[key][1]

    if not ORS_API_KEY:
        return None

    headers = {'Authorization': ORS_API_KEY, 'Content-Type': 'application/json'}
    body = {
        'coordinates': [[lon, lat] for lat, lon in coords_lat_lon],
        'instructions': False,
    }
    resp = requests.post(ORS_URL, headers=headers, data=json.dumps(body), timeout=60)
    resp.raise_for_status()
    data = resp.json()
    _ors_cache[key] = (now, data)
    return data


def _haversine_m(p1, p2):
    r = 6371000
    lat1, lon1 = math.radians(p1[0]), math.radians(p1[1])
    lat2, lon2 = math.radians(p2[0]), math.radians(p2[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _estimate_walk_metrics(coords_lat_lon):
    """Fallback when ORS is unavailable."""
    dist = 0.0
    for i in range(len(coords_lat_lon) - 1):
        dist += _haversine_m(coords_lat_lon[i], coords_lat_lon[i + 1])
    dist *= 1.4
    speed = 5 * 1000 / 3600
    return round(dist), round(dist / speed)


def _score_waypoints_path(coords_lat_lon, condition, optimized):
    """
    Score a path by averaging multifactor scores at each waypoint
    (aligned with sampling along a routed polyline).
    """
    scores = []
    sources_agg = {}
    for lat, lon in coords_lat_lon:
        env = environmental_data_service.get_environmental_data(lat, lon)
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
            sources_agg[k] = v
    mean_score = sum(scores) / len(scores) if scores else 5.0
    return round(mean_score, 1), sources_agg


def compute_astar_optimized_route(start_location, end_location, condition='respiratory', preferences=None):
    """
    Grid Environmental A* (environmentalAStar.js findOptimalRoute) + ORS snap + multifactor score.
    """
    parsed = _parse_lat_lon_pair(start_location, end_location)
    if not parsed:
        return {'error': 'invalid coordinates'}
    s_lat, s_lon, e_lat, e_lon = parsed

    astar = find_optimal_route(s_lat, s_lon, e_lat, e_lon, condition, preferences=preferences)
    path = astar['path']
    coords = simplify_path_for_routing(path)

    ors_data = _ors_request_coords(coords)
    if ors_data:
        distance_m, duration_s = _ors_decode_summary(ors_data)
        if distance_m is None:
            distance_m, duration_s = _estimate_walk_metrics(coords)
    else:
        distance_m, duration_s = _estimate_walk_metrics(coords)

    env_score, sources = score_path_multifactor(path, condition, optimized=True)

    return {
        'name': f'Environmental A* ({condition})',
        'description': 'Grid-based environmental A* pathfinding (research algorithm)',
        'waypoints': [{'lat': c[0], 'lon': c[1]} for c in coords],
        'astar_path_nodes': len(path),
        'astar_cost': astar.get('astar_cost'),
        'astar_goal_reached': astar.get('goal_reached'),
        'astar_grid_resolution_m': astar.get('grid_resolution_m'),
        'astar_grid_nodes': astar.get('grid_nodes'),
        'astar_expansions': astar.get('expansions'),
        'distance_m': round(distance_m or 0),
        'duration_s': round(duration_s or 0),
        'env_score': env_score,
        'data_sources': sources,
        'scoring_method': 'environmental_astar_grid',
        'patterns_evaluated': 1,
    }


def compute_optimized_pathplanner_route(start_location, end_location, condition='respiratory'):
    """
    PathPlanner-integrated smart route: condition waypoints + ORS geometry + API scoring.
    Mirrors frontend: routePlanner.generateOptimizedRoutes + Mapbox routing.
    """
    parsed = _parse_lat_lon_pair(start_location, end_location)
    if not parsed:
        return {'error': 'invalid coordinates'}
    s_lat, s_lon, e_lat, e_lon = parsed

    baseline_ors = _ors_request_coords([(s_lat, s_lon), (e_lat, e_lon)])
    if baseline_ors:
        baseline_distance_m, _ = _ors_decode_summary(baseline_ors)
        if baseline_distance_m is None:
            baseline_distance_m, _ = _estimate_walk_metrics([(s_lat, s_lon), (e_lat, e_lon)])
    else:
        baseline_distance_m, _ = _estimate_walk_metrics([(s_lat, s_lon), (e_lat, e_lon)])

    patterns = generate_condition_waypoints(s_lat, s_lon, e_lat, e_lon, condition)
    candidates = []

    for pattern in patterns:
        coords = pattern['waypoints']
        ors_data = _ors_request_coords(coords)
        if ors_data:
            distance_m, duration_s = _ors_decode_summary(ors_data)
            if distance_m is None:
                distance_m, duration_s = _estimate_walk_metrics(coords)
        else:
            distance_m, duration_s = _estimate_walk_metrics(coords)

        env_score, sources = _score_waypoints_path(coords, condition, optimized=True)
        candidates.append({
            'name': pattern['name'],
            'description': pattern['description'],
            'waypoints': [{'lat': c[0], 'lon': c[1]} for c in coords],
            'distance_m': round(distance_m or 0),
            'duration_s': round(duration_s or 0),
            'env_score': env_score,
            'data_sources': sources,
            'detour_m': round(detour_metres(distance_m or 0, baseline_distance_m)),
        })

    if not candidates:
        return {'error': 'no route patterns generated'}

    selection = select_best_within_detour_policy(candidates, baseline_distance_m)
    best = selection.get('chosen')
    detour_reason = selection.get('reason')
    if not best:
        best = next(
            (c for c in candidates if 'direct' in c.get('name', '').lower()),
            min(candidates, key=lambda c: c.get('detour_m', 0)),
        )
        detour_reason = 'fallback_direct_detour_cap'
    best['scoring_method'] = 'pathplanner_integrated_optimized'
    best['patterns_evaluated'] = len(candidates)
    best['baseline_distance_m'] = round(baseline_distance_m or 0)
    best['detour_selection'] = detour_reason
    best['detour_policy'] = {
        'max_detour_m': MAX_DETOUR_M,
        'better_score_tolerance_m': BETTER_SCORE_ENV_TOLERANCE_M,
    }
    return best


def astar_route(request):
    """
    Smart route via grid Environmental A* (research; mirrors environmentalAStar.js).
    GET params: start, end, condition
    """
    start_location = request.GET.get('start')
    end_location = request.GET.get('end')
    if not (start_location and end_location):
        return JsonResponse({'error': 'start and end params required'}, status=400)
    condition = request.GET.get('condition', 'respiratory')
    preferences = _extract_preferences(request)
    result = compute_astar_optimized_route(start_location, end_location, condition, preferences=preferences)
    if 'error' in result:
        return JsonResponse(result, status=400)
    return JsonResponse(result)


def optimized_route(request):
    """
    Smart / condition-optimized route for benchmarks.
    GET params: start, end, condition, mode=astar|waypoints|both (default: astar)
    """
    start_location = request.GET.get('start')
    end_location = request.GET.get('end')
    if not (start_location and end_location):
        return JsonResponse({'error': 'start and end params required'}, status=400)
    condition = request.GET.get('condition', 'respiratory')
    mode = (request.GET.get('mode') or 'astar').lower()
    preferences = _extract_preferences(request)

    if mode == 'waypoints':
        result = compute_optimized_pathplanner_route(start_location, end_location, condition)
    elif mode == 'both':
        wp = compute_optimized_pathplanner_route(start_location, end_location, condition)
        ast = compute_astar_optimized_route(start_location, end_location, condition, preferences=preferences)
        if 'error' in wp or 'error' in ast:
            return JsonResponse({'error': wp.get('error') or ast.get('error')}, status=400)
        result = {
            'mode': 'both',
            'waypoints': wp,
            'astar': ast,
            'env_score': ast.get('env_score'),
            'scoring_method': 'comparison_both',
        }
    else:
        result = compute_astar_optimized_route(start_location, end_location, condition, preferences=preferences)

    if 'error' in result:
        return JsonResponse(result, status=400)
    return JsonResponse(result)


def get_env_score(request):
    """Lightweight multifactor score only (legacy fallback; no path geometry)."""
    start_location = request.GET.get('start')
    end_location = request.GET.get('end')
    if not (start_location and end_location):
        return JsonResponse({'error': 'start and end params required'}, status=400)
    condition = request.GET.get('condition', 'respiratory')
    optimized = request.GET.get('optimized', 'true').lower() in ('1', 'true', 'yes')
    score_payload = get_pathplanner_multifactor_score(
        start_location, end_location, condition, optimized
    )
    return JsonResponse({
        'env_score': score_payload['score'],
        'environmental_factors': score_payload.get('factors'),
        'data_sources': score_payload.get('data_sources'),
        'scoring_method': score_payload.get('method', 'python_multifactor_api'),
    })


# View to handle route calculation
def calculate_custom_route(request, preference_id):
    try:
        preference = UserPreferences.objects.get(id=preference_id)
    except UserPreferences.DoesNotExist:
        return JsonResponse(
            {'error': f'UserPreferences id={preference_id} not found. Run validate_setup.py.'},
            status=404,
        )

    start_location = request.GET.get('start')
    end_location = request.GET.get('end')
    condition = request.GET.get('condition', 'respiratory')

    preferences = {
        'nature': preference.nature,
        'entertainment': preference.entertainment,
        'tourism': preference.tourism,
        'nightlife': preference.nightlife,
        'hospital': preference.hospital,
    }

    integrated = compute_optimized_pathplanner_route(start_location, end_location, condition)
    if 'error' not in integrated:
        return JsonResponse({
            'route': integrated.get('waypoints'),
            'route_name': integrated.get('name'),
            'distance_m': integrated.get('distance_m'),
            'duration_s': integrated.get('duration_s'),
            'env_score': integrated['env_score'],
            'data_sources': integrated.get('data_sources'),
            'scoring_method': integrated.get('scoring_method'),
            'patterns_evaluated': integrated.get('patterns_evaluated'),
        })

    try:
        route = calculate_route(start_location, end_location, preferences)
    except Exception as exc:
        print(f'[custom_route] calculate_route failed: {exc}')
        route = [start_location, end_location]

    score_payload = get_pathplanner_multifactor_score(start_location, end_location, condition, True)

    return JsonResponse({
        'route': route,
        'env_score': score_payload['score'],
        'environmental_factors': score_payload.get('factors'),
        'data_sources': score_payload.get('data_sources'),
        'scoring_method': score_payload.get('method', 'python_multifactor_api'),
    })


def get_pathplanner_multifactor_score(start_location, end_location, condition='respiratory', optimized=True):
    """
    Multi-factor score from external APIs (Open-Meteo, OpenAQ, OpenTopoData, OSM Overpass).
    Same weighting as pathplanner_scorer.js calculateActualScore, with real factor values.
    """
    try:
        s_lat, s_lon = map(float, start_location.split(','))
        e_lat, e_lon = map(float, end_location.split(','))
    except ValueError:
        return {'score': 5.0, 'method': 'error', 'factors': {}, 'data_sources': {}}

    env = environmental_data_service.average_route_environment(s_lat, s_lon, e_lat, e_lon)
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
    return {
        'score': result['score'],
        'factors': result['factors'],
        'data_sources': env.get('dataSources', {}),
        'method': result['method'],
        'is_default': env.get('isDefault', False),
    }

# ---------------- Shortest path via OpenRouteService ----------------

ORS_API_KEY = os.getenv('ORS_API_KEY')
ORS_URL = 'https://api.openrouteservice.org/v2/directions/foot-walking'

_ors_cache = {}
CACHE_TTL = 60  # seconds


def _ors_request(start, end):
    key = (start, end)
    now = time.time()
    if key in _ors_cache and now - _ors_cache[key][0] < CACHE_TTL:
        return _ors_cache[key][1]

    headers = {
        'Authorization': ORS_API_KEY,
        'Content-Type': 'application/json'
    }
    body = {
        'coordinates': [[start[1], start[0]], [end[1], end[0]]],
        'instructions': False
    }
    resp = requests.post(ORS_URL, headers=headers, data=json.dumps(body), timeout=30)
    resp.raise_for_status()
    data = resp.json()
    _ors_cache[key] = (now, data)
    return data


def shortest_route(request):
    start_param = request.GET.get('start')
    end_param = request.GET.get('end')
    if not (start_param and end_param):
        return JsonResponse({'error': 'start and end params required'}, status=400)

    try:
        s_lat, s_lon = map(float, start_param.split(','))
        e_lat, e_lon = map(float, end_param.split(','))
    except ValueError:
        return JsonResponse({'error': 'invalid coordinate format'}, status=400)

    # If no ORS API key, use simple distance calculation
    if not ORS_API_KEY:
        import math
        # Haversine formula for distance
        R = 6371000  # Earth radius in meters
        lat1_rad = math.radians(s_lat)
        lat2_rad = math.radians(e_lat)
        delta_lat = math.radians(e_lat - s_lat)
        delta_lon = math.radians(e_lon - s_lon)
        
        a = math.sin(delta_lat/2)**2 + \
            math.cos(lat1_rad) * math.cos(lat2_rad) * \
            math.sin(delta_lon/2)**2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
        distance = R * c
        
        # Estimate walking time: 5 km/h average walking speed
        walking_speed = 5 * 1000 / 3600  # m/s
        duration = distance / walking_speed
        
        score_payload = get_pathplanner_multifactor_score(
            f"{s_lat},{s_lon}",
            f"{e_lat},{e_lon}",
            'standard',
            False,
        )
        return JsonResponse({
            'distance_m': round(distance * 1.4),  # Add 40% for street routing
            'duration_s': round(duration * 1.4),  # Same adjustment
            'env_score': score_payload['score'],
            'environmental_factors': score_payload.get('factors'),
            'data_sources': score_payload.get('data_sources'),
            'scoring_method': score_payload.get('method', 'python_multifactor_api'),
            'note': 'Estimated without ORS API',
        })

    try:
        ors_data = _ors_request((s_lat, s_lon), (e_lat, e_lon))
        
        # ORS returns data in 'features' format
        if 'features' in ors_data and ors_data['features']:
            feature = ors_data['features'][0]
            if 'properties' in feature and 'summary' in feature['properties']:
                summary = feature['properties']['summary']
                distance_m = summary.get('distance', 0)
                duration_s = summary.get('duration', 0)
            else:
                return JsonResponse({'error': 'Invalid ORS response structure'}, status=502)
        # Alternative format (older ORS API)
        elif 'routes' in ors_data and ors_data['routes']:
            summary = ors_data['routes'][0]['summary']
            distance_m = summary['distance']
            duration_s = summary['duration']
        else:
            return JsonResponse({'error': f'Unexpected ORS format: {list(ors_data.keys())}'}, status=502)
            
    except Exception as e:
        return JsonResponse({'error': f'ORS API error: {str(e)}'}, status=502)

    score_payload = get_pathplanner_multifactor_score(
        f"{s_lat},{s_lon}",
        f"{e_lat},{e_lon}",
        'standard',
        False,
    )

    return JsonResponse({
        'distance_m': round(distance_m),
        'duration_s': round(duration_s),
        'env_score': score_payload['score'],
        'environmental_factors': score_payload.get('factors'),
        'data_sources': score_payload.get('data_sources'),
        'scoring_method': score_payload.get('method', 'python_multifactor_api'),
    })

def get_environmental_data(request):
    """All environmental factors at a point (from external APIs)."""
    try:
        lat = float(request.GET.get('lat'))
        lon = float(request.GET.get('lon'))
        data = environmental_data_service.get_environmental_data(lat, lon)
        return JsonResponse(data)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=400)


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def get_real_environment_data(request):
    """
    Real air-quality and pollen values for the selected pathology profile.

    GET:
      /api/environment/?lat=41.9028&lon=12.4964&pathologies=respiratory,allergy
      /api/environment/?waypoints=41.9,12.5;41.91,12.49&condition=cardiac

    POST JSON:
      {"waypoints": [{"lat": 41.9028, "lon": 12.4964}], "pathologies": ["respiratory"]}
    """
    try:
        waypoints, pathologies = _parse_environment_request(request)
        return JsonResponse(build_environment_payload(waypoints, pathologies))
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception:
        return JsonResponse({'error': 'environment data lookup failed'}, status=500)


def _parse_environment_request(request):
    if request.method == 'GET':
        params = request.GET
        pathologies = (
            params.get('pathologies')
            or params.get('conditions')
            or params.get('condition')
            or params.get('pathology')
            or 'default'
        )
        if params.get('waypoints'):
            return _parse_waypoints_string(params['waypoints']), pathologies
        return [(_parse_lat_lon(params.get('lat'), params.get('lon')))], pathologies

    try:
        body = json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError as exc:
        raise ValueError('invalid JSON body') from exc

    pathologies = (
        body.get('pathologies')
        or body.get('conditions')
        or body.get('condition')
        or body.get('pathology')
        or 'default'
    )
    if body.get('waypoints') is not None:
        return _parse_waypoints_body(body['waypoints']), pathologies
    return [(_parse_lat_lon(body.get('lat'), body.get('lon')))], pathologies


def _parse_waypoints_string(value):
    points = []
    for raw_point in value.split(';'):
        raw_point = raw_point.strip()
        if not raw_point:
            continue
        parts = [part.strip() for part in raw_point.split(',')]
        if len(parts) != 2:
            raise ValueError('waypoints must use lat,lon;lat,lon format')
        points.append(_parse_lat_lon(parts[0], parts[1]))
    if not points:
        raise ValueError('at least one waypoint is required')
    return points


def _parse_waypoints_body(value):
    if not isinstance(value, list):
        raise ValueError('waypoints must be a list')
    points = []
    for item in value:
        if isinstance(item, dict):
            points.append(_parse_lat_lon(item.get('lat'), item.get('lon')))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            points.append(_parse_lat_lon(item[0], item[1]))
        else:
            raise ValueError('each waypoint must contain lat and lon')
    if not points:
        raise ValueError('at least one waypoint is required')
    return points


def _parse_lat_lon(raw_lat, raw_lon):
    if raw_lat is None or raw_lon is None:
        raise ValueError('lat and lon parameters are required')
    try:
        lat = float(raw_lat)
        lon = float(raw_lon)
    except (TypeError, ValueError) as exc:
        raise ValueError('lat and lon must be numbers') from exc
    if not -90 <= lat <= 90:
        raise ValueError('lat must be between -90 and 90')
    if not -180 <= lon <= 180:
        raise ValueError('lon must be between -180 and 180')
    return lat, lon


def get_parks_in_bbox(request):
    """Real OSM parks / green areas inside a bounding box.

    GET /api/parks?min_lat=..&min_lon=..&max_lat=..&max_lon=..
    Returns only genuine OpenStreetMap elements (name may be null when unnamed);
    never synthetic. Used to list the green areas a proposed route passes by.
    """
    try:
        min_lat = float(request.GET.get('min_lat'))
        min_lon = float(request.GET.get('min_lon'))
        max_lat = float(request.GET.get('max_lat'))
        max_lon = float(request.GET.get('max_lon'))
    except (TypeError, ValueError):
        return JsonResponse({'error': 'min_lat, min_lon, max_lat, max_lon must be numbers'}, status=400)

    try:
        payload = fetch_named_green_areas(min_lat, min_lon, max_lat, max_lon)
        return JsonResponse(payload)
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception:
        return JsonResponse({'error': 'parks lookup failed'}, status=500)


# View to handle air quality data requests
def get_air_quality_data(request):
    """Get air quality data for a specific location"""
    try:
        # Get latitude and longitude from request parameters
        lat = float(request.GET.get('lat'))
        lon = float(request.GET.get('lon'))
        
        # Use the air quality service to get data
        air_quality_data = air_quality_service.get_air_quality_data(lat, lon)
        
        return JsonResponse(air_quality_data)
    except Exception as e:
        return JsonResponse({
            'airQuality': air_quality_service.default_aqi,
            'error': str(e),
            'isDefault': True
        })
