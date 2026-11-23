// Image-model pass: redraws each rendered window as an illustration while keeping streets and buildings in place.
// Windows overlap so seams can be feathered. Providers: openai (gpt-image-1 edits), gemini (image generation), mock (local filter).
//   REDRAW_PROVIDER=openai OPENAI_API_KEY=… bun run scripts/redraw.ts [cx,cy]
import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { CHUNK, DIRS } from "../config";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
const PROVIDER = process.env.REDRAW_PROVIDER || "mock", WIN = 1024, PAD = Number(process.env.PAD || 160), only = process.argv[2];
const UP = Number(process.env.UPSCALE || 1);
const WINDOWS = process.env.WINDOWS ? new Set(process.env.WINDOWS.split(";")) : null;   // "5,3;6,3" redraws just those 1024-px windows
const QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";   // 2 = ask the model for a 2x window and build 2x chunks (map gets twice the pixels)
const nx = geo.W / CHUNK, ny = geo.H / CHUNK;
mkdirSync(`${DIRS.out}/redrawn`, { recursive: true }); mkdirSync(`${DIRS.out}/redraw-cache`, { recursive: true });

const REF = process.env.REF ? Buffer.from(await Bun.file(process.env.REF).arrayBuffer()) : null;   // a finished window every call should match
const STYLE = `Redraw this 45-degree isometric map render of downtown Tempe, Arizona as a richly detailed hand-illustrated city
map, like a fine ink-and-watercolor architectural illustration. Keep EVERY street, sidewalk, lane marking, crosswalk, building
footprint, building height, roof shape, rooftop unit, tree and shadow exactly where it is, at the same size; do not add, remove,
move or widen anything; no text, labels or people. Elaborate the surfaces realistically: window grids and balconies on facades,
glass curtain walls with sky reflections, rooftop ducts and HVAC units, parapets, awnings and storefronts at street level, parked
cars in parking stalls, striped asphalt, concrete sidewalks with curbs, desert landscaping, palm and palo verde trees with soft
shadows. Mill Avenue itself: red brick-paver sidewalks, mature street trees and palms in tree wells, ornamental black lampposts,
restaurant patios with umbrellas, streetcar tracks set in the asphalt. Warm Arizona afternoon light, long soft shadows. Output the same framing.` + (REF ? `
The second image is a finished window of the same map and is a STYLE REFERENCE ONLY: match its palette, line weight,
paper tone, tree style and shading exactly so the two tile together seamlessly, but draw ONLY the buildings present in the
first image; never copy buildings, towers or landmarks from the reference.` : "");

// verified building notes whose roof centre falls inside a window, for the prompt
const sceneB = (JSON.parse(await Bun.file(`${DIRS.data}/scene.json`).text()).buildings as any[]).filter((b) => b.notes);
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const allB = (JSON.parse(await Bun.file(`${DIRS.data}/scene.json`).text()).buildings as any[]);
const roofPx = (b: any) => { const c = b.o.reduce((a: number[], p: number[]) => [a[0] + p[0] / b.o.length, a[1] + p[1] / b.o.length], [0, 0]); const w = [c[0], b.h, -c[1]]; return [(dot3(geo.cam.right, w) - geo.x0) / geo.mpp, (geo.y1 - dot3(geo.cam.up, w)) / geo.mpp]; };
const buildingsIn = (px: number, py: number, size: number) => allB.filter((b) => { const [x, y] = roofPx(b); return x >= px && x < px + size && y >= py && y < py + size; }).length;
const factsFor = (px: number, py: number, size: number) => sceneB.filter((b) => { const c = b.o.reduce((a: number[], p: number[]) => [a[0] + p[0] / b.o.length, a[1] + p[1] / b.o.length], [0, 0]); const w = [c[0], b.h, -c[1]];
  const x = (dot3(geo.cam.right, w) - geo.x0) / geo.mpp, y = (geo.y1 - dot3(geo.cam.up, w)) / geo.mpp; return x >= px && x < px + size && y >= py && y < py + size; }).map((b) => `- ${b.n}: ${b.notes}`).join("\n");

// one window of the full map, read across chunk boundaries
async function window_(px: number, py: number, w: number, h: number) {
  const parts: sharp.OverlayOptions[] = [];
  for (let cy = Math.floor(py / CHUNK); cy <= Math.floor((py + h - 1) / CHUNK); cy++) for (let cx = Math.floor(px / CHUNK); cx <= Math.floor((px + w - 1) / CHUNK); cx++) {
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
    const f = `${DIRS.out}/chunks/${cx}_${cy}.png`; if (!existsSync(f)) continue;
    const l = Math.max(px, cx * CHUNK), t = Math.max(py, cy * CHUNK), r = Math.min(px + w, (cx + 1) * CHUNK), b = Math.min(py + h, (cy + 1) * CHUNK);
    parts.push({ input: await sharp(f).extract({ left: l - cx * CHUNK, top: t - cy * CHUNK, width: r - l, height: b - t }).png().toBuffer(), left: l - px, top: t - py });
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: geo.palette.ground } }).composite(parts).png().toBuffer();
}

const providers: Record<string, (png: Buffer, size: number, facts?: string) => Promise<Buffer>> = {
  // local stand-in so the plumbing (windows, feathering, tiling) can run without any key
  async mock(png, size) { return sharp(png).resize(size, size).modulate({ saturation: 0.92 }).blur(0.6).sharpen({ sigma: 1.2 }).linear(1.04, -6).png().toBuffer(); },
  async openai(png, size, facts = "") {
    const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", prompt = STYLE + (facts ? `\n\nVerified facts about buildings in this view; draw them exactly so:\n${facts}` : "");
    for (const sz of [size, 1024]) {   // size is already the wanted output (window x UPSCALE); fall back to 1024 if refused
      const fd = new FormData(); fd.append("model", model); fd.append("prompt", prompt); fd.append("size", `${sz}x${sz}`); fd.append("quality", QUALITY); if (/gpt-image-1(\.|$)/.test(model)) fd.append("input_fidelity", "high");
      fd.append("image[]", new Blob([png], { type: "image/png" }), "window.png");
      if (REF) fd.append("image[]", new Blob([REF], { type: "image/png" }), "reference.png");
      const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: fd });
      if (r.ok) { const j = await r.json(); console.log(`  ${model} ${sz}px ok`); return Buffer.from(j.data[0].b64_json, "base64"); }
      const msg = (await r.text()).slice(0, 300); console.log(`  ${model} ${sz}px: ${r.status} ${msg}`);
      if (!(r.status === 400 && /size|input_fidelity/i.test(msg)) || sz === 1024) throw new Error(`openai ${r.status}: ${msg}`);
    }
    throw new Error("openai: no size accepted");
  },
  async gemini(png) {
    // newest first; a model the key cannot use (free tier, quota) falls through to the next
    const models = (process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image,gemini-3.1-flash-image,gemini-2.5-flash-image").split(",");
    let lastErr = "";
    for (const model of models) for (let attempt = 0; attempt < 3; attempt++) {
      const cfg: any = { responseModalities: ["IMAGE"] }; if (model.startsWith("gemini-3")) cfg.imageConfig = { aspectRatio: "1:1", imageSize: model.includes("pro") ? "2K" : "1K" };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: STYLE }, { inline_data: { mime_type: "image/png", data: png.toString("base64") } }] }], generationConfig: cfg }) });
      if (r.status === 429) { lastErr = `${model} 429`; console.log(`  ${model}: rate limited, waiting`); await Bun.sleep(20000 * (attempt + 1)); continue; }
      if (!r.ok) { lastErr = `${model} ${r.status}: ${(await r.text()).slice(0, 200)}`; console.log("  " + lastErr); break; }
      const j = await r.json(); const part = j.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData || p.inline_data);
      if (!part) { lastErr = `${model} returned no image: ${JSON.stringify(j).slice(0, 200)}`; console.log("  " + lastErr); break; }
      console.log(`  ${model} ok`); return Buffer.from((part.inlineData ?? part.inline_data).data, "base64");
    }
    throw new Error(lastErr);
  },
};
// Amazon Bedrock: Stability control-structure keeps the render's layout and repaints it in the prompt's style
providers.bedrock = async (png) => {
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  const modelId = process.env.BEDROCK_IMAGE_MODEL || "us.stability.stable-image-control-structure-v1:0";
  const body: any = { prompt: STYLE.replace(/\s+/g, " ").trim(), image: png.toString("base64"), control_strength: Number(process.env.CONTROL_STRENGTH || 0.75), output_format: "png",
    negative_prompt: "photorealistic, blurry, text, letters, watermark, people, cars, extra buildings, distorted streets, 3d render" };
  if (process.env.SEED) body.seed = Number(process.env.SEED);
  const r = await client.send(new InvokeModelCommand({ modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) }));
  const j = JSON.parse(new TextDecoder().decode(r.body));
  if (!j.images?.[0]) throw new Error(`bedrock: ${JSON.stringify(j).slice(0, 300)}`);
  if (j.finish_reasons?.[0] && j.finish_reasons[0] !== null) console.log("  bedrock finish:", j.finish_reasons[0]);
  return Buffer.from(j.images[0], "base64");
};
const redraw = providers[PROVIDER]; if (!redraw) throw new Error(`unknown provider ${PROVIDER}`);

// feather mask: full in the middle, fading over PAD px at each edge, so overlapping windows blend
const mask = await (async () => { const n = (WIN + 2 * PAD) * UP, PADU = PAD * UP, raw = Buffer.alloc(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const fx = Math.min(1, Math.min(x, n - 1 - x) / PADU), fy = Math.min(1, Math.min(y, n - 1 - y) / PADU); raw[y * n + x] = Math.round(255 * Math.min(fx, fy)); } return sharp(raw, { raw: { width: n, height: n, channels: 1 } }).png().toBuffer(); })();

// accumulate per chunk: redrawn windows composited with the feather mask onto the plain render. Windows run POOL at a time.
const POOL = Number(process.env.POOL || 4);
const acc = new Map<string, sharp.OverlayOptions[]>();
let n = 0, t0 = Date.now();
type Job = { wx: number; wy: number; px: number; py: number; size: number; cache: string };
const jobs: Job[] = [];
for (let wy = 0; wy * WIN < geo.H; wy++) for (let wx = 0; wx * WIN < geo.W; wx++) {
  const cx = Math.floor((wx * WIN) / CHUNK), cy = Math.floor((wy * WIN) / CHUNK); if (only && only !== `${cx},${cy}`) continue;
  if (WINDOWS && !WINDOWS.has(`${wx},${wy}`)) continue;
  const px = wx * WIN - PAD, py = wy * WIN - PAD, size = WIN + 2 * PAD, cache = `${DIRS.out}/redraw-cache/${process.env.PASS ? process.env.PASS + "-" : ""}${PAD !== 96 ? "p" + PAD + "-" : ""}${UP > 1 ? "x" + UP + "-" : ""}${PROVIDER}${process.env.CONTROL_STRENGTH ? "-cs" + process.env.CONTROL_STRENGTH : ""}${PROVIDER === "openai" ? "-" + (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2") + "-" + QUALITY : ""}_${wx}_${wy}.png`;
  jobs.push({ wx, wy, px, py, size, cache });
}
const FRAME = 6;   // px of neutral border the model is asked to keep; anchors the framing
async function edgeMap(png: Buffer, w: number, crop: number) {
  // edges of the inner region only (the frame and the window border would otherwise dominate the match)
  const { data } = await sharp(png).greyscale().resize(w, w, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const e = new Float32Array(w * w); for (let y = crop; y < w - crop; y++) for (let x = crop; x < w - crop; x++) { const i = y * w + x; e[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w]); }
  return e;
}
// zero-mean normalised cross-correlation of two edge maps, b shifted by (dx, dy)
function ncc(a: Float32Array, b: Float32Array, w: number, dx: number, dy: number, crop: number) {
  let sa = 0, sb = 0, n = 0; const xs: number[] = [];
  for (let y = crop + Math.max(0, -dy); y < w - crop - Math.max(0, dy); y += 2) for (let x = crop + Math.max(0, -dx); x < w - crop - Math.max(0, dx); x += 2) { const i = y * w + x, j = (y + dy) * w + x + dx; sa += a[i]; sb += b[j]; n++; }
  if (n < 100) return -1; const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
  for (let y = crop + Math.max(0, -dy); y < w - crop - Math.max(0, dy); y += 2) for (let x = crop + Math.max(0, -dx); x < w - crop - Math.max(0, dx); x += 2) { const i = y * w + x, j = (y + dy) * w + x + dx, p = a[i] - ma, q = b[j] - mb; num += p * q; da += p * p; db += q * q; }
  return num / Math.sqrt(da * db || 1);
}
// the output rescaled about its centre to the source size
const rescaled = async (out: Buffer, size: number, sc: number) => { if (sc === 1) return out; const ss = Math.round(size * sc), off = Math.round((ss - size) / 2); const big = await sharp(out).resize(ss, ss).extend({ top: 300, bottom: 300, left: 300, right: 300, background: "#eee5d6" }).png().toBuffer(); return sharp(big).extract({ left: 300 + off, top: 300 + off, width: size, height: size }).png().toBuffer(); };
// how far (dx, dy, scale) the output drifted from the source; identity wins unless a candidate is clearly better
async function registration(src: Buffer, out: Buffer, size: number) {
  const W1 = 168, W2 = 336, crop1 = Math.round((W1 * 48) / size), crop2 = Math.round((W2 * 48) / size);
  const A1 = await edgeMap(src, W1, crop1), A2 = await edgeMap(src, W2, crop2);
  const ident = ncc(A1, await edgeMap(out, W1, crop1), W1, 0, 0, crop1);
  let best = { dx: 0, dy: 0, sc: 1, v: ident };
  for (const sc of [0.97, 0.985, 1, 1.015, 1.03]) {
    const B1 = await edgeMap(await rescaled(out, size, sc), W1, crop1);
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const v = ncc(A1, B1, W1, dx, dy, crop1); if (v > best.v) best = { dx, dy, sc, v }; }
  }
  // refine at double resolution around the best
  const B2 = await edgeMap(await rescaled(out, size, best.sc), W2, crop2); const cx = best.dx * 2, cy = best.dy * 2; let fine = { dx: cx, dy: cy, v: -1 };
  for (let dy = cy - 3; dy <= cy + 3; dy++) for (let dx = cx - 3; dx <= cx + 3; dx++) { const v = ncc(A2, B2, W2, dx, dy, crop2); if (v > fine.v) fine = { dx, dy, v }; }
  const gain = best.v - ident;
  return { dx: (fine.dx * size) / W2, dy: (fine.dy * size) / W2, sc: best.sc, v: best.v, ident, gain };
}
async function registered(src: Buffer, out: Buffer, size: number, tag: string) {
  const r = await registration(src, out, size);
  if (r.gain < 0.03 || (Math.hypot(r.dx, r.dy) < 3 && r.sc === 1)) { console.log(`  ${tag}: aligned (ncc ${r.ident.toFixed(2)})`); return out; }
  console.log(`  ${tag}: drift dx=${r.dx.toFixed(0)} dy=${r.dy.toFixed(0)} scale=${r.sc} (ncc ${r.ident.toFixed(2)} -> ${r.v.toFixed(2)}); correcting`);
  // output content at scale sc sits at (+dx, +dy) relative to the source: rescale about the centre, then shift it back
  const scaled = await rescaled(out, size, r.sc);
  const big = await sharp(scaled).extend({ top: 300, bottom: 300, left: 300, right: 300, background: "#eee5d6" }).png().toBuffer();
  return sharp(big).extract({ left: 300 + Math.round(r.dx), top: 300 + Math.round(r.dy), width: size, height: size }).png().toBuffer();
}
async function runJob(j: Job): Promise<Buffer | null> {
  if (existsSync(j.cache)) return Buffer.from(await Bun.file(j.cache).arrayBuffer());
  const src = await window_(j.px, j.py, j.size, j.size);
  const st = await sharp(src).stats(); if (st.channels.every((c) => c.stdev < 3)) return null;   // plain ground: skip
  const outSize = j.size * UP;
  const framed = await sharp(src).extract({ left: FRAME, top: FRAME, width: j.size - 2 * FRAME, height: j.size - 2 * FRAME }).extend({ top: FRAME, bottom: FRAME, left: FRAME, right: FRAME, background: "#2b2420" }).png().toBuffer();
  const sent = PROVIDER === "bedrock" ? await sharp(framed).resize(1024, 1024).png().toBuffer() : framed;
  const facts = factsFor(j.px, j.py, j.size); if (facts) console.log(`  facts for window ${j.wx},${j.wy}:\n${facts}`);
  const got = await redraw(sent, outSize, facts);
  const raw = await sharp(got).resize(outSize, outSize, { fit: "fill" }).png().toBuffer(); await Bun.write(j.cache.replace(/([^/]+)$/, "raw-$1"), raw);
  // align to the source at render resolution, then drop the frame (fill it from the source so edges feather cleanly)
  const aligned = await registered(await sharp(src).resize(outSize, outSize).png().toBuffer(), raw, outSize, `window ${j.wx},${j.wy}`);
  const F = FRAME * UP, inner = await sharp(aligned).extract({ left: F, top: F, width: outSize - 2 * F, height: outSize - 2 * F }).png().toBuffer();
  const out = await sharp(await sharp(src).resize(outSize, outSize).png().toBuffer()).composite([{ input: inner, left: F, top: F }]).png().toBuffer();
  await Bun.write(j.cache, out); n++; console.log(`  window ${j.wx},${j.wy} done (${n} new, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return out;
}
const results = new Map<Job, Buffer | null>();
async function normaliseTones() {
  const stats = new Map<Job, { mean: number[]; std: number[] }>();
  for (const [j, buf] of results) if (buf) { const st = await sharp(buf).stats(); stats.set(j, { mean: st.channels.slice(0, 3).map((c) => c.mean), std: st.channels.slice(0, 3).map((c) => c.stdev) }); }
  if (stats.size < 3) return;
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const target = { mean: [0, 1, 2].map((c) => med([...stats.values()].map((s) => s.mean[c]))), std: [0, 1, 2].map((c) => med([...stats.values()].map((s) => s.std[c]))) };
  for (const [j, st] of stats) {
    const buf = results.get(j)!; const a = [0, 1, 2].map((c) => Math.min(1.25, Math.max(0.8, target.std[c] / (st.std[c] || 1)))), b = [0, 1, 2].map((c) => (target.mean[c] - st.mean[c] * a[c]) * 0.7);   // pull 70% of the way to the median
    const chans = await Promise.all([0, 1, 2].map((c) => sharp(buf).extractChannel(c as 0 | 1 | 2).linear(a[c], b[c]).toBuffer()));
    const meta = await sharp(buf).metadata();
    results.set(j, await sharp(chans[0], { raw: { width: meta.width!, height: meta.height!, channels: 1 } }).joinChannel([chans[1], chans[2]], { raw: { width: meta.width!, height: meta.height!, channels: 1 } }).png().toBuffer());
  }
  console.log(`tone-normalised ${stats.size} windows toward the median`);
}
for (let i = 0; i < jobs.length; i += POOL) await Promise.all(jobs.slice(i, i + POOL).map(async (j) => { try { results.set(j, await runJob(j)); } catch (e) { console.log(`  window ${j.wx},${j.wy} FAILED: ${String(e).slice(0, 200)}`); results.set(j, null); } }));
if (!process.env.NO_TONE) await normaliseTones();
for (const j of jobs) {
  const out = results.get(j); if (!out) continue;
  const masked = await sharp(out).ensureAlpha().joinChannel(mask, { raw: undefined }).removeAlpha().joinChannel(mask).png().toBuffer();
  for (let cy2 = Math.max(0, Math.floor(j.py / CHUNK)); cy2 <= Math.min(ny - 1, Math.floor((j.py + j.size - 1) / CHUNK)); cy2++) for (let cx2 = Math.max(0, Math.floor(j.px / CHUNK)); cx2 <= Math.min(nx - 1, Math.floor((j.px + j.size - 1) / CHUNK)); cx2++) {
    const k = `${cx2}_${cy2}`; (acc.get(k) ?? acc.set(k, []).get(k)!).push({ input: masked, left: (j.px - cx2 * CHUNK) * UP, top: (j.py - cy2 * CHUNK) * UP });
  }
}
const OUTCHUNK = CHUNK * UP, WSIZE = (WIN + 2 * PAD) * UP;
for (const [k, parts] of acc) {
  const base = `${DIRS.out}/chunks/${k}.png`; if (!existsSync(base)) continue;
  if (only && k !== only.replace(",", "_")) continue;
  const clipped: sharp.OverlayOptions[] = [];
  for (const p of parts) {
    const l = Math.max(0, p.left as number), t = Math.max(0, p.top as number), r = Math.min(OUTCHUNK, (p.left as number) + WSIZE), b = Math.min(OUTCHUNK, (p.top as number) + WSIZE);
    if (r <= l || b <= t) continue;
    clipped.push({ input: await sharp(p.input as Buffer).extract({ left: l - (p.left as number), top: t - (p.top as number), width: r - l, height: b - t }).png().toBuffer(), left: l, top: t });
  }
  const bg = UP > 1 ? await sharp(base).resize(OUTCHUNK, OUTCHUNK, { kernel: "lanczos3" }).png().toBuffer() : base;
  await sharp(bg).composite(clipped).png().toFile(`${DIRS.out}/redrawn/${k}.png`);
}
console.log(`redrew ${n} new windows with ${PROVIDER}; ${acc.size} chunks written to ${DIRS.out}/redrawn/`);
