// Ground elevation for a map from the USGS 3DEP elevation service (free, no key): one GeoTIFF covering the map extent.
// Writes data/<map>/terrain.json (grid for the renderer) and public/maps/<map>/terrain.bin (+ meta) for the site.
// usage: MAP=mill bun run scripts/terrain.ts   [TERRAIN_CELL=2 metres per cell]
import { gzipSync } from "node:zlib";
import { fromArrayBuffer } from "geotiff";
import { DIRS } from "../config.ts";

const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
const CELL = Number(process.env.TERRAIN_CELL || 2), MARGIN = 150;
const { e0, e1, n0, n1 } = geo.extent;
const E0 = e0 - MARGIN, E1 = e1 + MARGIN, N0 = n0 - MARGIN, N1 = n1 + MARGIN;
const toLon = (e: number) => geo.center.lon + e / geo.mPerDegLon, toLat = (n: number) => geo.center.lat + n / geo.mPerDegLat;
const w = Math.min(4000, Math.ceil((E1 - E0) / CELL)), h = Math.min(4000, Math.ceil((N1 - N0) / CELL));
const url = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=${toLon(E0)},${toLat(N0)},${toLon(E1)},${toLat(N1)}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation&f=image`;
console.log(`USGS 3DEP ${w}x${h} cells of ~${CELL} m`);
const res = await fetch(url); if (!res.ok) throw new Error(`3DEP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const tiff = await fromArrayBuffer(await res.arrayBuffer()), img = await tiff.getImage();
const [raster] = (await img.readRasters()) as unknown as Float32Array[];
const W = img.getWidth(), H = img.getHeight();

// base = median elevation (downtown is flat; a butte is a small share of the cells), heights stored in decimetres above it
const vals = Array.from(raster).filter((v) => v > -1000 && Number.isFinite(v)).sort((a, b) => a - b);
const base = vals[Math.floor(vals.length / 2)], zmin = vals[0], zmax = vals[vals.length - 1];
const z = new Int16Array(W * H);
for (let i = 0; i < W * H; i++) { const v = raster[i]; z[i] = v > -1000 && Number.isFinite(v) ? Math.round((v - base) * 10) : 0; }
const meta = { e0: E0, n1: N1, cellE: (E1 - E0) / W, cellN: (N1 - N0) / H, w: W, h: H, base, zmin, zmax };
await Bun.write(`${DIRS.data}/terrain.json`, JSON.stringify({ ...meta, z: Array.from(z) }));
await Bun.write(`${DIRS.pub}/terrain.json`, JSON.stringify(meta));
const gz = gzipSync(Buffer.from(z.buffer));
await Bun.write(`${DIRS.pub}/terrain.bin`, gz);
console.log(`terrain: base ${base.toFixed(1)} m, range ${zmin.toFixed(1)}..${zmax.toFixed(1)} m (${(zmax - base).toFixed(0)} m above downtown), ${(gz.length / 1e3).toFixed(0)} KB gz`);
