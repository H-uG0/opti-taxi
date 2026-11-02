#!/usr/bin/env bash
# Builds the OSRM routing graph for the Marseille – Grenoble axis
# (Provence-Alpes-Côte d'Azur + Rhône-Alpes extracts from Geofabrik).
# Needs Docker and ~4 GB of free disk. Takes 10-30 minutes.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p data
cd data

OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
OSMIUM_IMAGE=stefda/osmium-tool:1.16.0
BASE=https://download.geofabrik.de/europe/france

for region in provence-alpes-cote-d-azur rhone-alpes; do
  if [ ! -f "$region-latest.osm.pbf" ]; then
    curl -fL -o "$region-latest.osm.pbf" "$BASE/$region-latest.osm.pbf"
  fi
done

docker run --rm -v "$PWD:/data" -w /data "$OSMIUM_IMAGE" \
  osmium merge provence-alpes-cote-d-azur-latest.osm.pbf rhone-alpes-latest.osm.pbf -o region.osm.pbf --overwrite

docker run --rm -v "$PWD:/data" "$OSRM_IMAGE" osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -v "$PWD:/data" "$OSRM_IMAGE" osrm-partition /data/region.osrm
docker run --rm -v "$PWD:/data" "$OSRM_IMAGE" osrm-customize /data/region.osrm

echo "OSRM data ready. Start it with: docker compose --profile osrm up -d osrm"
echo "Then set OSRM_URL=http://osrm:5000 for the optimizer container (or http://localhost:5050 outside docker)."
