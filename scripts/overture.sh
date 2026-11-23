#!/usr/bin/env bash
# Download Overture Maps buildings (LiDAR heights) and places (tenants) for a map's bbox into data/<map>/overture/.
# usage: scripts/overture.sh <map>   (needs uvx; reads the bbox from config.ts)
set -euo pipefail
map=${1:-mill}
bbox=$(bun -e "const { MAPS } = await import('./config.ts'); const b = MAPS['$map'].bbox ?? MAPS['$map']; console.log([b.west, b.south, b.east, b.north].join(','))")
mkdir -p "data/$map/overture"
for type in building place; do
  uvx overturemaps download --bbox="$bbox" -f geojson --type=$type -o "data/$map/overture/${type}s.geojson"
done
rm -f data/$map/overture/*.state
ls -la "data/$map/overture"
