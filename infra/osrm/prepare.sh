#!/usr/bin/env bash
# Builds the OSRM routing graph for the Marseille – Grenoble axis: the Geofabrik
# extracts of Provence-Alpes-Côte d'Azur and Rhône-Alpes, merged, then clipped
# to the service corridor before the OSRM steps. Clipping keeps the processing
# light (Lyon, Nice and northern Savoie are cut off) so it fits a laptop's
# Docker memory. Needs Docker, ~1 GB of download and ~3 GB of free disk.
#
#   bash infra/osrm/prepare.sh
#   OSRM_BBOX=4.7,43.0,6.8,45.5 bash infra/osrm/prepare.sh   # other corridor
#
# OSRM_BBOX = min lon, min lat, max lon, max lat. The default covers the trips of
# V (Marseille, Aix, Manosque, Sisteron, Gap, Grenoble) with a margin that keeps
# the A7 / A49 through Valence and the Hautes-Alpes up to Briançon.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p data
cd data

OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
# osmium (merge + clip) from Debian's package, built once into a local image.
OSMIUM_IMAGE=opti-taxi-osmium:bookworm
BASE=https://download.geofabrik.de/europe/france
BBOX="${OSRM_BBOX:-4.7,43.0,6.8,45.5}"

# Git Bash on Windows rewrites /data/... arguments into Windows paths: turn that
# off and mount the folder by its Windows path.
MOUNT="$PWD"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    export MSYS_NO_PATHCONV=1
    MOUNT="$(pwd -W)"
    ;;
esac

for region in provence-alpes-cote-d-azur rhone-alpes; do
  if [ ! -f "$region-latest.osm.pbf" ]; then
    echo "Téléchargement de $region…"
    # Resumes a partial download (-C -) and retries when the connection drops.
    curl -fL --progress-bar --retry 8 --retry-delay 5 --retry-all-errors -C - \
      -o "$region-latest.osm.pbf.part" "$BASE/$region-latest.osm.pbf"
    mv "$region-latest.osm.pbf.part" "$region-latest.osm.pbf"
  fi
done

if ! docker image inspect "$OSMIUM_IMAGE" > /dev/null 2>&1; then
  printf 'FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends osmium-tool && rm -rf /var/lib/apt/lists/*\n' \
    | docker build -t "$OSMIUM_IMAGE" -
fi

echo "Fusion des deux régions, puis découpe du corridor $BBOX…"
docker run --rm -v "$MOUNT:/data" -w /data "$OSMIUM_IMAGE" \
  osmium merge provence-alpes-cote-d-azur-latest.osm.pbf rhone-alpes-latest.osm.pbf -o merged.osm.pbf --overwrite
docker run --rm -v "$MOUNT:/data" -w /data "$OSMIUM_IMAGE" \
  osmium extract --bbox "$BBOX" --strategy smart merged.osm.pbf -o region.osm.pbf --overwrite
rm -f merged.osm.pbf

echo "Construction du graphe routier (profil voiture, algorithme MLD)…"
docker run --rm -v "$MOUNT:/data" "$OSRM_IMAGE" osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -v "$MOUNT:/data" "$OSRM_IMAGE" osrm-partition /data/region.osrm
docker run --rm -v "$MOUNT:/data" "$OSRM_IMAGE" osrm-customize /data/region.osrm

echo "Graphe OSRM prêt. Démarrage : docker compose --profile osrm up -d osrm"
echo "Puis OSRM_URL=http://osrm:5000 pour l'optimiseur dans Docker (http://localhost:5050 hors Docker)."
