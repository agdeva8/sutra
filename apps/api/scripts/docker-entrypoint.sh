#!/bin/sh
# Start the API. Applies database migrations first unless RUN_MIGRATIONS=0 (set that on all but one
# replica, or when migrations are run as their own deploy step).
set -e
if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "applying migrations"
  alembic upgrade head
fi
exec uvicorn sutra_api.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
