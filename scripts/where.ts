// which chunk / pixel a lat,lon lands on:  bun run scripts/where.ts 33.4215 -111.9325
import { toEN, CHUNK, DIRS } from "../config";
const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
const [lat, lon] = process.argv.slice(2).map(Number); const { e, n } = toEN(lat, lon); const th = (geo.pitch * Math.PI) / 180;
const x = (e - geo.x0) / geo.mpp, y = (geo.y1 - n * Math.sin(th)) / geo.mpp;
console.log(`pixel ${x.toFixed(0)},${y.toFixed(0)}  chunk ${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
