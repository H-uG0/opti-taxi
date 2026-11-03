#!/bin/sh
# Entrypoint of the demo container (Dockerfile, service "web" of docker-compose.yml):
# applies the migrations, loads the fictitious data set on a fresh database, then
# starts the web server on port 3100.
set -e

# One random secret per container start unless one is given: open sessions end
# when the container restarts (sign in again).
if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  export SESSION_SECRET
fi

./node_modules/.bin/prisma migrate deploy

users="$(node -e "const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient(); p.user.count().then((n) => { console.log(n); return p.\$disconnect(); })")"
if [ "${DEMO_DATA:-1}" = "1" ] && [ "$users" = "0" ]; then
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
