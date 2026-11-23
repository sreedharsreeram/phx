// Image-model pass: redraws each rendered window as an illustration while keeping streets and buildings in place.
// Windows overlap so seams can be feathered. Providers: openai (gpt-image-1 edits), gemini (image generation), mock (local filter).
//   REDRAW_PROVIDER=openai OPENAI_API_KEY=… bun run scripts/redraw.ts [cx,cy]
import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { CHUNK, DIRS } from "../config";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
const PROVIDER = process.env.REDRAW_PROVIDER || "mock", WIN = 1024, PAD = 96, only = process.argv[2];
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
The second image is a finished window of the same map: match its palette, line weight, paper tone, tree style and shading
EXACTLY so the two tile together seamlessly.` : "");

// verified building notes whose roof centre falls inside a window, for the prompt
const sceneB = (JSON.parse(await Bun.file(`${DIRS.data}/scene.json`).text()).buildings as any[]).filter((b) => b.notes);
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
  const px = wx * WIN - PAD, py = wy * WIN - PAD, size = WIN + 2 * PAD, cache = `${DIRS.out}/redraw-cache/${UP > 1 ? "x" + UP + "-" : ""}${PROVIDER}${process.env.CONTROL_STRENGTH ? "-cs" + process.env.CONTROL_STRENGTH : ""}${PROVIDER === "openai" ? "-" + (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2") + "-" + QUALITY : ""}_${wx}_${wy}.png`;
  jobs.push({ wx, wy, px, py, size, cache });
}
async function runJob(j: Job): Promise<Buffer | null> {
  if (existsSync(j.cache)) return Buffer.from(await Bun.file(j.cache).arrayBuffer());
  const src = await window_(j.px, j.py, j.size, j.size);
  const st = await sharp(src).stats(); if (st.channels.every((c) => c.stdev < 3)) return null;   // plain ground: skip
  const outSize = j.size * UP, sent = PROVIDER === "bedrock" ? await sharp(src).resize(1024, 1024).png().toBuffer() : src;
  const facts = factsFor(j.px, j.py, j.size); if (facts) console.log(`  facts for window ${j.wx},${j.wy}:\n${facts}`);
  const got = await redraw(sent, outSize, facts);
  const out = await sharp(got).resize(outSize, outSize, { fit: "fill" }).png().toBuffer();
  await Bun.write(j.cache, out); n++; console.log(`  window ${j.wx},${j.wy} done (${n} new, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return out;
}
const results = new Map<Job, Buffer | null>();
for (let i = 0; i < jobs.length; i += POOL) await Promise.all(jobs.slice(i, i + POOL).map(async (j) => { try { results.set(j, await runJob(j)); } catch (e) { console.log(`  window ${j.wx},${j.wy} FAILED: ${String(e).slice(0, 200)}`); results.set(j, null); } }));
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
