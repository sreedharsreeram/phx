// Serves the site and a small JSON API over Valley Metro's GTFS-Realtime feeds (cached, so the upstream sees one poll per interval).
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_RT, MAPS, ADSB_URL, ADSB_FALLBACK } from "./config";
import { readdirSync, existsSync } from "node:fs";
const BBOX = MAPS.phx.bbox;   // vehicles are filtered to the widest map; each client filters further by what it shows

const PAD = 0.03;   // degrees of slack around the footprint so vehicles slide in from the edges
const cache: Record<string, { at: number; body: string }> = {};
const num = (v: any) => (v == null ? null : typeof v === "object" && "low" in v ? Number(v.toString()) : Number(v));

async function vehicles() {
  const res = await fetch(GTFS_RT("vehicles"), { headers: { "user-agent": "smallphx/0.1" } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const out = [];
  for (const e of feed.entity) {
    const v = e.vehicle; if (!v?.position) continue;
    const { latitude: lat, longitude: lon } = v.position;
    if (lat < BBOX.south - PAD || lat > BBOX.north + PAD || lon < BBOX.west - PAD || lon > BBOX.east + PAD) continue;
    out.push({ id: v.vehicle?.id ?? e.id, label: v.vehicle?.label ?? null, route: v.trip?.routeId ?? null, trip: v.trip?.tripId ?? null, dir: v.trip?.directionId ?? null,
      lat, lon, bearing: v.position.bearing ?? null, speed: v.position.speed ?? null, ts: num(v.timestamp), stop: v.stopId ?? null, status: v.currentStatus ?? null, seq: v.currentStopSequence ?? null });
  }
  return { at: num(feed.header.timestamp), vehicles: out };
}
async function alerts() {
  const res = await fetch(GTFS_RT("alerts"), { headers: { "user-agent": "smallphx/0.1" } });
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  return feed.entity.map((e) => ({ id: e.id, routes: e.alert?.informedEntity?.map((i) => i.routeId).filter(Boolean), header: e.alert?.headerText?.translation?.[0]?.text, body: e.alert?.descriptionText?.translation?.[0]?.text }));
}
// trip updates -> per-stop predicted arrivals (only for stops inside the footprint) and per-trip delay
const footprintStops = new Set<string>();
for (const m of readdirSync("public/maps")) if (existsSync(`public/maps/${m}/transit.json`)) for (const s of JSON.parse(await Bun.file(`public/maps/${m}/transit.json`).text()).stops) footprintStops.add(s.id);
async function arrivals() {
  const res = await fetch(GTFS_RT("realtime"), { headers: { "user-agent": "smallphx/0.1" } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const now = Math.floor(Date.now() / 1000), stops: Record<string, any[]> = {}, trips: Record<string, any> = {};
  for (const e of feed.entity) {
    const tu = e.tripUpdate; if (!tu) continue;
    const trip = tu.trip.tripId ?? "", route = tu.trip.routeId ?? null, vehicle = tu.vehicle?.id ?? null, headsign = tu.vehicle?.label ?? null;
    let nextStop: any = null;
    for (const st of tu.stopTimeUpdate) {
      const at = num(st.arrival?.time) ?? num(st.departure?.time); if (!at || at < now - 60) continue;
      const delay = st.arrival?.delay ?? st.departure?.delay ?? tu.delay ?? 0;
      if (!nextStop) nextStop = { stop: st.stopId, at, delay };
      if (st.stopId && footprintStops.has(st.stopId)) (stops[st.stopId] ??= []).push({ route, trip, vehicle, headsign, at, delay, seq: st.stopSequence });
    }
    if (vehicle) trips[vehicle] = { trip, route, delay: nextStop?.delay ?? tu.delay ?? 0, next: nextStop };
  }
  for (const k in stops) stops[k].sort((a, b) => a.at - b.at);
  return { at: num(feed.header.timestamp), stops, vehicles: trips };
}
// aircraft within ~22 nm of the centre, normalised; falls back to adsb.lol when adsb.fi is unavailable
async function aircraft() {
  let j: any = null;
  for (const url of [ADSB_URL, ADSB_FALLBACK]) {
    try { const r = await fetch(url, { headers: { "user-agent": "smallphx/0.1 (isometric map)" } }); if (r.ok) { j = await r.json(); break; } } catch {}
  }
  if (!j) throw new Error("no adsb source");
  const list = (j.aircraft ?? j.ac ?? []) as any[];
  const FT = 0.3048, FIELD_FT = 1135;   // Sky Harbor elevation
  return { at: Math.floor(j.now ?? Date.now() / 1000), aircraft: list.filter((a) => a.lat != null && a.lon != null && (a.seen_pos ?? 99) < 60).map((a) => ({
    id: a.hex, flight: (a.flight ?? "").trim() || null, reg: a.r ?? null, type: a.t ?? null, desc: a.desc ?? null, cat: a.category ?? null,
    lat: a.lat, lon: a.lon, ground: a.alt_baro === "ground", alt: a.alt_baro === "ground" ? 0 : Math.max(0, ((a.alt_geom ?? a.alt_baro ?? FIELD_FT) - FIELD_FT) * FT),
    gs: a.gs ?? null, track: a.track ?? null, vr: a.baro_rate ?? a.geom_rate ?? 0, seen: a.seen_pos ?? 0 })) };
}
const cached = async (key: string, ttl: number, fn: () => Promise<unknown>) => {
  const c = cache[key]; if (c && Date.now() - c.at < ttl) return c.body;
  try { const body = JSON.stringify(await fn()); cache[key] = { at: Date.now(), body }; return body; }
  catch (err) { console.error(key, err); if (c) return c.body; throw err; }
};

const port = Number(process.env.PORT || 8787);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    const json = (b: string) => new Response(b, { headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    if (p === "/api/vehicles") return json(await cached("vehicles", 10_000, vehicles));
    if (p === "/api/alerts") return json(await cached("alerts", 120_000, alerts));
    if (p === "/api/arrivals") {
      const all = JSON.parse(await cached("arrivals", 15_000, arrivals)); const want = url.searchParams.get("stops")?.split(",");
      return json(JSON.stringify(want ? { at: all.at, stops: Object.fromEntries(want.map((s) => [s, all.stops[s] ?? []])) } : all));
    }
    if (p === "/api/trip-status") { const all = JSON.parse(await cached("arrivals", 15_000, arrivals)); return json(JSON.stringify({ at: all.at, vehicles: all.vehicles })); }
    if (p === "/api/aircraft") return json(await cached("aircraft", 4_000, aircraft));
    const f = Bun.file("public" + (p === "/" ? "/index.html" : p));
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const immutable = p.startsWith("/tiles/");
    return new Response(f, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  },
});
console.log(`smallphx on http://localhost:${port}`);
