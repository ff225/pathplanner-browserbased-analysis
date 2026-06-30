# Current App Architecture And Original Difference

Generated on 2026-06-30.

Baseline compared:

```text
/Users/dtortoli/Downloads/pathplanner_browserbased_analysis (1)
```

Current working repo:

```text
/Users/dtortoli/Code/pathplanner_browserbased_analysis
```

This document is the high-level technical guide for the current version of the
app. It consolidates the existing Markdown notes in this repo and explains how
the current app differs from the original version, especially around backend
routing, real OSM data, GraphHopper, local SQLite databases, A*, route points,
environmental layers, and Docker/server deployment.

Markdown/context sources reviewed:

```text
README.md
CHANGES_VS_ORIGINAL.md
A_STAR_ANALYSIS.md
REPO_ANALYSIS.md
docs/A_STAR_TRAFFIC_OPENMAP.md
docs/LOCAL_ROUTING_ENGINE.md
docs/REAL_DATA_ROUTING_EVOLUTION.md
docs/deployment-linux-docker.md
docs/DEFENSIBLE_METRICS.md
docs/PATHPLANNER_BENCHMARK_INTEGRATION.md
docs/SCORING_EVIDENCE.md
docs/THREE_MAIN_ANALYSES.md
```

Original Markdown/context reviewed:

```text
/Users/dtortoli/Downloads/pathplanner_browserbased_analysis (1)/README.md
/Users/dtortoli/Downloads/pathplanner_browserbased_analysis (1)/docs/*.md
/Users/dtortoli/Downloads/pathplanner_browserbased_analysis (1)/analysis_outputs/*.md
```

## 1. Executive Summary

The original project was a Django web app with most routing logic and route
experimentation happening in the browser. The original README explicitly said
that the ideal implementation would generate paths server-side, but that the
project was still client-side and could suffer from too many API requests,
slowness, and loading problems.

The current version moves the important routing path to the backend:

- the browser collects start, destination, transport mode, distance tolerance,
  route style, and clinical profile;
- the browser calls `/api/backend_astar/`;
- the backend uses a local GraphHopper service for real OSM road candidates
  when available;
- the backend scores route candidates with clinical, environmental, POI, and
  walkability weights;
- local SQLite databases extracted from OSM PBF files provide parks,
  hospitals, tourism, nightlife, entertainment, pharmacies, benches, toilets,
  drinking water, and walkability tags;
- public Overpass remains fallback, not the preferred runtime dependency;
- air quality and weather still come from external real-data providers,
  mainly Open-Meteo, with OpenAQ as fallback/station support;
- Docker now has an explicit deployment contract with `.env`, mounted runtime
  data, healthchecks, Nginx, and bootstrap scripts.

The important architectural change is this:

```text
Original:
browser-heavy routing + public APIs during interaction

Current:
backend-first routing + local OSM road graph + local OSM POI/walkability DB
```

The current app is therefore more predictable for a clinical-routing demo. It
still uses real data, but the largest and slowest OSM dependencies are now local.

## 2. What The App Does Now

The app is a clinical/environmental map-based route planner.

The user can:

- choose a starting point and arrival point;
- choose transport mode: car, bike, or foot;
- choose a distance tolerance from short/direct to more willing to detour;
- choose a route style preset such as balanced, parks/green areas, medical
  access, tourism, entertainment, or nightlife;
- optionally use a saved custom route-style mix;
- choose a clinical routing profile such as respiratory, cardiac, arthritis,
  mental health, limited mobility, or diabetes;
- request route alternatives;
- inspect route cards, distance, duration, sources, exposure, POIs, and
  turn-by-turn instructions;
- preview the selected route;
- turn on PM2.5, PM10, NO2, O3, and pollen layers;
- log in, create/edit profile data, and manage saved route-style sets.

The current product meaning is:

```text
Route style = what kind of places the user prefers.
Clinical profile = health-aware weighting applied on top of that style.
Distance tolerance = how willing the user is to accept a longer route if it is
clinically/environmentally better.
```

The route style and clinical profile are intentionally separate. A user may want
parks as a style, and may also have respiratory sensitivity. Those are different
signals and they should stack.

## 3. Main Screens And Frontend Shape

The app is still server-rendered Django templates plus vanilla JavaScript. It is
not React/Vue/Svelte.

Main pages:

| Page | Path | Purpose |
| --- | --- | --- |
| Home | `/` | Landing/home entry |
| Map | `/map/` | Main route planner |
| Login | `/user/login/` | Authentication |
| Signup | `/user/signup/` | Registration |
| Profile | `/user/profile/` | User data and saved route sets |
| Edit profile | `/user/profile/edit/` | Name/surname/email/profile settings |
| Add/edit/delete set | `/user/profile/...` | Manage custom route-style sets |

Important frontend files:

| File | Role |
| --- | --- |
| `templates/map.html` | Main map shell and controls |
| `static/css/map.css` | Main map/sidebar/directions styling |
| `static/css/theme.css` | Shared theme tokens |
| `static/js/map.js` | Leaflet map bootstrap and sidebar behavior |
| `static/js/mapState.js` | Persists map form state in localStorage |
| `static/js/suggestions.js` | Mapbox address suggestions/geocoding |
| `static/js/services/routePlanner.js` | Calls backend A* and converts returned routes for UI |
| `static/js/master/routes.js` | Route selection, route cards, directions, preview, exposure card |
| `static/js/heatmap.js` | PM2.5/PM10/NO2/O3/pollen layers |
| `static/js/services/poisAlongRoute.js` | On-route POI lookup from `/api/pois` |

The current frontend is still JavaScript modules and DOM manipulation. The work
done so far makes it much more app-like, but the stack itself remains the
original server-rendered Django + JS approach.

## 4. Current Routing Flow

The primary routing flow is:

```text
User clicks Find route
  -> static/js/master/routes.js gathers form state
  -> static/js/services/routePlanner.js calls /api/backend_astar/
  -> evaluations/views.py::backend_astar_route()
  -> evaluations/backend_astar.py::generate_backend_astar_routes()
  -> GraphHopper local route candidates if available
  -> local SQLite POIs/walkability + Open-Meteo/OpenAQ/elevation samples
  -> backend scores alternatives
  -> frontend renders route cards, selected route, directions, exposure
```

The API called by the frontend is:

```text
/api/backend_astar/?start=lat,lon&end=lat,lon&condition=...&transport_mode=...&distance_tolerance=...&alternatives=...
```

Preference weights are added as query parameters:

```text
nature=...
hospital=...
entertainment=...
nightlife=...
tourism=...
```

The response contains:

- `routes`: list of alternatives;
- `path`: full route geometry for drawing/preview;
- `waypoints`: simplified points for summary/control use;
- `instructions`: turn-by-turn instructions from GraphHopper when available;
- `distance_m`;
- `duration_s`;
- `astar_cost`;
- `env_score`;
- `data_sources`;
- `explanation`;
- `parallelism`;
- `timing_ms`.

## 5. GraphHopper And Road Geometry

GraphHopper is the preferred road-route provider now.

Configured by:

```env
PATHPLANNER_ROUTING_REGIONS=italy|32.90,-5.52,47.26,21.72|http://graphhopper-italy:8989|/app/runtime/local_osm_pois/italy.sqlite3;london|51.20,-0.65,51.75,0.45|http://graphhopper-london:8989|/app/runtime/local_osm_pois/london.sqlite3;new-york|40.40,-74.35,41.05,-73.55|http://graphhopper-new-york:8989|/app/runtime/local_osm_pois/new-york.sqlite3
GRAPHHOPPER_TIMEOUT_SECONDS=8
GRAPHHOPPER_FORCE=false
GRAPHHOPPER_PROFILE_WALKING=foot
GRAPHHOPPER_PROFILE_CYCLING=bike
GRAPHHOPPER_PROFILE_CAR=car
```

In the Docker Compose flow, GraphHopper is started by
`docker-compose.osm-data.yml` on the same Compose network as Django. The current
Compose runtime starts three services:

| Region | Internal URL | Host check URL |
| --- | --- | --- |
| Italy | `http://graphhopper-italy:8989` | `http://127.0.0.1:8989/info` |
| London | `http://graphhopper-london:8989` | `http://127.0.0.1:8991/info` |
| New York | `http://graphhopper-new-york:8989` | `http://127.0.0.1:8993/info` |

For manual debugging outside Compose, the helper script can still start one
region:

```bash
scripts/start_graphhopper.sh italy
scripts/start_graphhopper.sh london
scripts/start_graphhopper.sh new-york
```

GraphHopper uses local OSM PBF extracts and builds/loads its own graph cache:

| Region | PBF | Graph cache |
| --- | --- | --- |
| Italy | `pbf/italy-260626.osm.pbf` | `runtime/graphhopper/graphs/italy-gh9` |
| London | `pbf/greater-london-260626.osm.pbf` | `runtime/graphhopper/graphs/london-gh9` |
| New York | `pbf/new-york-260626.osm.pbf` | `runtime/graphhopper/graphs/new-york-gh9` |

GraphHopper does not replace the app's clinical logic. It supplies real road
candidate geometries. PathPlanner then ranks those geometries.

Current behavior:

- if start/end match a configured `PATHPLANNER_ROUTING_REGIONS` bbox, the
  backend calls that region's GraphHopper service and matching local SQLite DB;
- if no region matches but `GRAPHHOPPER_URL` is set, the backend uses that
  single GraphHopper URL as a fallback;
- if GraphHopper is unavailable and `GRAPHHOPPER_FORCE=false`, backend falls
  back to Overpass street-graph A*;
- if GraphHopper is unavailable and `GRAPHHOPPER_FORCE=true`, the backend
  returns an error instead of silently degrading.

### Transport Mode

Transport mode now matters.

The frontend sends:

```text
transport_mode=driving|cycling|walking
```

The backend normalizes:

```text
driving/car -> car
cycling -> cycling
anything else -> walking
```

Then maps to GraphHopper profiles:

```text
car -> GRAPHHOPPER_PROFILE_CAR
cycling -> GRAPHHOPPER_PROFILE_CYCLING
walking -> GRAPHHOPPER_PROFILE_WALKING
```

For the Overpass fallback, car mode also affects one-way handling in the local
street-graph builder.

## 6. What "A*" Means In The Current Version

There are three routing concepts that should not be mixed up.

### 6.1 Original / Legacy Grid A*

The original project had grid-style environmental A* logic in the browser and a
Python port in `evaluations/environmental_astar.py`.

That algorithm:

- creates a lat/lon bounding-box grid between start and end;
- connects nearby grid nodes;
- expands nodes with a priority queue;
- uses `g + heuristic`;
- adds penalties from environmental values and patient sensitivity;
- can generate paths that are not necessarily road-real unless they are later
  snapped/routed by another service.

This still exists mostly for research/benchmark/fallback compatibility. It is
not the preferred main UI route source anymore.

### 6.2 Current Preferred Path: GraphHopper Candidates + Backend Scoring

When GraphHopper is available, GraphHopper internally computes road-real route
candidates from the local OSM graph.

PathPlanner then scores each candidate path using:

- physical distance;
- patient profile weights;
- route style preference weights;
- air quality samples;
- weather samples;
- slope/elevation samples;
- local OSM POIs;
- local OSM walkability features;
- distance tolerance;
- duplicate/self-intersection filtering.

This is why route cards may say "Backend OSM street-graph A*" even when the road
geometry came from GraphHopper. In the preferred path, GraphHopper supplies the
candidate road geometries and PathPlanner performs the clinical/environmental
ranking.

### 6.3 Fallback Path: Backend Street-Graph A*

If GraphHopper is not available, the backend can fetch an OSM street graph from
Overpass and run its own A* on that graph.

This happens in:

```text
evaluations/backend_astar.py::_street_graph_astar()
```

Algorithm:

1. Fetch street graph for a bbox around start/end.
2. Build nodes and adjacency.
3. Snap start/end to connected road nodes.
4. Fetch relevant POIs and walkability features.
5. Prefetch environment samples.
6. Use a priority queue of `(cost + heuristic, node)`.
7. Pop the best frontier node.
8. For each neighbor, calculate edge cost.
9. Stop when goal node is reached or expansion limit is hit.
10. Generate alternatives by adding penalties around already accepted routes.

The A* expansion itself is sequential because each pop depends on the current
best frontier. What is parallelized is the expensive I/O around it:

- street graph / POI / walkability lookup;
- POI categories;
- environmental sample fetches;
- final route scoring.

Current backend reports this in `parallelism`:

```text
parallelized: street_graph_and_pois, poi_categories, environment_seed, route_scoring
sequential: priority_queue_astar_expansion, penalty_based_alternative_generation
```

In GraphHopper mode, the internal road routing is handled by GraphHopper and the
backend reports:

```text
parallelized: graphhopper_routes, poi_categories, environment_seed, candidate_scoring
sequential: graphhopper_internal_routing
```

## 7. Route Points: Full Path vs Waypoints

The backend intentionally returns two point lists.

```text
path      = full route geometry
waypoints = simplified control/summary points
```

`path` is the important geometry:

- used to draw the line on the Leaflet map;
- used for route preview;
- used for route exposure sampling;
- used for route length and explanation.

`waypoints` is a simplified list:

- start;
- selected interior points;
- end;
- capped by `_simplify_waypoints()`;
- used as route control/summary points in the frontend.

This distinction exists because sending every geometry point as a "waypoint" to
another routing component can create artificial via-points, odd turn
instructions, or tiny go-forward/go-back artifacts. The full path remains real;
the simplified waypoint list is only a compact representation.

## 8. Distance Tolerance

Distance tolerance is currently sent from the UI to the backend as:

```text
distance_tolerance=1..10
```

It affects routing in three ways:

1. Route bbox padding:

   Higher tolerance gives the backend a wider search area for POIs/fallback
   graph routing.

2. GraphHopper alternative looseness:

   In GraphHopper mode, `alternative_route.max_weight_factor` grows with
   distance tolerance:

   ```text
   1.15 + (distance_tolerance - 1) * 0.08
   ```

   Higher tolerance allows GraphHopper to return longer alternatives.

3. Green/preference scaling:

   `tolerance_green_scale(distance_tolerance)` increases how much nature/green
   preferences can reward a longer route.

Product meaning:

```text
Low tolerance = prefer direct/short.
High tolerance = user is willing to walk/ride/drive more if the route is
clinically or environmentally better.
```

## 9. Clinical And Preference Weights

Clinical profiles live in:

```text
evaluations/environmental_astar.py::PATIENT_CONDITIONS
static/js/master/patientConditions.js
```

The backend uses patient weights such as:

- `airQualitySensitivity`;
- `slopeSensitivity`;
- `noiseSensitivity`;
- `temperatureSensitivity`;
- `humiditySensitivity`;
- `patientNature`;
- `patientHospital`;
- `patientEntertainment`;
- `patientNightlife`;
- `patientTourism`.

Route-style preferences use the same POI dimensions:

```text
nature
hospital
entertainment
nightlife
tourism
```

Combined weight:

```text
effective_weight = clinical_profile_weight + selected_route_style_weight
```

This is why it still makes sense to keep saved custom route-style sets. They are
not the same thing as a disease/clinical profile. A route style expresses a
preference; a clinical profile expresses health risk and sensitivity.

Potential UX caveat:

- mixing strong medical access with strong nightlife/tourism/entertainment is
  allowed, but it can be semantically odd;
- the UI should present this as an advanced custom mix rather than the normal
  path for clinical users.

## 10. Local OSM POI And Walkability Databases

Local OSM POI/walkability support lives in:

```text
evaluations/local_osm_poi_service.py
scripts/build_local_osm_pois.py
scripts/ensure_local_osm_poi_db.py
docker-compose.osm-data.yml
```

The runtime DB is configured by:

```env
LOCAL_OSM_POI_DB=/app/runtime/local_osm_pois/italy.sqlite3
LOCAL_OSM_PBF_PATH=/app/pbf/italy-260626.osm.pbf
LOCAL_OSM_POI_BUILD_MODE=full
PATHPLANNER_ENSURE_LOCAL_OSM_DB=false
```

The database schema has three tables:

| Table | Purpose |
| --- | --- |
| `poi` | parks, hospitals, tourism, nightlife, entertainment, pharmacies, etc. |
| `walkability_feature` | OSM tags relevant to route difficulty/accessibility |
| `meta` | build metadata |

Current local DB files:

| Region | DB |
| --- | --- |
| Italy | `runtime/local_osm_pois/italy.sqlite3` |
| London | `runtime/local_osm_pois/london.sqlite3` |
| New York | `runtime/local_osm_pois/new-york.sqlite3` |

The older file:

```text
runtime/local_osm_pois/italy.poi-only.20260627-160103.sqlite3
```

is a preserved partial/backup POI-only Italy database. It should not be used as
the main deploy DB if walkability scoring is required.

### Extracted POI Categories

Current POI classification includes:

| App category | OSM tags/examples |
| --- | --- |
| `parks` | `leisure=park`, `garden`, `nature_reserve`, `landuse=forest/grass/meadow`, `natural=wood`, protected areas |
| `hospitals` | `amenity=hospital/clinic`, `healthcare=hospital/clinic` |
| `entertainment` | cinema, theatre, concert hall, arts centre |
| `nightlife` | bar, pub, nightclub |
| `tourism` | attraction, museum, viewpoint, gallery |
| `pharmacies` | pharmacy |
| `toilets` | public toilets |
| `drinking_water` | drinking water |
| `bench` | benches |

### Extracted Walkability Features

Current walkability classification includes:

| Category | OSM source |
| --- | --- |
| `steps` | `highway=steps` |
| `incline` | `incline=*` |
| `surface` | `surface=*` |
| `smoothness` | `smoothness=*` |
| `wheelchair` | `wheelchair=*` |

These are real OSM tags. Coverage depends on how well the local OSM community
has mapped that city.

Important limitation:

```text
PBF files do not contain a full terrain/elevation model.
```

So true continuous slope still comes from elevation providers unless a local DEM
pipeline is added. OSM `incline=*` and `highway=steps` are still valuable real
signals, but they are not a full replacement for terrain data.

### Who Builds The DB?

There are two options.

Fast deploy option:

```text
Copy the prebuilt SQLite DB into runtime/local_osm_pois/
Set PATHPLANNER_ENSURE_LOCAL_OSM_DB=false
```

Bootstrap option:

```text
Copy the PBF into pbf/
Set PATHPLANNER_ENSURE_LOCAL_OSM_DB=true
Mount runtime/local_osm_pois as writable
Let docker/entrypoint.sh run scripts/ensure_local_osm_poi_db.py
```

The ensure script is idempotent:

- if DB exists and passes checks, it does nothing;
- if DB is missing or invalid, it imports from PBF into a temp file;
- it validates counts/integrity;
- it atomically replaces the target only after success.

## 11. Runtime Files Not In Git

Large runtime files should not be pushed to GitHub.

Current runtime assets:

| Folder/file | Purpose |
| --- | --- |
| `pbf/*.osm.pbf` | Raw OSM extracts |
| `runtime/local_osm_pois/*.sqlite3` | Local POI/walkability DBs |
| `runtime/graphhopper/graphs/*-gh9` | Imported GraphHopper routing graphs |
| `runtime/graphhopper/lib/graphhopper-web-9.1.jar` | GraphHopper web/server jar |
| `runtime/graphhopper/config/pathplanner-demo.yml` | GraphHopper config |

Prepared upload zips:

```text
/Users/dtortoli/Documents/pathplanner-runtime-upload/pathplanner-pbf.zip
/Users/dtortoli/Documents/pathplanner-runtime-upload/pathplanner-local-osm-pois.zip
/Users/dtortoli/Documents/pathplanner-runtime-upload/pathplanner-graphhopper.zip
```

They are structured so they can be extracted directly in the project root:

```bash
unzip pathplanner-pbf.zip -d /path/to/repo
unzip pathplanner-local-osm-pois.zip -d /path/to/repo
unzip pathplanner-graphhopper.zip -d /path/to/repo
```

## 12. Environmental Data And Layers

The app has two environmental concepts:

```text
Map layer = city/corridor exposure surface.
Selected-route exposure = exposure summary for this exact route.
```

### Air Quality For Routing

Backend route scoring calls:

```text
evaluations/air_quality_service.py::get_air_quality_data()
```

Provider priority:

1. Open-Meteo Air Quality API;
2. OpenAQ fallback if configured/available;
3. default unavailable marker if both fail.

Open-Meteo is primary because it has broad gridded coverage and does not require
an API key. OpenAQ is useful for real station metadata/fallback, but depends on
station availability and `OPENAQ_API_KEY`.

### Weather For Routing

Weather comes from Open-Meteo forecast through:

```text
evaluations/environmental_data_service.py::_fetch_open_meteo_weather()
```

### Slope

Slope/elevation currently comes from:

```text
evaluations/environmental_data_service.py::_fetch_slope()
```

It uses external elevation providers. This is one of the remaining pieces that
is not fully local.

### Route Sampling

Backend route scoring samples route context adaptively:

| Straight-line distance | Environment samples |
| ---: | ---: |
| <= 3 km | 3 |
| <= 8 km | 5 |
| longer | up to `BACKEND_ASTAR_MAX_ENV_SAMPLES` |

This is intentional. Air quality often has city/neighborhood-scale resolution,
so calling it dozens of times on a short route creates latency without adding
much real precision.

Cache is short-lived and process-local:

```env
BACKEND_ASTAR_ENV_CACHE_TTL_SECONDS=600
BACKEND_ASTAR_ENV_CACHE_PRECISION=3
```

This is not a persistent city cache.

### Map Layers

Layer buttons:

```text
PM2.5
PM10
NO2
O3
Pollen
```

Air layer behavior:

- use real station/sample points when available;
- render an interpolated Leaflet heat surface;
- when no saved station rows exist, sample real Open-Meteo AQ values over the
  city/current context;
- when start and destination are selected, sample over the corridor from start
  to arrival;
- when no route is being searched, spread samples over the current city or
  geolocation context;
- show numbered circles/markers so the user can inspect real sample points.

Pollen behavior:

- uses Open-Meteo pollen forecast;
- renders an areal field around the selected/city context.

## 13. Duplicate And Weird Route Filtering

The backend filters similar routes before they reach the UI.

Relevant functions:

```text
_path_signature()
_path_overlap_ratio()
_is_similar_route()
_remove_local_path_loops()
_path_has_local_self_intersection()
```

This handles problems noticed during QA:

- duplicate routes appearing as separate cards;
- tiny local route loops;
- small self-intersections / bow-tie shapes;
- alternatives that overlap too much to be meaningful.

The frontend also does a second lightweight deduplication in
`static/js/services/routePlanner.js`, but the important fix is backend-side so
bad alternatives are removed before render.

## 14. Docker And Server Runtime

Current Docker files:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds Python 3.12 app image |
| `docker/entrypoint.sh` | Checks env, optionally builds local OSM DB, migrates, collectstatic |
| `docker-compose.yml` | Production-ish app + Nginx |
| `docker-compose.local.yml` | Local dev port 8765 |
| `docker-compose.osm-data.yml` | Starts GraphHopper and mounts PBF, graph cache, and local OSM DB folders |
| `.env.example` | Documents required runtime env vars |
| `.dockerignore` | Keeps large runtime files out of Docker build context |

Recent important Docker fix:

```text
Dockerfile now installs libexpat1.
```

This is required by Python `osmium` inside the container. Without it, importing
PBF files inside Docker fails with:

```text
ImportError: libexpat.so.1: cannot open shared object file
```

Server startup with Docker Compose:

```bash
docker compose -f docker-compose.yml -f docker-compose.osm-data.yml up -d --build
```

Local app convention:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.osm-data.yml up -d --build
```

GraphHopper is now part of the Compose runtime when
`docker-compose.osm-data.yml` is included. The app depends on three GraphHopper
services and uses `PATHPLANNER_ROUTING_REGIONS` to select Italy, London, or New
York automatically from route coordinates. The host can inspect the services at
`127.0.0.1:8989`, `127.0.0.1:8991`, and `127.0.0.1:8993`.

## 15. Deployment / Migration From Old Server Version

For the old server, where the app was mainly frontend/API-driven, pull/rebuild
alone is not enough for the current version to behave like local.

Required after pulling code:

1. Create `.env` from `.env.example`.
2. Set `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, CSRF/SSL flags.
3. Set `MAPBOX_ACCESS_TOKEN`.
4. Set `OPENAQ_API_KEY` if available.
5. Copy runtime zips or equivalent folders.
6. Extract them into the repo root.
7. Keep or edit `PATHPLANNER_ROUTING_REGIONS` if the deployed regions change.
8. Rebuild/restart Docker Compose with `docker-compose.osm-data.yml`.
9. Run backend smoke tests.

The default Compose runtime serves Italy, London, and New York together. The
runtime artifacts must exist in the extracted folders:

| Region | GraphHopper service | PBF | Graph cache | SQLite DB |
| --- | --- | --- | --- | --- |
| Italy | `graphhopper-italy` | `pbf/italy-260626.osm.pbf` | `runtime/graphhopper/graphs/italy-gh9` | `runtime/local_osm_pois/italy.sqlite3` |
| London | `graphhopper-london` | `pbf/greater-london-260626.osm.pbf` | `runtime/graphhopper/graphs/london-gh9` | `runtime/local_osm_pois/london.sqlite3` |
| New York | `graphhopper-new-york` | `pbf/new-york-260626.osm.pbf` | `runtime/graphhopper/graphs/new-york-gh9` | `runtime/local_osm_pois/new-york.sqlite3` |

## 16. Backend API Map

Important routes:

| API | View | Purpose |
| --- | --- | --- |
| `/api/backend_astar/` | `backend_astar_route()` | Main backend clinical/environmental routing |
| `/api/pois/` | `get_pois_in_bbox()` | Real POIs from local SQLite or Overpass fallback |
| `/api/environment/` | `get_real_environment_data()` | Real environmental payload for points/waypoints |
| `/api/air_quality/` | `get_air_quality_data()` | Air quality at a point |
| `/api/pollen/` | `get_pollen()` | Pollen forecast |
| `/api/street_graph/` | `get_street_graph()` | Overpass street graph endpoint/fallback/debug |
| `/api/optimized_route/` | `optimized_route()` | Older optimized route endpoint |
| `/api/astar_route/` | `astar_route()` | Older/grid A* endpoint |
| `/api/shortest_route/` | `shortest_route()` | Direct route endpoint |

## 17. High-Level Difference From Original Version

| Area | Original baseline | Current version |
| --- | --- | --- |
| Routing ownership | Mostly client-side / browser orchestration | Backend-first `/api/backend_astar/` |
| Road data | Browser/API calls, Mapbox/ORS/Overpass-style flow | Local GraphHopper OSM graph preferred |
| A* | Grid A* in browser/Python research path | Backend scoring + street-graph A* fallback |
| Route reality | Grid paths could need snapping | GraphHopper gives road-real geometry |
| POIs | Public Overpass during interaction | Local SQLite extracted from PBF, Overpass fallback |
| Walkability | Limited or synthetic/proxy | Local OSM tags: steps, incline, surface, smoothness, wheelchair |
| Air quality | API-based and partly frontend | Backend Open-Meteo primary, OpenAQ fallback |
| Layers | Basic heatmap/layer idea | PM2.5/PM10/NO2/O3/pollen real sample surfaces |
| Preferences | User profile preferences | Built-in route styles + custom saved route-style sets |
| Clinical profiles | Less integrated | Explicit patient condition selector and weights |
| Distance tolerance | Not strongly tied to backend route generation | Affects route bbox, GraphHopper alternatives, preference scaling |
| Duplicate alternatives | Could appear in UI | Backend and frontend dedup/filtering |
| State persistence | Form selections could be lost | `mapState.js` persists start/end/controls locally |
| Deployment | Dev-oriented README/runserver/setup.py | Docker, Nginx, env, mounted runtime data, bootstrap scripts |
| Secrets | Original had hard-coded/client tokens in places | Env-driven `.env`, `.gitignore`, `.dockerignore` |
| Testing | Limited Django/browser scripts | Backend pytest files, runtime config checks, Playwright GUI suite |

## 18. File-Level Difference From Original

Major new files/folders in current repo:

```text
Dockerfile
docker-compose.yml
docker-compose.local.yml
docker-compose.osm-data.yml
docker/entrypoint.sh
deploy/
.env.example
.dockerignore
.gitignore
evaluations/backend_astar.py
evaluations/local_osm_poi_service.py
evaluations/pollen_service.py
evaluations/real_environment_service.py
scripts/build_local_osm_pois.py
scripts/check_runtime_config.py
scripts/ensure_local_osm_poi_db.py
scripts/smoke_backend_cities.py
scripts/smoke_gui.py
scripts/start_graphhopper.sh
tests/playwright/
static/js/mapState.js
static/js/environmentInspector.js
static/js/routeStepSimulator.js
static/js/services/poisAlongRoute.js
static/js/utils/envQualityBadge.js
static/css/theme.css
docs/REAL_DATA_ROUTING_EVOLUTION.md
docs/LOCAL_ROUTING_ENGINE.md
docs/deployment-linux-docker.md
```

Major modified areas:

```text
core/settings.py
core/views.py
evaluations/views.py
evaluations/urls.py
evaluations/environmental_astar.py
evaluations/environmental_data_service.py
evaluations/air_quality_service.py
static/js/services/routePlanner.js
static/js/master/routes.js
static/js/heatmap.js
static/js/suggestions.js
templates/map.html
static/css/map.css
users/models.py
users/forms.py
users/views.py
users/templates/*
requirements.txt
```

No meaningful source files from the baseline were intentionally deleted. The
current tree is mostly additions and modifications.

## 19. Verification And Tests

Backend tests added/used:

```text
evaluations/test_backend_astar.py
evaluations/test_astar_distance_tolerance.py
evaluations/test_ensure_local_osm_poi_db.py
evaluations/test_local_osm_poi_service.py
evaluations/test_runtime_config_check.py
evaluations/test_street_graph_service.py
evaluations/test_overpass_resilience.py
evaluations/test_air_quality_service.py
```

Runtime config check:

```bash
python scripts/check_runtime_config.py
```

Multi-city backend smoke:

```bash
python scripts/smoke_backend_cities.py --require-local-data --require-walkability
```

GUI tests:

```bash
PP_BASE_URL=http://127.0.0.1:8765 npm run test:gui
PP_BASE_URL=http://127.0.0.1:8765 npm run test:gui:full
```

The GUI tests are Playwright tests; they are not "manual only".

## 20. Current Known Limits

The current version is much stronger than the original, but these limits remain:

1. Multi-region routing depends on configured local assets.

   The Compose runtime now starts Italy, London, and New York GraphHopper
   services together and selects them by `PATHPLANNER_ROUTING_REGIONS`. Routes
   outside those configured bboxes still need another region entry, GraphHopper
   graph, and SQLite POI/walkability DB.

2. Air quality resolution is provider-dependent.

   Open-Meteo gives gridded coverage, not exact street-level measurements.
   OpenAQ gives station data where stations exist. In many cities, route-to-route
   air quality differences over short distances may be small or uncertain.

3. True terrain slope is not fully local.

   OSM PBF has `incline` when mapped, but not a DEM. Real slope still depends on
   external elevation APIs unless a local DEM is added.

4. SQLite is fine for demo/single-server, not ideal for high multi-user load.

   For production traffic, migrate Django data to PostgreSQL and keep OSM POI
   indexes either as SQLite read-only assets or move them to PostGIS.

5. Custom mixed preference sets are powerful but need careful UX.

   They should be presented as advanced route-style mixes, especially when users
   combine medical access with nightlife/tourism/entertainment.

6. Local OSM data freshness is tied to the PBF date.

   Updating maps means downloading newer PBFs, rebuilding GraphHopper graphs, and
   rebuilding local SQLite POI/walkability DBs.

## 21. Practical Mental Model

Use this model when explaining the app:

```text
The app does not invent route context.

Roads come from local OSM GraphHopper.
Parks/hospitals/places/walkability come from local OSM SQLite.
Air/weather/pollen come from real environmental APIs.
Clinical profiles and route styles turn those data into weights.
Distance tolerance controls how much extra distance the user accepts.
The backend ranks route candidates and sends full geometry plus explanation.
The frontend renders, previews, persists selections, and visualizes layers.
```

The original version was a browser-centered prototype. The current version is a
backend-centered, real-data clinical routing demo with explicit local data
assets and a deployable Docker contract.
