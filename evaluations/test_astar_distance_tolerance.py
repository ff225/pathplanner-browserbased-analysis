"""Tests for the distance-tolerance slider wiring in environmental_astar.

Proves the #percentageSlider (1..10) actually changes the A* search so higher
tolerance => longer/greener routes:
  (a) tolerance_padding_deg / tolerance_green_scale: baseline identity at <=1,
      monotonic increase above 1, clamped at 10;
  (b) create_search_grid widens the bbox (more grid nodes) as tolerance rises;
  (c) calculate_edge_cost rewards a green node MORE as the green scale rises,
      so a greener detour out-competes the direct grey path.

Django-free: exercises the pure geometry/cost helpers with a stubbed env lookup.
"""

import pytest

from evaluations import environmental_astar as ea


def test_padding_baseline_and_monotonic():
    base = ea.tolerance_padding_deg(1)
    # slider <= 1 or non-finite keeps the legacy 0.01 deg padding (bit-identical).
    assert base == pytest.approx(0.01)
    assert ea.tolerance_padding_deg(0.5) == pytest.approx(0.01)
    assert ea.tolerance_padding_deg(None) == pytest.approx(0.01)
    # strictly wider as tolerance grows
    assert ea.tolerance_padding_deg(5) > base
    assert ea.tolerance_padding_deg(10) > ea.tolerance_padding_deg(5)
    # clamped at 10
    assert ea.tolerance_padding_deg(50) == pytest.approx(ea.tolerance_padding_deg(10))


def test_green_scale_baseline_and_monotonic():
    assert ea.tolerance_green_scale(1) == pytest.approx(1.0)
    assert ea.tolerance_green_scale(0) == pytest.approx(1.0)
    assert ea.tolerance_green_scale(10) > ea.tolerance_green_scale(5) > 1.0
    assert ea.tolerance_green_scale(99) == pytest.approx(ea.tolerance_green_scale(10))


def test_search_grid_widens_with_tolerance():
    start = {'lat': 44.6400, 'lon': 10.9200}
    goal = {'lat': 44.6600, 'lon': 10.9400}
    resolution = 100.0

    baseline = len(ea.create_search_grid(start, goal, resolution, distance_tolerance=1))
    widened = len(ea.create_search_grid(start, goal, resolution, distance_tolerance=10))

    # A wider bbox at the same resolution must expose strictly more grid nodes,
    # so green detours off the straight line become reachable.
    assert widened > baseline
    # Default arg keeps the legacy bbox (regression guard for existing callers).
    assert len(ea.create_search_grid(start, goal, resolution)) == baseline


def test_green_reward_scales_edge_cost(monkeypatch):
    # Stub the env lookup so the test is deterministic and network-free. The node is
    # green (greenVisibility=1.0) BUT carries a real baseline penalty (poor air
    # quality) so the green reward operates in the positive-penalty regime. The P0
    # audit fix floors the net penalty at 0 (arc >= physical distance), so a node
    # whose reward already exceeds every penalty would clamp to the floor at EVERY
    # tolerance; we keep a positive baseline so the tolerance effect is observable.
    green_env = {
        'airQuality': 8.0, 'temperature': 22.0, 'humidity': 50.0,
        'noise': 3.0, 'slope': 0.0, 'greenSpace': 10.0, 'weather': 1.0,
        'trafficDensity': 0.0, 'greenVisibility': 1.0,
        'emergencyAccessibility': 0.0, 'surfaceQuality': 0.0, 'sensoryLoad': 0.0,
    }
    monkeypatch.setattr(ea, '_get_env', lambda lat, lon: dict(green_env))

    current = {'lat': 44.6400, 'lon': 10.9200}
    neighbor = {'lat': 44.6410, 'lon': 10.9200}
    patient = ea.PATIENT_CONDITIONS['respiratory']
    distance = ea.haversine_m(current, neighbor)

    cost_baseline = ea.calculate_edge_cost(current, neighbor, 0.0, patient, green_reward_scale=1.0)
    cost_high = ea.calculate_edge_cost(
        current, neighbor, 0.0, patient,
        green_reward_scale=ea.tolerance_green_scale(10),
    )

    # Higher tolerance amplifies the green reward (reduces the net penalty), so a
    # greener node has a strictly LOWER edge cost => the algorithm prefers green
    # detours.
    assert cost_high < cost_baseline
    # P0 audit fix: even with the amplified green reward, the arc never drops below
    # the physical distance (no negative weights).
    assert cost_high >= distance
    assert cost_baseline >= distance


def test_negative_poi_weight_penalizes_closeness(monkeypatch):
    """Clinical presets use negative weights for unwanted POIs (e.g. nightlife).

    A nearby unwanted POI must cost MORE than a far unwanted POI; otherwise
    "avoid nightlife" silently behaves like "ignore nightlife".
    """
    neutral = {
        'airQuality': 4.0, 'temperature': 22.0, 'humidity': 50.0,
        'noise': 3.0, 'slope': 0.0, 'greenSpace': 3.0, 'weather': 1.0,
        'trafficDensity': 0.0, 'greenVisibility': 0.3,
        'emergencyAccessibility': 0.7, 'surfaceQuality': 0.0, 'sensoryLoad': 0.0,
    }
    monkeypatch.setattr(ea, '_get_env', lambda lat, lon: dict(neutral))

    current = {'lat': 44.6400, 'lon': 10.9200}
    neighbor = {'lat': 44.6410, 'lon': 10.9200}
    patient = ea.PATIENT_CONDITIONS['respiratory']
    prefs = {'nightlife': -5}

    near_poi = {'nightlife': [(neighbor['lat'], neighbor['lon'])]}
    far_poi = {'nightlife': [(neighbor['lat'] + 0.02, neighbor['lon'] + 0.02)]}

    near_cost = ea.calculate_edge_cost(current, neighbor, 0.0, patient, preferences=prefs, poi_lists=near_poi)
    far_cost = ea.calculate_edge_cost(current, neighbor, 0.0, patient, preferences=prefs, poi_lists=far_poi)

    assert near_cost > far_cost


def test_positive_poi_weight_penalizes_distance(monkeypatch):
    """Positive preference weights should prefer being close to matching POIs."""
    neutral = {
        'airQuality': 4.0, 'temperature': 22.0, 'humidity': 50.0,
        'noise': 3.0, 'slope': 0.0, 'greenSpace': 3.0, 'weather': 1.0,
        'trafficDensity': 0.0, 'greenVisibility': 0.3,
        'emergencyAccessibility': 0.7, 'surfaceQuality': 0.0, 'sensoryLoad': 0.0,
    }
    monkeypatch.setattr(ea, '_get_env', lambda lat, lon: dict(neutral))

    current = {'lat': 44.6400, 'lon': 10.9200}
    neighbor = {'lat': 44.6410, 'lon': 10.9200}
    patient = ea.PATIENT_CONDITIONS['respiratory']
    prefs = {'nature': 5}

    near_poi = {'nature': [(neighbor['lat'], neighbor['lon'])]}
    far_poi = {'nature': [(neighbor['lat'] + 0.02, neighbor['lon'] + 0.02)]}

    near_cost = ea.calculate_edge_cost(current, neighbor, 0.0, patient, preferences=prefs, poi_lists=near_poi)
    far_cost = ea.calculate_edge_cost(current, neighbor, 0.0, patient, preferences=prefs, poi_lists=far_poi)

    assert far_cost > near_cost


def test_find_optimal_route_default_tolerance_is_baseline(monkeypatch):
    # Network-free: stub env to a constant so find_optimal_route only exercises the
    # geometry/threading. Confirms the new param is backward-compatible (default=1).
    neutral = {
        'airQuality': 5.0, 'temperature': 22.0, 'humidity': 50.0,
        'noise': 4.0, 'slope': 3.0, 'greenSpace': 3.0, 'weather': 1.0,
        'trafficDensity': 0.0, 'greenVisibility': 0.3,
        'emergencyAccessibility': 0.7, 'surfaceQuality': 0.3, 'sensoryLoad': 0.4,
    }
    monkeypatch.setattr(ea, '_get_env', lambda lat, lon: dict(neutral))
    monkeypatch.setattr(ea, 'get_poi_lists_for_grid', lambda grid: {})

    res_default = ea.find_optimal_route(44.6400, 10.9200, 44.6450, 10.9250, condition='respiratory')
    res_explicit = ea.find_optimal_route(
        44.6400, 10.9200, 44.6450, 10.9250, condition='respiratory', distance_tolerance=1
    )
    # Default and explicit baseline build the same grid (no behaviour change at x1.0).
    assert res_default['grid_nodes'] == res_explicit['grid_nodes']

    res_wide = ea.find_optimal_route(
        44.6400, 10.9200, 44.6450, 10.9250, condition='respiratory', distance_tolerance=10
    )
    # Higher tolerance searches a wider grid (more nodes) at the same OD pair.
    assert res_wide['grid_nodes'] > res_default['grid_nodes']
