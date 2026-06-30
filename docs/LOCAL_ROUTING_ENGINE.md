# Local routing engine option

The app can optionally use a GraphHopper-compatible routing service before the
Overpass street-graph A* path.

Why this exists:

- Public Overpass is real OSM data, but it is shared infrastructure and can time
  out under bbox-heavy route requests.
- A local GraphHopper instance uses real OSM extracts too, but keeps the routing
  graph local and predictable for demos.
- The app still owns the clinical/environmental scoring. GraphHopper supplies
  candidate routes; PathPlanner ranks them using patient weights, real
  air-quality/weather/elevation samples, and real OSM POIs when available.

Configuration:

```env
PATHPLANNER_ROUTING_REGIONS=italy|32.90,-5.52,47.26,21.72|http://graphhopper-italy:8989|/app/runtime/local_osm_pois/italy.sqlite3;london|51.20,-0.65,51.75,0.45|http://graphhopper-london:8989|/app/runtime/local_osm_pois/london.sqlite3;new-york|40.40,-74.35,41.05,-73.55|http://graphhopper-new-york:8989|/app/runtime/local_osm_pois/new-york.sqlite3
GRAPHHOPPER_TIMEOUT_SECONDS=8
GRAPHHOPPER_FORCE=false
GRAPHHOPPER_PROFILE_WALKING=foot
GRAPHHOPPER_PROFILE_CYCLING=bike
GRAPHHOPPER_PROFILE_CAR=car
```

Behavior:

- If start/end match a configured region, that region's GraphHopper and local
  SQLite DB are used.
- If no region matches and `GRAPHHOPPER_URL` is empty, the backend uses
  Overpass street-graph A*.
- If no region matches and `GRAPHHOPPER_URL` is set, that single GraphHopper URL
  is used as fallback.
- If GraphHopper is set but unavailable, the backend falls back to Overpass A*
  unless `GRAPHHOPPER_FORCE=true`.
- If `GRAPHHOPPER_FORCE=true` and GraphHopper cannot return usable routes, the
  endpoint returns a service error instead of silently using Overpass.

This is not a city cache. The routing graph comes from an OSM extract chosen for
the demo/runtime, and the app still works with any city covered by that extract.

## Local demo imports

Local files currently tested under `pbf/`:

| Region | PBF | Import result | Graph size | Direct route API |
| --- | --- | ---: | ---: | ---: |
| London | `greater-london-260626.osm.pbf` | ~10 s | 79 MB | ~8-82 ms |
| New York | `new-york-260626.osm.pbf` | ~33 s | 317 MB | ~93 ms |
| Italy | `italy-260626.osm.pbf` | ~2 min 35 s | 1.2 GB | ~69 ms for Modena |

Start the tested multi-region runtime:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.osm-data.yml up -d --build
curl http://127.0.0.1:8989/info
curl http://127.0.0.1:8991/info
curl http://127.0.0.1:8993/info
```

The Compose flow starts Django plus three GraphHopper services. Django reaches
them through the internal Docker network as `graphhopper-italy`,
`graphhopper-london`, and `graphhopper-new-york`; the host can inspect them on
ports `8989`, `8991`, and `8993`.

For debugging outside Compose, start one tested region manually:

```bash
scripts/start_graphhopper.sh italy
```

Or run it as a detached Docker container:

```bash
docker rm -f pathplanner-graphhopper-italy >/dev/null 2>&1 || true
docker run -d --name pathplanner-graphhopper-italy \
  -p 127.0.0.1:8989:8989 \
  -p 127.0.0.1:8990:8990 \
  -v "$PWD:/work" \
  -w /work \
  eclipse-temurin:17-jre \
  java -Xmx10g \
    -Ddw.graphhopper.datareader.file=/work/pbf/italy-260626.osm.pbf \
    -Ddw.graphhopper.graph.location=/work/runtime/graphhopper/graphs/italy-gh9 \
    -jar /work/runtime/graphhopper/lib/graphhopper-web-9.1.jar \
    server /work/runtime/graphhopper/config/pathplanner-demo.yml
```

If the Django app itself runs outside Compose and GraphHopper runs in Docker,
point it at the host-published port:

```env
GRAPHHOPPER_URL=http://127.0.0.1:8989
```

Observed backend end-to-end timings are still around 4 seconds for clinical
routes because PathPlanner adds environmental samples and POI scoring after
GraphHopper returns route candidates. GraphHopper itself returns the road route
in milliseconds, so the remaining latency is now in POI/environment scoring, not
road-graph acquisition.

## POI locality

Parks, hospitals, entertainment/nightlife/tourism POIs, and useful walkability
signals can also be moved off public Overpass. Build a local SQLite index from
the same PBF extract:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --pbf pbf/italy-260626.osm.pbf \
  --db runtime/local_osm_pois/italy.sqlite3
```

For faster route-scoring imports, skip walkability features:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --pbf pbf/italy-260626.osm.pbf \
  --db runtime/local_osm_pois/italy.sqlite3 \
  --poi-only
```

If a DB already exists, refresh its SQLite bbox indexes without reading the PBF:

```bash
.venv/bin/python scripts/build_local_osm_pois.py \
  --db runtime/local_osm_pois/italy.sqlite3 \
  --optimize-only
```

Then point the app at that explicit database:

```env
LOCAL_OSM_POI_DB=/app/runtime/local_osm_pois/italy.sqlite3
```

For local Docker, `docker-compose.osm-data.yml` mounts `runtime/local_osm_pois`
into `/app/runtime/local_osm_pois`; the backend selects the matching Italy,
London, or New York DB from `PATHPLANNER_ROUTING_REGIONS`. There is no hidden
persistent city cache.

Extracted POIs:

- parks: `leisure=park`, `landuse=grass`, `natural=wood` on nodes/ways
- hospitals/clinics: `amenity=hospital|clinic`, `healthcare=hospital|clinic`
- entertainment/nightlife/tourism: the same categories used by route scoring
- optional rest/access data: pharmacies, toilets, drinking water, benches

Extracted walkability feature centroids:

- `highway=steps`
- `incline=*`
- `surface=*`
- `smoothness=*`
- `wheelchair=*`

The PBF does not contain a full terrain model, so true slope percentage still
comes from elevation APIs unless we add a local DEM. OSM `incline` and `steps`
are real route-quality signals and can be folded into clinical scoring without
inventing values.
