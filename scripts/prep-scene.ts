// osmium-exported GeoJSON -> data/scene.json in local metres: extruded buildings, road ribbons, rail, areas, trees, signals.
import { toEN, BBOX } from "../config";

type Pt = [number, number];
const src = JSON.parse(await Bun.file("data/osm.geojson").text()) as { features: any[] };
const en = (c: number[]): Pt => { const { e, n } = toEN(c[1], c[0]); return [+e.toFixed(1), +n.toFixed(1)]; };
const ring = (r: number[][]) => r.map(en);

const metres = (v?: string) => {
  if (!v) return null;
  const m = v.match(/^([\d.]+)\s*(m|ft|')?/); if (!m) return null;
  const x = parseFloat(m[1]); return m[2] && m[2] !== "m" ? x * 0.3048 : x;
};
const buildingHeight = (t: Record<string, string>) => {
  const h = metres(t.height) ?? (t["building:levels"] ? parseFloat(t["building:levels"]) * 3.4 + 1 : null);
  if (h) return Math.min(h, 220);
  const b = t.building;
  if (/house|detached|residential|bungalow|garage|shed|hut|cabin/.test(b)) return 4.5;
  if (/apartments|dormitory|hotel|office|commercial|university|college|hospital|school/.test(b)) return 9;
  if (/industrial|warehouse|retail|supermarket|hangar|terminal/.test(b)) return 7;
  return 5.5;
};
const roadWidth = (t: Record<string, string>) => {
  const lanes = parseFloat(t.lanes);
  const base: Record<string, number> = { motorway: 15, motorway_link: 7, trunk: 13, trunk_link: 7, primary: 12, primary_link: 6, secondary: 10, secondary_link: 6, tertiary: 8, residential: 6, unclassified: 6, living_street: 5, service: 3.5, pedestrian: 5, footway: 1.6, path: 1.4, cycleway: 2, steps: 1.6, track: 2.5, busway: 7 };
  const w = base[t.highway]; if (w == null) return null;
  return lanes > 0 && !/footway|path|cycleway|steps/.test(t.highway) ? Math.max(w, lanes * 3.4) : w;
};

const scene = { buildings: [] as any[], roads: [] as any[], rails: [] as any[], areas: [] as any[], trees: [] as Pt[], signals: [] as Pt[], aero: [] as any[] };
const polys = (g: any): { outer: Pt[]; holes: Pt[][] }[] => {
  if (g.type === "Polygon") return [{ outer: ring(g.coordinates[0]), holes: g.coordinates.slice(1).map(ring) }];
  if (g.type === "MultiPolygon") return g.coordinates.map((p: number[][][]) => ({ outer: ring(p[0]), holes: p.slice(1).map(ring) }));
  return [];
};
const lines = (g: any): Pt[][] => g.type === "LineString" ? [ring(g.coordinates)] : g.type === "MultiLineString" ? g.coordinates.map(ring) : [];

for (const f of src.features) {
  const t = f.properties ?? {}; const g = f.geometry; if (!g) continue;
  if (g.type === "Point") {
    if (t.natural === "tree") scene.trees.push(en(g.coordinates));
    else if (t.highway === "traffic_signals") scene.signals.push(en(g.coordinates));
    continue;
  }
  if (t.building && t.building !== "no") {
    const h = buildingHeight(t), min = metres(t.min_height) ?? (t["building:min_level"] ? parseFloat(t["building:min_level"]) * 3.4 : 0);
    for (const p of polys(g)) if (p.outer.length >= 4) scene.buildings.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, h, m: min || undefined, k: t.building, n: t.name });
    continue;
  }
  if (t.highway) {
    const w = roadWidth(t); if (!w) continue;
    const layer = parseInt(t.layer) || 0, bridge = t.bridge && t.bridge !== "no", tunnel = t.tunnel && t.tunnel !== "no";
    if (tunnel) continue;
    for (const l of lines(g)) scene.roads.push({ p: l, w, c: t.highway, z: bridge ? Math.max(layer, 1) * 6 : 0, n: t.name });
    continue;
  }
  if (t.railway && /^(light_rail|rail|tram|subway|monorail)$/.test(t.railway)) {
    if (t.tunnel && t.tunnel !== "no") continue;
    const layer = parseInt(t.layer) || 0, bridge = t.bridge && t.bridge !== "no";
    for (const l of lines(g)) scene.rails.push({ p: l, k: t.railway, z: bridge ? Math.max(layer, 1) * 6 : 0 });
    continue;
  }
  if (t.aeroway === "runway" || t.aeroway === "taxiway") { for (const l of lines(g)) scene.aero.push({ p: l, w: t.aeroway === "runway" ? (metres(t.width) ?? 45) : 23, c: t.aeroway }); continue; }
  const kind = t.natural === "water" || /^(river|riverbank|canal|dock)$/.test(t.waterway ?? "") ? "water"
    : /^(park|garden|pitch|golf_course|dog_park|playground)$/.test(t.leisure ?? "") || /^(grass|recreation_ground|cemetery|forest|meadow|village_green)$/.test(t.landuse ?? "") ? "green"
    : t.leisure === "stadium" ? "stadium" : t.amenity === "parking" ? "parking" : t.aeroway === "apron" ? "apron" : null;
  if (kind) for (const p of polys(g)) scene.areas.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, k: kind });
}
await Bun.write("data/scene.json", JSON.stringify(scene));

// drivable graph for the traffic simulation: nodes keyed by coordinate (ways share exact coordinates at junctions)
{
  const CLS: Record<string, number> = { motorway: 0, motorway_link: 1, trunk: 2, trunk_link: 1, primary: 3, primary_link: 4, secondary: 5, secondary_link: 4, tertiary: 6, residential: 7, unclassified: 7, living_street: 8, busway: 6 };
  const nodeIx = new Map<string, number>(), nodes: Pt[] = [], edges: number[][] = [];
  const nid = (p: Pt) => { const k = p[0] + "," + p[1]; let i = nodeIx.get(k); if (i == null) { i = nodes.length; nodes.push(p); nodeIx.set(k, i); } return i; };
  for (const f of src.features) {
    const t = f.properties ?? {}, g = f.geometry; if (!g || !t.highway || CLS[t.highway] == null) continue;
    if ((t.tunnel && t.tunnel !== "no") || t.access === "private" || t.access === "no") continue;
    const oneway = t.oneway === "yes" || t.oneway === "1" || t.junction === "roundabout" ? 1 : t.oneway === "-1" ? -1 : 0;
    const lanes = Math.max(1, Math.round((parseFloat(t.lanes) || (CLS[t.highway] <= 3 ? 4 : CLS[t.highway] <= 6 ? 2 : 2)) / (oneway ? 1 : 2)));
    const z = t.bridge && t.bridge !== "no" ? Math.max(parseInt(t.layer) || 0, 1) * 6 : 0;
    const maxkph = parseFloat(t.maxspeed) ? (/mph/.test(t.maxspeed) ? parseFloat(t.maxspeed) * 1.609 : parseFloat(t.maxspeed)) : 0;
    for (const l of lines(g)) {
      const pts = oneway === -1 ? [...l].reverse() : l;
      for (let i = 0; i + 1 < pts.length; i++) edges.push([nid(pts[i]), nid(pts[i + 1]), CLS[t.highway], oneway ? 1 : 0, lanes, z, Math.round(maxkph)]);
    }
  }
  const signals = scene.signals.map((p) => nodeIx.get(p[0] + "," + p[1])).filter((i): i is number => i != null);
  await Bun.write("public/data/roads.json", JSON.stringify({ nodes, edges, signals }));
  console.log(`roads graph: ${nodes.length} nodes, ${edges.length} edges, ${signals.length} signals at nodes`);
}
const c = Object.fromEntries(Object.entries(scene).map(([k, v]) => [k, v.length]));
console.log(c, `${(JSON.stringify(scene).length / 1e6).toFixed(1)} MB`);
