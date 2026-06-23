# Deploy Linux/Docker di PathPlanner

Questa guida copre due installazioni su Linux:

1. Docker Compose con Gunicorn + Nginx, consigliata per un server singolo.
2. Servizio systemd non-Docker con Gunicorn + Nginx, utile se il server non deve usare container.

Non usare `setup.py` in produzione: e pensato per setup/dev e puo cancellare dati locali. Usa sempre `migrate` e `collectstatic`.

## Prerequisiti

- Ubuntu/Debian recente o distribuzione Linux equivalente.
- Docker Engine con plugin `docker compose`, oppure Python 3.12 + venv per installazione non-Docker.
- Dominio o IP pubblico.
- Token Mapbox (`MAPBOX_ACCESS_TOKEN`) per la mappa.
- Chiave OpenAQ opzionale (`OPENAQ_API_KEY`) se si vuole aumentare quota/affidabilita dei dati ambientali.

## Variabili ambiente

Copia `.env.example` in `.env` e compila solo valori reali sul server. Non committare `.env`.

```bash
cp .env.example .env
python - <<'PY'
from django.core.management.utils import get_random_secret_key
print(get_random_secret_key())
PY
```

Valori minimi:

```dotenv
DJANGO_DEBUG=0
DJANGO_SECRET_KEY=<secret-generata-sul-server>
DJANGO_ALLOWED_HOSTS=pathplanner.example.com,localhost,127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://pathplanner.example.com
MAPBOX_ACCESS_TOKEN=<token-mapbox>
OPENAQ_API_KEY=<opzionale>
```

Con HTTPS attivo lascia:

```dotenv
DJANGO_SECURE_SSL_REDIRECT=true
DJANGO_SESSION_COOKIE_SECURE=true
DJANGO_CSRF_COOKIE_SECURE=true
DJANGO_SECURE_HSTS_SECONDS=31536000
```

Se stai provando solo in HTTP temporaneo, imposta a `false` redirect/cookie secure e `0` HSTS, poi riattivali appena configuri TLS.

## Deploy con Docker Compose

Sul server:

```bash
sudo mkdir -p /opt/pathplanner
sudo chown "$USER":"$USER" /opt/pathplanner
git clone <repo-url> /opt/pathplanner/app
cd /opt/pathplanner/app
git checkout feature/a-star-preferences
cp .env.example .env
```

Compila `.env`, poi valida e avvia:

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

L'entrypoint esegue automaticamente:

```bash
python manage.py migrate --noinput
python manage.py collectstatic --noinput
```

Comandi manuali equivalenti:

```bash
docker compose exec app python manage.py migrate --noinput
docker compose exec app python manage.py collectstatic --noinput
docker compose exec app python manage.py check --deploy
```

Per validare il file Compose prima di creare `.env` reale:

```bash
PATHPLANNER_ENV_FILE=.env.example docker compose config
```

### Build/run Docker senza Compose

Utile per una prova locale:

```bash
docker build -t pathplanner:local .
docker run --rm --env-file .env -p 8000:8000 \
  -v pathplanner-db:/app/data \
  -v pathplanner-static:/app/staticfiles \
  -v pathplanner-uploads:/app/uploads \
  pathplanner:local
```

## Servizio Docker con systemd

Installa il template:

```bash
sudo cp deploy/systemd/pathplanner-docker.service /etc/systemd/system/pathplanner-docker.service
sudo systemctl daemon-reload
sudo systemctl enable --now pathplanner-docker
sudo systemctl status pathplanner-docker
```

Log:

```bash
docker compose logs -f
journalctl -u pathplanner-docker -n 200 --no-pager
```

## Nginx e TLS

Docker Compose usa `deploy/nginx/pathplanner-docker.conf` dentro il container Nginx e pubblica HTTP su porta 80.

Per HTTPS puoi mettere un reverse proxy host davanti al Compose, oppure estendere il container Nginx con certificati. Imposta sempre:

```dotenv
DJANGO_CSRF_TRUSTED_ORIGINS=https://pathplanner.example.com
DJANGO_SECURE_SSL_REDIRECT=true
```

Se usi Nginx host con installazione non-Docker:

```bash
sudo cp deploy/nginx/pathplanner-systemd.conf /etc/nginx/sites-available/pathplanner
sudo ln -s /etc/nginx/sites-available/pathplanner /etc/nginx/sites-enabled/pathplanner
sudo nginx -t
sudo systemctl reload nginx
```

Poi installa certificati con il flusso standard del server, ad esempio Certbot.

## Deploy non-Docker con systemd

```bash
sudo adduser --system --group --home /opt/pathplanner pathplanner
sudo mkdir -p /opt/pathplanner/app /opt/pathplanner/data /etc/pathplanner
sudo chown -R pathplanner:www-data /opt/pathplanner
sudo -u pathplanner git clone <repo-url> /opt/pathplanner/app
cd /opt/pathplanner/app
sudo -u pathplanner git checkout feature/a-star-preferences
sudo -u pathplanner python3.12 -m venv /opt/pathplanner/venv
sudo -u pathplanner /opt/pathplanner/venv/bin/pip install --upgrade pip
sudo -u pathplanner /opt/pathplanner/venv/bin/pip install -r requirements.txt
sudo cp .env.example /etc/pathplanner/pathplanner.env
sudo chown root:pathplanner /etc/pathplanner/pathplanner.env
sudo chmod 640 /etc/pathplanner/pathplanner.env
```

Modifica `/etc/pathplanner/pathplanner.env` con valori reali e path non-Docker:

```dotenv
DJANGO_STATIC_ROOT=/opt/pathplanner/app/staticfiles
DJANGO_MEDIA_ROOT=/opt/pathplanner/app/uploads
DJANGO_SQLITE_PATH=/opt/pathplanner/data/db.sqlite3
```

Collega il file env fuori repository al loader Django locale:

```bash
sudo -u pathplanner ln -sf /etc/pathplanner/pathplanner.env /opt/pathplanner/app/.env
```

Esegui setup applicativo:

```bash
sudo -u pathplanner /opt/pathplanner/venv/bin/python manage.py migrate --noinput
sudo -u pathplanner /opt/pathplanner/venv/bin/python manage.py collectstatic --noinput
sudo -u pathplanner /opt/pathplanner/venv/bin/python manage.py check --deploy
```

Installa il servizio:

```bash
sudo cp deploy/systemd/pathplanner-gunicorn.service /etc/systemd/system/pathplanner-gunicorn.service
sudo systemctl daemon-reload
sudo systemctl enable --now pathplanner-gunicorn
sudo systemctl status pathplanner-gunicorn
```

Log:

```bash
journalctl -u pathplanner-gunicorn -f
```

## Aggiornamento

Docker:

```bash
cd /opt/pathplanner/app
git fetch origin
git checkout feature/a-star-preferences
git pull --ff-only
docker compose build
docker compose up -d
docker compose exec app python manage.py migrate --noinput
docker compose exec app python manage.py collectstatic --noinput
```

Non-Docker:

```bash
cd /opt/pathplanner/app
sudo -u pathplanner git fetch origin
sudo -u pathplanner git checkout feature/a-star-preferences
sudo -u pathplanner git pull --ff-only
sudo -u pathplanner /opt/pathplanner/venv/bin/pip install -r requirements.txt
sudo systemctl stop pathplanner-gunicorn
sudo -u pathplanner /opt/pathplanner/venv/bin/python manage.py migrate --noinput
sudo -u pathplanner /opt/pathplanner/venv/bin/python manage.py collectstatic --noinput
sudo systemctl start pathplanner-gunicorn
```

## Rollback

Docker:

```bash
cd /opt/pathplanner/app
git log --oneline -5
git checkout <commit-buono>
docker compose build
docker compose up -d
```

Non-Docker:

```bash
cd /opt/pathplanner/app
sudo -u pathplanner git checkout <commit-buono>
sudo -u pathplanner /opt/pathplanner/venv/bin/pip install -r requirements.txt
sudo systemctl restart pathplanner-gunicorn
```

Se una migration ha modificato il DB, valuta restore da backup prima del rollback.

## Backup dati

Compose usa volumi persistenti:

- `pathplanner-db` -> `/app/data` con SQLite.
- `pathplanner-static` -> `/app/staticfiles`.
- `pathplanner-uploads` -> `/app/uploads`.

Backup semplice dei volumi a container fermo:

```bash
docker compose stop app
mkdir -p backups
docker run --rm -v pathplanner-db:/data -v "$PWD/backups:/backup" alpine \
  tar czf /backup/pathplanner-db-$(date +%Y%m%d-%H%M%S).tgz -C /data .
docker compose up -d
```

Per non-Docker, salva almeno `/opt/pathplanner/data/db.sqlite3` e `/opt/pathplanner/app/uploads`.

## Verifiche post-deploy

```bash
curl -I http://pathplanner.example.com/map/
curl -I http://pathplanner.example.com/static/
docker compose exec app python manage.py check --deploy
docker compose logs --tail=100 app
```

Nel browser verifica:

- `/map/` carica senza errore 500.
- La mappa usa il token Mapbox corretto.
- Login e calcolo rotta funzionano.
- Le API esterne eventualmente usate dal profilo paziente rispondono o degradano esplicitamente come non disponibili.

## Limiti noti

- SQLite e adatto a demo/single-server leggero; per traffico multiutente serio pianificare PostgreSQL e backup consistenti.
- TLS/certificati non sono inclusi nel Compose base: aggiungerli con reverse proxy host o estensione Nginx.
- `MAPBOX_ACCESS_TOKEN` e le chiavi API esterne restano secrets del server: non inserirle nel repository.
