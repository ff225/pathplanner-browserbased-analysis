#!/usr/bin/env python
"""
Mini Route Sampler: generate paired (optimized vs shortest) routes
and persist metrics for quick notebook analysis.

usage:
  pipenv run python scripts/mini_route_sampler.py \
      --cities barcelona munich --pairs 50
"""

import os, sys, random, csv, argparse, json, pathlib, time, requests
import django

# ── Django setup so we can import models ─────────────────────────
BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(BASE_DIR))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from evaluations.models import RouteAnalysis, City  # noqa

# ── Config: city bounding boxes ─────────────────────────────────
CITIES = {
    "barcelona": dict(lat_min=41.30, lat_max=41.46,
                      lon_min=2.05, lon_max=2.23),
    "munich":    dict(lat_min=48.06, lat_max=48.21,
                      lon_min=11.45, lon_max=11.66),
}

PATIENTS = ["respiratory", "cardiac"]    # quick demo

OPTIM_URL = "http://localhost:8000/api/calculate_custom_route"
STD_URL  = "http://localhost:8000/api/shortest_route"

# Helper: random point in bbox
def random_point(cfg):
    lat = random.uniform(cfg["lat_min"], cfg["lat_max"])
    lon = random.uniform(cfg["lon_min"], cfg["lon_max"])
    return lat, lon

def call_route(url, start, end, patient=None):
    params = {
        "start": f"{start[0]},{start[1]}",
        "end":   f"{end[0]},{end[1]}",
    }
    if patient:
        params["patient"] = patient
    resp = requests.get(url, params=params, timeout=25)
    resp.raise_for_status()
    return resp.json()

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--cities", nargs="+", required=True,
                        help="city slugs, e.g. barcelona munich")
    parser.add_argument("--pairs", type=int, default=50,
                        help="how many OD pairs per city")
    parser.add_argument("--save-db", action="store_true",
                        help="also insert into RouteAnalysis")
    args = parser.parse_args(argv)

    for city_slug in args.cities:
        if city_slug not in CITIES:
            print(f"Unknown city: {city_slug}", file=sys.stderr)
            continue
        bbox = CITIES[city_slug]
        rows = []
        print(f"\n▶ Generating {args.pairs} pairs in {city_slug.title()}")

        for i in range(args.pairs):
            start = random_point(bbox)
            end   = random_point(bbox)
            patient = random.choice(PATIENTS)

            try:
                std_js  = call_route(STD_URL,  start, end)
                opt_js  = call_route(OPTIM_URL, start, end, patient)

                row = dict(
                    city=city_slug,
                    patient=patient,
                    start_lat=start[0], start_lon=start[1],
                    end_lat=end[0],     end_lon=end[1],

                    std_dist=std_js["distance_m"],
                    std_time=std_js["duration_s"],
                    std_env= std_js.get("env_score", 0),

                    opt_dist=opt_js["distance_m"],
                    opt_time=opt_js["duration_s"],
                    opt_env= opt_js.get("env_score", 0),
                )
                row["pct_time_diff"]  = (row["opt_time"] - row["std_time"]) / row["std_time"] * 100
                row["pct_env_change"] = (row["std_env"] - row["opt_env"]) / row["std_env"] * 100
                rows.append(row)

                # optional DB insert
                if args.save_db:
                    RouteAnalysis.objects.create(
                        city=City.objects.get_or_create(name=city_slug.title())[0],
                        route_type="optimized",
                        patient_condition=patient,
                        start_lat=start[0], start_lon=start[1],
                        end_lat=end[0],   end_lon=end[1],
                        distance_m=row["opt_dist"],
                        duration_s=row["opt_time"],
                        env_score=row["opt_env"],
                        health_score=row["pct_env_change"],  # placeholder
                        pct_time_diff=row["pct_time_diff"],
                        pct_dist_diff=(row["opt_dist"]-row["std_dist"])/row["std_dist"]*100,
                        pct_env_improve=row["pct_env_change"]
                    )

            except Exception as exc:
                print(f"  pair {i} failed: {exc}")

            time.sleep(0.1)  # be nice to API

        # ── write CSV ────────────────────────────────────────────
        out_csv = BASE_DIR / f"sample_routes_{city_slug}.csv"
        with open(out_csv, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=rows[0].keys())
            writer.writeheader(); writer.writerows(rows)
        print(f"  ✔ saved {len(rows)} rows → {out_csv}")

if __name__ == "__main__":
    main()