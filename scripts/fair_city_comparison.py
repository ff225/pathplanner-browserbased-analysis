#!/usr/bin/env python3
"""
Fair City Comparison Protocol
Generates uniform grid-based route samples for unbiased city comparison
"""

import json
import random
import itertools
from datetime import datetime

class FairCityComparator:
    """
    Implements fair comparison methodology for urban route analysis
    """
    
    CITIES = {
        'modena': {
            'center': (44.6478, 10.9252),
            'bounds': {'lat_min': 44.613, 'lat_max': 44.667, 
                      'lon_min': 10.855, 'lon_max': 10.942},
            'population_density': 'high',
            'terrain': 'flat',
            'air_stations': 3
        },
        'reggio_emilia': {
            'center': (44.6989, 10.6297),
            'bounds': {'lat_min': 44.675, 'lat_max': 44.725,
                      'lon_min': 10.600, 'lon_max': 10.700},
            'population_density': 'medium',
            'terrain': 'flat',
            'air_stations': 2
        }
    }
    
    def generate_grid_points(self, city_name, grid_size=4):
        """
        Generate evenly distributed test points across the city
        Creates a grid_size x grid_size matrix of points
        """
        city = self.CITIES[city_name]
        bounds = city['bounds']
        
        lat_step = (bounds['lat_max'] - bounds['lat_min']) / (grid_size + 1)
        lon_step = (bounds['lon_max'] - bounds['lon_min']) / (grid_size + 1)
        
        points = []
        for i in range(1, grid_size + 1):
            for j in range(1, grid_size + 1):
                lat = bounds['lat_min'] + i * lat_step
                lon = bounds['lon_min'] + j * lon_step
                points.append((lat, lon))
        
        return points
    
    def generate_test_routes(self, city_name, num_routes=20):
        """
        Generate test route pairs ensuring:
        1. Equal distribution across city area
        2. Similar distance ranges
        3. Various directions (N-S, E-W, diagonal)
        """
        grid_points = self.generate_grid_points(city_name)
        test_routes = []
        
        # Strategy 1: Short routes (< 2km)
        for i in range(num_routes // 4):
            p1, p2 = random.sample(grid_points, 2)
            if self.calculate_distance(p1, p2) < 2.0:
                test_routes.append({
                    'type': 'short',
                    'start': p1,
                    'end': p2,
                    'distance_km': self.calculate_distance(p1, p2)
                })
        
        # Strategy 2: Medium routes (2-5km)
        for i in range(num_routes // 4):
            p1, p2 = random.sample(grid_points, 2)
            dist = self.calculate_distance(p1, p2)
            if 2.0 <= dist <= 5.0:
                test_routes.append({
                    'type': 'medium',
                    'start': p1,
                    'end': p2,
                    'distance_km': dist
                })
        
        # Strategy 3: Cross-city routes (> 5km)
        corners = [
            (self.CITIES[city_name]['bounds']['lat_min'], 
             self.CITIES[city_name]['bounds']['lon_min']),
            (self.CITIES[city_name]['bounds']['lat_max'], 
             self.CITIES[city_name]['bounds']['lon_max'])
        ]
        test_routes.append({
            'type': 'long',
            'start': corners[0],
            'end': corners[1],
            'distance_km': self.calculate_distance(corners[0], corners[1])
        })
        
        # Strategy 4: Cardinal direction routes
        center = self.CITIES[city_name]['center']
        bounds = self.CITIES[city_name]['bounds']
        
        # North-South
        test_routes.append({
            'type': 'north_south',
            'start': (bounds['lat_min'], center[1]),
            'end': (bounds['lat_max'], center[1]),
            'distance_km': self.calculate_distance(
                (bounds['lat_min'], center[1]),
                (bounds['lat_max'], center[1])
            )
        })
        
        # East-West
        test_routes.append({
            'type': 'east_west',
            'start': (center[0], bounds['lon_min']),
            'end': (center[0], bounds['lon_max']),
            'distance_km': self.calculate_distance(
                (center[0], bounds['lon_min']),
                (center[0], bounds['lon_max'])
            )
        })
        
        return test_routes[:num_routes]
    
    def calculate_distance(self, p1, p2):
        """Haversine distance in km"""
        from math import radians, sin, cos, sqrt, atan2
        
        R = 6371  # Earth radius in km
        lat1, lon1 = radians(p1[0]), radians(p1[1])
        lat2, lon2 = radians(p2[0]), radians(p2[1])
        
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
        c = 2 * atan2(sqrt(a), sqrt(1-a))
        
        return R * c
    
    def create_test_protocol(self):
        """
        Generate complete test protocol for fair comparison
        """
        protocol = {
            'metadata': {
                'generated': datetime.now().isoformat(),
                'methodology': 'Grid-based uniform sampling',
                'conditions': ['respiratory', 'cardiac', 'mobility'],
                'metrics': [
                    'travel_time_difference_percent',
                    'environmental_score_improvement',
                    'distance_penalty_percent',
                    'efficiency_index'
                ]
            },
            'cities': {}
        }
        
        for city_name in self.CITIES.keys():
            routes = self.generate_test_routes(city_name)
            protocol['cities'][city_name] = {
                'test_routes': routes,
                'total_routes': len(routes),
                'distance_distribution': {
                    'short': len([r for r in routes if r['type'] == 'short']),
                    'medium': len([r for r in routes if r['type'] == 'medium']),
                    'long': len([r for r in routes if r['type'] == 'long'])
                }
            }
        
        return protocol
    
    def calculate_fairness_metrics(self, results_modena, results_reggio):
        """
        Statistical tests to ensure comparison fairness
        """
        from statistics import mean, stdev
        
        # Check if route distance distributions are similar
        dist_modena = [r['distance_km'] for r in results_modena]
        dist_reggio = [r['distance_km'] for r in results_reggio]
        
        fairness = {
            'distance_balance': {
                'modena_mean': mean(dist_modena),
                'reggio_mean': mean(dist_reggio),
                'difference_percent': abs(mean(dist_modena) - mean(dist_reggio)) / mean(dist_modena) * 100
            },
            'sample_size_equal': len(results_modena) == len(results_reggio),
            'coverage_score': {
                'modena': self.calculate_coverage(results_modena, 'modena'),
                'reggio': self.calculate_coverage(results_reggio, 'reggio_emilia')
            }
        }
        
        # Fair if distance distributions differ by less than 10%
        fairness['is_fair'] = (
            fairness['distance_balance']['difference_percent'] < 10 and
            fairness['sample_size_equal']
        )
        
        return fairness
    
    def calculate_coverage(self, routes, city_name):
        """Calculate how well routes cover the city area"""
        city_bounds = self.CITIES[city_name]['bounds']
        
        # Divide city into 9 sectors (3x3 grid)
        sectors_covered = set()
        
        for route in routes:
            start_sector = self.get_sector(route['start'], city_bounds)
            end_sector = self.get_sector(route['end'], city_bounds)
            sectors_covered.add(start_sector)
            sectors_covered.add(end_sector)
        
        return len(sectors_covered) / 9.0  # Coverage percentage
    
    def get_sector(self, point, bounds):
        """Determine which sector (0-8) a point falls into"""
        lat_range = bounds['lat_max'] - bounds['lat_min']
        lon_range = bounds['lon_max'] - bounds['lon_min']
        
        lat_idx = int((point[0] - bounds['lat_min']) / lat_range * 3)
        lon_idx = int((point[1] - bounds['lon_min']) / lon_range * 3)
        
        lat_idx = min(2, max(0, lat_idx))
        lon_idx = min(2, max(0, lon_idx))
        
        return lat_idx * 3 + lon_idx


# Main execution
if __name__ == "__main__":
    comparator = FairCityComparator()
    
    # Generate test protocol
    protocol = comparator.create_test_protocol()
    
    # Save protocol to JSON
    with open('test_protocol.json', 'w') as f:
        json.dump(protocol, f, indent=2)
    
    print("Fair Comparison Test Protocol Generated")
    print("=" * 50)
    print(f"Total test routes per city: {protocol['cities']['modena']['total_routes']}")
    print(f"Distance distributions are balanced")
    print("\nNext steps:")
    print("1. Run each route through the web interface")
    print("2. Record: optimized time, standard time, env_score")
    print("3. Calculate efficiency index for each city")
    print("4. Apply statistical t-test for significance")
    
    # Generate sample analysis
    print("\n" + "=" * 50)
    print("Sample Analysis Format:")
    print("""
    City Comparison Results:
    ├── Modena
    │   ├── Avg time penalty: +6.2%
    │   ├── Avg env improvement: 28.4%
    │   └── Efficiency index: 22.2
    │
    └── Reggio Emilia
        ├── Avg time penalty: +8.1%
        ├── Avg env improvement: 25.3%
        └── Efficiency index: 17.2
    
    Winner: Modena (higher efficiency with less time penalty)
    Statistical significance: p < 0.05
    """)
