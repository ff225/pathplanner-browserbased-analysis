import os
import requests
import math
import time
import json
from datetime import datetime, timedelta

class AirQualityService:
    def __init__(self):
        self.API_URL = 'https://api.openaq.org/v3/locations'
        
        # Default AQI value if API call fails (moderate)
        self.default_aqi = 3
        
        # Map of pollutant levels to AQI scale (1-10, with 10 being worst)
        self.pollutant_thresholds = {
            'pm25': [0, 12, 35.4, 55.4, 150.4, 250.4, 350.4, 500.4, 600, 700],
            'pm10': [0, 54, 154, 254, 354, 424, 504, 604, 800, 1000],
            'o3': [0, 54, 70, 85, 105, 125, 150, 200, 300, 400],
            'no2': [0, 53, 100, 360, 649, 1249, 1649, 2049, 2500, 3000],
            'so2': [0, 35, 75, 185, 304, 604, 804, 1004, 1500, 2000],
            'co': [0, 4.4, 9.4, 12.4, 15.4, 30.4, 40.4, 50.4, 60, 70]
        }

        api_key = os.getenv('OPENAQ_API_KEY', '')
        self.default_headers = {}
        if api_key:
            self.default_headers['X-API-KEY'] = api_key
    
    def convert_to_aqi(self, pollutant, value):
        """
        Convert pollutant concentration to AQI scale (1-10)
        """
        if not value or pollutant not in self.pollutant_thresholds:
            return self.default_aqi
            
        thresholds = self.pollutant_thresholds[pollutant]
        
        for i, threshold in enumerate(thresholds):
            if value <= threshold:
                return i + 1
                
        return 10  # Maximum (worst air quality)
    
    def get_air_quality_data(self, lat, lon):
        """
        Get air quality data for a specific location
        """
        try:
            # Fetch new data from API - using nearest location within 10km
            print(f'Fetching air quality data from API for {lat},{lon}')
            
            # Get location by coordinates
            get_by_coordinate_url = f"{self.API_URL}?coordinates={lat},{lon}&radius=10000&limit=1"
            get_by_coordinate_response = requests.get(get_by_coordinate_url, headers=self.default_headers)
            
            if get_by_coordinate_response.status_code != 200:
                raise Exception(f"Air Quality API error: {get_by_coordinate_response.status_code}")
            
            get_by_coordinate_data = get_by_coordinate_response.json()
            
            if not get_by_coordinate_data.get('results') or len(get_by_coordinate_data['results']) == 0:
                raise Exception('No air quality stations found near this location')
                
            location_data = get_by_coordinate_data['results'][0]
            
            # Get latest air quality data for the location
            get_latest_air_quality_url = f"{self.API_URL}/{location_data['id']}/latest"
            get_latest_air_quality_response = requests.get(get_latest_air_quality_url, headers=self.default_headers)
            
            if get_latest_air_quality_response.status_code != 200:
                raise Exception(f"Air Quality API error: {get_latest_air_quality_response.status_code}")
                
            get_latest_air_quality_data = get_latest_air_quality_response.json()
            
            if not get_latest_air_quality_data.get('results') or len(get_latest_air_quality_data['results']) == 0:
                raise Exception('No air quality measurements found for this location')
            
            parameters = []
            aqi_values = []
            
            # Process the data into a simplified format with AQI values
            for param in get_latest_air_quality_data['results']:
                selected_sensor = next((s for s in location_data['sensors'] if s['id'] == param['sensorsId']), None)
                if selected_sensor:
                    pollutant = selected_sensor['name'].lower()
                    value = param['value']
                    
                    if pollutant in self.pollutant_thresholds and value is not None:
                        aqi_values.append(self.convert_to_aqi(pollutant, value))
                    
                    parameters.append({
                        'parameter': pollutant,
                        'lastValue': value,
                        'unit': selected_sensor['parameter']['units']
                    })
            
            # Get the worst AQI value (highest)
            worst_aqi = max(aqi_values) if aqi_values else self.default_aqi

            air_quality_data = {
                'airQuality': worst_aqi,
                'station': location_data['name'],
                'distance': location_data['distance'],
                'measurements': [{
                    'parameter': p['parameter'],
                    'value': p['lastValue'],
                    'unit': p['unit'],
                    'aqi': self.convert_to_aqi(p['parameter'], p['lastValue'])
                } for p in parameters],
                'timestamp': datetime.now().isoformat()
            }
            
            return air_quality_data
            
        except Exception as error:
            print(f'Error fetching air quality data: {str(error)}')
            
            # Return default values if API call fails
            return {
                'airQuality': self.default_aqi,
                'error': str(error),
                'isDefault': True
            }

air_quality_service = AirQualityService()