"""
Multi-factor environmental score (same weighting logic as backend_js/pathplanner_scorer.js).
Uses real factor values from environmental_data_service — no random simulation.
"""

import os
from typing import Any, Dict

CONDITION_WEIGHTS = {
    'respiratory': {
        'airQuality': 8.0,
        'humidity': 3.5,
        'temperature': 3.0,
        'greenSpace': -5.0,
        'slope': 4.0,
        'noise': 2.0,
        'weather': 1.5,
    },
    'cardiac': {
        'slope': 7.0,
        'temperature': 4.0,
        'airQuality': 3.5,
        'humidity': 2.0,
        'noise': 3.0,
        'greenSpace': -4.0,
        'weather': 2.0,
    },
    'mobility': {
        'slope': 8.0,
        'greenSpace': -3.0,
        'airQuality': 2.0,
        'temperature': 2.0,
        'humidity': 1.5,
        'noise': 1.0,
        'weather': 3.0,
    },
    'mental': {
        'noise': 7.0,
        'greenSpace': -6.0,
        'airQuality': 3.0,
        'temperature': 2.0,
        'humidity': 1.5,
        'slope': 1.0,
        'weather': 2.5,
    },
    'arthritis': {
        'slope': 6.0,
        'temperature': 3.0,
        'humidity': 3.0,
        'weather': 4.0,
        'airQuality': 2.0,
        'greenSpace': -2.0,
        'noise': 1.0,
    },
    'diabetes': {
        'greenSpace': -4.0,
        'slope': 2.0,
        'airQuality': 3.0,
        'temperature': 2.0,
        'humidity': 1.5,
        'noise': 1.0,
        'weather': 1.5,
    },
    'standard': {
        'airQuality': 1.0,
        'temperature': 1.0,
        'humidity': 1.0,
        'noise': 1.0,
        'slope': 1.0,
        'greenSpace': -1.0,
        'weather': 1.0,
    },
}


def calculate_multifactor_score(
    factors: Dict[str, float],
    condition: str = 'respiratory',
    optimized: bool = True,
) -> Dict[str, Any]:
    """
    factors keys: airQuality, temperature, humidity, noise, slope, greenSpace, weather
    airQuality: 1–10 where 10 = worst pollution (matches OpenAQ scale in this project)
    """
    weights = CONDITION_WEIGHTS.get(condition, CONDITION_WEIGHTS['standard'])

    total_score = 0.0
    total_weight = 0.0

    aq = float(factors.get('airQuality', 5.0))
    aq_score = 10.0 - aq
    total_score += aq_score * abs(weights['airQuality'])
    total_weight += abs(weights['airQuality'])

    temp = float(factors.get('temperature', 22.0))
    temp_dev = abs(temp - 22.0)
    temp_score = max(0.0, 10.0 - temp_dev * 0.5)
    total_score += temp_score * abs(weights['temperature'])
    total_weight += abs(weights['temperature'])

    hum = float(factors.get('humidity', 50.0))
    hum_dev = abs(hum - 50.0)
    hum_score = max(0.0, 10.0 - hum_dev * 0.1)
    total_score += hum_score * abs(weights['humidity'])
    total_weight += abs(weights['humidity'])

    noise = float(factors.get('noise', 4.0))
    noise_score = 10.0 - noise
    total_score += noise_score * abs(weights['noise'])
    total_weight += abs(weights['noise'])

    slope = float(factors.get('slope', 3.0))
    slope_score = max(0.0, 10.0 - slope * 0.7)
    total_score += slope_score * abs(weights['slope'])
    total_weight += abs(weights['slope'])

    green = float(factors.get('greenSpace', 3.0))
    total_score += green * abs(weights['greenSpace'])
    total_weight += abs(weights['greenSpace'])

    weather = float(factors.get('weather', 1.0))
    weather_score = 10.0 - weather * 2.0
    total_score += weather_score * abs(weights['weather'])
    total_weight += abs(weights['weather'])

    final_score = total_score / total_weight if total_weight > 0 else 5.0

    if optimized and condition != 'standard':
        final_score = min(10.0, final_score * 1.2 + 1.0)

    # Optional tiny jitter only if explicitly enabled (off by default for reproducibility)
    if os.getenv('USE_SCORE_JITTER', '').lower() in ('1', 'true', 'yes'):
        import random
        final_score += (random.random() - 0.5) * 0.5

    final_score = max(1.0, min(10.0, final_score))

    return {
        'score': round(final_score, 1),
        'factors': factors,
        'weights': weights,
        'method': 'python_multifactor_api',
    }
