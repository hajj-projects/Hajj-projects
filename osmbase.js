/* OpenStreetMap vector basemap for Makkah & the Holy Sites.
   Data comes from Overpass (downloaded once in the browser via a link, then uploaded from
   «إدارة البيانات»), stored as a shared asset and drawn on a canvas pane under the project layers.
   Buildings/tents and minor streets appear from zoom 15. */
(function () {
  "use strict";
  // Browser links to Overpass (the page itself cannot call external hosts); the downloaded
  // JSON is uploaded once from «إدارة البيانات» and shared with every viewer as an asset.
  const BBOX = [21.32, 39.78, 21.47, 40.01];      // Makkah + Mina + Muzdalifah + Arafat
  const BBOX_BLD = { bld_mash: [21.34, 39.865, 21.44, 40.01], bld_mak: [21.36, 39.79, 21.46, 39.865] }; // Mashaer / central Makkah
  const DETAIL_ZOOM = 15, CELL = 0.02, SNAP_VER = 3;
  const ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">مساهمو OpenStreetMap</a>';
  const LS_KEY = "osmBaseOn";

  const MAIN_Q = `[out:json][timeout:300][maxsize:536870912][bbox:${BBOX.join(",")}];
(way["highway"];way["railway"~"^(rail|light_rail|subway|monorail|funicular)$"];nwr["tourism"="camp_site"];nwr["landuse"];nwr["leisure"~"^(park|garden|pitch|stadium)$"];nwr["amenity"~"^(place_of_worship|hospital|parking)$"];nwr["natural"~"^(water|wood|scrub)$"];);
out geom qt;
(node["place"];way["place"];relation["place"];node["natural"~"^(peak|hill)$"]["name"];nwr["tourism"="camp_site"]["name"];nwr["amenity"~"^(place_of_worship|hospital)$"]["name"];nwr["historic"]["name"];node["railway"="station"]["name"];);
out center tags qt;`;
  const bldQ = bb => `[out:json][timeout:300][maxsize:536870912][bbox:${bb.join(",")}];
(way["building"];relation["building"];);
out geom qt;`;
  // overpass-turbo runs the query in the browser (direct API links are refused with 406)
  const qURL = q => "https://overpass-turbo.eu/?Q=" + encodeURIComponent(q) + "&R";
  const altURL = q => "https://overpass.kumi.systems/api/interpreter?data=" + encodeURIComponent(q.replace(/\n/g, ""));

  // ---------- styles ----------
  const ROAD = {
    motorway: [5, "#e892a2", "#c75a6f"], trunk: [4.5, "#f9b29c", "#cf7d62"], primary: [4, "#fcd6a4", "#c89a59"],
    secondary: [3.5, "#f7fabf", "#a9ad6a"], tertiary: [3, "#ffffff", "#bdb3a4"], pedestrian: [2.2, "#ededf2", "#bdb7c4"],
    residential: [2.2, "#ffffff", "#c9c0b3"], unclassified: [2.2, "#ffffff", "#c9c0b3"], road: [2.2, "#ffffff", "#c9c0b3"],
    living_street: [2.2, "#f3f3f3", "#c9c0b3"], service: [1.4, "#ffffff", "#cfc6ba"], track: [1, "#b89c6e", null],
    footway: [0.9, "#e7928b", null], path: [0.9, "#e7928b", null], steps: [1.4, "#e7928b", null],
  };
  const AREA = {
    residential: ["#e6e1d9", null], commercial: ["#f1dcd8", null], retail: ["#f4d7d3", null], industrial: ["#e7dbe5", null],
    religious: ["#e2dccb", null], cemetery: ["#d2e0cc", null], grass: ["#d6eac4", null], recreation_ground: ["#dcefcf", null],
    construction: ["#ece6d3", null], railway: ["#e3dde3", null], military: ["#f0d9d4", null], farmland: ["#eef0d5", null],
    orchard: ["#d4ebc1", null], garages: ["#e0ddd5", null], park: ["#cfeac0", "#a9cf96"], garden: ["#cfeac0", null],
    pitch: ["#aee0c6", "#86c4a6"], stadium: ["#d6efe2", "#9dc9b2"], wood: ["#c5dfb4", null], scrub: ["#d8e6c2", null],
    water: ["#aad3df", "#86b8c8"], camp: ["#f5e6bf", "#cfae6a"], worship: ["#e0d6c2", "#b5a589"], hospital: ["#f6dddd", "#d8a9a9"],
    parking: ["#eeeeee", "#cccccc"], building: ["#d9d0c9", "#bfb3a8"], tent: ["#fbf6ea", "#cdbf9f"],
  };
  const ROAD_ORDER = ["footway", "path", "steps", "track", "service", "living_street", "road", "unclassified", "residential", "pedestrian", "tertiary", "secondary", "primary", "trunk", "motorway"];
  const AREA_ORDER = ["residential", "commercial", "retail", "industrial", "garages", "religious", "construction", "railway", "military", "farmland", "orchard", "cemetery", "grass", "recreation_ground", "wood", "scrub", "park", "garden", "stadium", "pitch", "water", "parking", "camp", "hospital", "worship"];

  // ---------- local cache (IndexedDB) ----------
  let idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(res => {
      try {
        const r = indexedDB.open("osm-base", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
        setTimeout(() => res(null), 1500); // Firefox (private/partitioned storage) may never answer
      } catch (e) { res(null); }
    });
    return idbP;
  }
  async function cget(k) {
    const d = await idb(); if (!d) return null;
    return new Promise(res => { setTimeout(() => res(null), 1500); try { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } });
  }
  async function cset(k, v) {
    const d = await idb(); if (!d) return;
    try { d.transaction("kv", "readwrite").objectStore("kv").put(v, k); } catch (e) { }
  }

  // ---------- parsing to a compact form ----------
  const R5 = v => Math.round(v * 1e5) / 1e5;
  const pt = g => [R5(g.lat), R5(g.lon)];
  const gj = c => [R5(c[1]), R5(c[0])];
  const nameOf = t => t && (t["name:ar"] || t.name || t["name:en"]) || "";
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  function joinRings(ways) {
    const segs = ways.map(w => w.slice()); const rings = [];
    while (segs.length) {
      let ring = segs.shift(), guard = 0;
      while (ring.length > 2 && !same(ring[0], ring[ring.length - 1]) && guard++ < 5000) {
        const end = ring[ring.length - 1]; let found = false;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (same(s[0], end)) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); found = true; break; }
          if (same(s[s.length - 1], end)) { ring = ring.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); found = true; break; }
        }
        if (!found) break;
      }
      if (ring.length > 2) rings.push(ring);
    }
    return rings;
  }
  function areaKind(t) {
    if (t.building && t.building !== "no") return t.building === "tent" ? "tent" : "building";
    if (t.tourism === "camp_site") return "camp";
    if (t.amenity === "place_of_worship") return "worship";
    if (t.amenity === "hospital") return "hospital";
    if (t.amenity === "parking") return "parking";
    if (t.natural === "water" || t.water) return "water";
    if (t.leisure && AREA[t.leisure]) return t.leisure;
    if (t.natural && AREA[t.natural]) return t.natural;
    if (t.landuse && AREA[t.landuse]) return t.landuse;
    return null;
  }
  function roadKind(hw) {
    if (!hw) return null; hw = hw.replace("_link", "");
    if (hw === "cycleway" || hw === "bridleway") hw = "path";
    return ROAD[hw] ? hw : null;
  }
  function labelKind(t) {
    if (t.place) return t.place;
    if (t.tourism === "camp_site") return "camp";
    if (t.natural === "peak" || t.natural === "hill") return "peak";
    if (t.amenity === "place_of_worship") return "mosque";
    if (t.amenity === "hospital") return "hospital";
    if (t.railway === "station") return "station";
    if (t.historic) return "historic";
    return null;
  }
  function addLine(F, t, c) {
    if (c.length < 2) return;
    if (t.railway && /rail|subway|monorail|funicular/.test(t.railway)) { F.push({ r: 1, c, n: nameOf(t) }); return; }
    const h = roadKind(t.highway); if (h && t.area !== "yes") F.push({ h, c, n: nameOf(t), tu: t.tunnel === "yes" || t.covered === "yes" ? 1 : 0 });
  }
  // Overpass JSON ("out geom" / "out center") or GeoJSON (e.g. overpass-turbo export)
  function parse(json) {
    const F = [], Lb = [], seen = new Set();
    const label = (t, ll, key) => { const n = nameOf(t), k = labelKind(t); if (!n || !k || !ll) return; if (key) { if (seen.has(key)) return; seen.add(key); } Lb.push({ k, n, p: [R5(ll[0]), R5(ll[1])] }); };
    if (Array.isArray(json.elements)) {
      for (const el of json.elements) {
        const t = el.tags || {};
        if (el.type === "way" && el.geometry) {
          const c = el.geometry.filter(Boolean).map(pt);
          if ((t.highway || t.railway) && !areaKind(t)) addLine(F, t, c);
          else { const k = areaKind(t); if (k && c.length > 3) F.push({ a: k, c: [c], n: nameOf(t) }); }
          if (el.center) label(t, [el.center.lat, el.center.lon], "w" + el.id);
        } else if (el.type === "relation" && el.members) {
          const k = areaKind(t);
          if (k) { const rings = joinRings(el.members.filter(m => m.type === "way" && m.geometry && m.role !== "inner").map(m => m.geometry.filter(Boolean).map(pt))); if (rings.length) F.push({ a: k, c: rings, n: nameOf(t) }); }
          if (el.center) label(t, [el.center.lat, el.center.lon], "r" + el.id);
        } else if (el.type === "node") label(t, [el.lat, el.lon], "n" + el.id);
        else if (el.center) label(t, [el.center.lat, el.center.lon], el.type[0] + el.id);
      }
    } else if (Array.isArray(json.features)) {
      for (const f of json.features) {
        const t = Object.assign({}, f.properties && f.properties.tags || {}, f.properties || {}), g = f.geometry; if (!g) continue;
        const k = areaKind(t);
        if (g.type === "Point") label(t, gj(g.coordinates));
        else if (g.type === "LineString") { const c = g.coordinates.map(gj); if (k && c.length > 3 && same(c[0], c[c.length - 1])) F.push({ a: k, c: [c], n: nameOf(t) }); else addLine(F, t, c); }
        else if (g.type === "MultiLineString") g.coordinates.forEach(l => addLine(F, t, l.map(gj)));
        else if (g.type === "Polygon" || g.type === "MultiPolygon") {
          const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
          if (k) F.push({ a: k, c: polys.map(p => p[0].map(gj)), n: nameOf(t) });
          if (labelKind(t)) { const r = polys[0][0]; let la = 0, lo = 0; r.forEach(q => { la += q[1]; lo += q[0]; }); label(t, [la / r.length, lo / r.length]); }
        }
      }
    } else throw new Error("الملف ليس بصيغة Overpass JSON أو GeoJSON.");
    return { f: F, l: Lb };
  }

  // ---------- shared store ----------
  const store = { db: null, assets: null, canWrite: false };
  let meta = null;            // basemap/osm doc
  let data = null;            // merged {f, l}
  let state = "init";         // init | loading | ready | empty | error
  const listeners = new Set();
  function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { } }); }
  const PARTS = ["main", "bld_mash", "bld_mak", "bld"];

  async function fetchPart(p) {
    const loc = await cget("asset:" + p.assetId);
    if (loc) return loc;
    const r = await fetch((window.blobURL ? window.blobURL(p.assetId) : "/_blob/" + p.assetId), { credentials: "same-origin" }); if (!r.ok) throw new Error("asset " + r.status);
    const d = await r.json(); cset("asset:" + p.assetId, d); return d;
  }
  let loadSeq = 0;
  async function loadFromMeta(m) {
    const my = ++loadSeq;
    meta = m;
    const parts = PARTS.map(k => m && m[k]).filter(p => p && p.assetId);
    if (!parts.length) { data = null; state = "empty"; notify(); return; }
    state = "loading"; notify();
    try {
      const ds = await Promise.all(parts.map(fetchPart));
      if (my !== loadSeq) return;
      data = { f: [].concat(...ds.map(d => d.f || [])), l: [].concat(...ds.map(d => d.l || [])), key: parts.map(p => p.assetId).join("|") };
      state = "ready";
    } catch (e) { if (my !== loadSeq) return; state = "error"; }
    notify();
  }

  async function importFile(file, onProgress) {
    if (!store.db || !store.assets || !store.canWrite) throw new Error("رفع خريطة الأساس يتطلب صلاحية «محرر» على الرابط.");
    onProgress && onProgress("قراءة الملف…");
    const text = await file.text();
    let json; try { json = JSON.parse(text); } catch (e) { throw new Error("تعذّر قراءة الملف — تأكد أنه ملف JSON كامل (انتظر حتى يكتمل التحميل من Overpass)."); }
    if (json.remark && /error|runtime/i.test(json.remark) && !(json.elements || []).length) throw new Error("خادم Overpass أعاد خطأ: " + json.remark);
    onProgress && onProgress("تحليل البيانات…");
    const d = parse(json);
    if (!d.f.length && !d.l.length) throw new Error("لا توجد عناصر صالحة في الملف.");
    const nb = d.f.filter(x => x.a === "building" || x.a === "tent").length;
    let part = "main";
    if (nb > d.f.length / 2) {
      let lo = 0, c = 0; for (const x of d.f) { if (x.a) { lo += x.c[0][0][1]; c++; } }
      part = c && lo / c < 39.865 ? "bld_mak" : "bld_mash";
    }
    const out = { v: SNAP_VER, f: d.f, l: d.l };
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    onProgress && onProgress("رفع " + (blob.size / 1048576).toFixed(1) + " MB…");
    const up = await store.assets.upload(blob, { type: "application/json" });
    const s = await store.db.doc("basemap/osm").get().catch(() => null);
    const old = s && s.exists ? s.data() : {};
    const doc = Object.assign({}, old, { ver: SNAP_VER, [part]: { assetId: up.id, file: file.name, at: new Date().toISOString(), n: d.f.length, labels: d.l.length } });
    await store.db.doc("basemap/osm").set(doc);
    if (old[part] && old[part].assetId && old[part].assetId !== up.id) { try { await store.assets.delete(old[part].assetId); } catch (e) { } }
    return { part, features: d.f.length, labels: d.l.length, buildings: nb };
  }
  async function removePart(part) {
    const s = await store.db.doc("basemap/osm").get().catch(() => null);
    const old = s && s.exists ? s.data() : {};
    const p = old[part]; if (!p) return;
    const doc = Object.assign({}, old); delete doc[part];
    await store.db.doc("basemap/osm").set(doc);
    if (p.assetId) { try { await store.assets.delete(p.assetId); } catch (e) { } }
  }

  // ---------- label layer (DOM, collision-checked) ----------
  const LBL = {
    city: [9, 1, "lb-city"], town: [11, 2, "lb-city"], suburb: [12, 3, "lb-sub"], borough: [12, 3, "lb-sub"],
    quarter: [13, 4, "lb-sub"], neighbourhood: [14, 5, "lb-nb"], village: [12, 4, "lb-sub"], hamlet: [14, 6, "lb-nb"],
    locality: [13, 5, "lb-nb"], isolated_dwelling: [16, 9, "lb-nb"], square: [16, 8, "lb-nb"], plot: [17, 10, "lb-nb"],
    peak: [14, 6, "lb-peak"], mosque: [15, 6, "lb-poi"], hospital: [15, 7, "lb-poi"], station: [14, 5, "lb-poi"],
    historic: [16, 8, "lb-poi"], camp: [16, 7, "lb-camp"], road: [15, 8, "lb-road"], street: [16, 9, "lb-road"], area: [16, 9, "lb-poi"],
  };
  const LabelLayer = L.Layer.extend({
    initialize(getLabels) { this._get = getLabels; },
    onAdd(map) {
      this._map = map;
      this._el = L.DomUtil.create("div", "osm-labels", map.getPane("osmLabels"));
      map.on("moveend zoomend resize", this._draw, this);
      this._draw();
    },
    onRemove(map) { map.off("moveend zoomend resize", this._draw, this); L.DomUtil.remove(this._el); },
    _draw() {
      const map = this._map; if (!map || !this._el) return;
      const z = map.getZoom(), b = map.getBounds().pad(0.05), size = map.getSize();
      const cand = this._get().filter(l => { const s = LBL[l.k] || LBL.locality; return z >= s[0] && b.contains(l.p); });
      cand.sort((a, c) => (LBL[a.k] || LBL.locality)[1] - (LBL[c.k] || LBL.locality)[1]);
      const placed = [], html = [];
      for (const l of cand) {
        if (placed.length > 220) break;
        const p = map.latLngToLayerPoint(l.p), cp = map.latLngToContainerPoint(l.p);
        const st = LBL[l.k] || LBL.locality;
        const fs = st[2] === "lb-city" ? 15 : st[2] === "lb-sub" ? 13 : 11.5;
        const w = Math.min(220, l.n.length * fs * 0.55 + 10), h = fs + 8;
        const r = [cp.x - w / 2, cp.y - h / 2, cp.x + w / 2, cp.y + h / 2];
        if (r[2] < 0 || r[3] < 0 || r[0] > size.x || r[1] > size.y) continue;
        if (placed.some(q => !(r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3]))) continue;
        placed.push(r);
        html.push(`<div class="osm-lb ${st[2]}" style="transform:translate(${Math.round(p.x)}px,${Math.round(p.y)}px) translate(-50%,-50%)">${esc(l.n)}</div>`);
      }
      this._el.innerHTML = html.join("");
    },
  });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- per-map attachment ----------
  function isOn() { try { return localStorage.getItem(LS_KEY) !== "0"; } catch (e) { return true; } }
  function setOn(v) { try { localStorage.setItem(LS_KEY, v ? "1" : "0"); } catch (e) { } }
  function lineLen(c) { let s = 0; for (let i = 1; i < c.length; i++) { const dy = c[i][0] - c[i - 1][0], dx = (c[i][1] - c[i - 1][1]) * 0.93; s += Math.sqrt(dx * dx + dy * dy); } return s * 111000; }
  function midOf(c) { const tot = lineLen(c); let acc = 0; for (let i = 1; i < c.length; i++) { const seg = lineLen([c[i - 1], c[i]]); if (acc + seg >= tot / 2) { const f = seg ? (tot / 2 - acc) / seg : 0; return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f]; } acc += seg; } return c[0]; }
  const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "pedestrian"]);
  const firstPt = f => f.a ? f.c[0][0] : f.c[0];

  // derived per data version (shared by all maps)
  let prep = null;
  function prepare() {
    if (!data) return null;
    if (prep && prep.key === data.key) return prep;
    const base = [], cellsM = new Map(), roadLbl = [], byName = new Map();
    for (const f of data.f) {
      const detail = (f.a === "building" || f.a === "tent") || (f.h && !MAJOR.has(f.h));
      if (detail) {
        const p = firstPt(f); const k = Math.floor(p[0] / CELL) + ":" + Math.floor(p[1] / CELL);
        if (!cellsM.has(k)) cellsM.set(k, []); cellsM.get(k).push(f);
      } else base.push(f);
      if ((f.h || f.r) && f.n && lineLen(f.c) >= 80) {
        const m = midOf(f.c), prev = byName.get(f.n) || [];
        if (prev.some(q => Math.abs(q[0] - m[0]) < 0.004 && Math.abs(q[1] - m[1]) < 0.004)) continue;
        prev.push(m); byName.set(f.n, prev);
        roadLbl.push({ k: f.h && !MAJOR.has(f.h) ? "street" : "road", n: f.n, p: m });
      }
    }
    prep = { key: data.key, base, cells: cellsM, labels: data.l.concat(roadLbl) };
    return prep;
  }

  function attach(map) {
    if (!map.getPane("osmBase")) { const p = map.createPane("osmBase"); p.style.zIndex = 250; p.style.pointerEvents = "none"; }
    if (!map.getPane("osmLabels")) { const p = map.createPane("osmLabels"); p.style.zIndex = 390; p.style.pointerEvents = "none"; }
    const el = map.getContainer();
    const renderer = L.canvas({ pane: "osmBase", padding: 0.4, tolerance: 0 });
    const baseG = L.layerGroup(), detailG = L.layerGroup();
    let drawnKey = null, drawnCells = new Set();
    const labels = new LabelLayer(() => { const P = prepare(); return P ? P.labels : []; });
    let on = isOn(), statusEl;

    const ctl = L.control({ position: "topleft" });
    ctl.onAdd = () => {
      const d = L.DomUtil.create("div", "leaflet-bar osm-ctl");
      d.innerHTML = `<label title="خريطة الأساس OpenStreetMap"><input type="checkbox" ${on ? "checked" : ""}> خريطة الأساس</label><span class="osm-st"></span>`;
      statusEl = d.querySelector(".osm-st");
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      d.querySelector("input").addEventListener("change", e => { on = e.target.checked; setOn(on); apply(); });
      return d;
    };
    ctl.addTo(map);
    const attr = L.control({ position: "bottomright" });
    attr.onAdd = () => { const d = L.DomUtil.create("div", "osm-attr"); d.innerHTML = ATTR; L.DomEvent.disableClickPropagation(d); return d; };
    let attrOn = false;
    const status = (t, cls) => { if (statusEl) { statusEl.innerHTML = t || ""; statusEl.className = "osm-st" + (cls ? " " + cls : ""); } };

    function addArea(g, f) {
      const s = AREA[f.a] || AREA.residential, b = f.a === "building" || f.a === "tent";
      L.polygon(f.c, { renderer, pane: "osmBase", interactive: false, stroke: !!s[1], color: s[1] || s[0], weight: b ? 0.6 : 0.8, fillColor: s[0], fillOpacity: 1, smoothFactor: b ? 0.3 : 0.8 }).addTo(g);
    }
    // road widths shrink when zoomed out
    const zf = z => z <= 12 ? 0.35 : z <= 13 ? 0.45 : z <= 14 ? 0.6 : z <= 15 ? 0.75 : z <= 16 ? 0.9 : 1;
    let roadLines = [];
    function addRoads(g, list) {
      const sorted = list.slice().sort((a, b) => ROAD_ORDER.indexOf(a.h) - ROAD_ORDER.indexOf(b.h)), f0 = zf(map.getZoom());
      for (const f of sorted) { const s = ROAD[f.h]; if (s[2]) { const w = s[0] + 1.5; roadLines.push([L.polyline(f.c, { renderer, pane: "osmBase", interactive: false, color: s[2], weight: w * f0, opacity: f.tu ? 0.35 : 1, dashArray: f.tu ? "4 4" : null, lineCap: "round", lineJoin: "round" }).addTo(g), w]); } }
      for (const f of sorted) { const s = ROAD[f.h]; roadLines.push([L.polyline(f.c, { renderer, pane: "osmBase", interactive: false, color: s[1], weight: s[0] * f0, opacity: f.tu ? 0.45 : 1, dashArray: !s[2] ? "3 3" : null, lineCap: "round", lineJoin: "round" }).addTo(g), s[0]]); }
    }
    let lastF = null;
    map.on("zoomend", () => { const f = zf(map.getZoom()); if (f === lastF) return; lastF = f; for (const [l, w] of roadLines) l.setStyle({ weight: w * f }); });
    function drawSet(g, list) {
      const areas = list.filter(f => f.a).sort((a, b) => AREA_ORDER.indexOf(a.a) - AREA_ORDER.indexOf(b.a));
      for (const f of areas) addArea(g, f);
      addRoads(g, list.filter(f => f.h));
      for (const f of list) if (f.r) { L.polyline(f.c, { renderer, pane: "osmBase", interactive: false, color: "#7d7d7d", weight: 2.2, lineCap: "butt" }).addTo(g); L.polyline(f.c, { renderer, pane: "osmBase", interactive: false, color: "#ffffff", weight: 1, dashArray: "6 6", lineCap: "butt" }).addTo(g); }
    }
    function refreshDetail() {
      const P = prepare();
      if (!on || !P) return;
      if (map.getZoom() < DETAIL_ZOOM) { if (map.hasLayer(detailG)) map.removeLayer(detailG); return; }
      if (!map.hasLayer(detailG)) detailG.addTo(map);
      const b = map.getBounds().pad(0.3);
      const i0 = Math.floor(b.getSouth() / CELL), i1 = Math.floor(b.getNorth() / CELL), j0 = Math.floor(b.getWest() / CELL), j1 = Math.floor(b.getEast() / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i + ":" + j; if (drawnCells.has(k)) continue; drawnCells.add(k);
        const list = P.cells.get(k); if (list) drawSet(detailG, list);
      }
    }
    function sync() {
      if (!map._container) return;
      if (!on) { status(""); return; }
      if (state === "loading" || state === "init") { status("جارٍ تحميل خريطة الأساس…"); return; }
      if (state === "error") { status("تعذّر تحميل خريطة الأساس", "err"); return; }
      if (state === "empty") { status(store.canWrite ? 'لم تُرفع بعد — <a href="#data">إدارة البيانات</a>' : "غير متوفرة بعد"); return; }
      const P = prepare(); if (!P) return;
      if (drawnKey !== P.key) {
        baseG.clearLayers(); detailG.clearLayers(); roadLines = []; drawnCells = new Set(); drawnKey = P.key;
        drawSet(baseG, P.base);
      }
      el.classList.add("osm-on"); if (!attrOn) { attr.addTo(map); attrOn = true; }
      if (!map.hasLayer(baseG)) baseG.addTo(map);
      if (!map.hasLayer(labels)) labels.addTo(map); else labels._draw();
      refreshDetail();
      status("");
    }
    function apply() {
      if (!on) {
        [baseG, detailG, labels].forEach(l => map.hasLayer(l) && map.removeLayer(l));
        if (attrOn) { attr.remove(); attrOn = false; }
        el.classList.remove("osm-on"); status(""); return;
      }
      sync();
    }
    listeners.add(sync);
    map.on("moveend", refreshDetail);
    map.on("unload", () => listeners.delete(sync));
    apply();
  }

  let unsub = null;
  window.OSMBase = {
    attach,
    setStore(s) {
      Object.assign(store, s || {});
      if (!store.db || unsub) return;
      state = "loading"; notify();
      const t = setTimeout(() => { if (state === "loading") { state = "error"; notify(); } }, 15000);
      try {
        unsub = store.db.doc("basemap/osm").onSnapshot(snap => {
          if (snap.metadata && snap.metadata.fromCache && !snap.exists) return;
          clearTimeout(t);
          loadFromMeta(snap.exists ? snap.data() : null);
        }, () => { clearTimeout(t); state = "error"; notify(); });
      } catch (e) { state = "error"; notify(); }
    },
    noStore() { state = "empty"; notify(); },
    importFile, removePart,
    onChange(fn) { listeners.add(fn); },
    meta: () => meta, state: () => state,
    links: { main: qURL(MAIN_Q), bld_mash: qURL(bldQ(BBOX_BLD.bld_mash)), bld_mak: qURL(bldQ(BBOX_BLD.bld_mak)) },
    alt: { main: altURL(MAIN_Q), bld_mash: altURL(bldQ(BBOX_BLD.bld_mash)), bld_mak: altURL(bldQ(BBOX_BLD.bld_mak)) },
    ATTR,
  };
})();
