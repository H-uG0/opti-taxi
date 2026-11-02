#!/usr/bin/env bash
# Local PostgreSQL cluster on port 5433 for machines where Docker cannot be used.
# Mirrors the docker-compose service (user/password/db = optitaxi).
#   scripts/local-postgres.sh init    # once: create the cluster in .local/pgdata and the database
#   scripts/local-postgres.sh start
#   scripts/local-postgres.sh stop
#   scripts/local-postgres.sh status
set -euo pipefail

cd "$(dirname "$0")/.."
DATA=.local/pgdata
PORT=5433
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || command -v psql)")}"

case "${1:-}" in
  init)
    mkdir -p .local
    printf 'optitaxi\n' > .local/pwfile
    "$PG_BIN/initdb" -D "$DATA" -U optitaxi --auth=scram-sha-256 --pwfile=.local/pwfile -E UTF8 --locale=C
    rm .local/pwfile
    "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT" -l .local/postgres.log start >/dev/null
    PGPASSWORD=optitaxi "$PG_BIN/createdb" -h localhost -p "$PORT" -U optitaxi optitaxi
    echo "PostgreSQL ready on localhost:$PORT (database optitaxi)"
    ;;
  start)
    "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT" -l .local/postgres.log start >/dev/null
    echo "PostgreSQL started on localhost:$PORT"
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DATA" stop
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$DATA" status
    ;;
  *)
    echo "usage: $0 init|start|stop|status" >&2
    exit 1
    ;;
esac
