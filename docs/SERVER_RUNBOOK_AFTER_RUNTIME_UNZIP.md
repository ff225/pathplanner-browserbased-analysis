# Server Runbook After Runtime Unzip

This is the shortest deploy checklist for the real-data routing version after
the runtime zip files have been copied to the server.

The runtime zip files are expected to be extracted into the project root. After
that, GraphHopper is started by Docker Compose; do not start GraphHopper
manually.

## 1. Update Code

```bash
cd /opt/pathplanner/app
git fetch origin
git checkout real-data-routing
git pull --ff-only
```

## 2. Extract Runtime Assets

Run these commands from any folder that contains the zip files:

```bash
unzip pathplanner-pbf.zip -d /opt/pathplanner/app
unzip pathplanner-local-osm-pois.zip -d /opt/pathplanner/app
unzip pathplanner-graphhopper.zip -d /opt/pathplanner/app
```

Then verify the expected files are present:

```bash
cd /opt/pathplanner/app
ls pbf/
ls runtime/local_osm_pois/
ls runtime/graphhopper/graphs/
ls runtime/graphhopper/lib/graphhopper-web-9.1.jar
```

Expected runtime coverage:

| Region | PBF | SQLite DB | GraphHopper graph |
| --- | --- | --- | --- |
| Italy | `pbf/italy-260626.osm.pbf` | `runtime/local_osm_pois/italy.sqlite3` | `runtime/graphhopper/graphs/italy-gh9` |
| London | `pbf/greater-london-260626.osm.pbf` | `runtime/local_osm_pois/london.sqlite3` | `runtime/graphhopper/graphs/london-gh9` |
| New York | `pbf/new-york-260626.osm.pbf` | `runtime/local_osm_pois/new-york.sqlite3` | `runtime/graphhopper/graphs/new-york-gh9` |

## 3. Configure `.env`

Create the file:

```bash
cp .env.example .env
```

Set these values:

```dotenv
DJANGO_SECRET_KEY=<long-secret-generated-on-server>
DJANGO_ALLOWED_HOSTS=<domain-or-ip>,localhost,127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=http://<domain-or-ip>
MAPBOX_ACCESS_TOKEN=<mapbox-token>
OPENAQ_API_KEY=<optional>
```

For temporary HTTP-only demo access, use:

```dotenv
DJANGO_SECURE_SSL_REDIRECT=false
DJANGO_SESSION_COOKIE_SECURE=false
DJANGO_CSRF_COOKIE_SECURE=false
DJANGO_SECURE_HSTS_SECONDS=0
```

Leave these values as they are in `.env.example`:

```dotenv
GRAPHHOPPER_URL=
LOCAL_OSM_POI_DB=
LOCAL_OSM_PBF_PATH=
PATHPLANNER_ENSURE_LOCAL_OSM_DB=false
PATHPLANNER_ROUTING_REGIONS=italy|32.90,-5.52,47.26,21.72|http://graphhopper-italy:8989|/app/runtime/local_osm_pois/italy.sqlite3;london|51.20,-0.65,51.75,0.45|http://graphhopper-london:8989|/app/runtime/local_osm_pois/london.sqlite3;new-york|40.40,-74.35,41.05,-73.55|http://graphhopper-new-york:8989|/app/runtime/local_osm_pois/new-york.sqlite3
```

Do not edit `PATHPLANNER_ROUTING_REGIONS` unless the deployed regions change.
It is what lets the backend serve Italy, London, and New York together.

## 4. Start Docker Compose

```bash
docker compose -f docker-compose.yml -f docker-compose.osm-data.yml up -d --build
```

Compose starts:

| Service | Purpose | Host check |
| --- | --- | --- |
| `app` | Django/Gunicorn app | through Nginx on port `80` |
| `nginx` | HTTP frontend/reverse proxy | `http://<server>/map/` |
| `graphhopper-italy` | Italy road graph | `http://127.0.0.1:8989/info` |
| `graphhopper-london` | London road graph | `http://127.0.0.1:8991/info` |
| `graphhopper-new-york` | New York road graph | `http://127.0.0.1:8993/info` |

## 5. Verify Runtime

```bash
docker compose -f docker-compose.yml -f docker-compose.osm-data.yml ps
docker compose -f docker-compose.yml -f docker-compose.osm-data.yml exec app python scripts/check_runtime_config.py
```

Expected output includes:

```text
Runtime config: ok
GraphHopper regions: 3/3 ok
Local DB regions: 3/3 ok
```

Check GraphHopper from the server:

```bash
curl http://127.0.0.1:8989/info
curl http://127.0.0.1:8991/info
curl http://127.0.0.1:8993/info
```

Run backend smoke tests:

```bash
docker compose -f docker-compose.yml -f docker-compose.osm-data.yml exec app \
  python scripts/smoke_backend_cities.py \
  --base-url http://127.0.0.1:8000 \
  --require-local-data \
  --require-walkability
```

Expected result:

```text
6 passed, 0 failed, 0 skipped
```

## 6. Access From Your Machine

The app is exposed by Nginx on server port `80`.

For SSH tunnelling:

```bash
ssh -L 8080:127.0.0.1:80 user@server
```

Then open:

```text
http://127.0.0.1:8080/map/
```

The GraphHopper ports `8989`, `8991`, and `8993` are host-side checks only. The
frontend does not call them directly.
