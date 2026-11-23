// Live Valley Metro: trains and streetcars slide along their line, buses along the road; cards show predicted arrivals.
window.Transit = (() => {
  const POLL = 10_000, RAIL = new Set(["A", "B", "S", "SKYT"]);
  let geo, data, viewer, G, ui, status = {};
  const vehicles = new Map(); let follow = null, selected = null, selectedStop = null;
  const colorOf = (route) => "#" + (data.routes[route]?.color || (RAIL.has(route) ? "1e8ecd" : "5f6b7a"));
  const nameOf = (route) => data.routes[route]?.long || route;
  const stopName = (id) => data.stops.find((s) => s.id === id)?.name ?? id;
  const platformsOf = (st) => [st.id, ...data.stops.filter((s) => s.parent === st.id).map((s) => s.id)];

  const shapes = [];
  function buildShapes() {
    for (const sh of data.shapes) {
      const pts = sh.pts.map(([lat, lon]) => G.toPixel(lat, lon)), cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      shapes.push({ ...sh, pts, cum, len: cum[cum.length - 1] });
    }
  }
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

  async function poll() {
    try {
      const [j, ts] = await Promise.all([fetch("/api/vehicles", { cache: "no-store" }).then((r) => r.json()), fetch("/api/trip-status", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ vehicles: {} }))]);
      status = ts.vehicles || {}; const now = performance.now(), seen = new Set();
      for (const v of j.vehicles) {
        seen.add(v.id);
        const p = G.toPixel(v.lat, v.lon, 0.5), rail = RAIL.has(v.route), sn = rail ? snap(v.route, p) : null;
        const cur = { x: sn ? sn.x : p.x, y: sn ? sn.y : p.y, depth: p.depth, d: sn?.d, shape: sn?.shape, ts: v.ts };
        const old = vehicles.get(v.id);
        if (!old) vehicles.set(v.id, { ...v, rail, cur, prev: cur, t0: now, shown: cur });
        else { const moved = Math.hypot(cur.x - old.cur.x, cur.y - old.cur.y) > 0.5; Object.assign(old, v, { rail, prev: moved ? { ...old.shown } : old.prev, cur, t0: moved ? now : old.t0 }); }
      }
      for (const id of vehicles.keys()) if (!seen.has(id)) vehicles.delete(id);
      const age = Math.round(Date.now() / 1000 - j.at), rails = [...vehicles.values()].filter((v) => v.rail).length;
      ui.status.textContent = `${rails} train${rails === 1 ? "" : "s"} and ${vehicles.size - rails} buses · ${age < 90 ? age + "s" : Math.round(age / 60) + " min"} old`;
      if (selected && vehicles.has(selected)) renderCard(); if (selectedStop) renderStopCard();
    } catch (e) { ui.status.textContent = "Live feed unavailable, retrying…"; console.warn(e); }
    setTimeout(poll, POLL);
  }
  function place(v, now) {
    const t = Math.min(1, (now - v.t0) / (POLL * 0.9)), k = t * t * (3 - 2 * t);
    let x, y, ang; const onLine = v.rail && v.cur.shape && v.prev.shape === v.cur.shape && v.prev.d != null;
    if (onLine) { const d = v.prev.d + (v.cur.d - v.prev.d) * k, q = along(v.cur.shape, d); x = q.x; y = q.y; ang = q.ang; if (v.cur.d < v.prev.d) ang += Math.PI; }
    else { x = v.prev.x + (v.cur.x - v.prev.x) * k; y = v.prev.y + (v.cur.y - v.prev.y) * k; const h = v.bearing != null ? G.heading(v.bearing) : null; ang = h ? Math.atan2(h[1], h[0]) : Math.atan2(v.cur.y - v.prev.y, v.cur.x - v.prev.x); }
    v.shown = { x, y, d: v.cur.d, shape: v.cur.shape, depth: v.cur.depth, ang };
    return v.shown;
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, r); }

  function draw(ctx, view) {
    const { W, H, scale, toScreen } = view, showRail = ui.toggles.rail.checked, showBus = ui.toggles.bus.checked, showStops = ui.toggles.stops.checked;
    if (showStops && scale > 0.05) for (const st of data.stops) {
      if (!st.station) continue; const p = G.toPixel(st.lat, st.lon, 1.5), [sx, sy] = toScreen(p.x, p.y); if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
      const r = Math.max(4, Math.min(9, 8 * view.pxPerM)), sel = selectedStop === st.id;
      ctx.fillStyle = sel ? "#2b2420" : "#fffdf8"; ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (scale > 0.25) { ctx.font = "600 12px Inter, sans-serif"; ctx.fillStyle = "#2b2420"; ctx.strokeStyle = "rgba(255,253,248,.9)"; ctx.lineWidth = 3; ctx.strokeText(st.name, sx + r + 4, sy + 4); ctx.fillText(st.name, sx + r + 4, sy + 4); }
      view.hits.push({ kind: "stop", st, sx, sy, r: r + 4 });
    }
    const list = [...vehicles.values()].filter((v) => (v.rail ? showRail : showBus)).map((v) => ({ v, s: place(v, view.now) })).sort((a, b) => a.s.y - b.s.y);
    for (const { v, s } of list) {
      if (s.x < 0 || s.y < 0 || s.x > geo.W || s.y > geo.H) continue;   // off the picture
      const [sx, sy] = toScreen(s.x, s.y); if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
      const hid = G.hidden({ x: s.x, y: s.y, depth: s.depth }), col = colorOf(v.route), hl = selected === v.id || follow === v.id;
      ctx.save(); ctx.translate(sx, sy); ctx.globalAlpha = hid ? 0.35 : 1;
      if (v.rail) {
        const L = Math.max(14, 28 * view.pxPerM), Wd = Math.max(5, 2.7 * view.pxPerM);   // a 28 m light-rail car
        ctx.rotate(s.ang); ctx.fillStyle = "rgba(43,36,32,.25)"; roundRect(ctx, 1.5, 2.5, L, Wd, 3); ctx.fill();
        ctx.fillStyle = col; roundRect(ctx, 0, 0, L, Wd, 3); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.beginPath(); ctx.moveTo(0, -Wd / 2); ctx.lineTo(0, Wd / 2); ctx.stroke();
        if (hl) { ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; roundRect(ctx, 0, 0, L + 6, Wd + 6, 5); ctx.stroke(); }
        view.hits.push({ kind: "vehicle", v, sx, sy, r: Math.max(10, L / 2) });
      } else {
        const r = Math.max(4, 3.5 * view.pxPerM);   // a bus, seen as a disc
        ctx.fillStyle = "rgba(43,36,32,.22)"; ctx.beginPath(); ctx.arc(1, 2, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.2; ctx.stroke();
        if (r >= 8) { ctx.fillStyle = "#fff"; ctx.font = `600 ${Math.round(r)}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(v.route ?? "", 0, 0.5); }
        if (hl) { ctx.strokeStyle = "#2b2420"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, Math.PI * 2); ctx.stroke(); }
        view.hits.push({ kind: "vehicle", v, sx, sy, r: Math.max(10, r + 2) });
      }
      ctx.restore();
    }
    if (follow && vehicles.has(follow)) { const s = vehicles.get(follow).shown; viewer.viewport.panTo(viewer.viewport.imageToViewportCoordinates(s.x, s.y), false); }
  }

  const delayText = (d) => (d == null ? "" : Math.abs(d) < 90 ? "on time" : d > 0 ? `${Math.round(d / 60)} min late` : `${Math.round(-d / 60)} min early`);
  const mins = (at) => { const m = Math.round((at - Date.now() / 1000) / 60); return m <= 0 ? "now" : m === 1 ? "1 min" : `${m} min`; };
  function renderCard() {
    const v = vehicles.get(selected); if (!v) return; const st = status[v.id], age = Math.round(Date.now() / 1000 - v.ts);
    ui.card.classList.add("on");
    ui.card.innerHTML = `<div><span class="pill" style="background:${colorOf(v.route)}">${v.route ?? "?"}</span><span class="name">${v.rail ? nameOf(v.route) : "Bus " + (v.route ?? "")}</span></div>
      <div class="sub" style="margin-top:4px">${v.label ? "To " + v.label : ""}${st?.next ? ` · ${stopName(st.next.stop)} ${mins(st.next.at) === "now" ? "now" : "in " + mins(st.next.at)}` : v.stop ? ` · ${v.status === 1 ? "at" : "next"} ${stopName(v.stop)}` : ""}</div>
      <div class="sub">${st ? delayText(st.delay) + " · " : ""}vehicle ${v.id} · reported ${age}s ago</div>
      <div style="margin-top:8px"><button class="btn" data-follow>${follow === v.id ? "Stop following" : "Follow"}</button></div>`;
    ui.card.querySelector("[data-follow]").onclick = () => { follow = follow === v.id ? null : v.id; ui.onFollow(!!follow); renderCard(); };
  }
  async function renderStopCard() {
    const st = data.stops.find((s) => s.id === selectedStop); if (!st) return; const plats = platformsOf(st);
    const lines = [...new Set(shapes.filter((s) => s.stops.some((id) => plats.includes(id))).map((s) => s.route))];
    ui.card.classList.add("on");
    ui.card.innerHTML = `<div class="name">${st.name}</div><div style="margin:4px 0">${lines.map((r) => `<span class="pill" style="background:${colorOf(r)}">${r}</span>`).join("")}</div><div class="sub">Loading arrivals…</div>`;
    try {
      const j = await (await fetch(`/api/arrivals?stops=${plats.join(",")}`, { cache: "no-store" })).json(); if (selectedStop !== st.id) return;
      const arr = Object.values(j.stops).flat().sort((a, b) => a.at - b.at).slice(0, 7);
      const rows = arr.map((a) => `<div class="row"><span class="pill" style="background:${colorOf(a.route)}">${a.route}</span><span class="dest">${a.headsign ?? nameOf(a.route)}</span><span class="eta">${mins(a.at)}</span><span class="sub">${Math.abs(a.delay) >= 90 ? delayText(a.delay) : ""}</span></div>`).join("");
      ui.card.innerHTML = `<div class="name">${st.name}</div><div style="margin:4px 0 6px">${lines.map((r) => `<span class="pill" style="background:${colorOf(r)}">${r}</span>`).join("")}</div>${rows || `<div class="sub">Nothing predicted in the next while.</div>`}`;
    } catch (e) { console.warn(e); }
  }
  function select(h) {
    if (!h || (h.kind !== "vehicle" && h.kind !== "stop")) { selected = null; selectedStop = null; return false; }
    if (h.kind === "vehicle") { selected = h.v.id; selectedStop = null; renderCard(); } else { selectedStop = h.st.id; selected = null; renderStopCard(); }
    return true;
  }
  function start(opts) {
    ({ viewer, G } = opts); ui = opts;
    return Promise.all([fetch(opts.base + "geo.json").then((r) => r.json()), fetch(opts.base + "transit.json").then((r) => r.json())]).then(([g, d]) => {
      geo = g; data = d; buildShapes(); poll(); Layers.add({ name: "transit", draw });
    });
  }
  return { start, select, unfollow: () => (follow = null), vehicles };
})();
