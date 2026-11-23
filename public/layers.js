// One overlay canvas, one frame loop. Layers register draw(ctx, view) and push hit targets; clicks go to the nearest.
window.Layers = (() => {
  const layers = []; let viewer, canvas, ctx, onSelect, lastFrame = 0, dpr = 1;
  const view = { W: 0, H: 0, scale: 1, toScreen: null, hits: [] };
  function resize() { const r = viewer.container.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = r.width * dpr; canvas.height = r.height * dpr; canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px"; view.W = r.width; view.H = r.height; }
  function frame(now) {
    const item = viewer.world.getItemAt(0);
    if (item && now - lastFrame > 33) {
      lastFrame = now; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, view.W, view.H); view.hits.length = 0;
      view.scale = (viewer.viewport.getZoom(true) * viewer.viewport.getContainerSize().x) / item.getContentSize().x;
      const tl = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
      view.toScreen = (x, y) => [tl.x + x * view.scale, tl.y + y * view.scale];
      view.now = now;
      for (const l of layers) if (!l.enabled || l.enabled()) { ctx.save(); try { l.draw(ctx, view); } catch (e) { console.warn(l.name, e); } ctx.restore(); }
    }
    requestAnimationFrame(frame);
  }
  function hit(x, y) { let best = null; for (const h of view.hits) { const d = Math.hypot(h.sx - x, h.sy - y); if (d < h.r && (!best || d < best.d)) best = { ...h, d }; } return best; }
  function start(opts) {
    ({ viewer, canvas, onSelect } = opts); ctx = canvas.getContext("2d"); resize();
    viewer.addHandler("resize", resize); addEventListener("resize", resize);
    viewer.addHandler("canvas-click", (e) => { if (e.quick) onSelect(hit(e.position.x, e.position.y)); });
    requestAnimationFrame(frame);
  }
  return { start, add: (l) => layers.push(l), view, hit };
})();
