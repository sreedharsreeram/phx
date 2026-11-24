// osmium-exported GeoJSON -> <data>/scene.json (local metres) + <pub>/roads.json (drivable graph), clipped to the map's box.
import { existsSync, mkdirSync } from "node:fs";
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
    for (const p of polys(g)) if (p.outer.length >= 4) scene.buildings.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, h, m: min || undefined, k: t.building, n: t.name, hs: metres(t.height) ?? t["building:levels"] ? "osm" : "default", a: t["addr:housenumber"] && t["addr:street"] ? `${t["addr:housenumber"]} ${t["addr:street"]}` : undefined, u: asu(t) || undefined, r: t["roof:shape"], c: t["building:colour"] });
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
    : t.leisure === "swimming_pool" ? "pool" : t.landuse === "construction" || t.landuse === "brownfield" || t.landuse === "greenfield" ? "dirt"
    : /^(scrub|heath|sand|bare_rock|scree|grassland)$/.test(t.natural ?? "") || t.leisure === "nature_reserve" ? "desert" : null;
  if (kind) for (const p of polys(g)) scene.areas.push({ o: p.outer, i: p.holes.length ? p.holes : undefined, k: kind });
}
// photo-verified overrides beat OSM guesses: data/<map>/overrides.json [{ match: { name }, set: { h, k, c, glass, ... } }]
const ovPath = `${DIRS.data}/overrides.json`;
if (await Bun.file(ovPath).exists()) {
  const ov = JSON.parse(await Bun.file(ovPath).text()) as { match: { name?: string; at?: [number, number]; contains?: [number, number] }; set: Record<string, any> }[];
  const inPoly = (pt: { e: number; n: number }, o: number[][]) => { let c = false; for (let i = 0, j = o.length - 1; i < o.length; j = i++) if (o[i][1] > pt.n !== o[j][1] > pt.n && pt.e < ((o[j][0] - o[i][0]) * (pt.n - o[i][1])) / (o[j][1] - o[i][1]) + o[i][0]) c = !c; return c; };
  for (const o of ov) {
    let hits = scene.buildings.filter((b) => (o.match.name && b.n === o.match.name) || (o.match.at && Math.hypot(b.o[0][0] - toEN(o.match.at[0], o.match.at[1]).e, b.o[0][1] - toEN(o.match.at[0], o.match.at[1]).n) < 30) || (o.match.contains && inPoly(toEN(o.match.contains[0], o.match.contains[1]), b.o)));
    if (!hits.length && o.match.contains) {   // point just outside every footprint (POI pins sit on the sidewalk): nearest building within 30 m
      const pt = toEN(o.match.contains[0], o.match.contains[1]); let best = 30, pick: any;
      for (const b of scene.buildings) for (const [e, n] of b.o) { const d = Math.hypot(e - pt.e, n - pt.n); if (d < best) { best = d; pick = b; } }
      if (pick) hits = [pick];
    }
    for (const b of hits) { if (o.set.h) { b.h = o.set.h; b.hs = "override"; } if (o.set.k) b.k = o.set.k; if (o.set.c) b.c = o.set.c; if (o.set.glass) b.g = true; if (o.set.n) b.n = o.set.n; if (o.set.notes) b.notes = (b.notes ? b.notes + " " : "") + o.set.notes; b.v = true; }
    console.log(`override ${o.match.name ?? o.match.contains ?? o.match.at}: ${hits.length} building(s)`);
  }
}
// Overture Maps (scripts/overture.sh): USGS-LiDAR heights replace OSM defaults/estimates, Microsoft-ML heights replace only
// defaults, photo-verified overrides win; places become per-building tenants (hover) and storefront-sign facts (painter)
const ovDir = `${DIRS.data}/overture`;
const inPoly2 = (pt: number[], o: number[][]) => { let c = false; for (let i = 0, j = o.length - 1; i < o.length; j = i++) if (o[i][1] > pt[1] !== o[j][1] > pt[1] && pt[0] < ((o[j][0] - o[i][0]) * (pt[1] - o[i][1])) / (o[j][1] - o[i][1]) + o[i][0]) c = !c; return c; };
const centroid = (o: number[][]) => o.reduce((a, q) => [a[0] + q[0] / o.length, a[1] + q[1] / o.length], [0, 0]);
const nearestBuilding = (pt: number[], limit: number) => { let best = limit, pick: any; for (const b of scene.buildings) for (const [e, n] of b.o) { const d = Math.hypot(e - pt[0], n - pt[1]); if (d < best) { best = d; pick = b; } } return pick; };
if (existsSync(`${ovDir}/buildings.geojson`)) {
  const ob = JSON.parse(await Bun.file(`${ovDir}/buildings.geojson`).text()).features as any[];
  let lidar = 0, ml = 0;
  for (const f of ob) {
    const h = f.properties.height; if (!h) continue;
    const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    const c = centroid(ring.map(([lon, lat]: number[]) => { const q = toEN(lat, lon); return [q.e, q.n]; }));
    const b = scene.buildings.find((b) => inPoly2(c, b.o)) ?? (() => { let best = 8, pick: any; for (const b of scene.buildings) { const d = Math.hypot(...(centroid(b.o).map((v, i) => v - c[i]) as [number, number])); if (d < best) { best = d; pick = b; } } return pick; })();
    if (!b || b.hs === "override") continue;
    const src = (f.properties.sources ?? []).map((x: any) => x.dataset).join(" ");
    if (/Lidar/i.test(src)) { b.h = Math.max(2.5, h); b.hs = "lidar"; lidar++; }
    else if (/Microsoft/i.test(src) && b.hs === "default") { b.h = Math.max(2.5, h); b.hs = "ml"; ml++; }
  }
  console.log(`overture heights: ${lidar} from USGS LiDAR, ${ml} from Microsoft ML`);
}
if (existsSync(`${ovDir}/places.geojson`)) {
  const SIGN = new Set(["restaurant", "bar", "casual_eatery", "fast_food_restaurant", "coffee_shop", "cafe", "brewery", "food_and_beverage_store", "fashion_and_apparel_store", "hotel", "lodging", "bank_or_credit_union", "movie_theater", "convenience_store", "personal_care_and_beauty_store", "sporting_goods_store", "flowers_and_gifts_store", "electronics_store", "specialty_store", "hardware_home_and_garden_store", "toys_and_games_store", "gym", "fitness_studio", "smoothie_juice_bar", "non_alcoholic_beverage_venue", "nightlife_venue", "dance_club", "lounge", "music_venue", "theatre_venue", "pharmacy", "grocery_store", "shopping_mall", "market", "art_gallery", "museum", "bookstore", "ice_cream_shop", "dessert_shop", "pizza_restaurant", "tattoo_and_piercing"]);
  const pl = (JSON.parse(await Bun.file(`${ovDir}/places.geojson`).text()).features as any[]).filter((f) => (f.properties.confidence ?? 0) >= 0.6 && SIGN.has(f.properties.basic_category) && f.properties.names?.primary && !/\b(llc|inc|l\.l\.c|llp|festival)\b/i.test(f.properties.names.primary));
  const per = new Map<any, any[]>();
  for (const f of pl) { const q = toEN(f.geometry.coordinates[1], f.geometry.coordinates[0]), pt = [q.e, q.n]; const b = scene.buildings.find((b) => inPoly2(pt, b.o)) ?? nearestBuilding(pt, 12); if (b) (per.get(b) ?? per.set(b, []).get(b)!).push(f); }
  for (const [b, fs] of per) {
    const seen = new Set<string>(); const names: string[] = [];
    for (const f of fs.sort((x, y) => (y.properties.confidence ?? 0) - (x.properties.confidence ?? 0))) { const n = f.properties.names.primary.replace(/\s+-\s+Tempe$|\s+Tempe$/i, ""); const k = n.toLowerCase(); if (seen.has(k)) continue; seen.add(k); names.push(n); if (names.length >= 6) break; }
    b.t = names; b.notes = (b.notes ? b.notes + " " : "") + `Storefront signs: ${names.map((n) => `'${n}'`).join(", ")}.`;
  }
  console.log(`overture places: ${pl.length} sign-worthy tenants on ${per.size} buildings`);
}

// street trees: OSM has almost no trees mapped downtown, so plant them along sidewalks (both sides, every ~11 m on
// major streets, ~16 m on residential), skipping spots that already have a mapped tree or fall inside a building
{
  const pip = (x: number, y: number, r: Pt[]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const cell = 25, grid = new Map<string, Pt[]>(); const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const put = (p: Pt) => { const k = key(p[0], p[1]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); };
  const near = (x: number, y: number, d: number) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${Math.floor(x / cell) + i},${Math.floor(y / cell) + j}`) ?? []) if (Math.hypot(q[0] - x, q[1] - y) < d) return true; return false; };
  for (const t of scene.trees) put(t);
  const bgrid = new Map<string, any[]>(); for (const b of scene.buildings) { const xs = b.o.map((p: Pt) => p[0]), ys = b.o.map((p: Pt) => p[1]); b.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; for (let x = Math.floor(b.bb[0] / 50); x <= Math.floor(b.bb[2] / 50); x++) for (let y = Math.floor(b.bb[1] / 50); y <= Math.floor(b.bb[3] / 50); y++) (bgrid.get(`${x},${y}`) ?? bgrid.set(`${x},${y}`, []).get(`${x},${y}`)!).push(b); }
  const inBuilding = (x: number, y: number) => (bgrid.get(`${Math.floor(x / 50)},${Math.floor(y / 50)}`) ?? []).some((b) => x > b.bb[0] - 1 && x < b.bb[2] + 1 && y > b.bb[1] - 1 && y < b.bb[3] + 1 && pip(x, y, b.o));
  let planted = 0;
  for (const r of scene.roads) {
    if (r.foot || r.sw <= 0 || r.cls <= 2) continue;
    const step = r.cls <= 6 ? 11 : 16, off = r.w / 2 + r.sw * 0.55; let acc = step / 2;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const [ax, an] = r.p[i], [bx, bn] = r.p[i + 1], L = Math.hypot(bx - ax, bn - an); if (L < 0.5) continue; const ux = (bx - ax) / L, un = (bn - an) / L;
      for (let d = acc; d < L; d += step) for (const side of [1, -1]) { const x = ax + ux * d + un * off * side, y = an + un * d - ux * off * side; if (near(x, y, 7) || inBuilding(x, y)) continue; const p: Pt = [+x.toFixed(1), +y.toFixed(1)]; scene.trees.push(p); put(p); planted++; }
      acc = (acc + Math.ceil((L - acc) / step) * step) - L;
    }
  }
  for (const b of scene.buildings) delete b.bb;
  console.log(`street trees planted: ${planted}`);
}
// desert scrub and rocks: creosote-sized bushes on dirt/desert areas, on terrain slopes and in vacant lots (away from roads,
// buildings and landscaped areas), boulders on steep ground. Bare ground otherwise paints as a blank beige field.
{
  const pip = (x: number, y: number, r: Pt[]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const hash = (a: number, b: number) => { let h = 2166136261 ^ Math.round(a * 7 + b * 13); h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  const terPath = `${DIRS.data}/terrain.json`, TER = existsSync(terPath) ? JSON.parse(await Bun.file(terPath).text()) : null;
  const T = TER ? (e: number, n: number) => { const fx = (e - TER.e0) / TER.cellE - 0.5, fy = (TER.n1 - n) / TER.cellN - 0.5, x0 = Math.max(0, Math.min(TER.w - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(TER.h - 2, Math.floor(fy))), tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0)), z = TER.z, i = y0 * TER.w + x0; return ((z[i] * (1 - tx) + z[i + 1] * tx) * (1 - ty) + (z[i + TER.w] * (1 - tx) + z[i + TER.w + 1] * tx) * ty) / 10; } : () => 0;
  const C = 50, cellKey = (x: number, y: number) => `${Math.floor(x / C)},${Math.floor(y / C)}`;
  type Box = { bb: number[]; o: Pt[]; k?: string; w?: number };
  const boxes = (items: Box[]) => { const g = new Map<string, Box[]>(); for (const it of items) { const xs = it.o.map((p) => p[0]), ys = it.o.map((p) => p[1]); it.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; for (let x = Math.floor((it.bb[0] - 8) / C); x <= Math.floor((it.bb[2] + 8) / C); x++) for (let y = Math.floor((it.bb[1] - 8) / C); y <= Math.floor((it.bb[3] + 8) / C); y++) (g.get(`${x},${y}`) ?? g.set(`${x},${y}`, []).get(`${x},${y}`)!).push(it); } return g; };
  const bGrid = boxes(scene.buildings.map((b: any) => ({ bb: [], o: b.o })));
  const keep = new Set(["parking", "green", "water", "platform", "pool", "stadium", "apron"]);
  const aGrid = boxes(scene.areas.map((a: any) => ({ bb: [], o: a.o, k: a.k })));
  const rGrid = new Map<string, { p: Pt[]; w: number }[]>(); for (const r of scene.roads) { const corridor = r.w / 2 + (r.sw ?? 0) + (r.foot ? 2 : 10); for (let i = 0; i + 1 < r.p.length; i++) { const [ax, ay] = r.p[i], [bx, by] = r.p[i + 1]; for (let x = Math.floor((Math.min(ax, bx) - corridor) / C); x <= Math.floor((Math.max(ax, bx) + corridor) / C); x++) for (let y = Math.floor((Math.min(ay, by) - corridor) / C); y <= Math.floor((Math.max(ay, by) + corridor) / C); y++) (rGrid.get(`${x},${y}`) ?? rGrid.set(`${x},${y}`, []).get(`${x},${y}`)!).push({ p: [r.p[i], r.p[i + 1]], w: corridor }); } }
  for (const r of scene.rails) for (let i = 0; i + 1 < r.p.length; i++) { const [ax, ay] = r.p[i], [bx, by] = r.p[i + 1]; for (let x = Math.floor((Math.min(ax, bx) - 8) / C); x <= Math.floor((Math.max(ax, bx) + 8) / C); x++) for (let y = Math.floor((Math.min(ay, by) - 8) / C); y <= Math.floor((Math.max(ay, by) + 8) / C); y++) (rGrid.get(`${x},${y}`) ?? rGrid.set(`${x},${y}`, []).get(`${x},${y}`)!).push({ p: [r.p[i], r.p[i + 1]], w: 8 }); }
  const segD = (x: number, y: number, [a, b]: Pt[]) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  const nearBuilding = (x: number, y: number, d: number) => (bGrid.get(cellKey(x, y)) ?? []).some((b) => x > b.bb[0] - d && x < b.bb[2] + d && y > b.bb[1] - d && y < b.bb[3] + d && (pip(x, y, b.o) || b.o.some((q) => Math.hypot(q[0] - x, q[1] - y) < d) || b.o.some((q, i) => i + 1 < b.o.length && segD(x, y, [q, b.o[i + 1]]) < d)));
  const areaAt = (x: number, y: number) => { let k: string | undefined; for (const a of aGrid.get(cellKey(x, y)) ?? []) if (x >= a.bb[0] && x <= a.bb[2] && y >= a.bb[1] && y <= a.bb[3] && pip(x, y, a.o)) { if (keep.has(a.k!)) return a.k; k = a.k; } return k; };
  const roadDist = (x: number, y: number) => { let best = 99; for (const r of rGrid.get(cellKey(x, y)) ?? []) best = Math.min(best, segD(x, y, r.p) - r.w); return best; };
  const tgrid = new Map<string, Pt[]>(); for (const t of scene.trees) { const k = cellKey(t[0], t[1]); (tgrid.get(k) ?? tgrid.set(k, []).get(k)!).push(t); }
  const nearTree = (x: number, y: number) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of tgrid.get(`${Math.floor(x / C) + i},${Math.floor(y / C) + j}`) ?? []) if (Math.hypot(q[0] - x, q[1] - y) < 4) return true; return false; };
  const geo = JSON.parse(await Bun.file(`${DIRS.data}/geo.json`).text());
  const { e0, e1, n0, n1 } = geo.extent, M = 200, scrub: number[][] = [];
  for (let y = n0 - M; y < n1 + M; y += 5) for (let x = e0 - M; x < e1 + M; x += 5) {
    const jx = x + (hash(x, y) - 0.5) * 4, jy = y + (hash(y, x) - 0.5) * 4, r = hash(x + 1, y + 2);
    const a = areaAt(jx, jy); if (a && keep.has(a)) continue;
    if (nearBuilding(jx, jy, 5) || nearTree(jx, jy)) continue;
    const rd = roadDist(jx, jy); if (rd < 0) continue;
    const t = T(jx, jy), slope = Math.hypot(T(jx + 3, jy) - T(jx - 3, jy), T(jx, jy + 3) - T(jx, jy - 3)) / 6;
    const wild = a === "dirt" || a === "desert" || t > 1.5 || slope > 0.08;
    const p = wild ? 0.42 : rd > 12 ? 0.09 : 0;
    if (r >= p) continue;
    const rock = slope > 0.22 && hash(y + 3, x + 5) < 0.3;
    scrub.push([+jx.toFixed(1), +jy.toFixed(1), +(rock ? 0.6 + hash(x, y + 9) * 1.6 : 0.8 + hash(x + 4, y) * 1.4).toFixed(2), rock ? 1 : 0]);
  }
  scene.scrub = scrub; console.log(`scrub: ${scrub.filter((s) => !s[3]).length} bushes, ${scrub.filter((s) => s[3]).length} rocks`);
}
await Bun.write(`${DIRS.data}/scene.json`, JSON.stringify(scene));
console.log(Object.fromEntries(Object.entries(scene).map(([k, v]) => [k, v.length])), `${(JSON.stringify(scene).length / 1e6).toFixed(1)} MB`);

// building footprints for the hover layer: outline in local metres, height, name, kind, and a label every building has:
// name, else street address, else kind + nearest named street
const KIND: Record<string, string> = { apartments: "Apartments", residential: "Residence", house: "House", detached: "House", retail: "Shops", commercial: "Commercial building", office: "Office building", university: "ASU building", college: "ASU building", dormitory: "Dorm", hotel: "Hotel", parking: "Parking structure", garage: "Garage", garages: "Garages", carport: "Carport", roof: "Canopy", terrace: "Townhomes", school: "School", church: "Church", industrial: "Industrial building", warehouse: "Warehouse", shed: "Shed", service: "Utility building", public: "Public building", civic: "Civic building", kiosk: "Kiosk", transportation: "Transit building", train_station: "Station" };
const segDist = (c: [number, number], a: [number, number], b: [number, number]) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(c[0] - a[0] - t * dx, c[1] - a[1] - t * dy); };
const namedRoads = scene.roads.filter((r) => r.n && !r.foot);
const nearestStreet = (c: [number, number]) => { let best = 80, name: string | undefined; for (const r of namedRoads) for (let i = 0; i < r.p.length - 1; i++) { const d = segDist(c, r.p[i], r.p[i + 1]); if (d < best) { best = d; name = r.n; } } return name; };
const label = (b: any) => { if (b.n) return b.n; if (b.a) return b.a; const k = KIND[b.k] ?? (b.u ? "ASU building" : "Building"); const c: [number, number] = [b.o.reduce((s: number, q: number[]) => s + q[0], 0) / b.o.length, b.o.reduce((s: number, q: number[]) => s + q[1], 0) / b.o.length]; const st = nearestStreet(c); return st ? `${k} \u00b7 ${st}` : k; };
await Bun.write(`${DIRS.pub}/buildings.json`, JSON.stringify(scene.buildings.filter((b) => b.o.length >= 4).map((b) => ({ o: b.o.map(([e, n]) => [+e.toFixed(1), +n.toFixed(1)]), h: +b.h.toFixed(1), m: b.m, n: b.n, l: label(b), k: b.k, t: b.t }))));

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
