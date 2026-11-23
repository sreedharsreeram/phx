// Drives the renderer page in headless Chrome: one PNG + one depth block per chunk into out/chunks/.
import puppeteer from "puppeteer";
import { CHUNK, DEPTH_CELL_PX } from "../config";
import { mkdirSync, existsSync } from "node:fs";

const geo = JSON.parse(await Bun.file("data/geo.json").text());
const only = process.argv[2];   // optional "cx,cy" to render one chunk
mkdirSync("out/chunks", { recursive: true });

const srv = Bun.serve({ port: 0, async fetch(req) { const p = decodeURIComponent(new URL(req.url).pathname); const f = Bun.file("." + p); return (await f.exists()) ? new Response(f) : new Response("nope", { status: 404 }); } });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", `--window-size=${CHUNK},${CHUNK}`, "--enable-unsafe-webgpu", "--js-flags=--max-old-space-size=8192"], protocolTimeout: 600000 });
const page = await browser.newPage(); await page.setViewport({ width: CHUNK, height: CHUNK, deviceScaleFactor: 1 });
page.on("console", (m) => console.log("  [page]", m.text())); page.on("pageerror", (e) => console.log("  [page error]", e.message));
await page.goto(`http://localhost:${srv.port}/render/index.html?chunk=${CHUNK}&depthDiv=${DEPTH_CELL_PX}`, { waitUntil: "load" });
const t0 = Date.now(); await page.waitForFunction("window.ready === true", { timeout: 600000 });
console.log(`scene built in ${((Date.now() - t0) / 1000).toFixed(1)}s`, await page.evaluate("JSON.stringify(window.camInfo)"));
await Bun.write("out/cam.json", await page.evaluate("JSON.stringify(window.camInfo)"));

const nx = geo.W / CHUNK, ny = geo.H / CHUNK; let done = 0;
for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
  if (only && only !== `${cx},${cy}`) continue;
  const base = `out/chunks/${cx}_${cy}`; if (existsSync(base + ".png") && !only && !process.env.FORCE) { done++; continue; }
  const t = Date.now();
  const r = (await page.evaluate(`window.renderChunk(${cx * CHUNK}, ${cy * CHUNK})`)) as { png: string; depth: string };
  await Bun.write(base + ".png", Buffer.from(r.png.slice(r.png.indexOf(",") + 1), "base64"));
  await Bun.write(base + ".depth", Buffer.from(r.depth, "base64"));
  console.log(`chunk ${cx},${cy} (${++done}/${nx * ny}) ${Date.now() - t}ms`);
}
await browser.close(); srv.stop(); console.log("done");
