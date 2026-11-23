// Serves the site and a small JSON API over Valley Metro's GTFS-Realtime feeds (cached, so the upstream sees one poll per interval).
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_RT, BBOX } from "./config";

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
    const f = Bun.file("public" + (p === "/" ? "/index.html" : p));
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const immutable = p.startsWith("/tiles/");
    return new Response(f, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  },
});
console.log(`smallphx on http://localhost:${port}`);
