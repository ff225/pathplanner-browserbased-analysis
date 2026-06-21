#!/usr/bin/env python3
"""
Benchmark POI-distance precomputation for the A* grid.

Compares sequential (1 worker) vs parallel (4 workers) precomputation
using the same helper used by evaluations/environmental_astar.py.
"""

import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
import django  # noqa: E402

django.setup()

from evaluations.environmental_astar import (  # noqa: E402
    nearest_poi_distance,
    precompute_poi_distances,
)


def make_grid(count: int, center_lat: float, center_lon: float, span: float):
    return [
        {
            "lat": center_lat + (random.random() - 0.5) * span,
            "lon": center_lon + (random.random() - 0.5) * span,
        }
        for _ in range(count)
    ]


def make_pois(count: int, center_lat: float, center_lon: float, span: float):
    return [
        (center_lat + (random.random() - 0.5) * span, center_lon + (random.random() - 0.5) * span)
        for _ in range(count)
    ]


def brute_force_precompute(grid, poi_lists):
    """Baseline: scan every POI list for every node."""
    return {
        f"{node['lat']:.6f},{node['lon']:.6f}": {
            category: nearest_poi_distance(node, poi_list)
            for category, poi_list in poi_lists.items()
        }
        for node in grid
    }


def main():
    random.seed(42)
    grid = make_grid(5000, 44.64, 10.92, 0.02)
    poi_lists = {
        category: make_pois(80, 44.64, 10.92, 0.02)
        for category in ["nature", "entertainment", "nightlife", "tourism", "hospital"]
    }

    print(f"Grid nodes: {len(grid)}")
    print(f"POIs per category: {len(poi_lists['nature'])}")
    print("Warming up...")
    precompute_poi_distances(grid, poi_lists)

    # Baseline brute force
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        result = brute_force_precompute(grid, poi_lists)
        t1 = time.perf_counter()
        times.append(t1 - t0)
        assert len(result) == len(grid)
    avg = sum(times) / len(times)
    print(f"  brute-force scan: avg {avg:.3f}s (runs: {[f'{t:.3f}' for t in times]})")

    # Spatial index
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        result = precompute_poi_distances(grid, poi_lists)
        t1 = time.perf_counter()
        times.append(t1 - t0)
        assert len(result) == len(grid)
    avg = sum(times) / len(times)
    print(f"  spatial-index precompute: avg {avg:.3f}s (runs: {[f'{t:.3f}' for t in times]})")


if __name__ == "__main__":
    main()
