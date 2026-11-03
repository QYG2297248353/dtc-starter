#!/bin/sh
# Container entrypoint: run database migrations, then exec the real command.
#
# Fail-fast: if `medusa db:migrate` fails, this script exits non-zero and the
# container never starts serving with a stale/partially-migrated schema.
#
# RUN_MIGRATIONS=false skips migrations — use it for extra replicas so only
# one instance performs the migration (see docs/DEPLOYMENT.md).
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Running database migrations (medusa db:migrate)..."
  ./node_modules/.bin/medusa db:migrate
  echo "[entrypoint] Migrations completed."
else
  echo "[entrypoint] RUN_MIGRATIONS=${RUN_MIGRATIONS}, skipping migrations."
fi

exec "$@"
