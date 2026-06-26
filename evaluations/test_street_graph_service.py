"""Backend tests for real OSM street-graph and POI proxy plumbing.

Network-free: Overpass is mocked at the service boundary. These tests prove the
backend returns real OSM-shaped nodes/ways without synthetic grids, enforces bbox
guards, keeps the short-lived in-memory cache exact to route/mode, and exposes
all routing POI categories through the backend proxy.
"""

import pytest

from evaluations import environmental_data_service as eds


@pytest.fixture(autouse=True)
def _reset_overpass_state():
    eds.reset_overpass_state()
    yield
    eds.reset_overpass_state()


def _street_graph_payload():
    return {
        'elements': [
            {
                'type': 'way',
                'id': 10,
                'nodes': [1, 2, 3],
                'tags': {'highway': 'residential', 'name': 'Via Test'},
            },
            {
                'type': 'way',
                'id': 11,
                'nodes': [3, 4],
                'tags': {'highway': 'footway', 'oneway': 'yes'},
            },
            {'type': 'node', 'id': 1, 'lat': 44.0000, 'lon': 10.0000},
            {'type': 'node', 'id': 2, 'lat': 44.0005, 'lon': 10.0005},
            {'type': 'node', 'id': 3, 'lat': 44.0010, 'lon': 10.0010},
            {'type': 'node', 'id': 4, 'lat': 44.0015, 'lon': 10.0015},
            # Not referenced by any returned way: must be dropped.
            {'type': 'node', 'id': 999, 'lat': 45.0, 'lon': 11.0},
        ]
    }


def test_fetch_street_graph_returns_real_osm_nodes_and_ways(monkeypatch):
    calls = []

    def fake_overpass(query, breaker=None, timeout=None):
        calls.append({'query': query, 'breaker': breaker, 'timeout': timeout})
        return _street_graph_payload()

    monkeypatch.setattr(eds, '_overpass_post', fake_overpass)

    result = eds.fetch_street_graph(44.0, 10.0, 44.01, 10.01, mode='walking')

    assert result['source'] == 'OpenStreetMap-Overpass'
    assert result['mode'] == 'walking'
    assert result['count'] == {'nodes': 4, 'ways': 2}
    assert {node['id'] for node in result['nodes']} == {1, 2, 3, 4}
    assert result['ways'][0]['highway'] == 'residential'
    assert result['ways'][1]['oneway'] == 'yes'
    assert calls[0]['breaker'] is eds._overpass_street_graph_breaker
    assert calls[0]['timeout'] == eds.OVERPASS_STREET_GRAPH_TIMEOUT
    assert 'way["highway"~' in calls[0]['query']
    assert 'foot' in calls[0]['query']


def test_fetch_street_graph_uses_exact_short_lived_cache(monkeypatch):
    call_count = {'n': 0}

    def fake_overpass(*args, **kwargs):
        call_count['n'] += 1
        return _street_graph_payload()

    monkeypatch.setattr(eds, '_overpass_post', fake_overpass)

    first = eds.fetch_street_graph(44.0, 10.0, 44.01, 10.01, mode='walking')
    second = eds.fetch_street_graph(44.0, 10.0, 44.01, 10.01, mode='walking')
    third = eds.fetch_street_graph(44.0, 10.0, 44.01, 10.01, mode='cycling')

    assert first == second
    assert call_count['n'] == 2
    assert third['mode'] == 'cycling'


def test_fetch_street_graph_rejects_oversized_bbox(monkeypatch):
    monkeypatch.setattr(eds, '_overpass_post', lambda *args, **kwargs: _street_graph_payload())

    with pytest.raises(ValueError, match='street graph bounding box too large'):
        eds.fetch_street_graph(44.0, 10.0, 44.5, 10.01, mode='walking')


@pytest.mark.parametrize(
    ('category', 'tags'),
    [
        ('parks', {'name': 'Parco Test', 'leisure': 'park'}),
        ('hospitals', {'name': 'Hospital Test', 'amenity': 'hospital'}),
        ('entertainment', {'name': 'Cinema Test', 'amenity': 'cinema'}),
        ('nightlife', {'name': 'Pub Test', 'amenity': 'pub'}),
        ('tourism', {'name': 'Museum Test', 'tourism': 'museum'}),
    ],
)
def test_fetch_named_pois_supports_all_routing_categories(monkeypatch, category, tags):
    def fake_overpass(*args, **kwargs):
        return {'elements': [{'type': 'node', 'id': 1, 'lat': 44.0, 'lon': 10.0, 'tags': tags}]}

    monkeypatch.setattr(eds, '_overpass_post', fake_overpass)

    result = eds.fetch_named_pois(category, 43.99, 9.99, 44.01, 10.01)

    assert category in eds.POI_CATEGORIES
    assert result['count'] == 1
    assert result['pois'][0]['name'] == tags['name']
    assert result['source'] == 'OpenStreetMap-Overpass'
