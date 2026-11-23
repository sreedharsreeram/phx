// Writes data/geo.json (shared by the renderer and the site): the camera, the map's pixel extent, and the palette.
import { BBOX, CENTER, MPP, PITCH_DEG, CHUNK, DEPTH_CELL_PX, M_PER_DEG_LAT, M_PER_DEG_LON, toEN } from "../config";

const th = (PITCH_DEG * Math.PI) / 180, S = Math.sin(th), C = Math.cos(th);
const sw = toEN(BBOX.south, BBOX.west), ne = toEN(BBOX.north, BBOX.east);
const HMAX = 230;   // tallest thing we'd draw, metres
// screen-plane coordinates: sx = east, sy = n*sin(pitch) + h*cos(pitch)
const x0 = sw.e, x1 = ne.e, y1 = ne.n * S + HMAX * C, y0 = sw.n * S;
const W = Math.ceil((x1 - x0) / MPP / CHUNK) * CHUNK, H = Math.ceil((y1 - y0) / MPP / CHUNK) * CHUNK;
const geo = {
  center: CENTER, mPerDegLat: M_PER_DEG_LAT, mPerDegLon: M_PER_DEG_LON, pitch: PITCH_DEG, mpp: MPP,
  x0, y1, W, H, extent: { e0: sw.e, e1: ne.e, n0: sw.n, n1: ne.n },
  depthGrid: { cell: DEPTH_CELL_PX, w: W / DEPTH_CELL_PX, h: H / DEPTH_CELL_PX },
  palette: {
    ground: "#efe7da", road: "#f7f3ec", roadService: "#f1ece3", roadCasing: "#cdc3b4", path: "#e4dccd", bridgeShadow: "#d6ccbb",
    runway: "#d9d4ca", apron: "#e3ded4", parking: "#e6dfd3", green: "#b8cc95", stadium: "#a9c48a", water: "#8fb9d2",
    railBed: "#c9c0b1", lightRailBed: "#cfc5b4", rail: "#8b8378",
    buildings: ["#e7d8c3", "#dfd5c6", "#e4cfbf", "#d9d2cb", "#e9dfd0", "#d8cbbd", "#e2d3c9"], tower: "#c9d3dc", edge: "#5a4e42",
    tree: "#7a9e62", trunk: "#8a6a4d", pole: "#4d4842", lamp: "#3a3632",
  },
};
await Bun.write("data/geo.json", JSON.stringify(geo, null, 1));
console.log(`map ${W}x${H} px (${(W * H / 1e6).toFixed(0)} Mpx), chunks ${W / CHUNK}x${H / CHUNK}, depth grid ${geo.depthGrid.w}x${geo.depthGrid.h}`);
