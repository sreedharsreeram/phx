// Simulated street traffic on the OpenStreetMap graph: cars follow lanes, queue behind each other, stop at real signals,
// and thin out or thicken with the time of day in Phoenix. A share of them are robotaxis.
window.Traffic = (() => {
  let G, ui, nodes, edges, out, signals, cars = [], density = 0, lastSim = 0;
  const SPEED_KPH = [105, 60, 80, 65, 50, 60, 50, 40, 25, 25];   // by class index from prep-scene
  const CAR_LEN = 4.6, GAP = 2.2, LANE_W = 3.2, ROBOTAXI = 0.07;
  const COLORS = ["#f3f1ec", "#e8e4dc", "#d9d4cb", "#bfc3c9", "#9ea4ab", "#5d6166", "#3a3d42", "#b64a3f", "#2f5f8a", "#c9a24a", "#f3f1ec", "#e8e4dc"];
  const hour = () => { const d = new Date(); return (d.getUTCHours() - 7 + 24) % 24 + d.getUTCMinutes() / 60; };   // Phoenix has no DST
  const targetDensity = () => { const h = hour(), peak = (c, w) => Math.exp(-((h - c) ** 2) / (2 * w * w)); return 0.12 + 0.55 * peak(8, 1.1) + 0.6 * peak(17.5, 1.3) + 0.25 * peak(12.5, 2.5) * (h > 6 && h < 22 ? 1 : 0); };

  function load(data) {
    nodes = data.nodes.map(([e, n]) => { const p = G.enToPixel(e, n, 0); return { e, n, x: p.x, y: p.y, out: [] }; });
    edges = data.edges.map(([a, b, cls, oneway, lanes, z, kph, w], i) => { const A = nodes[a], B = nodes[b], L = Math.hypot(B.e - A.e, B.n - A.n) || 0.1; const per = oneway ? lanes : Math.max(1, Math.floor(lanes / 2)); return { i, a, b, cls, oneway, lanes: per, w: w || lanes * 3.5, kph, z, L, ux: (B.e - A.e) / L, un: (B.n - A.n) / L, cars: [], rev: -1 }; });
    // two-way streets get a reverse edge; remember the pairing so cars never U-turn onto their own edge
    const n0 = edges.length;
    for (let i = 0; i < n0; i++) { const e = edges[i]; if (!e.oneway) { const r = { ...e, i: edges.length, a: e.b, b: e.a, ux: -e.ux, un: -e.un, cars: [], rev: i }; e.rev = r.i; edges.push(r); } }
    for (const e of edges) nodes[e.a].out.push(e.i);
    signals = new Map(data.signals.map((n) => [n, { phase: (n * 7919) % 90 }]));
    for (const [n, sg] of signals) { const dirs = [...nodes[n].out.map((i) => edges[i]), ...edges.filter((e) => e.b === n)]; sg.axisOf = (e) => (Math.abs(e.ux) > Math.abs(e.un) ? 0 : 1); }
    // weights for spawning: busier classes get more cars per metre
    const W = [3, 1.2, 2.5, 2.2, 1, 1.6, 1.1, 0.35, 0.15];
    out = { total: edges.reduce((s, e) => s + e.L * W[e.cls], 0), W };
  }
  // is the light red for a car arriving at node n along edge e?  90 s cycle, two axes, 4 s all-red between
  function red(n, e, t) {
    const sg = signals.get(n); if (!sg) return false;
    const c = (t / 1000 + sg.phase) % 90, axis = sg.axisOf(e);
    return axis === 0 ? c >= 43 : c < 45 || c >= 88;
  }
  function spawn() {
    let r = Math.random() * out.total;
    for (const e of edges) { r -= e.L * out.W[e.cls]; if (r <= 0) { const lane = Math.floor(Math.random() * e.lanes); const c = { e, s: Math.random() * e.L, v: 0, lane, color: COLORS[Math.floor(Math.random() * COLORS.length)], robo: Math.random() < ROBOTAXI, age: 0 }; if (c.robo) c.color = "#ffffff"; e.cars.push(c); cars.push(c); return; } }
  }
  function nextEdge(e, n) {
    const opts = nodes[n].out.map((i) => edges[i]).filter((x) => x.i !== e.rev);
    if (!opts.length) return nodes[n].out.length ? edges[nodes[n].out[0]] : null;
    // prefer going straight; turning onto a bigger road is popular, onto a residential one less so
    const w = opts.map((x) => { const dot = x.ux * e.ux + x.un * e.un; return Math.max(0.05, (dot + 1.2) ** 3) * (x.cls <= 6 ? 1.3 : 0.6); });
    let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; } return opts[opts.length - 1];
  }
  function step(dt, t) {
    const want = Math.min(5000, Math.round(density * out.total / 60));   // ~1 car per 60 m of weighted road at full density, capped for the CPU
    for (let i = 0; i < 40 && cars.length < want; i++) spawn();
    if (cars.length > want * 1.1) { const c = cars.pop(); c.e.cars.splice(c.e.cars.indexOf(c), 1); }
    for (const e of edges) if (e.cars.length > 1) e.cars.sort((a, b) => a.s - b.s);
    for (const c of cars) {
      const e = c.e, vmax = ((e.kph || SPEED_KPH[e.cls] || 40) / 3.6) * (c.robo ? 0.9 : 0.85 + ((c.color.charCodeAt(1) % 7) / 7) * 0.3);
      // the car ahead in this lane on this edge, else on the next edge
      let gap = Infinity; const idx = e.cars.indexOf(c);
      for (let k = idx + 1; k < e.cars.length; k++) if (e.cars[k].lane === c.lane) { gap = e.cars[k].s - c.s - CAR_LEN; break; }
      const toEnd = e.L - c.s, stopHere = red(e.b, e, t) || (nodes[e.b].out.length > 2 && !signals.has(e.b) && Math.random() < 0.002);
      if (stopHere) gap = Math.min(gap, toEnd - 1.5);
      else if (gap === Infinity && c.next) { const nx = c.next; const ahead = nx.cars.find((o) => o.lane === Math.min(c.lane, nx.lanes - 1)); if (ahead) gap = toEnd + ahead.s - CAR_LEN; }
      const slowNear = nodes[e.b].out.length > 2 && toEnd < 25 && !signals.has(e.b) ? vmax * 0.55 : vmax;
      const vTarget = gap < GAP ? 0 : Math.min(slowNear, Math.sqrt(Math.max(0, 2 * 3.5 * (gap - GAP))));
      c.v += Math.max(-7 * dt, Math.min(2.6 * dt, vTarget - c.v)); if (c.v < 0.05) c.v = 0;
      c.s += c.v * dt; c.age += dt;
      if (c.s >= e.L) {
        const nx = c.next || nextEdge(e, e.b); c.next = null;
        if (!nx) { c.s = e.L - 0.01; c.v = 0; continue; }
        e.cars.splice(e.cars.indexOf(c), 1); c.s -= e.L; c.e = nx; c.lane = Math.min(c.lane, nx.lanes - 1); nx.cars.push(c);
      } else if (!c.next && e.L - c.s < 60) c.next = nextEdge(e, e.b);
    }
  }
  function draw(ctx, view) {
    const now = view.now; if (!lastSim) lastSim = now; const dt = Math.min(0.1, (now - lastSim) / 1000); lastSim = now;
    density += (targetDensity() - density) * 0.02; step(dt, now);
    const L = CAR_LEN * view.pxPerM, Wd = 1.9 * view.pxPerM;
    if (L < 1.2) return;   // too far out to see a car
    for (const c of cars) {
      // lanes sit inside the drawn asphalt: one-way streets use the whole width, two-way streets the right half
      const e = c.e, A = nodes[e.a], laneW = e.oneway ? e.w / e.lanes : e.w / 2 / e.lanes, off = e.oneway ? -e.w / 2 + (c.lane + 0.5) * laneW : (c.lane + 0.5) * laneW;
      const re = e.un, rn = -e.ux;   // right-hand normal
      const pe = A.e + e.ux * c.s + re * off, pn = A.n + e.un * c.s + rn * off;
      const p = G.enToPixel(pe, pn, 0.8 + e.z); if (p.x < 0 || p.y < 0 || p.x > view.imgW || p.y > view.imgH) continue;   // off the picture
      const [sx, sy] = view.toScreen(p.x, p.y);
      if (sx < -20 || sy < -20 || sx > view.W + 20 || sy > view.H + 20) continue;
      if (G.hidden(p, 1.2)) continue;
      const h = G.heading((Math.atan2(e.ux, e.un) * 180) / Math.PI), ang = Math.atan2(h[1], h[0]);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang);
      ctx.fillStyle = "rgba(43,36,32,.28)"; ctx.fillRect(-L / 2 + 1, -Wd / 2 + 1.5, L, Wd);
      ctx.fillStyle = c.color; ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
      if (L > 6) { ctx.fillStyle = "rgba(40,50,70,.55)"; ctx.fillRect(-L * 0.15, -Wd / 2 + 0.6, L * 0.34, Wd - 1.2); if (c.robo) { ctx.fillStyle = "#2b2420"; ctx.beginPath(); ctx.arc(0, 0, Wd * 0.22, 0, Math.PI * 2); ctx.fill(); } }
      if (L > 4 && c.v < 0.3) { ctx.fillStyle = "#e8483b"; ctx.fillRect(-L / 2 - 0.5, -Wd / 2, 1.2, Wd); }
      ctx.restore();
    }
  }
  return { start(opts) { ({ G } = opts); ui = opts; fetch(opts.base + "roads.json").then((r) => r.json()).then((d) => { load(d); Layers.add({ name: "traffic", enabled: () => ui.toggle.checked, draw }); }); }, cars: () => cars.length };
})();
