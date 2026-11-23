// Image-model pass: redraws each rendered window as an illustration while keeping streets and buildings in place.
// Windows overlap so seams can be feathered. Providers: openai (gpt-image-1 edits), gemini (image generation), mock (local filter).
//   REDRAW_PROVIDER=openai OPENAI_API_KEY=… bun run scripts/redraw.ts [cx,cy]
import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { CHUNK } from "../config";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const geo = JSON.parse(await Bun.file("data/geo.json").text());
const PROVIDER = process.env.REDRAW_PROVIDER || "mock", WIN = 1024, PAD = 96, only = process.argv[2];
const nx = geo.W / CHUNK, ny = geo.H / CHUNK;
mkdirSync("out/redrawn", { recursive: true }); mkdirSync("out/redraw-cache", { recursive: true });

const STYLE = `Redraw this top-down 45-degree isometric city map render as a warm, hand-illustrated map in the style of a detailed
isometric city poster: soft gouache textures, subtle paper grain, gentle ink outlines, pastel desert palette (cream ground,
sage greens, dusty terracotta and sand buildings, slate-blue glass towers, pale blue water). Keep EVERY street, building
footprint, building height, tree, parking lot and shadow exactly where it is and the same size; do not add, remove or move
anything; do not add text, labels, people or vehicles. This is Tempe / Phoenix, Arizona: desert light, palo verde and palm
trees, flat roofs with rooftop units. Output a single image of the same framing.`;

// one window of the full map, read across chunk boundaries
async function window_(px: number, py: number, w: number, h: number) {
  const parts: sharp.OverlayOptions[] = [];
  for (let cy = Math.floor(py / CHUNK); cy <= Math.floor((py + h - 1) / CHUNK); cy++) for (let cx = Math.floor(px / CHUNK); cx <= Math.floor((px + w - 1) / CHUNK); cx++) {
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
    const f = `out/chunks/${cx}_${cy}.png`; if (!existsSync(f)) continue;
    const l = Math.max(px, cx * CHUNK), t = Math.max(py, cy * CHUNK), r = Math.min(px + w, (cx + 1) * CHUNK), b = Math.min(py + h, (cy + 1) * CHUNK);
    parts.push({ input: await sharp(f).extract({ left: l - cx * CHUNK, top: t - cy * CHUNK, width: r - l, height: b - t }).png().toBuffer(), left: l - px, top: t - py });
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: geo.palette.ground } }).composite(parts).png().toBuffer();
}

const providers: Record<string, (png: Buffer, size: number) => Promise<Buffer>> = {
  // local stand-in so the plumbing (windows, feathering, tiling) can run without any key
  async mock(png) { return sharp(png).modulate({ saturation: 0.92 }).blur(0.6).sharpen({ sigma: 1.2 }).linear(1.04, -6).png().toBuffer(); },
  async openai(png, size) {
    const fd = new FormData(); fd.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"); fd.append("prompt", STYLE); fd.append("size", `${size}x${size}`); fd.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
    fd.append("image", new Blob([png], { type: "image/png" }), "window.png");
    const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: fd });
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json(); return Buffer.from(j.data[0].b64_json, "base64");
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
const mask = await (async () => { const n = WIN + 2 * PAD, raw = Buffer.alloc(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const fx = Math.min(1, Math.min(x, n - 1 - x) / PAD), fy = Math.min(1, Math.min(y, n - 1 - y) / PAD); raw[y * n + x] = Math.round(255 * Math.min(fx, fy)); } return sharp(raw, { raw: { width: n, height: n, channels: 1 } }).png().toBuffer(); })();

// accumulate per chunk: redrawn windows composited with the feather mask onto the plain render
const acc = new Map<string, sharp.OverlayOptions[]>();
let n = 0, t0 = Date.now();
for (let wy = 0; wy * WIN < geo.H; wy++) for (let wx = 0; wx * WIN < geo.W; wx++) {
  const cx = Math.floor((wx * WIN) / CHUNK), cy = Math.floor((wy * WIN) / CHUNK); if (only && only !== `${cx},${cy}`) continue;
  const px = wx * WIN - PAD, py = wy * WIN - PAD, size = WIN + 2 * PAD, cache = `out/redraw-cache/${PROVIDER}${process.env.CONTROL_STRENGTH ? "-cs" + process.env.CONTROL_STRENGTH : ""}_${wx}_${wy}.png`;
  let out: Buffer;
  if (existsSync(cache)) out = Buffer.from(await Bun.file(cache).arrayBuffer());
  else {
    const src = await window_(px, py, size, size);
    // skip windows that are plain ground: nothing to redraw, and it keeps the bill down
    const st = await sharp(src).stats(); if (st.channels.every((c) => c.stdev < 3)) continue;
    const sendSize = PROVIDER === "openai" || PROVIDER === "bedrock" ? 1024 : size;   // fixed/1 MP input sizes; scale there and back
    const sent = sendSize === size ? src : await sharp(src).resize(sendSize, sendSize).png().toBuffer();
    const got = await redraw(sent, sendSize);
    out = await sharp(got).resize(size, size, { fit: "fill" }).png().toBuffer();
    await Bun.write(cache, out); n++;
    if (n % 10 === 0) console.log(`${n} windows redrawn, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const masked = await sharp(out).ensureAlpha().joinChannel(mask, { raw: undefined }).removeAlpha().joinChannel(mask).png().toBuffer();
  for (let cy2 = Math.max(0, Math.floor(py / CHUNK)); cy2 <= Math.min(ny - 1, Math.floor((py + size - 1) / CHUNK)); cy2++) for (let cx2 = Math.max(0, Math.floor(px / CHUNK)); cx2 <= Math.min(nx - 1, Math.floor((px + size - 1) / CHUNK)); cx2++) {
    const k = `${cx2}_${cy2}`; (acc.get(k) ?? acc.set(k, []).get(k)!).push({ input: masked, left: px - cx2 * CHUNK, top: py - cy2 * CHUNK });
  }
}
for (const [k, parts] of acc) {
  const base = `out/chunks/${k}.png`; if (!existsSync(base)) continue;
  // sharp cannot composite outside the canvas: crop each overlay to the chunk first
  const clipped: sharp.OverlayOptions[] = [];
  for (const p of parts) {
    const l = Math.max(0, p.left as number), t = Math.max(0, p.top as number), r = Math.min(CHUNK, (p.left as number) + WIN + 2 * PAD), b = Math.min(CHUNK, (p.top as number) + WIN + 2 * PAD);
    if (r <= l || b <= t) continue;
    clipped.push({ input: await sharp(p.input as Buffer).extract({ left: l - (p.left as number), top: t - (p.top as number), width: r - l, height: b - t }).png().toBuffer(), left: l, top: t });
  }
  await sharp(base).composite(clipped).png().toFile(`out/redrawn/${k}.png`);
}
console.log(`redrew ${n} new windows with ${PROVIDER}; ${acc.size} chunks written to out/redrawn/`);
