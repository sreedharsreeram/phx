// lat/lon -> map pixel (and view depth), shared by every layer. Needs /geo.json; the depth grid comes from /depth.bin.
(function (root) {
  function undelta(url, cells, w) {
    return fetch(url, { priority: "low" }).then((res) => new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()).then((raw) => {
      const d = new Int16Array(raw), out = new Uint16Array(d.length);
      for (let i = 0; i < d.length; i += w) { let v = 0; for (let x = 0; x < w; x++) { v = (v + d[i + x]) & 0xffff; out[i + x] = v; } }
      return out;
    });
  }
  function make(geo, depth /* Uint16Array or null */) {
    const th = (geo.pitch * Math.PI) / 180, S = Math.sin(th), C = Math.cos(th), dg = geo.depthGrid;
    const toEN = (lat, lon) => [(lon - geo.center.lon) * geo.mPerDegLon, (lat - geo.center.lat) * geo.mPerDegLat];
    // view depth of a point, in the renderer's convention: metres along the camera ray from the camera position
    const cam = dg.cam, viewDepth = (e, n, h) => (e - cam.pos[0]) * cam.dir[0] + (h - cam.pos[1]) * cam.dir[1] + (-n - cam.pos[2]) * cam.dir[2];
    const enToPixel = (e, n, h = 0) => ({ x: (e - geo.x0) / geo.mpp, y: (geo.y1 - (n * S + h * C)) / geo.mpp, depth: viewDepth(e, n, h) });
    function toPixel(lat, lon, h = 0) { const [e, n] = toEN(lat, lon); return enToPixel(e, n, h); }
    // scene depth at a map pixel (metres), or null off-grid / without the grid
    function sceneDepth(px, py) {
      if (!depth) return null;
      const i = Math.floor(px / dg.cell), j = Math.floor(py / dg.cell);
      if (i < 0 || j < 0 || i >= dg.w || j >= dg.h) return null;
      return dg.lo + (depth[j * dg.w + i] / 65535) * dg.span;
    }
    // is a point at this pixel hidden behind something drawn? (tolerance in metres along the ray)
    const hidden = (p, tol = 1.5) => { const d = sceneDepth(p.x, p.y); return d != null && d < p.depth - tol; };
    // screen-space direction of a compass bearing (degrees clockwise from north), unit vector in pixels
    const heading = (deg) => { const r = (deg * Math.PI) / 180, dx = Math.sin(r), dy = -Math.cos(r) * S, L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
    const pxPerMetreNorth = S / geo.mpp, pxPerMetreEast = 1 / geo.mpp;
    return { toEN, toPixel, enToPixel, sceneDepth, hidden, heading, S, C, pxPerMetreNorth, pxPerMetreEast };
  }
  root.IsoGeo = { make, load: (geo, base = "/") => undelta(base + "depth.bin", geo.depthGrid.w * geo.depthGrid.h, geo.depthGrid.w) };
})(window);
