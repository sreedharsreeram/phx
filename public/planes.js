// Aircraft from ADS-B, dead-reckoned between polls, drawn at altitude with a ground shadow that fades as they climb.
window.Planes = (() => {
  const POLL = 5000, KT = 0.514444;   // knots -> m/s
  const planes = new Map(); let G, ui, follow = null, selected = null;
  const SPAN = { A1: 11, A2: 18, A3: 36, A4: 48, A5: 65, A6: 20, A7: 14 };   // wingspan (rotor) by ADS-B category, metres
  const span = (p) => SPAN[p.cat] || (p.type && /^(B7[3-9]|A3[12]|A2|B73|E1|E7|CRJ)/.test(p.type) ? 36 : 14);

  async function poll() {
    try {
      const j = await (await fetch("/api/aircraft", { cache: "no-store" })).json(); const seen = new Set(), now = performance.now();
      for (const a of j.aircraft) {
        seen.add(a.id); const [e, n] = G.toEN(a.lat, a.lon); const old = planes.get(a.id);
        const fix = { e, n, alt: a.alt, t: now - (a.seen ?? 0) * 1000 };
        if (!old) planes.set(a.id, { ...a, fix, shown: { e, n, alt: a.alt } });
        else Object.assign(old, a, { fix: Math.hypot(e - old.fix.e, n - old.fix.n) > 1 || Math.abs(a.alt - old.fix.alt) > 1 ? fix : old.fix });
      }
      for (const id of planes.keys()) if (!seen.has(id)) planes.delete(id);
      ui.status.textContent = `${planes.size} aircraft`;
    } catch (e) { console.warn("aircraft", e); }
    setTimeout(poll, POLL);
  }
  // predicted position now: last fix carried forward along track at ground speed (capped at 45 s of extrapolation)
  function place(p, now) {
    const dt = Math.min(45, Math.max(0, (now - p.fix.t) / 1000)), v = (p.gs ?? 0) * KT, tr = ((p.track ?? 0) * Math.PI) / 180;
    const e = p.fix.e + Math.sin(tr) * v * dt, n = p.fix.n + Math.cos(tr) * v * dt, alt = Math.max(0, p.fix.alt + (p.vr ?? 0) * 0.00508 * dt);
    const k = 0.15; p.shown.e += (e - p.shown.e) * k; p.shown.n += (n - p.shown.n) * k; p.shown.alt += (alt - p.shown.alt) * k;   // ease toward the prediction
    return p.shown;
  }
  function silhouette(ctx, L, heli) {
    ctx.beginPath();
    if (heli) { ctx.ellipse(0, 0, L * 0.5, L * 0.14, 0, 0, Math.PI * 2); ctx.moveTo(-L * 0.5, 0); ctx.lineTo(-L * 0.75, 0); ctx.fill(); ctx.beginPath(); ctx.arc(0, 0, L * 0.55, 0, Math.PI * 2); ctx.globalAlpha *= 0.35; ctx.fill(); return; }
    const f = L * 1.1;   // fuselage length vs wingspan
    ctx.moveTo(f * 0.5, 0); ctx.lineTo(f * 0.3, -L * 0.07); ctx.lineTo(-f * 0.1, -L * 0.5); ctx.lineTo(-f * 0.2, -L * 0.5); ctx.lineTo(-f * 0.18, -L * 0.08); ctx.lineTo(-f * 0.45, -L * 0.07); ctx.lineTo(-f * 0.5, -L * 0.22); ctx.lineTo(-f * 0.55, -L * 0.22); ctx.lineTo(-f * 0.5, 0);
    ctx.lineTo(-f * 0.55, L * 0.22); ctx.lineTo(-f * 0.5, L * 0.22); ctx.lineTo(-f * 0.45, L * 0.07); ctx.lineTo(-f * 0.18, L * 0.08); ctx.lineTo(-f * 0.2, L * 0.5); ctx.lineTo(-f * 0.1, L * 0.5); ctx.lineTo(f * 0.3, L * 0.07); ctx.closePath(); ctx.fill();
  }
  function draw(ctx, view) {
    const list = [...planes.values()].map((p) => ({ p, s: place(p, view.now) })).sort((a, b) => a.s.alt - b.s.alt);
    for (const { p, s } of list) {
      const air = G.enToPixel(s.e, s.n, s.alt), gnd = G.enToPixel(s.e, s.n, 0);
      const [sx, sy] = view.toScreen(air.x, air.y); if (sx < -80 || sy < -80 || sx > view.W + 80 || sy > view.H + 80) continue;
      const heli = p.cat === "A7", L = Math.max(10, (span(p) / 0.5) * view.scale);   // 0.5 = metres per map pixel
      const h = G.heading(p.track ?? 0), ang = Math.atan2(h[1], h[0]);
      const onGround = p.ground || s.alt < 15;
      if (onGround && G.hidden({ x: gnd.x, y: gnd.y, depth: gnd.depth }, 3)) ctx.globalAlpha = 0.3;
      // shadow on the ground, offset by the sun (up-right here) and softer the higher the aircraft
      const [gx, gy] = view.toScreen(gnd.x, gnd.y), soft = Math.min(1, s.alt / 1500);
      ctx.save(); ctx.translate(gx + 2, gy + 2); ctx.rotate(ang); ctx.fillStyle = `rgba(43,36,32,${0.35 * (1 - soft * 0.8)})`; ctx.filter = soft > 0.05 ? `blur(${(soft * 6).toFixed(1)}px)` : "none"; silhouette(ctx, L, heli); ctx.restore();
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang); ctx.fillStyle = selected === p.id || follow === p.id ? "#2b2420" : "#fffdf8"; ctx.strokeStyle = "#2b2420"; ctx.lineWidth = Math.max(0.8, L / 24);
      silhouette(ctx, L, heli); ctx.stroke(); ctx.restore();
      ctx.globalAlpha = 1;
      view.hits.push({ kind: "plane", p, sx, sy, r: Math.max(10, L / 2) });
    }
    if (follow && planes.has(follow)) { const s = planes.get(follow).shown, a = G.enToPixel(s.e, s.n, s.alt); ui.viewer.viewport.panTo(ui.viewer.viewport.imageToViewportCoordinates(a.x, a.y), false); }
  }
  function card(h) {
    const p = h.p; selected = p.id;
    const alt = Math.round(p.shown.alt), kts = Math.round(p.gs ?? 0);
    return `<div><span class="pill" style="background:#2b2420">${p.flight ?? p.reg ?? p.id.toUpperCase()}</span><span class="name">${p.desc ?? p.type ?? "Aircraft"}</span></div>
      <div class="sub" style="margin-top:4px">${p.ground || alt < 15 ? "On the ground at Sky Harbor" : `${alt.toLocaleString()} m above the field · ${kts} kt${p.vr > 300 ? " · climbing" : p.vr < -300 ? " · descending" : ""}`}${p.reg && p.flight ? ` · ${p.reg}` : ""}</div>
      <div style="margin-top:8px"><button class="btn" data-follow>${follow === p.id ? "Stop following" : "Follow"}</button></div>`;
  }
  return { start(opts) { ({ G } = opts); ui = opts; poll(); Layers.add({ name: "planes", enabled: () => ui.toggle.checked, draw }); },
    card, follow: (id) => { follow = follow === id ? null : id; return follow; }, unfollow: () => (follow = null), deselect: () => (selected = null), isFollowing: () => !!follow };
})();
