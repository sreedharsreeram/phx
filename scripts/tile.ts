// out/chunks/*.png -> public/tiles/<level>/<x>_<y>.webp (DeepZoom layout, overlap 0) + public/map.json;
// out/chunks/*.depth -> public/depth.bin (gzipped row-delta Uint16 grid) + public/geo.json for the site.
import sharp from "sharp";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { CHUNK, TILE, DEPTH_CELL_PX, DIRS } from "../config";

sharp.cache(false); sharp.concurrency(4);
// SOURCE=redrawn uses out/redrawn/ (image-model pass) where a chunk exists there, else the plain render
const SOURCE = process.env.SOURCE || "chunks";
// REDRAWN_ONLY=13_3,1_1 limits which redrawn chunks are used (the rest stay plain)
const ONLY = process.env.REDRAWN_ONLY ? new Set(process.env.REDRAWN_ONLY.split(",")) : null;
const chunkPath = (cx: number, cy: number) => { const r = `${DIRS.out}/${SOURCE}/${cx}_${cy}.png`; return SOURCE !== "chunks" && existsSync(r) && (!ONLY || ONLY.has(`${cx}_${cy}`)) ? r : `${DIRS.out}/chunks/${cx}_${cy}.png`; };
// paper grain: a tiled noise texture multiplied in very lightly, so flat colour reads as print rather than vector
const grain = await sharp({ create: { width: 512, height: 512, channels: 3, noise: { type: "gaussian", mean: 236, sigma: 9 } } }).png().toBuffer();
const paper = async (src: string | Buffer) => sharp(src).composite([{ input: grain, tile: true, blend: "multiply" }]).png().toBuffer();
const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
// redrawn chunks may be UPSCALE x larger than the render; the map then has UP x the pixels. A depth-only run must keep the
// scale of the tiles already published, so it reads UP back from map.json instead of trusting the environment.
const published = existsSync(`${DIRS.pub}/map.json`) ? JSON.parse(await Bun.file(`${DIRS.pub}/map.json`).text()) : null;
const UP = process.env.DEPTH_ONLY && published ? published.W / geo.W : Number(process.env.UPSCALE || 1);
const W = geo.W * UP, H = geo.H * UP, OUTCHUNK = CHUNK * UP, nx = geo.W / CHUNK, ny = geo.H / CHUNK, PER = OUTCHUNK / TILE;
const maxLevel = Math.ceil(Math.log2(Math.max(W, H)));
const sizeAt = (L: number) => { const f = 2 ** (maxLevel - L); return { w: Math.ceil(W / f), h: Math.ceil(H / f) }; };
const VERSION = process.env.TILE_VERSION || Date.now().toString(36);
const dir = (L: number) => { const d = `${DIRS.pub}/tiles/${VERSION}/${L}`; mkdirSync(d, { recursive: true }); return d; };
const webp = { quality: 82, effort: 4 };

// full-resolution level: cut each chunk into PER x PER tiles
if (!process.env.DEPTH_ONLY) {
  const d = dir(maxLevel); let n = 0; const jobs: Promise<unknown>[] = [];
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const src = chunkPath(cx, cy); if (!existsSync(src)) { console.log("missing", src); continue; }
    const meta = await sharp(src).metadata(); const buf = await paper(meta.width === OUTCHUNK ? src : await sharp(src).resize(OUTCHUNK, OUTCHUNK, { kernel: "lanczos3" }).png().toBuffer());
    for (let ty = 0; ty < PER; ty++) for (let tx = 0; tx < PER; tx++) {
      const out = `${d}/${cx * PER + tx}_${cy * PER + ty}.webp`; if (existsSync(out)) continue;
      jobs.push(sharp(buf).extract({ left: tx * TILE, top: ty * TILE, width: TILE, height: TILE }).webp(webp).toFile(out)); n++;
    }
    await Promise.all(jobs); jobs.length = 0;
  }
  await Promise.all(jobs); console.log(`level ${maxLevel}: ${n} tiles`);
}
// every coarser level: each tile is the 2x2 block below it, halved
for (let L = maxLevel - 1; L >= 0 && !process.env.DEPTH_ONLY; L--) {
  const { w, h } = sizeAt(L), below = sizeAt(L + 1), d = dir(L), bd = `${DIRS.pub}/tiles/${VERSION}/${L + 1}`;
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
if (!process.env.DEPTH_ONLY) await Bun.write(`${DIRS.pub}/map.json`, JSON.stringify({ W, H, tileSize: TILE, format: "webp", maxLevel, tiles: `/${DIRS.pub}/tiles/${VERSION}/`.replace("/public/", "/"), v: VERSION }));

// depth grid: chunk blocks (Float32, CHUNK/cell square) -> one Uint16 grid, metres from `lo` over `span`, row-delta coded, gzipped
{
  const n = CHUNK / DEPTH_CELL_PX, gw = geo.W / DEPTH_CELL_PX, gh = geo.H / DEPTH_CELL_PX, grid = new Float32Array(gw * gh).fill(NaN);
  let lo = Infinity, hi = -Infinity;
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const f = `${DIRS.out}/chunks/${cx}_${cy}.depth`; if (!existsSync(f)) continue;
    const blk = new Float32Array((await Bun.file(f).arrayBuffer()));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = blk[y * n + x]; grid[(cy * n + y) * gw + cx * n + x] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  // the "far" clear value is the sky; cap the range at what the scene actually occupies so 16 bits resolve ~cm
  const vals = Array.from(grid).filter((v) => !Number.isNaN(v)); vals.sort((a, b) => a - b); const hiScene = vals[Math.floor(vals.length * 0.999)];
  const span = hiScene - lo, u16 = new Uint16Array(gw * gh), delta = new Int16Array(gw * gh);
  for (let i = 0; i < grid.length; i++) { const v = Number.isNaN(grid[i]) ? hiScene : Math.min(grid[i], hiScene); u16[i] = Math.round(((v - lo) / span) * 65535); }
  for (let y = 0; y < gh; y++) { let prev = 0; for (let x = 0; x < gw; x++) { const v = u16[y * gw + x]; delta[y * gw + x] = (v - prev) & 0xffff; prev = v; } }
  const gz = gzipSync(Buffer.from(delta.buffer));
  await Bun.write(`${DIRS.pub}/depth.bin`, gz);
  const cam = JSON.parse(await Bun.file(`${DIRS.out}/cam.json`).text());
  const site = { center: geo.center, mPerDegLat: geo.mPerDegLat, mPerDegLon: geo.mPerDegLon, pitch: geo.pitch, mpp: geo.mpp / UP, x0: geo.x0, y1: geo.y1, W, H, extent: geo.extent,
    depthGrid: { cell: DEPTH_CELL_PX * UP, w: gw, h: gh, lo, span, cam: { pos: cam.pos, dir: cam.dir } } };
  await Bun.write(`${DIRS.pub}/geo.json`, JSON.stringify({ ...site, map: geo.map, title: geo.title, workArea: geo.workArea ?? null }));
  console.log(`depth grid ${gw}x${gh}, ${lo.toFixed(1)}..${hiScene.toFixed(1)} m, ${(gz.length / 1e6).toFixed(1)} MB gz`);
}
