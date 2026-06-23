FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DJANGO_STATIC_ROOT=/app/staticfiles \
    DJANGO_MEDIA_ROOT=/app/uploads \
    DJANGO_SQLITE_PATH=/app/data/db.sqlite3

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY . /app/

RUN chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /app/data /app/staticfiles /app/uploads \
    && useradd --create-home --shell /usr/sbin/nologin pathplanner \
    && chown -R pathplanner:pathplanner /app

USER pathplanner

EXPOSE 8000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["gunicorn", "core.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-"]
