// which chunk / pixel a lat,lon lands on:  MAP=mill bun run scripts/where.ts 33.4240 -111.9420
import { toEN, CHUNK, DIRS } from "../config";
const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
const [lat, lon] = process.argv.slice(2).map(Number); const { e, n } = toEN(lat, lon); const p = [e, 0, -n];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const x = (dot(geo.cam.right, p) - geo.x0) / geo.mpp, y = (geo.y1 - dot(geo.cam.up, p)) / geo.mpp;
console.log(`pixel ${x.toFixed(0)},${y.toFixed(0)}  chunk ${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
