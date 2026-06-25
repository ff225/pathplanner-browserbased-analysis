import time
from unittest.mock import patch

import requests
from django.test import TestCase, override_settings

from .real_environment_service import (
    OPEN_METEO_AIR_QUALITY_URL,
    build_environment_payload,
    clear_environment_cache,
)
from .pollen_service import clear_pollen_cache


class MockJsonResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'HTTP {self.status_code}')


@override_settings(OPENAQ_API_KEY='test-openaq-key')
class RealEnvironmentEndpointTests(TestCase):
    def setUp(self):
        clear_environment_cache()

    def tearDown(self):
        clear_environment_cache()

    @patch('evaluations.real_environment_service.requests.get')
    def test_environment_endpoint_parses_open_meteo_and_openaq(self, mock_get):
        mock_get.side_effect = [
            MockJsonResponse({
                'latitude': 41.9,
                'longitude': 12.5,
                'utc_offset_seconds': 7200,
                'current_units': {
                    'time': 'iso8601',
                    'european_aqi': 'EAQI',
                    'pm10': 'ug/m3',
                    'pm2_5': 'ug/m3',
                    'nitrogen_dioxide': 'ug/m3',
                    'ozone': 'ug/m3',
                    'grass_pollen': 'grains/m3',
                },
                'current': {
                    'time': '2026-06-20T17:00',
                    'european_aqi': 61,
                    'pm10': 14.6,
                    'pm2_5': 11.0,
                    'nitrogen_dioxide': 2.2,
                    'ozone': 135.0,
                    'grass_pollen': 22.4,
                },
            }),
            MockJsonResponse({
                'results': [{
                    'id': 7527,
                    'name': 'L.GO MAGNA GRECIA',
                    'distance': 2425.8,
                    'coordinates': {'latitude': 41.883075, 'longitude': 12.50895},
                    'sensors': [
                        {'id': 21804, 'parameter': {'name': 'pm10', 'units': 'ug/m3'}},
                        {'id': 21915, 'parameter': {'name': 'no2', 'units': 'ug/m3'}},
                    ],
                }],
            }),
            MockJsonResponse({
                'results': [
                    {
                        'sensorsId': 21804,
                        'value': 21.0,
                        'datetime': {'utc': '2026-06-20T13:00:00Z'},
                        'coordinates': {'latitude': 41.883064, 'longitude': 12.508939},
                    },
                    {
                        'sensorsId': 21915,
                        'value': 2.0,
                        'datetime': {'utc': '2026-06-20T13:00:00Z'},
                        'coordinates': {'latitude': 41.883064, 'longitude': 12.508939},
                    },
                ],
            }),
        ]

        response = self.client.get(
            '/api/environment',
            {'lat': '41.9028', 'lon': '12.4964', 'pathologies': 'respiratory,allergy'},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['status'], 'available')
        self.assertEqual(payload['pathologies'], ['respiratory', 'allergy'])
        self.assertIn('european_aqi', payload['pollutants'])
        self.assertIn('grass_pollen', payload['pollutants'])

        pm25 = payload['pollutants']['pm2_5']
        self.assertEqual(pm25['value'], 11.0)
        self.assertEqual(pm25['source'], 'Open-Meteo Air Quality API')
        self.assertEqual(pm25['timestamp'], '2026-06-20T17:00:00+02:00')
        self.assertEqual(pm25['lat'], 41.9)
        self.assertEqual(pm25['lon'], 12.5)

        pm10_observation = payload['pollutants']['pm10']['nearest_observation']
        self.assertEqual(pm10_observation['value'], 21.0)
        self.assertEqual(pm10_observation['source'], 'OpenAQ')
        self.assertEqual(pm10_observation['station']['id'], 7527)
        self.assertEqual(pm10_observation['timestamp'], '2026-06-20T13:00:00Z')

        locations_call = mock_get.call_args_list[1]
        self.assertEqual(locations_call.kwargs['headers']['X-API-Key'], 'test-openaq-key')

    def test_environment_endpoint_rejects_invalid_coordinates(self):
        response = self.client.get(
            '/api/environment/',
            {'lat': '100', 'lon': '12.4964', 'pathologies': 'respiratory'},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'error': 'lat must be between -90 and 90'})


@override_settings(OPENAQ_API_KEY='')
class ParallelEnvironmentBuildTests(TestCase):
    """build_environment_payload fans waypoints out across threads; results must
    still map back to the input order and carry the real per-point values."""

    def setUp(self):
        clear_environment_cache()

    def tearDown(self):
        clear_environment_cache()

    @patch('evaluations.real_environment_service.requests.get')
    def test_parallel_build_preserves_waypoint_order(self, mock_get):
        # Distinct waypoints; pm2_5 is keyed to the latitude so each returned
        # point is uniquely identifiable. Earlier waypoints sleep LONGER, so if
        # results were collected by completion order they would come back
        # reversed — the index-based collection must keep input order.
        waypoints = [(40.0, 9.0), (41.0, 9.1), (42.0, 9.2), (43.0, 9.3)]

        def fake_get(url, params=None, **kwargs):
            # No OpenAQ key configured, so only Open-Meteo is ever called.
            self.assertEqual(url, OPEN_METEO_AIR_QUALITY_URL)
            lat = params['latitude']
            lon = params['longitude']
            time.sleep((44.0 - lat) * 0.02)
            return MockJsonResponse({
                'latitude': lat,
                'longitude': lon,
                'utc_offset_seconds': 0,
                'current_units': {
                    'time': 'iso8601',
                    'european_aqi': 'EAQI',
                    'pm2_5': 'ug/m3',
                },
                'current': {
                    'time': '2026-06-25T08:00',
                    'european_aqi': lat,
                    'pm2_5': lat,
                },
            })

        mock_get.side_effect = fake_get

        payload = build_environment_payload(waypoints, 'default')

        self.assertEqual(payload['status'], 'available')
        returned = payload['points']
        self.assertEqual(len(returned), len(waypoints))
        # Order preserved AND each point carries its own real value.
        for (lat, lon), point in zip(waypoints, returned):
            self.assertEqual(point['lat'], lat)
            self.assertEqual(point['lon'], lon)
            self.assertEqual(point['status'], 'available')
            pm25 = point['pollutants']['pm2_5']
            self.assertEqual(pm25['value'], lat)
            self.assertEqual(pm25['source'], 'Open-Meteo Air Quality API')
        # One Open-Meteo call per waypoint.
        self.assertEqual(mock_get.call_count, len(waypoints))


class PollenEndpointTests(TestCase):
    def setUp(self):
        clear_pollen_cache()

    def tearDown(self):
        clear_pollen_cache()

    @staticmethod
    def _open_meteo_pollen_payload():
        return {
            'latitude': 44.6471,
            'longitude': 10.9252,
            'hourly_units': {
                'time': 'iso8601',
                'alder_pollen': 'grains/m³',
                'birch_pollen': 'grains/m³',
                'grass_pollen': 'grains/m³',
                'mugwort_pollen': 'grains/m³',
                'olive_pollen': 'grains/m³',
                'ragweed_pollen': 'grains/m³',
            },
            'hourly': {
                'time': ['2026-06-25T08:00'],
                'alder_pollen': [0.0],
                'birch_pollen': [None],
                'grass_pollen': [22.4],
                'mugwort_pollen': [0.0],
                'olive_pollen': [5.1],
                'ragweed_pollen': [None],
            },
        }

    @patch('evaluations.pollen_service.requests.get')
    def test_pollen_endpoint_parses_open_meteo(self, mock_get):
        mock_get.return_value = MockJsonResponse(self._open_meteo_pollen_payload())

        response = self.client.get('/api/pollen/', {'lat': '44.6471', 'lon': '10.9252'})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['status'], 'available')
        self.assertEqual(payload['provider'], 'Open-Meteo Air Quality API')
        self.assertEqual(payload['unit'], 'grains/m³')
        self.assertEqual(payload['timestamp'], '2026-06-25T08:00')
        self.assertEqual(payload['pollen']['grass']['value'], 22.4)
        self.assertEqual(payload['pollen']['olive']['value'], 5.1)
        # Null variables stay null — never invented.
        self.assertIsNone(payload['pollen']['birch']['value'])
        self.assertIsNone(payload['pollen']['ragweed']['value'])
        self.assertEqual(payload['total'], 27.5)
        self.assertEqual(payload['dominant'], {'type': 'grass', 'value': 22.4})
        self.assertEqual(
            sorted(payload['available_types']),
            ['alder', 'grass', 'mugwort', 'olive'],
        )

        # Explicit connect/read timeout on the outbound HTTP call.
        self.assertEqual(mock_get.call_args.kwargs['timeout'], (5, 10))

    @patch('evaluations.pollen_service.requests.get')
    def test_pollen_endpoint_handles_offseason_nulls(self, mock_get):
        payload = self._open_meteo_pollen_payload()
        for variable in (
            'alder_pollen', 'birch_pollen', 'grass_pollen',
            'mugwort_pollen', 'olive_pollen', 'ragweed_pollen',
        ):
            payload['hourly'][variable] = [None]
        mock_get.return_value = MockJsonResponse(payload)

        response = self.client.get('/api/pollen/', {'lat': '64.0', 'lon': '-20.0'})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['status'], 'unavailable')
        self.assertEqual(body['total'], 0.0)
        self.assertEqual(body['available_types'], [])
        self.assertIsNone(body['dominant'])
        self.assertTrue(body['reason'])
        # No fake values — every type stays null.
        for entry in body['pollen'].values():
            self.assertIsNone(entry['value'])

    @patch('evaluations.pollen_service.requests.get')
    def test_pollen_endpoint_uses_geo_cache(self, mock_get):
        mock_get.return_value = MockJsonResponse(self._open_meteo_pollen_payload())

        first = self.client.get('/api/pollen/', {'lat': '44.6471', 'lon': '10.9252'})
        second = self.client.get('/api/pollen/', {'lat': '44.6472', 'lon': '10.9251'})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        # Both coords round to the same geo-cache cell -> only one upstream call.
        self.assertEqual(mock_get.call_count, 1)

    def test_pollen_endpoint_rejects_invalid_coordinates(self):
        response = self.client.get('/api/pollen/', {'lat': '100', 'lon': '10.0'})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'error': 'lat must be between -90 and 90'})
