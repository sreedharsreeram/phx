// Hover a building to see its name. Footprints are projected at ground and roof level; the hit test covers both and the walls between.
window.Buildings = (() => {
  let G, list = [], hover = null, tip;
  const pip = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  function load(data) {
    list = data.map((b) => { const base = b.o.map(([e, n]) => { const p = G.enToPixel(e, n, b.m ?? 0); return [p.x, p.y]; }), roof = b.o.map(([e, n]) => { const p = G.enToPixel(e, n, b.h); return [p.x, p.y]; });
      const xs = [...base, ...roof].map((p) => p[0]), ys = [...base, ...roof].map((p) => p[1]);
      return { ...b, base, roof, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }; });
  }
  // image-pixel hit: roof polygon, base polygon, or the vertical sweep between them (approximated per edge as a quad)
  function hit(x, y) {
    let best = null;
    for (const b of list) { if (x < b.bb[0] || x > b.bb[2] || y < b.bb[1] || y > b.bb[3]) continue;
      let ok = pip(x, y, b.roof) || pip(x, y, b.base);
      if (!ok) for (let i = 0; i < b.base.length - 1 && !ok; i++) ok = pip(x, y, [b.base[i], b.base[i + 1], b.roof[i + 1], b.roof[i]]);
      if (ok && (!best || b.h > best.h)) best = b;   // the taller building is in front when footprints overlap on screen
    }
    return best;
  }
  function draw(ctx, view) {
    if (!hover) return;
    const poly = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => { const [sx, sy] = view.toScreen(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); };
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(43,36,32,.9)"; ctx.fillStyle = "rgba(255,253,248,.18)";
    poly(hover.roof); ctx.fill(); ctx.stroke(); if (hover.h > 3) { ctx.setLineDash([4, 4]); poly(hover.base); ctx.stroke(); }
    ctx.restore();
  }
  function start(opts) {
    ({ G } = opts); tip = opts.tip;
    fetch(opts.base + "buildings.json").then((r) => r.json()).then((d) => { load(d); Layers.add({ name: "buildings", draw }); });
    const el = opts.viewer.container;
    el.addEventListener("mousemove", (ev) => {
      const r = el.getBoundingClientRect(), p = opts.viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
      const b = hit(p.x, p.y); hover = b;
      if (b && b.n) { tip.textContent = b.n; tip.style.display = "block"; tip.style.left = ev.clientX + 14 + "px"; tip.style.top = ev.clientY + 14 + "px"; } else tip.style.display = "none";
      el.style.cursor = b && b.n ? "pointer" : "";
    });
    el.addEventListener("mouseleave", () => { hover = null; tip.style.display = "none"; });
  }
  return { start, hit: (x, y) => hit(x, y) };
})();
