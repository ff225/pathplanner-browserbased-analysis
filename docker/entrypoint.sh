#!/bin/sh
set -eu

: "${DJANGO_SECRET_KEY:?DJANGO_SECRET_KEY is required}"
: "${DJANGO_ALLOWED_HOSTS:?DJANGO_ALLOWED_HOSTS is required}"

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec "$@"
