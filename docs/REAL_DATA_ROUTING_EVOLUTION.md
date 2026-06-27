# Real Data Routing Evolution

This document explains how route generation and environmental POI lookup worked
before, how it works now, what changed in the repository/Docker setup, and why
those changes matter for the clinical routing demo.

## Summary

The project moved from a browser/Overpass-heavy routing flow to a backend-first
real-data flow:

- road routes now come from a local GraphHopper service built from an explicit
  OSM PBF extract;
- parks, hospitals, nightlife, tourism, and similar POIs can now come from a
  local SQLite database extracted from the same OSM PBF;
- short routes now use fewer environmental samples, and repeated samples are
  cached briefly to avoid redundant calls to air/weather/elevation providers;
- route payloads now include an `explanation` object with environmental summary,
  nearest POIs, walkability signals, data sources, and readable reasons;
- the route selector UI can show those explanations and sources directly in the
  route card;
- public Overpass remains as fallback, not as the preferred runtime dependency;
- the Docker setup mounts generated local routing/POI data instead of baking
  large PBF or SQLite files into the image.

The main result is not only speed. It is predictability: the app no longer
depends on public Overpass latency or rate limits for the most important route
and POI operations during a demo.

## How It Worked Before

### Routing

Previously, routing had two weaker paths:

- browser-side or frontend-assisted A* behavior could still be involved;
- backend A* could fetch an OSM street graph from public Overpass for the route
  corridor.

That meant the app had to acquire street graph data during user interaction.
For small routes this could work, but it was vulnerable to:

- public Overpass timeout;
- mirror instability;
- variable latency depending on city, bbox size, and public server load;
- duplicate or low-quality alternatives if candidate generation returned very
  similar geometries.

### POI And Environmental Context

POIs such as parks and hospitals were also fetched from public Overpass at route
time. This created a second latency source after the route geometry itself.

In practice, this meant a route could appear first, while parks/hospitals arrived
later or timed out. That was especially bad for this app, because the POIs are
not decorative: they affect clinical/environmental scoring.

### Docker

Docker originally ran the Django app, but large local routing artifacts were not
part of a clean runtime contract. During one rebuild, Docker tried to send local
PBF/runtime data as build context, which made the context several GB.

That was fixed by excluding generated data from the image context and mounting
runtime data explicitly.

## How It Works Now

### Road Route Candidates

The backend first asks a local GraphHopper service for route candidates.

GraphHopper is started separately and points at a local imported OSM extract:

```bash
scripts/start_graphhopper.sh italy
```

or equivalent Docker command using:

```text
pbf/italy-260626.osm.pbf
runtime/graphhopper/graphs/italy-gh9
runtime/graphhopper/config/pathplanner-demo.yml
```

The Django backend calls GraphHopper through:

```env
GRAPHHOPPER_URL=http://host.docker.internal:8989
GRAPHHOPPER_TIMEOUT_SECONDS=8
GRAPHHOPPER_FORCE=false
```

If GraphHopper returns usable candidates, the backend scores them with the
clinical/environmental weights. If GraphHopper is unavailable and
`GRAPHHOPPER_FORCE=false`, the backend can still fall back to the old Overpass
street-graph A* path.

### POI Lookup

POIs can now be served from a local SQLite index extracted from the PBF:

```text
runtime/local_osm_pois/italy.sqlite3
```

The backend uses it when this env var is configured:

```env
LOCAL_OSM_POI_DB=/app/runtime/local_osm_pois/italy.sqlite3
```

The POI categories currently extracted include:

- `parks`
- `hospitals`
- `entertainment`
- `nightlife`
- `tourism`
- `pharmacies`
- `toilets`
- `drinking_water`
- `bench`

For route scoring, the most important categories today are mapped like this:

| Backend scoring category | Local POI category |
| --- | --- |
| `nature` | `parks` |
| `hospital` | `hospitals` |
| `nightlife` | `nightlife` |
| `tourism` | `tourism` |
| `entertainment` | `entertainment` |

The backend still uses Overpass as fallback if no local DB is configured.

### Walkability And Slope

The code can extract real OSM walkability tags:

- `highway=steps`
- `incline=*`
- `surface=*`
- `smoothness=*`
- `wheelchair=*`

Important limitation: a PBF does not contain a full elevation model. OSM
`incline=*` is useful when present, but true continuous terrain slope still
requires an elevation source or a local DEM. Currently, route slope values still
come from elevation APIs such as OpenTopoData/Open-Meteo unless we add a local
DEM pipeline.

The current Italy DB has been rebuilt with full walkability extraction enabled,
so the backend can use local `walkability_feature` rows at route time. These
features penalize routes near steps, steep inclines, bad surfaces, poor
smoothness, or limited wheelchair accessibility. The penalty is stronger for
profiles such as `mobility`, `arthritis`, and `cardiac`.

Current status:

- route scoring already calls the local walkability lookup;
- penalties are applied when matching rows exist in the SQLite DB;
- `runtime/local_osm_pois/italy.sqlite3` now contains `2,999,868`
  walkability rows from the Italy PBF;
- the previous POI-only DB was preserved locally as
  `runtime/local_osm_pois/italy.poi-only.20260627-160103.sqlite3`.

### Environmental Sampling And Caching

The backend no longer samples every short route with the maximum number of
environmental points.

Current behavior:

| Straight-line route length | Environment samples |
| ---: | ---: |
| <= 3 km | 3 |
| <= 8 km | 5 |
| longer | up to `BACKEND_ASTAR_MAX_ENV_SAMPLES` |

Each sampled point uses a short-lived backend cache:

```env
BACKEND_ASTAR_ENV_CACHE_TTL_SECONDS=600
BACKEND_ASTAR_ENV_CACHE_PRECISION=3
BACKEND_ASTAR_WALKABILITY_RADIUS_M=35
```

This matters because air quality/weather often has coarser spatial resolution
than individual street segments. Calling the same external provider for many
nearby points on a short route does not necessarily improve clinical accuracy,
but it does increase latency and timeout risk.

For the current app, this is the intended tradeoff: on short urban routes, air
quality is usually not precise enough to justify many per-segment calls. The
backend samples enough points to detect meaningful changes while keeping route
calculation responsive.

## What Changed In The Repo

### New Local OSM POI Service

File:

```text
evaluations/local_osm_poi_service.py
```

Responsibilities:

- parse OSM PBF files with `osmium`;
- classify OSM tags into app POI categories;
- write POIs to SQLite;
- create query indexes;
- serve bbox POI queries from local SQLite;
- optionally serve walkability features.

### New Build Script

File:

```text
scripts/build_local_osm_pois.py
```

Build the full POI + walkability DB from a PBF:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --pbf pbf/italy-260626.osm.pbf \
  --db runtime/local_osm_pois/italy.sqlite3
```

Build a faster POI-only DB when walkability is not needed:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --pbf pbf/italy-260626.osm.pbf \
  --db runtime/local_osm_pois/italy.poi-only.sqlite3 \
  --poi-only
```

Refresh indexes on an existing DB:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --db runtime/local_osm_pois/italy.sqlite3 \
  --optimize-only
```

### New Ensure Script For Server Bootstrap

File:

```text
scripts/ensure_local_osm_poi_db.py
```

Purpose:

- check whether the configured SQLite DB exists and is valid;
- do nothing when the DB already has enough POI/walkability rows;
- if the DB is missing, import it from the configured PBF;
- build into a temporary file first;
- atomically replace the target DB only after the import validates.

Local check:

```bash
LOCAL_OSM_POI_DB=runtime/local_osm_pois/italy.sqlite3 \
LOCAL_OSM_PBF_PATH=pbf/italy-260626.osm.pbf \
.venv/bin/python scripts/ensure_local_osm_poi_db.py
```

Expected output when the DB is already present:

```text
"action": "already_exists"
```

Build modes:

| Mode | Env / argument | Result |
| --- | --- | --- |
| full | `LOCAL_OSM_POI_BUILD_MODE=full` or `--mode full` | POIs plus walkability features |
| POI-only | `LOCAL_OSM_POI_BUILD_MODE=poi-only` or `--mode poi-only` | route POIs only, faster/smaller |

Important: full Italy import can take around 15 minutes on a laptop-class
machine and requires enough disk space for the temporary DB. The script avoids
leaving a partial target DB if the import fails.

### Backend Integration

Files:

```text
evaluations/environmental_data_service.py
evaluations/backend_astar.py
```

Changes:

- `fetch_named_pois()` checks `LOCAL_OSM_POI_DB` first;
- if local DB exists, POIs are loaded from SQLite;
- if no local DB exists, the old Overpass behavior remains available;
- backend route payloads now expose the actual POI source in `data_sources`, for
  example:

```text
OpenStreetMap local PBF SQLite: italy.sqlite3
```

The route payload now also includes:

```text
route.explanation.environment
route.explanation.nearest_pois_m
route.explanation.walkability
route.explanation.reasons
```

This makes the route score easier to inspect: the frontend can show why a route
was preferred without reverse-engineering the raw cost.

Additional backend changes:

- environment samples are fetched in parallel where useful;
- POIs, environmental samples, and walkability lookups are coordinated together
  for GraphHopper candidate routes;
- similar GraphHopper alternatives are removed immediately, before they are
  returned to the frontend;
- route scoring includes walkability penalties when local walkability rows are
  available.

### Frontend Route Explanation

Files:

```text
static/js/services/routePlanner.js
static/js/master/routes.js
static/css/map.css
templates/map.html
```

Changes:

- backend `route.explanation` is preserved in frontend route objects;
- route cards can show compact summaries such as average air quality, average
  slope, nearest green/care POIs, and walkability penalty;
- route cards can show source summaries such as GraphHopper, local OSM POIs,
  Open-Meteo air quality, and slope provider;
- the directions panel spacing and contrast were adjusted so the summary chips
  and instruction list have clearer vertical separation.

### Dependency

File:

```text
requirements.txt
```

Added:

```text
osmium==4.3.1
```

This is the Python binding used to stream-read OSM PBF files.

### Tests

File:

```text
evaluations/test_local_osm_poi_service.py
```

Coverage:

- local POI bbox lookup;
- local DB path integration through `fetch_named_pois()`;
- walkability feature lookup;
- index creation through `optimize_local_osm_db()`.

Current verification:

```bash
.venv/bin/python -m pytest evaluations -q
```

Observed result:

```text
51 passed
```

Additional coverage was added for:

- adaptive environmental sampling;
- environment cache reuse;
- near-duplicate GraphHopper alternatives;
- walkability penalties;
- route explanation payloads.
- local OSM DB bootstrap/validation behavior;
- read-only SQLite compatibility after DB optimization.

Frontend syntax checks were also run:

```bash
node --check static/js/master/routes.js
node --check static/js/services/routePlanner.js
```

Both passed.

## What Changed In Docker

### Local Compose Defaults

File:

```text
docker-compose.local.yml
```

The local app service now defaults to:

```env
GRAPHHOPPER_URL=http://host.docker.internal:8989
LOCAL_OSM_POI_DB=/app/runtime/local_osm_pois/italy.sqlite3
```

And mounts local POI DBs read-only:

```yaml
volumes:
  - ./runtime/local_osm_pois:/app/runtime/local_osm_pois:ro
```

This means the app image stays small, while generated local data remains on the
host filesystem.

### OSM Data Compose Override

File:

```text
docker-compose.osm-data.yml
```

This override is intended for local/server deployments that should have
GraphHopper/SQLite data mounted from the host. It mounts:

```text
./runtime/local_osm_pois -> /app/runtime/local_osm_pois
./pbf                    -> /app/pbf:ro
```

It also wires these environment variables:

```env
LOCAL_OSM_POI_DB=/app/runtime/local_osm_pois/italy.sqlite3
LOCAL_OSM_PBF_PATH=/app/pbf/italy-260626.osm.pbf
LOCAL_OSM_POI_BUILD_MODE=full
PATHPLANNER_ENSURE_LOCAL_OSM_DB=false
```

To make the app container create the SQLite DB automatically when it is missing,
set:

```env
PATHPLANNER_ENSURE_LOCAL_OSM_DB=true
```

Then start with:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.osm-data.yml \
  up -d --build
```

For a first server boot, make sure the PBF exists before enabling auto-build:

```text
pbf/italy-260626.osm.pbf
```

The runtime DB directory must be writable by the app container:

```text
runtime/local_osm_pois/
```

The Docker entrypoint calls the ensure script only when
`PATHPLANNER_ENSURE_LOCAL_OSM_DB` is `true` or `1`. Normal restarts therefore do
not rebuild the DB.

SQLite runtime note: the optimized DB is finalized with `journal_mode=DELETE`
instead of WAL. This matters when the app mounts the local SQLite DB read-only in
Docker, because WAL sidecar files can prevent reliable read-only opens.

### Docker Build Context

File:

```text
.dockerignore
```

Added:

```text
pbf
runtime
```

Why: PBFs and generated routing/POI data are large, reproducible runtime
artifacts. They should not be copied into the Docker build context or image.

### Git Ignore

File:

```text
.gitignore
```

Added:

```text
runtime/local_osm_pois/
```

Why: SQLite POI databases are generated artifacts. They should be rebuilt from
PBF files, not committed.

## Measured Results

Test route:

```text
Via Emilia Est 387, Modena
Centro Commerciale I Portali, Modena
```

Coordinates:

```text
start = 44.6398102, 10.9424172
end   = 44.6444776, 10.9569078
```

Parameters:

```text
condition = respiratory
transport_mode = walking
distance_tolerance = 5
alternatives = 3
```

### Route End-To-End

Same GraphHopper route provider, different POI provider:

| Setup | Runs | Average | Best |
| --- | ---: | ---: | ---: |
| GraphHopper + SQLite POIs | 2608 ms, 2281 ms, 2744 ms | 2545 ms | 2281 ms |
| GraphHopper + Overpass POIs | 4132 ms, 2751 ms, 2815 ms | 3233 ms | 2751 ms |

Observed improvement on this route:

```text
~21% faster average end-to-end route time
```

More importantly, the Overpass run produced a mirror timeout during the test,
while SQLite stayed deterministic.

After adaptive environmental sampling/cache and the full walkability DB import,
the same Modena local benchmark showed this cold/warm pattern:

| Run | Time |
| --- | ---: |
| first local run | ~907 ms |
| immediate repeated run | ~118 ms |

The second run is fast because route environment samples hit the backend cache.
This does not mean every fresh route will be 30 ms, but it confirms repeated
recalculation, route switching, and nearby requests no longer hammer external
environment providers. Compared with the smaller POI-only DB, the full DB adds
walkability lookup work, but remains comfortably below interactive latency on
the tested Modena route.

Observed payload shape from the latest Modena benchmark:

```text
source: graphhopper_candidate_routing
route_count: 2
first_route.distance_m: 1670
first_route.duration_s: 1202
first_route.explanation.environment.sample_count: 3
first_route.explanation.environment.cache_hits: 3 on the repeated run
first_route.explanation.walkability.feature_count: 900
first_route.explanation.walkability.penalty: 0.0
```

Observed data sources:

```text
street_graph: GraphHopper local OSM graph
poi_nature: OpenStreetMap local PBF SQLite: italy.sqlite3
poi_hospital: OpenStreetMap local PBF SQLite: italy.sqlite3
poi_nightlife: OpenStreetMap local PBF SQLite: italy.sqlite3
airQuality: Open-Meteo Air Quality API
temperature/humidity/weather/windSpeed: Open-Meteo
slope: OpenTopoData-srtm30m
walkability: OpenStreetMap local PBF SQLite: italy.sqlite3
```

### POI Query Timing

Modena bbox query from the local Italy DB:

| Category | Average |
| --- | ---: |
| parks | ~1.14 ms |
| hospitals | ~0.30 ms |
| nightlife | ~0.42 ms |

After index optimization, SQLite uses a covering index for the POI bbox query.

### Full Italy DB Counts

The active local Italy DB is:

```text
runtime/local_osm_pois/italy.sqlite3
```

Current size:

```text
~1.9 GB
```

POI rows:

```text
1,533,679
```

Walkability rows:

| Category | Rows |
| --- | ---: |
| `incline` | 111,843 |
| `smoothness` | 7,335 |
| `steps` | 125,129 |
| `surface` | 2,730,692 |
| `wheelchair` | 24,869 |
| total | 2,999,868 |

The full import command took:

```text
868.61 s
```

## Current Runtime Shape

For the local demo, the expected running services are:

```text
Django app:     http://127.0.0.1:8765
GraphHopper:    http://127.0.0.1:8989
POI SQLite DB:  runtime/local_osm_pois/italy.sqlite3
```

Smoke checks:

```bash
curl http://127.0.0.1:8989/info
```

```bash
curl 'http://127.0.0.1:8765/api/pois/?category=parks&min_lat=44.60&min_lon=10.86&max_lat=44.70&max_lon=11.00'
```

Expected POI source:

```text
OpenStreetMap local PBF SQLite: italy.sqlite3
```

Backend route benchmark utility:

```bash
LOCAL_OSM_POI_DB=runtime/local_osm_pois/italy.sqlite3 \
GRAPHHOPPER_URL=http://127.0.0.1:8989 \
.venv/bin/python scripts/benchmark_backend_routes.py \
  --case modena-portali \
  --mode walking \
  --tolerance 5 \
  --repeats 3
```

Backend multi-city smoke test:

```bash
.venv/bin/python scripts/smoke_backend_cities.py \
  --require-local-data \
  --require-walkability
```

What it checks:

- `/api/backend_astar/` returns at least one route;
- route path, distance, duration, environment sample count, and explanation are
  present;
- with `--require-local-data`, the route must use GraphHopper and local SQLite
  sources;
- with `--require-walkability`, the route must expose local walkability feature
  counts.

The script currently includes Modena, Bologna, Florence, Rome, London, and New
York cases. It queries the active GraphHopper `/info` bbox and skips cases
outside the loaded graph. With the current Italy graph, the expected result is:

```text
4 passed, 0 failed, 2 skipped
```

London and New York should pass after starting GraphHopper with their respective
PBF/graph and building the matching local SQLite DB.

The benchmark script currently includes these cases:

| Case | Area | Notes |
| --- | --- | --- |
| `modena-portali` | Modena | current local Italy GraphHopper/SQLite test case |
| `london-short` | London | useful after loading a UK/London PBF graph |
| `new-york-short` | New York | useful after loading a New York/US PBF graph |

Only areas present in the active GraphHopper graph and local SQLite DB can be
tested fully with local route/POI data.

## Where Data Calls Happen

This section maps each data type to the code path that requests it. It is useful
when debugging whether the app is using local data or falling back to an external
provider.

### Route Request From The Browser

The browser asks the backend for the clinical/environmental route here:

| Layer | File/function | Call |
| --- | --- | --- |
| Frontend | `static/js/services/routePlanner.js` | `fetch('/api/backend_astar/?...')` |
| Backend view | `evaluations/views.py::backend_astar_route()` | parses request and calls `generate_backend_astar_routes()` |
| Backend route engine | `evaluations/backend_astar.py::generate_backend_astar_routes()` | coordinates route candidates, POIs, weather, air quality, slope, and scoring |

The route API is:

```text
/api/backend_astar/?start=lat,lon&end=lat,lon&condition=...&transport_mode=...&distance_tolerance=...
```

### Road Graph / Route Geometry

Preferred path:

| Data | File/function | Provider |
| --- | --- | --- |
| Route candidates | `evaluations/backend_astar.py::_graphhopper_route_payload()` | local GraphHopper `/route` |
| GraphHopper URL | `GRAPHHOPPER_URL` | usually `http://host.docker.internal:8989` from Docker |
| OSM graph data | GraphHopper graph under `runtime/graphhopper/graphs/...` | generated from local PBF |

The actual HTTP call is:

```python
requests.get(f'{GRAPHHOPPER_URL}/route', params=params, timeout=GRAPHHOPPER_TIMEOUT_SECONDS)
```

Fallback path:

| Data | File/function | Provider |
| --- | --- | --- |
| Street graph bbox | `evaluations/environmental_data_service.py::fetch_street_graph()` | public Overpass |
| Overpass POST helper | `evaluations/environmental_data_service.py::_overpass_post()` | rotating Overpass mirrors |

This fallback is used only when GraphHopper is unavailable or not configured, and
`GRAPHHOPPER_FORCE=false`.

### POIs For Route Scoring

The route scorer calls POIs here:

| Layer | File/function | Purpose |
| --- | --- | --- |
| Route scoring | `evaluations/backend_astar.py::_fetch_poi_lists_parallel()` | fetches active POI categories in parallel |
| POI service | `evaluations/environmental_data_service.py::fetch_named_pois()` | chooses local SQLite first, Overpass fallback second |
| Local DB service | `evaluations/local_osm_poi_service.py::fetch_local_named_pois()` | indexed bbox query on `runtime/local_osm_pois/*.sqlite3` |

Provider selection:

```text
if LOCAL_OSM_POI_DB exists:
    use SQLite local PBF extract
else:
    use Overpass
```

The map/sidebar can also request POIs directly through:

| Layer | File/function | Call |
| --- | --- | --- |
| Frontend route POI list | `static/js/services/poisAlongRoute.js` | `fetch('/api/pois?...')` |
| Backend POI endpoint | `evaluations/views.py::get_pois_in_bbox()` | calls `fetch_named_pois()` |

The POI API is:

```text
/api/pois/?category=parks&min_lat=...&min_lon=...&max_lat=...&max_lon=...
```

Expected local source in JSON:

```text
OpenStreetMap local PBF SQLite: italy.sqlite3
```

### Walkability Features

Walkability is queried here:

| Layer | File/function | Purpose |
| --- | --- | --- |
| Backend route engine | `evaluations/backend_astar.py::_fetch_walkability_features()` | requests nearby local OSM walkability rows |
| Local DB service | `evaluations/local_osm_poi_service.py::fetch_local_walkability_features()` | indexed bbox/radius query |
| Edge scoring | `evaluations/backend_astar.py::_calculate_edge_cost()` | applies feature penalties to candidate segments |
| Route scoring | `evaluations/backend_astar.py::_score_candidate_path()` | includes walkability in final candidate cost |

The lookup radius is controlled by:

```env
BACKEND_ASTAR_WALKABILITY_RADIUS_M=35
```

Current caveat: this signal depends on OSM tag completeness. The DB now contains
the extracted features, but OpenStreetMap coverage can vary by city and road
type. Missing `surface`, `smoothness`, `incline`, or `wheelchair` tags mean “no
known penalty”, not guaranteed perfect accessibility.

### Weather

Weather for backend route scoring is fetched here:

| Data | File/function | Provider |
| --- | --- | --- |
| temperature, humidity, weather code, wind | `evaluations/environmental_data_service.py::_fetch_open_meteo_weather()` | Open-Meteo forecast API |
| route sample orchestration | `evaluations/backend_astar.py::_fetch_backend_environment_data()` | calls weather per sampled route point |

The endpoint is built from:

```text
https://api.open-meteo.com/v1/forecast
```

The frontend also has a weather service:

| Layer | File/function | Provider |
| --- | --- | --- |
| Frontend weather utility | `static/js/services/weather.js` | Open-Meteo forecast API |

For backend A* routing, the backend path is the important one.

### Air Quality

Air quality for backend route scoring is fetched here:

| Data | File/function | Provider |
| --- | --- | --- |
| PM / AQI data | `evaluations/air_quality_service.py::get_air_quality_data()` | Open-Meteo Air Quality first, OpenAQ fallback |
| Open-Meteo AQ call | `evaluations/air_quality_service.py::_fetch_open_meteo_air_quality()` | `https://air-quality-api.open-meteo.com/v1/air-quality` |
| OpenAQ fallback | `evaluations/air_quality_service.py::_fetch_openaq_air_quality()` | `https://api.openaq.org/v3/locations` and `/latest` |
| route sample orchestration | `evaluations/backend_astar.py::_fetch_backend_environment_data()` | calls `air_quality_service.get_air_quality_data()` |

OpenAQ key:

```env
OPENAQ_API_KEY=...
```

If no OpenAQ key is configured, Open-Meteo still works as the primary gridded
provider. OpenAQ is currently fallback/station metadata.

Frontend air quality calls also exist:

| Layer | File/function | Call |
| --- | --- | --- |
| Frontend air-quality service | `static/js/services/airQuality.js` | calls `/api/air_quality/` first |
| Backend endpoint | `evaluations/views.py::get_air_quality_data()` | calls `air_quality_service.get_air_quality_data()` |
| Optional Google AQ | `static/js/services/airQualityGoogle.js` | Google Air Quality API if configured |

For backend route scoring, `evaluations/air_quality_service.py` is the key path.

Backend route sampling/cache is coordinated here:

| Layer | File/function | Purpose |
| --- | --- | --- |
| Route engine | `evaluations/backend_astar.py::_sample_environment_points()` | chooses route sample points adaptively |
| Route engine | `evaluations/backend_astar.py::_fetch_backend_environment_data()` | fetches/caches AQ, weather, and slope for one sample |
| Route engine | `evaluations/backend_astar.py::_backend_env_cache_key()` | rounds nearby samples into short-lived cache keys |

Cache behavior is intentionally process-local and short-lived. It is not a
persistent city cache, so a user can move from Modena to New York or London
without relying on stale precomputed city blobs.

## GUI Testing

GUI testing does not have to be fully manual. The repository already contains
Playwright tests under:

```text
tests/playwright/
```

Recommended split:

- backend smoke tests validate route data correctness and sources;
- Playwright smoke tests validate that the map page, sidebar, suggestions,
  route cards, directions, layers, and responsive layout behave correctly;
- final manual QA is still useful for subjective map readability and clinical
  UX, but it should not be the only regression check.

Useful Playwright examples already present:

```text
tests/playwright/search-suggestions-layout.spec.js
tests/playwright/directions-card.spec.js
tests/playwright/sidebar-layout.spec.js
tests/playwright/routing-label.spec.js
```

The next practical GUI automation target is an end-to-end route smoke:

1. open `/map/`;
2. fill start/end with fixed coordinates by setting input datasets;
3. click Find route;
4. assert route cards and directions render;
5. assert explanation/source text appears;
6. optionally toggle layers and verify the map receives overlay elements.

### Elevation / Slope

Slope for backend route scoring is estimated here:

| Data | File/function | Provider |
| --- | --- | --- |
| slope estimate | `evaluations/environmental_data_service.py::_fetch_slope()` | OpenTopoData first, Open-Meteo elevation fallback, Mapbox terrain fallback |
| OpenTopoData | `evaluations/environmental_data_service.py::_elevation_opentopo()` | `https://api.opentopodata.org/v1/{dataset}` |
| Open-Meteo elevation | `evaluations/environmental_data_service.py::_elevation_open_meteo()` | `https://api.open-meteo.com/v1/elevation` |
| Mapbox fallback | `evaluations/environmental_data_service.py::_fetch_slope()` | Mapbox terrain tilequery if `MAPBOX_ACCESS_TOKEN` exists |
| route sample orchestration | `evaluations/backend_astar.py::_fetch_backend_environment_data()` | calls `_fetch_slope()` |

Important: this is still an external-data path. The local PBF can give us OSM
tags such as `incline=*` and `highway=steps`, but not a continuous terrain model.

### Address Suggestions / Geocoding

The route inputs use browser-side suggestions:

| Data | File/function | Provider |
| --- | --- | --- |
| address/place suggestions | `static/js/suggestions.js` | Mapbox SearchBox API |
| suggestion retrieval | `static/js/suggestions.js::retrieveSuggestion()` | Mapbox SearchBox `/retrieve/{mapbox_id}` |

Required config:

```env
MAPBOX_ACCESS_TOKEN=...
```

If this token is missing, the UI shows the “Location lookup is not configured”
message and the start/end autocomplete will not return places.

### Legacy / Other Data Paths To Know About

Some older or auxiliary frontend paths still exist:

| File | Data source | Notes |
| --- | --- | --- |
| `static/js/algorithms/environmentalAStar.js` | `/api/street_graph`, `/api/pois`, and sometimes Overpass | legacy/browser A* support; not the preferred route path now |
| `static/js/services/environmental.js` | Overpass/Mapbox/Open-Meteo style calls | older environmental utility code |
| `static/js/services/pointOfInterest.js` | Nominatim/Overpass | older POI helper code |
| `static/js/master/routes.js` | Mapbox routing for direct/preview route behavior | still used for UI/direct route behavior, not the backend clinical route scoring path |

The preferred clinical route flow is:

```text
static/js/services/routePlanner.js
  -> /api/backend_astar/
  -> evaluations/views.py::backend_astar_route()
  -> evaluations/backend_astar.py::generate_backend_astar_routes()
  -> GraphHopper local route candidates
  -> local SQLite POIs when LOCAL_OSM_POI_DB is configured
  -> Open-Meteo/OpenAQ/OpenTopoData for remaining environment samples
```

## Why This Is Better

This architecture is better for the app because:

- it uses real OSM data, not synthetic cache data;
- route candidates are available locally through GraphHopper;
- POI scoring is local, indexed, and deterministic;
- Overpass remains a fallback instead of a core runtime dependency;
- Docker images stay small because generated data is mounted, not baked in;
- the code reports data sources, so we can verify whether a route used local
  SQLite, Overpass, GraphHopper, or external environmental APIs.

For a clinical routing demo, this matters because users with health conditions
need reliable behavior. A route should not change quality or fail simply because
a public Overpass mirror is slow.

## What Still Remains

The main remaining external dependencies are:

- air quality;
- weather;
- elevation/slope.

The next likely improvement is to reduce those route-time API calls:

- batch environmental samples more aggressively where providers allow it;
- use GraphHopper path details for road/surface metadata where possible;
- add a local DEM if true offline slope is required;
- tune the clinical weight of walkability features after testing more patient
  profiles and cities;
- build equivalent local GraphHopper/SQLite datasets for London and New York
  when those demos are needed.

## Local Checkpoints

Current local branch:

```text
codex/real-data-routing
```

Useful local commits/tags:

| Commit/tag | Purpose |
| --- | --- |
| `3ab5b13` / `local-osm-poi-index-20260627-1055` | local OSM POI index support |
| `f8f3ae3` / `local-osm-poi-indexes-20260627-1102` | optimized local SQLite indexes |
| `067b326` / `real-data-routing-explainability-20260627-1518` | adaptive sampling, route explanation, dedup, walkability scoring hooks, frontend explanation |

No remote push is required for these checkpoints; they are local recovery points.
