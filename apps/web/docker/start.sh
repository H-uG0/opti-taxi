#!/bin/sh
# Entrypoint of the web container (Dockerfile, service "web" of docker-compose.yml):
# applies the migrations, loads the fictitious data set on a fresh database in demo
# mode only (DEMO_MODE=1), then starts the web server on port 3100.
#
# DEMO_MODE=1 must be set on purpose (docker-compose.yml, the online demo): the seed
# creates accounts whose passwords are published in the README. Without it (the
# default, production) the database is left empty, and the server refuses to start
# in production if demo accounts exist (src/lib/demo.ts).
#
# MIGRATION_DATABASE_URL (production): the owner role of the tables, used for the
# migrations only. The app runs with DATABASE_URL, a runtime role that owns nothing
# and cannot alter the audit trail (README, « Journal d'audit »). Unset (development,
# demo): DATABASE_URL for both.
set -e

# One random secret per container start unless one is given: open sessions end
# when the container restarts (sign in again).
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  export SESSION_SECRET
fi

DATABASE_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}" ./node_modules/.bin/prisma migrate deploy

users="$(node -e "const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient(); p.user.count().then((n) => { console.log(n); return p.\$disconnect(); })")"
if [ -n "$DEMO_DATA" ] && [ -z "$DEMO_MODE" ]; then
  echo "DEMO_DATA n'est plus lu : le jeu fictif ne se charge qu'avec DEMO_MODE=1 (démonstration seulement)."
fi
if [ "${DEMO_MODE:-0}" = "1" ] && [ "$users" = "0" ]; then
  # Empty database: the seed and the history simulation are safe to run. Their
  # guard (prisma/safety.ts) refuses production mode and a non-local host by
  # default, hence the development mode and SEED_ALLOW_WIPE for these two runs.
  echo "Base vide : chargement du jeu de données fictif (seed)…"
  NODE_ENV=development SEED_ALLOW_WIPE=1 ./node_modules/.bin/tsx prisma/seed.ts
  # 20 past working days for the dashboard, in the background (a few minutes):
  # the app is usable meanwhile.
  (
    echo "Simulation de l'historique (20 jours ouvrés passés) en arrière-plan…"
    if NODE_ENV=development SEED_ALLOW_WIPE=1 ./node_modules/.bin/tsx prisma/history.ts; then
      echo "Historique simulé chargé : le tableau de bord a ses 20 jours passés."
    else
      echo "La simulation d'historique a échoué (voir ci-dessus) ; l'application reste utilisable."
    fi
  ) &
fi

exec ./node_modules/.bin/next start --port 3100 --hostname 0.0.0.0
