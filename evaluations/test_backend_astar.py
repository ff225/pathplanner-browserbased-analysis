"""Network-free tests for backend street-graph A*."""

import os

import django
from django.test import RequestFactory

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
django.setup()

from evaluations import backend_astar as ba
from evaluations import views


def _graph_payload(mode='walking'):
    return {
        'mode': mode,
        'source': 'OpenStreetMap-Overpass',
        'nodes': [
            {'id': 1, 'lat': 44.0000, 'lon': 10.0000},
            {'id': 2, 'lat': 44.0005, 'lon': 10.0005},
            {'id': 3, 'lat': 44.0010, 'lon': 10.0010},
            {'id': 4, 'lat': 44.0010, 'lon': 10.0000},
        ],
        'ways': [
            {'id': 10, 'nodes': [1, 2, 3], 'highway': 'residential', 'name': 'Via Test'},
            {'id': 11, 'nodes': [1, 4, 3], 'highway': 'path', 'name': 'Green Path'},
        ],
        'count': {'nodes': 4, 'ways': 2},
    }


def _neutral_env(*args, **kwargs):
    return {
        'airQuality': 4.0,
        'temperature': 22.0,
        'humidity': 50.0,
        'noise': 3.0,
        'slope': 0.0,
        'greenSpace': 6.0,
        'weather': 1.0,
        'dataSources': {'airQuality': 'test'},
    }


def test_backend_astar_generates_real_street_graph_route(monkeypatch):
    monkeypatch.setattr(ba, 'GRAPHHOPPER_URL', '')
    monkeypatch.setattr(ba, 'fetch_street_graph', lambda *args, **kwargs: _graph_payload(kwargs.get('mode', 'walking')))
    monkeypatch.setattr(ba, 'fetch_named_pois', lambda *args, **kwargs: {'pois': [], 'source': 'mock'})
    monkeypatch.setattr(ba, '_fetch_backend_environment_data', lambda lat, lon: _neutral_env())

    payload = ba.generate_backend_astar_routes(
        44.0000,
        10.0000,
        44.0010,
        10.0010,
        condition='respiratory',
        transport_mode='walking',
        alternatives=2,
    )

    assert payload['source'] == 'backend_street_astar'
    assert payload['mode'] == 'walking'
    assert payload['count'] >= 1
    route = payload['routes'][0]
    assert route['routing_basis'] == 'street_graph'
    assert route['goal_reached'] is True
    assert route['path'][0] == {'lat': 44.0, 'lon': 10.0}
    assert route['path'][-1] == {'lat': 44.001, 'lon': 10.001}
    assert isinstance(route['env_score'], float)
    assert route['data_sources']['airQuality'] == 'test'
    assert 'street_graph_and_pois' in payload['parallelism']['parallelized']
    assert 'priority_queue_astar_expansion' in payload['parallelism']['sequential']


def test_backend_astar_uses_graphhopper_when_configured(monkeypatch):
    monkeypatch.setattr(ba, 'GRAPHHOPPER_URL', 'http://graphhopper.test')
    monkeypatch.setattr(ba, '_graphhopper_route_payload', lambda *args, **kwargs: {
        'paths': [
            {
                'distance': 180.0,
                'time': 120000,
                'points': {
                    'coordinates': [
                        [10.0000, 44.0000],
                        [10.0005, 44.0004],
                        [10.0010, 44.0010],
                    ],
                },
            },
            {
                'distance': 210.0,
                'time': 150000,
                'points': {
                    'coordinates': [
                        [10.0000, 44.0000],
                        [10.0000, 44.0008],
                        [10.0010, 44.0010],
                    ],
                },
            },
        ],
    })
    monkeypatch.setattr(ba, 'fetch_street_graph', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('Overpass street graph should not be used')))
    monkeypatch.setattr(ba, 'fetch_named_pois', lambda *args, **kwargs: {'pois': [], 'source': 'mock'})
    monkeypatch.setattr(ba, '_fetch_backend_environment_data', lambda lat, lon: _neutral_env())

    payload = ba.generate_backend_astar_routes(
        44.0000,
        10.0000,
        44.0010,
        10.0010,
        condition='respiratory',
        transport_mode='walking',
        alternatives=2,
    )

    assert payload['source'] == 'graphhopper_candidate_routing'
    assert payload['count'] == 2
    assert payload['routes'][0]['routing_basis'] == 'graphhopper_osm'
    assert payload['routes'][0]['path'][0] == {'lat': 44.0, 'lon': 10.0}
    assert payload['routes'][0]['path'][-1] == {'lat': 44.001, 'lon': 10.001}
    assert payload['street_graph']['source'] == 'GraphHopper local OSM graph'
    assert payload['routes'][0]['explanation']['environment']['sample_count'] >= 1


def test_environment_sampling_is_adaptive_for_route_length():
    short = ba._sample_environment_points(
        {'lat': 44.0, 'lon': 10.0},
        {'lat': 44.01, 'lon': 10.0},
        max_samples=9,
    )
    medium = ba._sample_environment_points(
        {'lat': 44.0, 'lon': 10.0},
        {'lat': 44.05, 'lon': 10.0},
        max_samples=9,
    )
    long = ba._sample_environment_points(
        {'lat': 44.0, 'lon': 10.0},
        {'lat': 44.20, 'lon': 10.0},
        max_samples=9,
    )

    assert len(short) == 3
    assert len(medium) == 5
    assert len(long) == 9


def test_backend_environment_cache_reuses_nearby_points(monkeypatch):
    ba.reset_backend_astar_state()
    calls = {'weather': 0, 'air': 0, 'slope': 0}

    def fake_weather(lat, lon):
        calls['weather'] += 1
        return {
            'temperature': 22,
            'humidity': 50,
            'weather': 1,
            'windSpeed': 2,
            'sources': {'temperature': 'test-weather'},
        }

    def fake_air(lat, lon):
        calls['air'] += 1
        return {'airQuality': 4, 'source': 'test-air', 'isDefault': False}

    def fake_slope(lat, lon):
        calls['slope'] += 1
        return 1.5, 'test-slope'

    monkeypatch.setattr(ba, '_fetch_open_meteo_weather', fake_weather)
    monkeypatch.setattr(ba.air_quality_service, 'get_air_quality_data', fake_air)
    monkeypatch.setattr(ba, '_fetch_slope', fake_slope)

    first = ba._fetch_backend_environment_data(44.0001, 10.0001)
    second = ba._fetch_backend_environment_data(44.0002, 10.0002)

    assert first['cacheHit'] is False
    assert second['cacheHit'] is True
    assert calls == {'weather': 1, 'air': 1, 'slope': 1}


def test_graphhopper_deduplicates_near_identical_alternatives(monkeypatch):
    monkeypatch.setattr(ba, 'GRAPHHOPPER_URL', 'http://graphhopper.test')
    monkeypatch.setattr(ba, '_graphhopper_route_payload', lambda *args, **kwargs: {
        'paths': [
            {
                'distance': 180.0,
                'time': 120000,
                'points': {'coordinates': [[10.0, 44.0], [10.0005, 44.0005], [10.001, 44.001]]},
            },
            {
                'distance': 181.0,
                'time': 121000,
                'points': {'coordinates': [[10.0, 44.0], [10.00051, 44.00051], [10.001, 44.001]]},
            },
        ],
    })
    monkeypatch.setattr(ba, 'fetch_named_pois', lambda *args, **kwargs: {'pois': [], 'source': 'mock'})
    monkeypatch.setattr(ba, '_fetch_backend_environment_data', lambda lat, lon: _neutral_env())
    monkeypatch.setattr(ba, '_fetch_walkability_features', lambda bbox: ([], None))

    payload = ba.generate_backend_astar_routes(
        44.0,
        10.0,
        44.001,
        10.001,
        condition='respiratory',
        transport_mode='walking',
        alternatives=2,
    )

    assert payload['count'] == 1


def test_walkability_features_penalize_candidate_routes(monkeypatch):
    monkeypatch.setattr(ba, 'GRAPHHOPPER_URL', 'http://graphhopper.test')
    monkeypatch.setattr(ba, '_graphhopper_route_payload', lambda *args, **kwargs: {
        'paths': [
            {
                'distance': 180.0,
                'time': 120000,
                'points': {'coordinates': [[10.0, 44.0], [10.0005, 44.0005], [10.001, 44.001]]},
            },
        ],
    })
    monkeypatch.setattr(ba, 'fetch_named_pois', lambda *args, **kwargs: {'pois': [], 'source': 'mock'})
    monkeypatch.setattr(ba, '_fetch_backend_environment_data', lambda lat, lon: _neutral_env())
    monkeypatch.setattr(ba, '_fetch_walkability_features', lambda bbox: ([
        {'category': 'steps', 'kind': 'steps', 'lat': 44.0005, 'lon': 10.0005},
    ], 'test-walkability'))

    payload = ba.generate_backend_astar_routes(
        44.0,
        10.0,
        44.001,
        10.001,
        condition='mobility',
        transport_mode='walking',
        alternatives=1,
    )

    route = payload['routes'][0]
    assert route['data_sources']['walkability'] == 'test-walkability'
    assert route['explanation']['walkability']['penalty'] > 0
    assert route['explanation']['walkability']['hits'][0]['category'] == 'steps'


def test_backend_astar_view_returns_503_when_real_osm_unavailable(monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError('Overpass unavailable for street graph lookup')

    monkeypatch.setattr(views, 'generate_backend_astar_routes', unavailable)
    request = RequestFactory().get(
        '/api/backend_astar/',
        {
            'start': '44.0,10.0',
            'end': '44.001,10.001',
            'condition': 'respiratory',
        },
    )

    response = views.backend_astar_route(request)

    assert response.status_code == 503
    assert b'Overpass unavailable for street graph lookup' in response.content


def test_build_street_graph_respects_oneway_only_for_car():
    payload = {
        'mode': 'car',
        'nodes': [
            {'id': 1, 'lat': 44.0, 'lon': 10.0},
            {'id': 2, 'lat': 44.0, 'lon': 10.001},
        ],
        'ways': [
            {'id': 99, 'nodes': [1, 2], 'highway': 'residential', 'oneway': 'yes'},
        ],
    }

    car_graph = ba._build_street_graph(payload)
    walking_graph = ba._build_street_graph({**payload, 'mode': 'walking'})

    assert len(car_graph['adjacency']['1']) == 1
    assert car_graph['adjacency']['2'] == []
    assert len(walking_graph['adjacency']['1']) == 1
    assert len(walking_graph['adjacency']['2']) == 1
