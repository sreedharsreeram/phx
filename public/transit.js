// Live Valley Metro: trains and streetcars slide along their line, buses along the road; everything is clickable.
window.Transit = (() => {
  const POLL = 10_000, RAIL = new Set(["A", "B", "S", "SKYT"]);
  const S = {}; let ctx, geo, data, viewer, G, canvas, ui;
  const vehicles = new Map();   // id -> { cur, prev, t0, route, ... }
  let follow = null, selected = null, lastFrame = 0;

  const colorOf = (route) => "#" + (data.routes[route]?.color || (RAIL.has(route) ? "1e8ecd" : "5f6b7a"));
  const nameOf = (route) => data.routes[route]?.long || route;

  // ---- rail shapes as pixel polylines with cumulative lengths, for snapping
  const shapes = [];
  function buildShapes() {
    for (const sh of data.shapes) {
      const pts = sh.pts.map(([lat, lon]) => G.toPixel(lat, lon)), cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      shapes.push({ ...sh, pts, cum, len: cum[cum.length - 1] });
    }
  }
  // nearest point on a shape of this route: { shape, d (distance along), px, py, dist (px off the line) }
  function snap(route, p) {
    let best = null;
    for (const sh of shapes) {
      if (sh.route !== route) continue;
      for (let i = 1; i < sh.pts.length; i++) {
        const a = sh.pts[i - 1], b = sh.pts[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)), qx = a.x + dx * t, qy = a.y + dy * t, dist = Math.hypot(p.x - qx, p.y - qy);
        if (!best || dist < best.dist) best = { shape: sh, d: sh.cum[i - 1] + Math.sqrt(L2) * t, x: qx, y: qy, dist };
      }
    }
    return best && best.dist < 60 ? best : null;
  }
  function along(sh, d) {
    d = Math.max(0, Math.min(sh.len, d)); let i = 1; while (i < sh.cum.length - 1 && sh.cum[i] < d) i++;
    const a = sh.pts[i - 1], b = sh.pts[i], t = (d - sh.cum[i - 1]) / ((sh.cum[i] - sh.cum[i - 1]) || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  // ---- polling
  async function poll() {
    try {
      const r = await fetch("/api/vehicles", { cache: "no-store" }); const j = await r.json(); const now = performance.now();
      const seen = new Set();
      for (const v of j.vehicles) {
        seen.add(v.id);
        const p = G.toPixel(v.lat, v.lon, 0.5), rail = RAIL.has(v.route), sn = rail ? snap(v.route, p) : null;
        const cur = { x: sn ? sn.x : p.x, y: sn ? sn.y : p.y, depth: p.depth, d: sn?.d, shape: sn?.shape, bearing: v.bearing, ts: v.ts };
        const old = vehicles.get(v.id);
        if (!old) vehicles.set(v.id, { ...v, rail, cur, prev: cur, t0: now, shown: cur });
        else {
          const moved = Math.hypot(cur.x - old.cur.x, cur.y - old.cur.y) > 0.5;
          Object.assign(old, v, { rail, prev: moved ? { ...old.shown } : old.prev, cur, t0: moved ? now : old.t0 });
        }
      }
      for (const id of vehicles.keys()) if (!seen.has(id)) vehicles.delete(id);
      const age = Math.round(Date.now() / 1000 - j.at);
      const rails = [...vehicles.values()].filter((v) => v.rail).length;
      ui.status.textContent = `${rails} train${rails === 1 ? "" : "s"} and ${vehicles.size - rails} buses live · positions ${age < 90 ? age + "s" : Math.round(age / 60) + " min"} old`;
    } catch (e) { ui.status.textContent = "Live feed unavailable, retrying…"; console.warn(e); }
    setTimeout(poll, POLL);
  }
  // where a vehicle is drawn right now: eased from where it was shown to where it reports, over the poll interval
  function place(v, now) {
    const t = Math.min(1, (now - v.t0) / (POLL * 0.9)), k = t * t * (3 - 2 * t);
    let x, y, ang;
    if (v.rail && v.cur.shape && v.prev.shape === v.cur.shape && v.prev.d != null) { const d = v.prev.d + (v.cur.d - v.prev.d) * k, q = along(v.cur.shape, d); x = q.x; y = q.y; ang = q.ang; }
    else { x = v.prev.x + (v.cur.x - v.prev.x) * k; y = v.prev.y + (v.cur.y - v.prev.y) * k; const h = v.bearing != null ? G.heading(v.bearing) : null; ang = h ? Math.atan2(h[1], h[0]) : Math.atan2(v.cur.y - v.prev.y, v.cur.x - v.prev.x); }
    if (v.rail && v.cur.shape && v.prev.shape === v.cur.shape && v.prev.d != null && v.cur.d < v.prev.d) ang += Math.PI;
    v.shown = { x, y, d: v.cur.d, shape: v.cur.shape, depth: v.cur.depth, ang };
    return v.shown;
  }

  // ---- drawing
  function resize() { const r = viewer.container.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = r.width * dpr; canvas.height = r.height * dpr; canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px"; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  const toScreen = (x, y) => { const p = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(x, y)); return [p.x, p.y]; };
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, r); }
  const hits = [];
  function draw(now) {
    const W = canvas.width / Math.min(devicePixelRatio || 1, 2), H = canvas.height / Math.min(devicePixelRatio || 1, 2);
    ctx.clearRect(0, 0, W, H); hits.length = 0;
    const scale = viewer.viewport.getZoom(true) * viewer.viewport.getContainerSize().x / geo.W;   // screen px per image px
    const showRail = ui.toggles.rail.checked, showBus = ui.toggles.bus.checked, showStops = ui.toggles.stops.checked;
    if (showStops && scale > 0.05) for (const st of data.stops) {
      if (!st.station) continue; const p = G.toPixel(st.lat, st.lon, 1.5), [sx, sy] = toScreen(p.x, p.y); if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
      const r = Math.max(4, Math.min(8, 60 * scale)); ctx.fillStyle = "#fffdf8"; ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (scale > 0.25) { ctx.font = "600 12px Inter, sans-serif"; ctx.fillStyle = "#2b2420"; ctx.strokeStyle = "rgba(255,253,248,.9)"; ctx.lineWidth = 3; ctx.strokeText(st.name, sx + r + 4, sy + 4); ctx.fillText(st.name, sx + r + 4, sy + 4); }
      hits.push({ kind: "stop", st, sx, sy, r: r + 4 });
    }
    const list = [...vehicles.values()].filter((v) => (v.rail ? showRail : showBus)).map((v) => ({ v, s: place(v, now) })).sort((a, b) => a.s.y - b.s.y);
    for (const { v, s } of list) {
      const [sx, sy] = toScreen(s.x, s.y); if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
      const hid = G.hidden({ x: s.x, y: s.y, depth: s.depth }), col = colorOf(v.route);
      ctx.save(); ctx.translate(sx, sy); ctx.globalAlpha = hid ? 0.35 : 1;
      if (v.rail) {
        const L = Math.max(14, Math.min(90, 56 * scale)), Wd = Math.max(5, Math.min(14, 9 * scale));   // a ~28 m train, two cars
        ctx.rotate(s.ang); ctx.fillStyle = "rgba(43,36,32,.25)"; roundRect(1.5, 2.5, L, Wd, 3); ctx.fill();
        ctx.fillStyle = col; roundRect(0, 0, L, Wd, 3); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.beginPath(); ctx.moveTo(0, -Wd / 2); ctx.lineTo(0, Wd / 2); ctx.stroke();
        if (selected === v.id || follow === v.id) { ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; roundRect(0, 0, L + 6, Wd + 6, 5); ctx.stroke(); }
        hits.push({ kind: "vehicle", v, sx, sy, r: Math.max(10, L / 2) });
      } else {
        const r = Math.max(4, Math.min(11, 7 * scale * 1.8));
        ctx.fillStyle = "rgba(43,36,32,.22)"; ctx.beginPath(); ctx.arc(1, 2, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.2; ctx.stroke();
        if (r >= 8) { ctx.fillStyle = "#fff"; ctx.font = `600 ${Math.round(r)}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(v.route ?? "", 0, 0.5); }
        if (selected === v.id || follow === v.id) { ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, Math.PI * 2); ctx.stroke(); }
        hits.push({ kind: "vehicle", v, sx, sy, r: Math.max(10, r + 2) });
      }
      ctx.restore();
    }
    if (follow && vehicles.has(follow)) { const s = vehicles.get(follow).shown; viewer.viewport.panTo(viewer.viewport.imageToViewportCoordinates(s.x, s.y), false); }
  }
  function frame(now) { if (now - lastFrame > 33) { lastFrame = now; draw(now); } requestAnimationFrame(frame); }

  // ---- interaction
  function hit(x, y) { let best = null; for (const h of hits) { const d = Math.hypot(h.sx - x, h.sy - y); if (d < h.r && (!best || d < best.d)) best = { ...h, d }; } return best; }
  function showCard(h) {
    if (!h) { ui.card.classList.remove("on"); selected = null; return; }
    ui.card.classList.add("on");
    if (h.kind === "vehicle") {
      const v = h.v; selected = v.id; const age = Math.round(Date.now() / 1000 - v.ts);
      ui.card.innerHTML = `<div><span class="pill" style="background:${colorOf(v.route)}">${v.route ?? "?"}</span><span class="name">${v.rail ? nameOf(v.route) : "Bus " + (v.route ?? "")}</span></div>
        <div class="sub" style="margin-top:4px">${v.label ? "To " + v.label : ""}${v.stop ? ` · ${v.status === "STOPPED_AT" ? "at" : "next"} stop ${stopName(v.stop)}` : ""}</div>
        <div class="sub">Vehicle ${v.id} · reported ${age}s ago</div>
        <div style="margin-top:8px"><button class="btn" id="btn-follow">${follow === v.id ? "Stop following" : "Follow"}</button></div>`;
      ui.card.querySelector("#btn-follow").onclick = () => { follow = follow === v.id ? null : v.id; ui.followBtn.classList.toggle("on", !!follow); showCard(h); };
    } else {
      const st = h.st, here = [...vehicles.values()].filter((v) => v.stop && platformsOf(st).has(v.stop));
      const lines = [...new Set(shapes.filter((s) => s.stops.some((id) => platformsOf(st).has(id))).map((s) => s.route))];
      ui.card.innerHTML = `<div class="name">${st.name}</div><div style="margin:4px 0">${lines.map((r) => `<span class="pill" style="background:${colorOf(r)}">${r}</span>`).join("")}</div>
        ${here.length ? here.map((v) => `<div class="sub">${v.route} ${v.rail ? "train" : "bus"} ${v.status === "STOPPED_AT" ? "at the platform" : "approaching"}${v.label ? " · to " + v.label : ""}</div>`).join("") : `<div class="sub">No vehicle heading here right now.</div>`}`;
    }
  }
  const stopName = (id) => data.stops.find((s) => s.id === id)?.name ?? id;
  const platformsOf = (st) => new Set([st.id, ...data.stops.filter((s) => s.parent === st.id).map((s) => s.id)]);

  function start(opts) {
    ({ viewer, G, canvas } = opts); ui = opts; ctx = canvas.getContext("2d");
    Promise.all([fetch("/geo.json").then((r) => r.json()), fetch("/data/transit.json").then((r) => r.json())]).then(([g, d]) => {
      geo = g; data = d; buildShapes(); resize(); poll(); requestAnimationFrame(frame);
      new OpenSeadragon.MouseTracker({ element: viewer.container, clickHandler: (e) => { if (!e.quick) return; const h = hit(e.position.x, e.position.y); showCard(h); } }).setTracking(true);
      viewer.addHandler("resize", resize); addEventListener("resize", resize);
      viewer.addHandler("canvas-drag", () => { if (follow) { follow = null; ui.followBtn.classList.remove("on"); } });
      ui.followBtn.onclick = () => { follow = null; ui.followBtn.classList.remove("on"); if (selected) showCard(hits.find((h) => h.kind === "vehicle" && h.v.id === selected) ?? null); };
    });
  }
  return { start, vehicles };
})();
