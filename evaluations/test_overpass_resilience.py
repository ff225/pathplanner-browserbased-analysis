"""Resilience tests for the Overpass path in environmental_data_service.

Proves the three guarantees added for env-A* (3 Overpass queries per node):
  (a) the circuit-breaker opens after N consecutive failed calls and then
      short-circuits without further HTTP,
  (b) a nearby coordinate hits the geospatial cache and avoids a 2nd HTTP call,
  (c) exponential backoff is applied between mirror retries.

Django-free: imports the service module directly, no settings required.
"""

from unittest.mock import patch

import pytest
import requests

from evaluations import environmental_data_service as eds


class _MockResponse:
    def __init__(self, payload, ok=True, status_code=200):
        self._payload = payload
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def _reset_overpass_state():
    eds.reset_overpass_state()
    yield
    eds.reset_overpass_state()


def test_breaker_opens_after_threshold_then_short_circuits():
    threshold = eds.OVERPASS_BREAKER_THRESHOLD
    n_mirrors = len(eds.OVERPASS_URLS)

    with patch.object(eds.requests, 'post', side_effect=requests.exceptions.Timeout('boom')) as mock_post, \
            patch.object(eds.time, 'sleep'):
        # The breaker is closed for the first `threshold` calls — each tries
        # every mirror and fails, recording one failure per call.
        for _ in range(threshold):
            assert eds._overpass_post('q') is None
            assert mock_post.called

        assert eds._overpass_breaker.is_open() is True
        http_calls_before = mock_post.call_count

        # Breaker is now open: the next call must short-circuit with NO HTTP.
        assert eds._overpass_post('q') is None
        assert mock_post.call_count == http_calls_before

    # Every failed call attempted all mirrors before recording the failure.
    assert http_calls_before == threshold * n_mirrors


def test_geocache_hit_avoids_second_http_call():
    payload = {'elements': [{'tags': {'leisure': 2}}]}

    with patch.object(eds.requests, 'post', return_value=_MockResponse(payload)) as mock_post:
        # Two coordinates in the SAME ~110 m grid cell (round(.,3) == 44.5,11.3).
        v1, s1 = eds._fetch_green_space(44.5000, 11.3000)
        v2, s2 = eds._fetch_green_space(44.5004, 11.3004)

    assert mock_post.call_count == 1  # second fetch served from the geo cache
    assert v1 == v2
    assert s1 == s2 == 'OpenStreetMap-Overpass'


def test_geocache_does_not_cache_failures():
    # When Overpass is unavailable the result must NOT be cached, so a later
    # call retries once the mirrors recover.
    fail = requests.exceptions.ConnectionError('down')
    ok_payload = {'elements': [{'tags': {'leisure': 3}}]}

    with patch.object(eds.time, 'sleep'), \
            patch.object(eds.requests, 'post', side_effect=fail):
        val, src = eds._fetch_green_space(45.0, 9.0)
    assert val is None and src == 'none'

    eds._overpass_breaker.record_success()  # clear failure count from the outage
    with patch.object(eds.requests, 'post', return_value=_MockResponse(ok_payload)) as mock_post:
        val2, src2 = eds._fetch_green_space(45.0, 9.0)
    assert mock_post.call_count == 1  # retried — no poisoned cache entry
    assert val2 is not None and src2 == 'OpenStreetMap-Overpass'


def test_backoff_is_applied_between_mirrors():
    n_mirrors = len(eds.OVERPASS_URLS)

    with patch.object(eds.requests, 'post', side_effect=requests.exceptions.ConnectionError('down')), \
            patch.object(eds.random, 'uniform', side_effect=lambda a, b: b) as mock_uniform, \
            patch.object(eds.time, 'sleep') as mock_sleep:
        assert eds._overpass_post('q') is None

    # One backoff sleep between each pair of mirror attempts -> n-1 sleeps.
    assert mock_sleep.call_count == n_mirrors - 1
    delays = [call.args[0] for call in mock_sleep.call_args_list]
    # Delays grow exponentially: base, base*2, base*4, ... (capped via full jitter).
    expected = [eds.OVERPASS_BACKOFF_BASE * (2 ** i) for i in range(n_mirrors - 1)]
    assert delays == expected
    assert mock_uniform.call_count == n_mirrors - 1


def test_breaker_half_opens_after_cooldown():
    breaker = eds._overpass_breaker
    breaker.failures = eds.OVERPASS_BREAKER_THRESHOLD
    breaker.opened_at = 1000.0

    with patch.object(eds.time, 'time', return_value=1000.0 + eds.OVERPASS_BREAKER_COOLDOWN - 1):
        assert breaker.is_open() is True

    with patch.object(eds.time, 'time', return_value=1000.0 + eds.OVERPASS_BREAKER_COOLDOWN + 1):
        # Cooldown elapsed -> half-open: is_open() returns False and resets state
        # so the next call goes through as a trial.
        assert breaker.is_open() is False
    assert breaker.failures == 0
    assert breaker.opened_at is None
