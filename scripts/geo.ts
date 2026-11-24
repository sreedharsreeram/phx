// Writes data/geo.json (shared by the renderer and the site): the camera, the map's pixel extent, and the palette.
import { BBOX, CENTER, MPP, PITCH_DEG, YAW_DEG, CHUNK, DEPTH_CELL_PX, M_PER_DEG_LAT, M_PER_DEG_LON, toEN, DIRS, MAP, MAPS } from "../config";
import { mkdirSync } from "node:fs";
mkdirSync(DIRS.data, { recursive: true });

// World: X = east, Y = up, Z = -north. The camera sits far to the south-west and above, looking north-east and down.
const th = (PITCH_DEG * Math.PI) / 180, ya = (YAW_DEG * Math.PI) / 180, S = Math.sin(th), C = Math.cos(th);
const dir = [C * Math.sin(ya), -S, -C * Math.cos(ya)];                 // unit view direction
const right = [Math.cos(ya), 0, Math.sin(ya)];                          // screen x, in the ground plane, perpendicular to the view
const up = [S * Math.sin(ya), C, -S * Math.cos(ya)];                    // screen y (upwards): world-up with the view component removed
const DIST = 30000, pos = dir.map((d) => -d * DIST);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sw = toEN(BBOX.south, BBOX.west), ne = toEN(BBOX.north, BBOX.east);
const HMAX = 230;   // tallest thing we'd draw, metres
const corners: number[][] = []; for (const e of [sw.e, ne.e]) for (const n of [sw.n, ne.n]) for (const h of [0, HMAX]) corners.push([e, h, -n]);
const sx = corners.map((c) => dot(right, c)), sy = corners.map((c) => dot(up, c));
const x0 = Math.min(...sx), x1 = Math.max(...sx), y1 = Math.max(...sy), y0 = Math.min(...sy);
const W = Math.ceil((x1 - x0) / MPP / CHUNK) * CHUNK, H = Math.ceil((y1 - y0) / MPP / CHUNK) * CHUNK;
const geo = {
  center: CENTER, mPerDegLat: M_PER_DEG_LAT, mPerDegLon: M_PER_DEG_LON, pitch: PITCH_DEG, yaw: YAW_DEG, mpp: MPP, cam: { dir, right, up, pos, dist: DIST },
  x0, y1, W, H, extent: { e0: sw.e, e1: ne.e, n0: sw.n, n1: ne.n },
  depthGrid: { cell: DEPTH_CELL_PX, w: W / DEPTH_CELL_PX, h: H / DEPTH_CELL_PX },
  palette: {
    ground: "#eee5d6", road: "#c9c3b9", roadService: "#d6d0c6", roadCasing: "#a9a093", sidewalk: "#f4efe5", path: "#e4dccd", bridgeShadow: "#cfc5b4", laneYellow: "#dcb64f", laneWhite: "#f6f3ec", platform: "#ddd6c9", pool: "#7fc4e0", dirt: "#e3d6bf",
    runway: "#d9d4ca", apron: "#e3ded4", parking: "#e6dfd3", green: "#b8cc95", stadium: "#a9c48a", water: "#8fb9d2",
    railBed: "#c9c0b1", lightRailBed: "#cfc5b4", rail: "#8b8378", railTie: "#b7ad9c", hvac: "#d9d5cd", shelter: "#8e8a84", palm: "#6f9a52",
    asu: ["#b9764f", "#c98a5e", "#a8644a", "#d4a27a"],
    buildings: ["#e7d8c3", "#dfd5c6", "#e4cfbf", "#d9d2cb", "#e9dfd0", "#d8cbbd", "#e2d3c9"], tower: "#c9d3dc", edge: "#5a4e42",
    tree: "#7a9e62", trunk: "#8a6a4d", pole: "#4d4842", lamp: "#3a3632", scrub: "#8f9b6e", rock: "#b08a66", desert: "#e6d9c0",
  },
};
await Bun.write(`${DIRS.data}/geo.json`, JSON.stringify({ ...geo, map: MAP, title: MAPS[MAP].title, workArea: (MAPS[MAP] as any).workArea ?? null }, null, 1));
console.log(`map ${W}x${H} px (${(W * H / 1e6).toFixed(0)} Mpx), chunks ${W / CHUNK}x${H / CHUNK}, depth grid ${geo.depthGrid.w}x${geo.depthGrid.h}`);
