// out/chunks/*.png -> public/tiles/<level>/<x>_<y>.webp (DeepZoom layout, overlap 0) + public/map.json;
// out/chunks/*.depth -> public/depth.bin (gzipped row-delta Uint16 grid) + public/geo.json for the site.
import sharp from "sharp";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { CHUNK, TILE, DEPTH_CELL_PX } from "../config";

sharp.cache(false); sharp.concurrency(4);
const geo = JSON.parse(await Bun.file("data/geo.json").text());
const { W, H } = geo, nx = W / CHUNK, ny = H / CHUNK, PER = CHUNK / TILE;
const maxLevel = Math.ceil(Math.log2(Math.max(W, H)));
const sizeAt = (L: number) => { const f = 2 ** (maxLevel - L); return { w: Math.ceil(W / f), h: Math.ceil(H / f) }; };
const VERSION = process.env.TILE_VERSION || Date.now().toString(36);
const dir = (L: number) => { const d = `public/tiles/${VERSION}/${L}`; mkdirSync(d, { recursive: true }); return d; };
const webp = { quality: 82, effort: 4 };

// full-resolution level: cut each chunk into PER x PER tiles
{
  const d = dir(maxLevel); let n = 0; const jobs: Promise<unknown>[] = [];
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const src = `out/chunks/${cx}_${cy}.png`; if (!existsSync(src)) { console.log("missing", src); continue; }
    for (let ty = 0; ty < PER; ty++) for (let tx = 0; tx < PER; tx++) {
      const out = `${d}/${cx * PER + tx}_${cy * PER + ty}.webp`; if (existsSync(out)) continue;
      jobs.push(sharp(src).extract({ left: tx * TILE, top: ty * TILE, width: TILE, height: TILE }).webp(webp).toFile(out)); n++;
      if (jobs.length >= 16) { await Promise.all(jobs); jobs.length = 0; }
    }
  }
  await Promise.all(jobs); console.log(`level ${maxLevel}: ${n} tiles`);
}
// every coarser level: each tile is the 2x2 block below it, halved
for (let L = maxLevel - 1; L >= 0; L--) {
  const { w, h } = sizeAt(L), below = sizeAt(L + 1), d = dir(L), bd = `public/tiles/${VERSION}/${L + 1}`;
  const cols = Math.ceil(w / TILE), rows = Math.ceil(h / TILE); let n = 0; const jobs: Promise<unknown>[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const out = `${d}/${i}_${j}.webp`; if (existsSync(out)) continue;
    const tw = Math.min(TILE, w - i * TILE), th = Math.min(TILE, h - j * TILE);
    const parts: sharp.OverlayOptions[] = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const bx = 2 * i + dx, by = 2 * j + dy, f = `${bd}/${bx}_${by}.webp`;
      if (bx * TILE >= below.w || by * TILE >= below.h || !existsSync(f)) continue;
      parts.push({ input: f, left: dx * TILE, top: dy * TILE });
    }
    const srcW = Math.min(2 * TILE, below.w - 2 * i * TILE), srcH = Math.min(2 * TILE, below.h - 2 * j * TILE);
    jobs.push(sharp({ create: { width: srcW, height: srcH, channels: 3, background: geo.palette.ground } }).composite(parts).png().toBuffer()
      .then((b) => sharp(b).resize(tw, th, { fit: "fill", kernel: "lanczos3" }).webp(webp).toFile(out))); n++;
    if (jobs.length >= 8) { await Promise.all(jobs); jobs.length = 0; }
  }
  await Promise.all(jobs); console.log(`level ${L}: ${cols}x${rows} = ${n} tiles (${w}x${h})`);
}
await Bun.write("public/map.json", JSON.stringify({ W, H, tileSize: TILE, format: "webp", maxLevel, tiles: `/tiles/${VERSION}/`, v: VERSION }));

// depth grid: chunk blocks (Float32, CHUNK/cell square) -> one Uint16 grid, metres from `lo` over `span`, row-delta coded, gzipped
{
  const n = CHUNK / DEPTH_CELL_PX, gw = W / DEPTH_CELL_PX, gh = H / DEPTH_CELL_PX, grid = new Float32Array(gw * gh).fill(NaN);
  let lo = Infinity, hi = -Infinity;
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const f = `out/chunks/${cx}_${cy}.depth`; if (!existsSync(f)) continue;
    const blk = new Float32Array((await Bun.file(f).arrayBuffer()));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = blk[y * n + x]; grid[(cy * n + y) * gw + cx * n + x] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  // the "far" clear value is the sky; cap the range at what the scene actually occupies so 16 bits resolve ~cm
  const vals = Array.from(grid).filter((v) => !Number.isNaN(v)); vals.sort((a, b) => a - b); const hiScene = vals[Math.floor(vals.length * 0.999)];
  const span = hiScene - lo, u16 = new Uint16Array(gw * gh), delta = new Int16Array(gw * gh);
  for (let i = 0; i < grid.length; i++) { const v = Number.isNaN(grid[i]) ? hiScene : Math.min(grid[i], hiScene); u16[i] = Math.round(((v - lo) / span) * 65535); }
  for (let y = 0; y < gh; y++) { let prev = 0; for (let x = 0; x < gw; x++) { const v = u16[y * gw + x]; delta[y * gw + x] = (v - prev) & 0xffff; prev = v; } }
  const gz = gzipSync(Buffer.from(delta.buffer));
  await Bun.write("public/depth.bin", gz);
  const cam = JSON.parse(await Bun.file("out/cam.json").text());
  const site = { center: geo.center, mPerDegLat: geo.mPerDegLat, mPerDegLon: geo.mPerDegLon, pitch: geo.pitch, mpp: geo.mpp, x0: geo.x0, y1: geo.y1, W, H, extent: geo.extent,
    depthGrid: { cell: DEPTH_CELL_PX, w: gw, h: gh, lo, span, cam: { pos: cam.pos, dir: cam.dir } } };
  await Bun.write("public/geo.json", JSON.stringify(site));
  console.log(`depth grid ${gw}x${gh}, ${lo.toFixed(1)}..${hiScene.toFixed(1)} m, ${(gz.length / 1e6).toFixed(1)} MB gz`);
}
