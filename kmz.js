/* KMZ/KML -> GeoJSON + ground overlays. Browser: window.HajjKmz ; Node: module.exports (pass deps). */
(function (root) {
  "use strict";

  function haversine(a, b) {
    const R = 6371008.8, toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function lineLen(coords) { let L = 0; for (let i = 1; i < coords.length; i++) L += haversine(coords[i - 1], coords[i]); return L; }
  function geomLength(g) {
    if (!g) return 0;
    if (g.type === "LineString") return lineLen(g.coordinates);
    if (g.type === "MultiLineString") return g.coordinates.reduce((s, c) => s + lineLen(c), 0);
    if (g.type === "GeometryCollection") return g.geometries.reduce((s, x) => s + geomLength(x), 0);
    return 0;
  }
  function eachCoord(g, fn) {
    if (!g) return;
    const walk = c => { if (typeof c[0] === "number") fn(c); else c.forEach(walk); };
    if (g.type === "GeometryCollection") g.geometries.forEach(x => eachCoord(x, fn));
    else if (g.coordinates) walk(g.coordinates);
  }
  // round coordinates to 7 decimals (~1 cm) and drop altitude to keep payloads small
  function slim(g) {
    if (!g) return g;
    if (g.type === "GeometryCollection") return { type: g.type, geometries: g.geometries.map(slim) };
    const walk = c => (typeof c[0] === "number") ? [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7] : c.map(walk);
    return { type: g.type, coordinates: walk(g.coordinates) };
  }
  function text(el, tag) {
    const n = el.getElementsByTagName(tag)[0];
    return n ? (n.textContent || "").trim() : "";
  }
  function mimeOf(path) {
    const e = (path.split(".").pop() || "").toLowerCase();
    return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[e] || null;
  }

  const NS = { gx: "http://www.google.com/kml/ext/2.2", kml: "http://www.opengis.net/kml/2.2", atom: "http://www.w3.org/2005/Atom", xal: "urn:oasis:names:tc:ciq:xsdschema:xAL:2.0", xsi: "http://www.w3.org/2001/XMLSchema-instance" };
  // Repair common KML export quirks: BOM / junk before the XML declaration, prefixes used without xmlns declarations.
  function fixKml(t) {
    t = String(t).replace(/^[﻿\s]+/, "");
    const i = t.indexOf("<?xml"); if (i > 0) t = t.slice(i);
    const used = new Set(); const re = /<\/?([A-Za-z_][\w.-]*):[A-Za-z_]/g; let m;
    while ((m = re.exec(t))) used.add(m[1]);
    const are = /\s([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g;
    while ((m = are.exec(t))) if (m[1] !== "xmlns" && m[1] !== "xml") used.add(m[1]);
    const missing = [...used].filter(p => p !== "xmlns" && p !== "xml" && !new RegExp("xmlns:" + p + "\\s*=").test(t));
    if (!missing.length) return t;
    const add = missing.map(p => ` xmlns:${p}="${NS[p] || "urn:x-" + p}"`).join("");
    const root = t.match(/<(?!\?|!)([A-Za-z_][\w.:-]*)/);
    if (!root) return t;
    const at = root.index + root[0].length;
    return t.slice(0, at) + add + t.slice(at);
  }
  function decode(bytes) {
    if (typeof bytes === "string") return bytes;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8);
    return new TextDecoder("utf-8").decode(u8);
  }
  const isZipBytes = b => { try { const u = new Uint8Array(b.slice ? b.slice(0, 2) : b); return u[0] === 0x50 && u[1] === 0x4b; } catch (e) { return false; } };

  // Collect every KML document inside a file (plain KML, KMZ, a zip of KMZ/KML files, nested to depth 3).
  async function collect(deps, bytes, name, depth, out) {
    if (depth > 3) return;
    if (isZipBytes(bytes)) {
      const zip = await deps.JSZip.loadAsync(bytes);
      const files = Object.keys(zip.files).filter(n => !zip.files[n].dir && !/__MACOSX|\/\./.test(n));
      const kmls = files.filter(n => /\.kml$/i.test(n)), nested = files.filter(n => /\.(kmz|zip)$/i.test(n));
      for (const n of kmls) out.push({ src: n.split("/").pop().replace(/\.kml$/i, ""), text: decode(await zip.files[n].async("uint8array")), zip });
      for (const n of nested) await collect(deps, await zip.files[n].async(deps.binaryType === "nodebuffer" ? "nodebuffer" : "arraybuffer"), n.split("/").pop(), depth + 1, out);
    } else {
      out.push({ src: String(name || "").replace(/\.(kml|kmz|zip)+$/i, ""), text: decode(bytes), zip: null });
    }
  }

  async function parse(deps, input, fileName) {
    const { toGeoJSON, DOMParser } = deps;
    const docs = [];
    await collect(deps, input, fileName, 0, docs);
    if (!docs.length) throw new Error("لا يوجد ملف KML داخل الملف.");
    const features = [], overlays = [];
    let length = 0, points = 0, lines = 0, polys = 0, ok = 0, docName = "";
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    const grow = c => { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; };
    for (const d of docs) {
      let dom;
      try {
        dom = new DOMParser().parseFromString(fixKml(d.text), "text/xml");
        if (!dom || !dom.documentElement || dom.getElementsByTagName("parsererror").length) continue;
      } catch (e) { continue; }
      ok++;
      const dn = (() => { const n = dom.getElementsByTagName("Document")[0]; return n ? text(n, "name") : ""; })();
      if (!docName) docName = dn;
      const fc = toGeoJSON.kml(dom);
      (fc.features || []).forEach(f => {
        if (!f || !f.geometry) return;
        if (f.properties && f.properties["@geometry-type"] === "groundoverlay") return;
        const g = slim(f.geometry);
        const props = {};
        Object.entries(f.properties || {}).forEach(([k, v]) => {
          if (v && typeof v === "object" && typeof v.value === "string") v = v.value;
          if (v == null || typeof v === "object") return;
          if (k === "styleUrl" || k === "styleHash" || k === "styleMapHash" || k === "icon") return;
          props[k] = typeof v === "string" ? v.slice(0, 4000) : v;
        });
        const L = geomLength(g);
        length += L;
        const t = g.type;
        if (/Point/.test(t)) points++; else if (/LineString/.test(t)) lines++; else if (/Polygon/.test(t)) polys++; else if (t === "GeometryCollection") lines++;
        eachCoord(g, grow);
        props._len = Math.round(L * 10) / 10;
        props._i = features.length;
        props._src = [d.src, dn].filter(Boolean).join(" · ").slice(0, 200);
        features.push({ type: "Feature", properties: props, geometry: g });
      });
      const gos = dom.getElementsByTagName("GroundOverlay");
      for (let i = 0; i < gos.length; i++) {
        const go = gos[i];
        const href = text(go, "href");
        let n = parseFloat(text(go, "north")), s = parseFloat(text(go, "south")), e = parseFloat(text(go, "east")), w = parseFloat(text(go, "west"));
        if (!(isFinite(n) && isFinite(s) && isFinite(e) && isFinite(w))) {
          const quad = go.getElementsByTagName("gx:LatLonQuad")[0] || go.getElementsByTagName("LatLonQuad")[0];
          if (quad) {
            const cs = text(quad, "coordinates").split(/\s+/).filter(Boolean).map(p => p.split(",").map(Number));
            if (cs.length >= 4) { w = Math.min(...cs.map(c => c[0])); e = Math.max(...cs.map(c => c[0])); s = Math.min(...cs.map(c => c[1])); n = Math.max(...cs.map(c => c[1])); }
          }
        }
        if (!href || !isFinite(n)) continue;
        let blob = null; const mime = mimeOf(href);
        if (d.zip && mime) {
          const key = Object.keys(d.zip.files).find(k => k === href || k.endsWith("/" + href) || href.endsWith(k));
          if (key) blob = await d.zip.files[key].async(deps.binaryType || "blob");
        }
        overlays.push({ name: text(go, "name") || ("Overlay " + (overlays.length + 1)), href, mime, blob, bounds: [[s, w], [n, e]] });
        grow([w, s]); grow([e, n]);
      }
    }
    if (!ok) throw new Error("تعذرت قراءة ملف KML (صيغة غير صالحة).");
    return {
      geojson: { type: "FeatureCollection", features },
      overlays,
      stats: { features: features.length, points, lines, polys, length: Math.round(length), overlays: overlays.length, docs: ok },
      bbox: features.length || overlays.length ? [minX, minY, maxX, maxY] : null,
      docName,
    };
  }

  const api = { parse, geomLength, haversine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HajjKmz = api;
})(typeof window !== "undefined" ? window : this);
