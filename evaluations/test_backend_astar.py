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
