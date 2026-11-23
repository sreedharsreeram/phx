// osmium-exported GeoJSON -> <data>/scene.json (local metres) + <pub>/roads.json (drivable graph), clipped to the map's box.
import { mkdirSync } from "node:fs";
import { toEN, BBOX, DIRS, ROAD_CLASS, LANE_W } from "../config";

type Pt = [number, number];
const src = JSON.parse(await Bun.file("data/osm.geojson").text()) as { features: any[] };
mkdirSync(DIRS.data, { recursive: true }); mkdirSync(DIRS.pub, { recursive: true });
const PAD = 0.004;   // keep a little outside the box so edges render through
const inBox = (c: number[]) => c[1] > BBOX.south - PAD && c[1] < BBOX.north + PAD && c[0] > BBOX.west - PAD && c[0] < BBOX.east + PAD;
const points = (c: any): number[][] => (typeof c[0] === "number" ? [c] : c.flatMap(points));
const touches = (g: any) => points(g.coordinates).some(inBox);
const en = (c: number[]): Pt => { const { e, n } = toEN(c[1], c[0]); return [+e.toFixed(2), +n.toFixed(2)]; };
const ring = (r: number[][]) => r.map(en);

const metres = (v?: string) => { if (!v) return null; const m = v.match(/^([\d.]+)\s*(m|ft|')?/); if (!m) return null; const x = parseFloat(m[1]); return m[2] && m[2] !== "m" ? x * 0.3048 : x; };
const buildingHeight = (t: Record<string, string>) => {
  const h = metres(t.height) ?? (t["building:levels"] ? parseFloat(t["building:levels"]) * 3.4 + 1 : null);
  if (h) return Math.min(h, 220);
  const b = t.building;
  if (/house|detached|residential|bungalow|garage|shed|hut|cabin/.test(b)) return 4.5;
  if (/apartments|dormitory|hotel|office|commercial|university|college|hospital|school/.test(b)) return 9;
  if (/industrial|warehouse|retail|supermarket|hangar|terminal/.test(b)) return 7;
  return 5.5;
};
// lanes -> width; the same numbers feed the traffic graph so cars always sit on asphalt
const roadSpec = (t: Record<string, string>) => {
  if (t.highway === "steps") return null;
  const foot = /^(footway|path|cycleway|pedestrian|track|corridor)$/.test(t.highway);
  if (foot) return { cls: 10, lanes: 0, width: t.highway === "pedestrian" ? 4 : t.highway === "cycleway" ? 2.2 : 1.8, sidewalk: 0, oneway: 0, kph: 0, foot: true };
  const spec = ROAD_CLASS[t.highway]; if (!spec) return null;
  const oneway = t.oneway === "yes" || t.oneway === "1" || t.junction === "roundabout" ? 1 : t.oneway === "-1" ? -1 : 0;
  const tagged = parseInt(t.lanes); const lanes = tagged > 0 ? tagged : oneway ? Math.max(1, Math.round(spec.lanes / 2)) : spec.lanes;
  const kph = parseFloat(t.maxspeed) ? (/mph/.test(t.maxspeed) ? parseFloat(t.maxspeed) * 1.609 : parseFloat(t.maxspeed)) : spec.kph;
  return { cls: spec.cls, lanes, width: Math.max(lanes * LANE_W, 3.5), sidewalk: spec.sidewalk, oneway, kph, foot: false };
};

const scene = { buildings: [] as any[], roads: [] as any[], rails: [] as any[], areas: [] as any[], trees: [] as Pt[], signals: [] as Pt[], aero: [] as any[], stops: [] as any[] };
const polys = (g: any): { outer: Pt[]; holes: Pt[][] }[] => g.type === "Polygon" ? [{ outer: ring(g.coordinates[0]), holes: g.coordinates.slice(1).map(ring) }] : g.type === "MultiPolygon" ? g.coordinates.map((p: number[][][]) => ({ outer: ring(p[0]), holes: p.slice(1).map(ring) })) : [];
const lines = (g: any): Pt[][] => g.type === "LineString" ? [ring(g.coordinates)] : g.type === "MultiLineString" ? g.coordinates.map(ring) : [];
const asu = (t: Record<string, string>) => /arizona state/i.test(t.operator ?? "") || /\bASU\b/.test(t.name ?? "");

for (const f of src.features) {
  const t = f.properties ?? {}; const g = f.geometry; if (!g || !touches(g)) continue;
  if (g.type === "Point") {
    if (t.natural === "tree") scene.trees.push(en(g.coordinates));
    else if (t.highway === "traffic_signals") scene.signals.push(en(g.coordinates));
    else if (t.highway === "bus_stop" || t.railway === "tram_stop") scene.stops.push({ p: en(g.coordinates), k: t.railway ? "tram" : "bus", n: t.name });
    continue;
  }
  if (t.building && t.building !== "no") {
    const h = buildingHeight(t), min = metres(t.min_height) ?? (t["building:min_level"] ? parseFloat(t["building:min_level"]) * 3.4 : 0);
    for (const p of polys(g)) if (p.outer.length >= 4) scene.buildings.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, h, m: min || undefined, k: t.building, n: t.name, u: asu(t) || undefined, r: t["roof:shape"], c: t["building:colour"] });
    continue;
  }
  if (t.highway) {
    const sp = roadSpec(t); if (!sp) continue;
    if (t.tunnel && t.tunnel !== "no") continue;
    const layer = parseInt(t.layer) || 0, bridge = t.bridge && t.bridge !== "no";
    for (const l of lines(g)) scene.roads.push({ p: sp.oneway === -1 ? [...l].reverse() : l, w: sp.width, c: t.highway, cls: sp.cls, lanes: sp.lanes, ow: sp.oneway ? 1 : 0, sw: sp.sidewalk, foot: sp.foot || undefined, z: bridge ? Math.max(layer, 1) * 6 : 0, n: t.name, kph: sp.kph });
    continue;
  }
  if (t.railway && /^(light_rail|rail|tram|subway|monorail)$/.test(t.railway)) {
    if (t.tunnel && t.tunnel !== "no") continue;
    const layer = parseInt(t.layer) || 0, bridge = t.bridge && t.bridge !== "no";
    for (const l of lines(g)) scene.rails.push({ p: l, k: t.railway, z: bridge ? Math.max(layer, 1) * 6 : 0 });
    continue;
  }
  if (t.railway === "platform" || t.public_transport === "platform") { for (const p of polys(g)) scene.areas.push({ o: p.outer, k: "platform" }); continue; }
  if (t.aeroway === "runway" || t.aeroway === "taxiway") { for (const l of lines(g)) scene.aero.push({ p: l, w: t.aeroway === "runway" ? (metres(t.width) ?? 45) : 23, c: t.aeroway }); continue; }
  const kind = t.natural === "water" || /^(river|riverbank|canal|dock)$/.test(t.waterway ?? "") ? "water"
    : /^(park|garden|pitch|golf_course|dog_park|playground)$/.test(t.leisure ?? "") || /^(grass|recreation_ground|cemetery|forest|meadow|village_green)$/.test(t.landuse ?? "") ? "green"
    : t.leisure === "stadium" ? "stadium" : t.amenity === "parking" && t.parking !== "multi-storey" && t.parking !== "underground" ? "parking" : t.aeroway === "apron" ? "apron"
    : t.leisure === "swimming_pool" ? "pool" : t.landuse === "construction" || t.landuse === "brownfield" ? "dirt" : null;
  if (kind) for (const p of polys(g)) scene.areas.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, k: kind });
}
await Bun.write(`${DIRS.data}/scene.json`, JSON.stringify(scene));
console.log(Object.fromEntries(Object.entries(scene).map(([k, v]) => [k, v.length])), `${(JSON.stringify(scene).length / 1e6).toFixed(1)} MB`);

// building footprints for the hover layer: outline in local metres, height, name, kind
await Bun.write(`${DIRS.pub}/buildings.json`, JSON.stringify(scene.buildings.filter((b) => b.o.length >= 4).map((b) => ({ o: b.o.map(([e, n]) => [+e.toFixed(1), +n.toFixed(1)]), h: +b.h.toFixed(1), m: b.m, n: b.n, k: b.k }))));

// drivable graph for the traffic simulation, with the same widths/lanes the renderer draws
{
  const nodeIx = new Map<string, number>(), nodes: Pt[] = [], edges: number[][] = [];
  const nid = (p: Pt) => { const k = p[0] + "," + p[1]; let i = nodeIx.get(k); if (i == null) { i = nodes.length; nodes.push(p); nodeIx.set(k, i); } return i; };
  for (const r of scene.roads) {
    if (r.foot || r.cls === 9) continue;   // no cars on footways or parking aisles
    for (let i = 0; i + 1 < r.p.length; i++) edges.push([nid(r.p[i]), nid(r.p[i + 1]), r.cls, r.ow, r.lanes, r.z, Math.round(r.kph), +r.w.toFixed(1)]);
  }
  const signals = scene.signals.map((p) => nodeIx.get(p[0] + "," + p[1])).filter((i): i is number => i != null);
  await Bun.write(`${DIRS.pub}/roads.json`, JSON.stringify({ nodes, edges, signals, laneW: LANE_W }));
  console.log(`roads graph: ${nodes.length} nodes, ${edges.length} edges, ${signals.length} signals at nodes`);
}
