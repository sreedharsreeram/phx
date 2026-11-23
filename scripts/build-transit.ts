// Static GTFS -> public/data/transit.json: routes, rail/streetcar shapes, and every stop inside the footprint.
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { BBOX, DIRS } from "../config";
import { mkdirSync } from "node:fs";
mkdirSync(DIRS.pub, { recursive: true });

const zip = new AdmZip("data/gtfs-static.zip");
const table = (name: string) => parse(zip.readAsText(`${name}.txt`), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
const inBox = (lat: number, lon: number) => lat > BBOX.south && lat < BBOX.north && lon > BBOX.west && lon < BBOX.east;

const routes = Object.fromEntries(table("routes").map((r) => [r.route_id, { id: r.route_id, name: r.route_short_name, long: r.route_long_name, type: Number(r.route_type), color: r.route_color || "888888" }]));
const stops = table("stops").map((s) => ({ id: s.stop_id, name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon), station: s.location_type === "1", parent: s.parent_station || null })).filter((s) => inBox(s.lat, s.lon));

// Shapes for the rail lines and the streetcar; buses are drawn where they report themselves.
const trips = table("trips");
const railRoutes = new Set(Object.values(routes).filter((r) => r.type === 0).map((r) => r.id));
const shapeRoute = new Map<string, string>();
for (const t of trips) if (railRoutes.has(t.route_id) && !shapeRoute.has(t.shape_id)) shapeRoute.set(t.shape_id, t.route_id);
const shapePts = new Map<string, { seq: number; lat: number; lon: number }[]>();
for (const p of table("shapes")) {
  if (!shapeRoute.has(p.shape_id)) continue;
  if (!shapePts.has(p.shape_id)) shapePts.set(p.shape_id, []);
  shapePts.get(p.shape_id)!.push({ seq: Number(p.shape_pt_sequence), lat: Number(p.shape_pt_lat), lon: Number(p.shape_pt_lon) });
}
const shapes = [...shapePts].map(([id, pts]) => ({ id, route: shapeRoute.get(id)!, pts: pts.sort((a, b) => a.seq - b.seq).map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) }));

// Which stops each rail shape serves, in order (from one representative trip), so a station card can show the line.
const shapeTrip = new Map<string, string>();
for (const t of trips) if (railRoutes.has(t.route_id) && !shapeTrip.has(t.shape_id)) shapeTrip.set(t.shape_id, t.trip_id);
const tripToShape = new Map([...shapeTrip].map(([sh, tr]) => [tr, sh]));
const shapeStops = new Map<string, { seq: number; stop: string }[]>();
for (const st of table("stop_times")) {
  const sh = tripToShape.get(st.trip_id);
  if (!sh) continue;
  (shapeStops.get(sh) ?? shapeStops.set(sh, []).get(sh)!).push({ seq: Number(st.stop_sequence), stop: st.stop_id });
}
const stopsOf = (sh: string) => (shapeStops.get(sh) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.stop);
const out = { generated: new Date().toISOString(), bbox: BBOX, routes, stops, shapes: shapes.map((s) => ({ ...s, stops: stopsOf(s.id) })) };
await Bun.write(`${DIRS.pub}/transit.json`, JSON.stringify(out));
console.log(`routes ${Object.keys(routes).length}, stops in footprint ${stops.length}, rail shapes ${shapes.length}, ${(JSON.stringify(out).length / 1e6).toFixed(1)} MB`);
