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
    const th = (geo.pitch * Math.PI) / 180, S0 = Math.sin(th), C0 = Math.cos(th);
    const cam = geo.cam || { dir: [0, -S0, -C0], right: [1, 0, 0], up: [0, C0, -S0], pos: [0, 30000 * S0, 30000 * C0] };   // maps built before the camera basis existed looked due north
    const dg = geo.depthGrid, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const toEN = (lat, lon) => [(lon - geo.center.lon) * geo.mPerDegLon, (lat - geo.center.lat) * geo.mPerDegLat];
    // world point (X = east, Y = up, Z = -north) -> map pixel + view depth (metres along the camera ray from the camera)
    const enToPixel = (e, n, h = 0) => { const p = [e, h, -n]; return { x: (dot(cam.right, p) - geo.x0) / geo.mpp, y: (geo.y1 - dot(cam.up, p)) / geo.mpp, depth: dot(cam.dir, [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]]) }; };
    function toPixel(lat, lon, h = 0) { const [e, n] = toEN(lat, lon); return enToPixel(e, n, h); }
    // map pixel at ground level -> lat/lon (used for links)
    function pixelToLatLon(px, py) {
      const sx = geo.x0 + px * geo.mpp, sy = geo.y1 - py * geo.mpp, [rx, , rz] = cam.right, [ux, , uz] = cam.up, det = rx * uz - rz * ux;
      const X = (sx * uz - sy * rz) / det, Z = (rx * sy - ux * sx) / det;
      return [geo.center.lat + -Z / geo.mPerDegLat, geo.center.lon + X / geo.mPerDegLon];
    }
    function sceneDepth(px, py) {
      if (!depth) return null;
      const i = Math.floor(px / dg.cell), j = Math.floor(py / dg.cell);
      if (i < 0 || j < 0 || i >= dg.w || j >= dg.h) return null;
      return dg.lo + (depth[j * dg.w + i] / 65535) * dg.span;
    }
    const hidden = (p, tol = 1.5) => { const d = sceneDepth(p.x, p.y); return d != null && d < p.depth - tol; };
    // screen-space direction of a compass bearing (degrees clockwise from north), unit vector in pixels
    const heading = (deg) => { const r = (deg * Math.PI) / 180, w = [Math.sin(r), 0, -Math.cos(r)], dx = dot(cam.right, w), dy = -dot(cam.up, w), L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
    return { toEN, toPixel, enToPixel, pixelToLatLon, sceneDepth, hidden, heading };
  }
  root.IsoGeo = { make, load: (geo, base = "/") => undelta(base + "depth.bin", geo.depthGrid.w * geo.depthGrid.h, geo.depthGrid.w) };
})(window);
