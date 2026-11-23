# Small Phoenix

An illustrated, isometric map of ASU / Tempe, the Valley Metro Rail corridor past Sky Harbor, and downtown Phoenix, with every
Valley Metro train, streetcar and bus live. In the spirit of [smallsf.com](https://smallsf.com).

## How it's made

1. **OSM → scene.** `data/osm.geojson` is an osmium clip of the Geofabrik Arizona extract to the footprint in `config.ts`.
   `scripts/prep-scene.ts` turns it into local-metre geometry: extruded buildings (height / levels / type), road ribbons, rail,
   water, parks, parking, aprons, trees, traffic signals.
2. **Scene → picture.** `render/index.html` builds a three.js scene and `render/render.ts` drives it in headless Chrome with an
   orthographic camera looking north, tilted 45°. The map is rendered in 2048 px chunks, plus a linear depth pass.
3. **Picture → tiles.** `scripts/tile.ts` cuts chunks into a DeepZoom pyramid of WebP tiles and packs the depth into a
   gzipped 16-bit grid so live vehicles can hide behind buildings.
4. **Live.** `server.ts` serves the site and proxies Valley Metro's GTFS-Realtime vehicle positions as JSON (10 s cache).
   `public/transit.js` snaps trains to their GTFS shapes and eases every vehicle between reports.

```sh
bun install
curl -o data/arizona-latest.osm.pbf https://download.geofabrik.de/north-america/us/arizona-latest.osm.pbf
curl -o data/gtfs-static.zip "https://mna.mecatran.com/utw/ws/gtfsfeed/static/valleymetro?apiKey=4f22263f69671d7f49726c3011333e527368211f"
bun run data:osm && bun run build
bun run dev      # http://localhost:8787
```

`bun run scripts/where.ts <lat> <lon>` tells you which chunk a place is in; `bun run render <cx>,<cy>` re-renders one.

## Data

OpenStreetMap (© OSM contributors, ODbL) for everything drawn. Valley Metro / City of Phoenix GTFS and GTFS-Realtime for transit.
