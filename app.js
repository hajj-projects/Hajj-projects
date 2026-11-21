/* Hajj 1448 projects dashboard — weekly Excel + live KMZ maps */
(function () {
  "use strict";
  const SPEC = window.SPEC, CSPEC = window.CSPEC, CATS = window.CATS || [];
  const PALETTE = ["#4a94ef", "#9fcdfa", "#2a6fcf", "#38bdf8", "#7bb8f5", "#1d5fb8", "#c4e2ff", "#0ea5e9"];
  const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  const GEN_LAYER = "GEN";
  const WATER = "#2a78d6", SEWER = "#16a34a";
  const SEW_RE = /صرف|sewer|sewage|waste\s*water|wastewater|\bWW\b|manhole|\bMH\b|غرف(ة)?\s*تفتيش/i;
  const kindOfType = t => /صرف/.test(t || "") && /مياه/.test(t || "") ? "mixed" : /صرف/.test(t || "") ? "sewer" : "water";
  const featKind = (layer, props) => props._k || (layer.kind === "sewer" ? "sewer" : "water");
  const YEAR_COLORS = { 1442: "#1d5fb8", 1443: "#2a74d1", 1444: "#3d8ae6", 1445: "#5aa2f0", 1446: "#7bb8f5", 1447: "#9fcdfa", 1448: "#38bdf8" };

  const S = {
    weeks: [],            // [{weekId, uploadedAt, sourceFile, data}] ascending
    weekId: null,
    source: "baseline",   // baseline | live
    layers: [],           // map layer docs
    geo: {},              // layerId -> geojson (loaded)
    db: null, assets: null, user: null, downloads: null,
    canWrite: false, canAssets: false,
    pending: null,        // parsed excel awaiting confirmation
    done: null,           // completed projects {projects, quantities, sourceFile, uploadedAt}
    doneSource: "baseline",
    cPending: null,
    charts: [], maps: [],
  };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (v, d = 0) => v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 2) => v == null || !isFinite(v) ? "—" : (v * 100).toFixed(d) + "%";
  const pts = v => v == null ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(2);
  const money = v => v == null ? "—" : nf(v);
  const mil = v => v == null ? "—" : (v / 1e6).toFixed(2);
  const parseISO = s => { if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null; const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const satOf = s => { const t = parseISO(s); if (t == null) return null; const wd = new Date(t).getUTCDay(); const d = (6 - wd + 7) % 7; return t + (d <= 3 ? d : d - 7) * 86400000; }; // nearest Saturday
  const fmtDate = s => { const t = parseISO(s); if (t == null) return s || "—"; const d = new Date(t); return String(d.getUTCDate()).padStart(2, "0") + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); };
  const HMON = ["محرم", "صفر", "ربيع الأول", "ربيع الثاني", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
  const hijri = s => { const t = parseISO(s); if (t == null) return ""; try { const p = {}; new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "UTC", day: "numeric", month: "numeric", year: "numeric" }).formatToParts(new Date(t)).forEach(x => p[x.type] = x.value); return String(p.day).padStart(2, "0") + " " + HMON[+p.month - 1] + " " + parseInt(p.year) + "هـ"; } catch (e) { return ""; } };
  // report dates, charts and other dates: Gregorian only (Hijri is kept for project start/end dates)
  const fmtDual = s => { const t = parseISO(s); if (t == null) return s || "—"; return fmtDate(s) + "م"; };
  const fmtMonth = t => { const d = new Date(t); return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); };
  const fmtLen = m => m == null ? "—" : m >= 1000 ? (m / 1000).toFixed(2) + " كم" : nf(m) + " م";
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const stripHtml = h => { try { return new DOMParser().parseFromString(String(h), "text/html").body.textContent.trim(); } catch (e) { return String(h); } };
  function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 3200); }

  // Planned % is unified on the latest plan file (window.SPLAN, weekly Saturday values): each week's planned value
  // is the plan at that report's Saturday. Projects not in the plan keep the value from their report.
  function planAt(pid, t) {
    const SP = window.SPLAN && window.SPLAN[pid]; if (!SP || t == null) return null;
    if (t < parseISO(SP.start)) return 0;
    let v = 0; for (const [d, y] of SP.w) { if (parseISO(d) <= t) v = y; else break; }
    return v / 100;
  }
  const planned$ = new WeakMap();
  // manual corrections of executed quantities per report (kept in code; applied over the saved report)
  const QTY_FIX = {
    "2026-11-07": { "QW-ARF2|أعمال الحفر": 5422, "QW-ARMZ|أعمال الحفر": 4816 }, // −185 and −264 m: dug during the 14 Nov week
    "2026-11-14": { "QW-MINA|المحابس": 5 },
  };
  // manual corrections of a report's scopes / permits (kept in code; applied over the saved report)
  const REPORT_FIX = {
    "2026-11-14": {
      addQty: [
        { pid: "QW-MAK", item: "أعمال الدفع النفقي", unit: "م.ط", contract: 280, done: 0, note: null },
        { pid: "QW-MAK", item: "أعمال الحفر", unit: "م.ط", contract: 420, done: 0, note: null },
      ],
      scopes: { "QW-MAK": [
        { pid: "QW-MAK", n: 1, scope: "تنفيذ خط الإمداد بطريقة الدفع النفقي بطول 280 م", status: "تحت التنفيذ", note: "جارٍ العمل في غرفة الدفع" },
        { pid: "QW-MAK", n: 2, scope: "تنفيذ خط الإمداد بطريقة الحفر المكشوف بطول 420 م", status: "جاري إصدار التصريح", note: null },
      ] },
      permits: { "QW-MAK": { pid: "QW-MAK", issued: 1, issuedDesc: "تصريح الدفع النفقي بطول 280 م.ط", issuedLen: null, pending: 1, pendingLen: null,
        pendingDesc: "تصريح الحفر المكشوف بطول 420 م.ط\nتم إصداره من الأمانة وبانتظار موافقة المرور، ومتوقع خلال يومين",
        note: "استغرق إصدار التصاريح وقتاً نظراً لحساسية الموقع وقربه من الحرم، ووجود العديد من التنسيقات والتصعيد بهذا الخصوص." } },
    },
  };
  function withPlan(d) {
    if (!d || !window.SPLAN || !d.projects) return d;
    if (planned$.has(d)) return planned$.get(d);
    const t = satOf((d.info && d.info.reportDate) || d.weekId);
    const out = Object.assign({}, d, { projects: d.projects.map(p => { const v = planAt(p.id, t); return v == null ? p : Object.assign({}, p, { planned: v, plannedReport: p.planned }); }) });
    const fx = QTY_FIX[d.weekId || (d.info && d.info.reportDate)];
    if (fx && d.quantities) out.quantities = d.quantities.map(q => { const k = q.pid + "|" + String(q.item || "").trim(); return k in fx ? Object.assign({}, q, { done: fx[k], doneReport: q.done }) : q; });
    const rf = REPORT_FIX[d.weekId || (d.info && d.info.reportDate)];
    if (rf) {
      if (rf.scopes) out.scopes = (d.scopes || []).filter(x => !rf.scopes[x.pid]).concat(...Object.values(rf.scopes));
      if (rf.addQty) { const q = out.quantities || d.quantities || []; const idx = q.findIndex(x => x.pid === rf.addQty[0].pid); out.quantities = idx < 0 ? q.concat(rf.addQty) : q.slice(0, idx).concat(rf.addQty, q.slice(idx)); }
      if (rf.permits) out.permits = (d.permits || []).filter(x => !rf.permits[x.pid]).concat(Object.values(rf.permits));
    }
    planned$.set(d, out); return out;
  }
  function curWeek() { return withPlan((S.weeks.find(w => w.weekId === S.weekId) || S.weeks[S.weeks.length - 1] || {}).data || null); }
  function prevWeekOf(id) { const i = S.weeks.findIndex(w => w.weekId === id); return i > 0 ? withPlan(S.weeks[i - 1].data) : null; }
  function prevWeekId() { const i = S.weeks.findIndex(w => w.weekId === S.weekId); return i > 0 ? S.weeks[i - 1].weekId : null; }
  // quantity executed during the week = this report's executed − previous report's executed (same project + item + unit)
  const qKey = q => [q.pid, String(q.item || "").replace(/\s+/g, " ").trim(), String(q.unit || "").trim()].join("|");
  function weekDelta(q, PW) {
    if (!PW || !PW.quantities || q.done == null) return null;
    const o = PW.quantities.find(x => qKey(x) === qKey(q));
    if (!o) return PW.quantities.some(x => x.pid === q.pid) ? q.done : null; // new item this week → previous = 0
    return q.done - (o.done || 0);
  }
  function deltaTxt(d) { if (d == null) return '<span class="muted">—</span>'; if (Math.abs(d) < 1e-9) return '<span class="muted">0</span>'; return `<b style="color:${d > 0 ? "var(--good)" : "var(--critical)"}">${d > 0 ? "+" : "−"}${nf(Math.abs(d), Math.abs(d) % 1 ? 1 : 0)}</b>`; }
  function weekWorkCard(W) {
    const PW = prevWeekOf(S.weekId);
    const norm = t => String(t || "").replace(/\s+/g, " ").trim().replace(/(^|\s)ال(?=أنابيب)/g, "$1").replace(/^الحفر المكشوف$/, "أعمال الحفر");
    const agg = new Map();
    W.projects.forEach(p => W.quantities.filter(q => q.pid === p.id).forEach(q => {
      const k = norm(q.item) + "|" + String(q.unit || "").trim();
      const a = agg.get(k) || { item: norm(q.item), unit: q.unit || "", contract: 0, done: 0, delta: 0, hasDelta: false, n: 0 };
      a.contract += q.contract || 0; a.done += q.done || 0; a.n++;
      const d = weekDelta(q, PW); if (d != null) { a.delta += d; a.hasDelta = true; }
      agg.set(k, a);
    }));
    const rows = [...agg.values()];
    return `<div class="card" style="margin-top:16px"><h2>الكميات المنفذة – إجمالي المشاريع <span class="hint">${PW ? `خلال الأسبوع من ${fmtDual(PW.info.reportDate || prevWeekId())} إلى ${fmtDual(W.info.reportDate)}` : "تقرير " + fmtDual(W.info.reportDate)}</span></h2>
      ${rows.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>البند</th><th>الوحدة</th><th>منفذ خلال الأسبوع</th><th>إجمالي المنفذ</th><th>التعاقدية</th><th>نسبة المنفذ</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td>${esc(a.item)}</td><td>${esc(a.unit)}</td><td class="n">${PW && a.hasDelta ? deltaTxt(a.delta) : '<span class="muted">—</span>'}</td><td class="n">${nf(a.done)}</td><td class="n">${nf(a.contract)}</td><td>${pbar(a.contract ? a.done / a.contract : null, "#2a78d6")}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">لا توجد كميات مسجلة.</div>`}</div>`;
  }
  function projColor(W, pid) { const i = W.projects.findIndex(p => p.id === pid); return PALETTE[(i >= 0 ? i : 0) % PALETTE.length]; }
  function shortName(p) { return (p.short || p.name || p.id).replace(/^المكاسب السريعة\s*[–-]\s*/, ""); }
  function slug(pid) { return "p-" + String(pid).toLowerCase().replace(/[^a-z0-9-]/g, "-"); }

  function perf(p) {
    if (p.actual == null || p.planned == null) return { cls: "muted", icon: "—", label: "غير مُدخل" };
    const gap = (p.planned - p.actual) * 100;
    if (gap <= 0) return { cls: "good", icon: "▲", label: "متقدم عن المخطط" };
    if (gap < 10) return { cls: "good", icon: "●", label: "منتظم" };
    if (gap <= 25) return { cls: "warning", icon: "▼", label: "متأخر" };
    return { cls: "critical", icon: "✖", label: "متعثر" };
  }
  function elapsed(p, reportDate) {
    const a = parseISO(p.startG), b = parseISO(p.endG), r = parseISO(reportDate);
    if (a == null || b == null || r == null || b <= a) return null;
    return clamp01((r - a) / (b - a));
  }
  function weighted(list, key) {
    const xs = list.filter(p => p[key] != null && p.value != null);
    const tv = xs.reduce((s, p) => s + p.value, 0);
    return tv ? xs.reduce((s, p) => s + p.value * p[key], 0) / tv : null;
  }
  function scopeCls(st) {
    st = st || "";
    if (/مكتمل|منجز/.test(st)) return "good";
    if (/متوقف|سحب|متعثر/.test(st)) return "critical";
    if (/تصريح|تصاريح|اعتماد/.test(st)) return "warning";
    if (/تحت التنفيذ|جاري/.test(st)) return "info";
    return "muted";
  }
  function badge(cls, icon, label) { return `<span class="badge ${cls}"><span aria-hidden="true">${icon}</span>${esc(label)}</span>`; }
  function bar(v, cls = "", color) { return `<div class="track"><div class="fill ${cls}" style="width:${v == null ? 0 : (clamp01(v) * 100).toFixed(1)}%;${color ? "background:" + color : ""}"></div></div>`; }
  function pbar(v, color) { return `<div class="pbar">${bar(v, "", color)}<span>${v == null ? "—" : Math.round(v * 100) + "%"}</span></div>`; }
  function ring(v, color, label, sub) {
    const r = 46, c = 2 * Math.PI * r, f = v == null ? 0 : clamp01(v);
    return `<div class="ring"><svg viewBox="0 0 112 112" role="img" aria-label="${esc(label)} ${pct(v)}">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="rgba(160,190,230,.18)" stroke-width="9"/>
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 56 56)"${color.startsWith("url") ? "" : ""}/>
      <text x="56" y="61" text-anchor="middle" fill="#eef4fc" font-size="19" font-weight="600" font-family="IBM Plex Sans Arabic, sans-serif">${v == null ? "—" : (v * 100).toFixed(2) + "%"}</text>
    </svg><div class="rl">${esc(label)}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
  }

  // ---------- chart helpers ----------
  Chart.defaults.font.family = '"IBM Plex Sans Arabic", sans-serif';
  Chart.defaults.color = "#b9c8dd";
  Chart.defaults.borderColor = "rgba(160,190,230,.14)";
  Chart.defaults.animation = false;
  function destroyCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; S.maps.forEach(m => m.remove()); S.maps = []; }
  const tooltipBase = { rtl: true, textDirection: "rtl", backgroundColor: "#ffffff", borderColor: "#c3d0e1", borderWidth: 1, titleColor: "#0f1f35", bodyColor: "#0f1f35", padding: 10, boxPadding: 4 };

  // ---------- routing ----------
  // "#ongoing" link = copy of the dashboard showing ongoing (1448) projects only, without completed projects or data management
  // «إدارة البيانات» only for people who can edit (owner / editors signed in); hidden for shared viewers
  function canManage() { return !!(S.db && S.canWrite && S.isEditor); }
  // completed projects: hidden by default; the "#full" link shows the full dashboard including them
  let FULL = false;
  try { if (location.hash === "#full") { sessionStorage.setItem("fullView", "1"); sessionStorage.removeItem("ongoingOnly"); } else if (!location.hash || location.hash === "#ongoing") sessionStorage.removeItem("fullView"); FULL = sessionStorage.getItem("fullView") === "1"; } catch (e) { FULL = location.hash === "#full"; }
  FULL = true; // editable full copy: completed projects always shown
  const HIDE_DONE = false;
  // security-system projects are hidden from the display (data kept in security.js; set to false to show them again)
  const HIDE_SEC = true;
  if (HIDE_SEC) window.SECURITY = null;
  // static copy (e.g. GitHub Pages): stored files are read from data/blob/<id>, the data from data/snapshot.json
  const STATIC = !!window.STATIC_SITE;
  const blobURL = id => (STATIC ? "data/blob/" : "/_blob/") + id;
  window.blobURL = blobURL;
  let ONGOING = false;
  try { if (location.hash === "#ongoing") sessionStorage.setItem("ongoingOnly", "1"); else if (!location.hash) sessionStorage.removeItem("ongoingOnly"); ONGOING = sessionStorage.getItem("ongoingOnly") === "1"; } catch (e) { ONGOING = location.hash === "#ongoing"; }
  function route() { const r = (location.hash || (ONGOING ? "#overview" : "#home")).slice(1) || (ONGOING ? "overview" : "home"); if (r === "home" && ONGOING) return "overview"; if (r === "ongoing" || r === "full" || r === "map") return "overview"; if (r === "done-map") return HIDE_DONE || ONGOING ? "overview" : "done"; if (((ONGOING || !canManage()) && r === "data") || (HIDE_DONE || ONGOING) && (r === "done" || r === "done-map" || r.startsWith("done-") || r.startsWith("c-"))) return "overview"; return r; }
  function isDoneRoute(r) { return r === "done" || r.startsWith("done-") || r.startsWith("c-"); }
  function isSecRoute(r) { return !HIDE_SEC && (r === "security" || r.startsWith("sec-")); }
  function section() { const r = route(); if (r === "home") return "home"; if (r === "data") return S.lastSec === "done" ? "done" : "cur"; return isDoneRoute(r) ? "done" : isSecRoute(r) ? "sec" : "cur"; }
  function cslug(id) { return "c-" + String(id).toLowerCase().replace(/[^a-z0-9-]/g, "-"); }
  function doneYears() { const D = S.done; if (!D) return []; return [...new Set(D.projects.map(p => p.year || 0))].sort((a, b) => b - a); }
  function renderTabs(W) {
    const r = route(), sec = section();
    if (r !== "data") S.lastSec = sec;
    const ong = sec === "cur" || sec === "sec";
    $("#secbar").innerHTML = (ONGOING ? "" : `<div class="segrow homerow"><a href="#home" class="seg seg-home ${sec === "home" ? "on" : ""}">الإجمالي العام</a></div>`) + `<div class="segrow"><a href="#overview" class="seg ${ong ? "on" : ""}">مشاريع تحت التنفيذ لخدمة حج 1448هـ</a>` +
      (ONGOING || HIDE_DONE ? "" : `<a href="#done" class="seg ${sec === "done" ? "on" : ""}">المشاريع المكتملة</a>`) + `</div>` +
      (ong && window.SECURITY ? `<div class="subseg" role="tablist" aria-label="مشاريع تحت التنفيذ"><a href="#overview" class="sseg ${sec === "cur" ? "on" : ""}">المكاسب السريعة</a>` +
        (window.SECURITY ? `<a href="#security" class="sseg ${sec === "sec" ? "on" : ""}">المنظومة الأمنية</a>` : "") + `</div>` : "") +
      (sec === "done" ? (() => { const cy = r.startsWith("done-") ? r.slice(5) : r.startsWith("c-") && S.done ? String((S.done.projects.find(p => cslug(p.id) === r) || {}).year || "") : ""; 
        return `<div class="subseg" role="tablist" aria-label="المشاريع المكتملة حسب العام"><a href="#done" class="sseg ${r === "done" ? "on" : ""}">كل السنوات</a>` +
          doneYears().map(y => `<a href="#done-${y}" class="sseg ${cy === String(y) ? "on" : ""}">${y ? y + "هـ" : "غير محدد"}</a>`).join("") + `</div>`; })() : "");
    let items;
    if (sec === "home") items = [["home", "الإجمالي العام"]];
    else if (sec === "cur") {
      items = [["overview", "نظرة عامة"]];
      (W ? W.projects : []).forEach(p => items.push([slug(p.id), shortName(p)]));
      if (!ONGOING && canManage()) items.push(["sep"], ["data", "إدارة البيانات"]);
    } else if (sec === "sec") {
      items = [["security", "نظرة عامة"]];
      window.SECURITY.groups.forEach((g, i) => items.push(["sec-g" + (i + 1), g.short]));
    } else {
      // completed: the black bar holds the funding-source filter (years are in the pill row above)
      const cy = r.startsWith("done-") ? +r.slice(5) : r.startsWith("c-") && S.done ? ((S.done.projects.find(p => cslug(p.id) === r) || {}).year || 0) : null;
      const P0 = S.done ? S.done.projects.filter(p => cy == null || (p.year || 0) === cy) : [];
      const counts = new Map(); P0.forEach(p => counts.set(fundOf(p), (counts.get(fundOf(p)) || 0) + 1));
      if (S.doneFund && !counts.has(S.doneFund)) S.doneFund = null;
      const keys = [...counts.keys()].sort((a, b) => a === NOFUND ? 1 : b === NOFUND ? -1 : counts.get(b) - counts.get(a));
      const btn = (k, t, n) => `<button type="button" class="ftab" data-fund="${esc(k || "")}" ${(S.doneFund || null) === k && r !== "data" ? 'aria-current="page"' : ""}>${esc(t)} <span class="num">${n}</span></button>`;
      $("#tabs").innerHTML = `<span class="ftab-lbl">مصدر التمويل:</span>` + btn(null, "الكل", P0.length) + keys.map(k => btn(k, k, counts.get(k))).join("") +
        (canManage() ? `<span class="sep" aria-hidden="true"></span><a href="#data" ${r === "data" ? 'aria-current="page"' : ""}>إدارة البيانات</a>` : "");
      $("#tabs").querySelectorAll(".ftab").forEach(b => b.addEventListener("click", () => {
        S.doneFund = b.dataset.fund || null;
        if (r.startsWith("c-") || r === "data") location.hash = cy ? "#done-" + cy : "#done"; else render();
      }));
      const curF = $("#tabs [aria-current=page]"); if (curF) curF.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const yr = r.startsWith("c-") && S.done ? (S.done.projects.find(p => cslug(p.id) === r) || {}).year : null;
    $("#tabs").innerHTML = items.map(([h, t], i) => h === "sep" ? '<span class="sep" aria-hidden="true"></span>' :
      (i === 1 && sec !== "done" ? '<span class="sep" aria-hidden="true"></span>' : "") +
      `<a href="#${h}" ${h === r || (yr && h === "done-" + yr) ? 'aria-current="page"' : ""}>${esc(t)}</a>`).join("");
    const cur = $("#tabs a[aria-current=page]"); if (cur) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function render() {
    destroyCharts();
    setTimeout(decorateKpis, 0);
    const W = curWeek();
    renderTabs(W);
    renderHeader(W);
    if (STATIC) { const b = $("#syncBadge"); b.className = "sync"; b.textContent = "نسخة منشورة" + (S.staticAt ? " · " + new Date(S.staticAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""); }
    showBanner();
    const r = route(), v = $("#view");
    if (isDoneRoute(r) || r === "done-map") {
      if (r === "done-map") return renderMapPage(v, doneLayerFilter(), "done");
      if (r.startsWith("c-")) { const p = S.done && S.done.projects.find(x => cslug(x.id) === r); if (p) return renderDoneProject(v, p); location.hash = "#done"; return; }
      return renderDone(v, r === "done" ? null : r.slice(5));
    }
    if (r === "home") return renderHome(v, W);
    if (r === "data") return renderData(v, W);
    if (HIDE_SEC && (r === "security" || r.startsWith("sec-"))) { location.hash = "#overview"; return; }
    if (r === "security") return renderSecurity(v);
    if (r.startsWith("sec-g")) { const g = window.SECURITY && window.SECURITY.groups[+r.slice(5) - 1]; if (g) return renderSecGroup(v, g); location.hash = "#security"; return; }
    if (!W) { v.innerHTML = `<div class="empty">لا توجد بيانات بعد. ارفع ملف Excel الأسبوعي من صفحة «إدارة البيانات».</div>`; return; }
    if (r === "overview") renderOverview(v, W);
    else if (r === "map") renderMapPage(v, curLayerFilter(W), "cur");
    else {
      const p = W.projects.find(x => slug(x.id) === r);
      if (p) renderProject(v, W, p); else { location.hash = "#overview"; return; }
    }
  }
  function curLayerFilter(W) { return new Set((W ? W.projects.map(p => p.id) : []).concat([GEN_LAYER])); }
  function doneLayerFilter() { return new Set((S.done ? S.done.projects.map(p => p.id) : []).concat([GEN_LAYER])); }
  function renderHeader(W) {
    const sec = section();
    $(".week-pick").style.display = sec === "cur" ? "" : "none";
    if (sec === "sec") {
      const X = window.SECURITY;
      $("#title").textContent = "مشاريع المنظومة الأمنية – حج 1448هـ";
      $("#subtitle").textContent = "مشاريع خدمة موسم الحج 1448هـ · بيانات " + fmtDual(X.reportDate);
      const b1 = $("#syncBadge"); b1.className = "sync warn"; b1.textContent = "بيانات مضمّنة (" + fmtDual(X.reportDate) + ")";
      $("#footSrc").textContent = "";
      return;
    }
    if (sec === "home") {
      $("#title").textContent = "مشاريع المياه والصرف الصحي لخدمة الحج – الإجمالي العام";
      $("#subtitle").textContent = "مشاريع تحت التنفيذ لحج 1448هـ والمشاريع المكتملة في المواسم السابقة";
      const bh = $("#syncBadge"); bh.className = "sync " + (S.source === "live" ? "live" : "warn"); bh.textContent = S.source === "live" ? "● متصل — يتحدّث تلقائياً" : "بيانات مضمّنة";
      $("#footSrc").textContent = "";
      return;
    }
    if (sec === "done") {
      $("#title").textContent = "المشاريع المكتملة";
      const D = S.done;
      $("#subtitle").textContent = D ? D.projects.length + " مشروعاً · مصنّفة حسب سنة الانتهاء الهجرية" : "لا توجد قائمة بعد";
      const b0 = $("#syncBadge");
      b0.className = "sync " + (S.doneSource === "live" ? "live" : "warn"); b0.textContent = S.doneSource === "live" ? "● متصل — يتحدّث تلقائياً" : "بيانات مضمّنة";
      $("#footSrc").textContent = D && D.sourceFile ? "المصدر: \u2068" + D.sourceFile + "\u2069" : "";
      return;
    }
    $("#title").textContent = "مشاريع المكاسب السريعة – حج 1448هـ";
    $("#subtitle").textContent = "مشاريع خدمة موسم الحج 1448هـ" + (W ? " · التقرير الأسبوعي بتاريخ " + fmtDual(W.info.reportDate) : "");
    const sel = $("#weekSel");
    sel.innerHTML = S.weeks.slice().reverse().map(w => `<option value="${esc(w.weekId)}" ${w.weekId === S.weekId ? "selected" : ""}>${fmtDual(w.weekId)}</option>`).join("");
    const b = $("#syncBadge");
    if (S.source === "live") { b.className = "sync live"; b.textContent = "● متصل — يتحدّث تلقائياً"; }
    else if (S.source === "snapshot") { b.className = "sync live"; b.textContent = "آخر تحديث: " + fmtDual(S.weekId); }
    else if (S.source === "loading") { b.className = "sync"; b.textContent = "جارٍ تحميل البيانات المحفوظة…"; }
    else { b.className = "sync warn"; b.textContent = "بيانات مضمّنة (07 نوفمبر 2026)"; }
    const wk = S.weeks.find(w => w.weekId === S.weekId);
    $("#footSrc").textContent = wk && wk.sourceFile ? "المصدر: \u2068" + wk.sourceFile + "\u2069" + (wk.uploadedAt ? " · رُفع " + new Date(wk.uploadedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "") : "";
  }

  // ---------- overview ----------
  // permit history shown under «موقف التصاريح» (kept in code so it survives weekly Excel re-uploads)
  const PERMIT_LOG = {};

  const FUND_MAK = "ميزانية شركة المياه الوطنية", FUND_SEC = "الميزانية العامة – الباب الرابع";
  // ---------- security-system projects (static data from security.js) ----------
  const SECV = g => g.contracts.reduce((a, c) => a + c.value, 0);
  const pctTxt = v => (Math.round(v * 100) / 100).toString() + "%";
  function secBar(p, color) { return `<div class="pbar">${bar(p / 100, "", color)}<span>${pctTxt(p)}</span></div>`; }
  function secColor(p) { return p >= 50 ? "#16a34a" : p >= 25 ? "#eda100" : "#e34948"; }
  function secOverview() {
    const X = window.SECURITY; if (!X) return "";
    const tot = X.groups.reduce((a, g) => a + SECV(g), 0);
    return `<h2 class="part-title" id="pSEC"><span class="pt-n">2</span>مشاريع المنظومة الأمنية <a class="hint" href="#security" style="font-size:13px;font-weight:500">التفاصيل ←</a></h2>
    <div class="grid g-2">${X.groups.map(g => `<a class="card" href="#security" style="text-decoration:none;color:inherit">
      <div class="small t2">${g.contracts.map(c => esc(c.name)).join(" + ")}</div>
      <h2 style="margin:4px 0 8px">${esc(g.contractor)}</h2>
      <div class="small" style="margin-bottom:8px">${badge(g.cls, "●", g.status)} · <span class="num">${g.sites}</span> موقع · <span class="num">${mil(SECV(g))}</span> مليون ريال</div>
      ${pbar(g.actual, g.cls === "critical" ? "#e34948" : "#2a78d6")}</a>`).join("")}</div>
    <div class="small muted" style="margin-top:6px">${X.groups.reduce((a, g) => a + g.contracts.length, 0)} عقود · <span class="num">${mil(tot)}</span> مليون ريال · ${X.totalSites} موقع · التمويل: ${FUND_SEC} · بيانات ${fmtDual(X.reportDate)} </div>`;
  }
  function renderSecGroup(v, g) {
    const X = window.SECURITY, i = X.groups.indexOf(g), c = g.cls === "critical" ? "#e34948" : "#2a78d6";
    v.innerHTML = `
    <div class="card"><div class="small t2" style="margin-bottom:4px"><a href="#security">مشاريع المنظومة الأمنية</a> · ${g.contracts.map(x => esc(x.name)).join(" + ")}</div>
      <h2 style="font-size:20px;margin:0 0 6px">${esc(g.contracts.map(x => x.name).join(" و"))}</h2>
      <div>${badge(g.cls, g.cls === "critical" ? "!" : "●", g.status)} <span class="small t2">· التمويل: ${FUND_SEC}</span></div></div>
    <div class="grid g-kpi" style="margin-top:16px">
      <div class="kpi"><div class="lbl">المقاول</div><div class="val" style="font-size:17px">${esc(g.contractor)}</div></div>
      <div class="kpi"><div class="lbl">القيمة</div><div class="val"><span class="num">${mil(SECV(g))}</span><small>مليون ريال</small></div><div class="foot2"><span class="num">${money(SECV(g))}</span> ريال</div></div>
      <div class="kpi"><div class="lbl">عدد المواقع</div><div class="val">${g.sites}<small>موقع</small></div></div>
      <div class="kpi"><div class="lbl">نسبة الإنجاز الفعلي</div><div class="val"><span class="num">${(g.actual * 100).toFixed(2)}%</span></div><div class="foot2">${bar(g.actual, "", c)}</div></div>
    </div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>العقود</h2><table class="tbl"><thead><tr><th>العقد</th><th>القيمة (ريال)</th></tr></thead><tbody>${g.contracts.map(x => `<tr><td>${esc(x.name)}</td><td class="n">${money(x.value)}</td></tr>`).join("")}<tr><td><b>الإجمالي</b></td><td class="n"><b>${money(SECV(g))}</b></td></tr></tbody></table></div>
      <div class="card"><h2>نطاق المشروع</h2><p style="line-height:1.9;margin:0">${esc(X.scope)}</p></div>
    </div>
    ${g.sitesNote ? `<div class="note">${esc(g.sitesNote)}</div>` : ""}`;
  }
  function renderSecurity(v) {
    const X = window.SECURITY;
    if (!X) { v.innerHTML = `<div class="empty">لا توجد بيانات للمنظومة الأمنية.</div>`; return; }
    const tot = X.groups.reduce((a, g) => a + SECV(g), 0), nC = X.groups.reduce((a, g) => a + g.contracts.length, 0);
    const listed = X.areas.flatMap(a => a.sites), avg = listed.reduce((a, s) => a + s[1], 0) / listed.length;
    v.innerHTML = `
    <div class="grid g-kpi">
      <div class="kpi"><div class="lbl">عدد المشاريع</div><div class="val">${nC}<small>عقود</small></div><div class="foot2">مقاولان</div></div>
      <div class="kpi"><div class="lbl">إجمالي القيمة</div><div class="val"><span class="num">${mil(tot)}</span><small>مليون ريال</small></div><div class="foot2"><span class="num">${money(tot)}</span> ريال</div></div>
      <div class="kpi"><div class="lbl">عدد المواقع</div><div class="val">${X.totalSites}<small>موقع</small></div><div class="foot2">${X.groups.map(g => g.sites).join(" + ")} موقع</div></div>
      <div class="kpi"><div class="lbl">مصدر التمويل</div><div class="val" style="font-size:18px">${FUND_SEC}</div></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>العقود والمقاولون</h2><div class="scroll-x"><table class="tbl">
      <thead><tr><th>#</th><th>اسم المشروع</th><th>المقاول</th><th>القيمة (ريال)</th><th>عدد المواقع</th><th>نسبة الإنجاز الفعلي</th><th>الحالة</th></tr></thead><tbody>
      ${(() => { let n = 0; return X.groups.map(g => g.contracts.map((c, i) => `<tr><td class="n muted">${++n}</td><td>${esc(c.name)}</td>${i === 0 ? `<td rowspan="${g.contracts.length}">${esc(g.contractor)}</td>` : ""}<td class="n">${money(c.value)}</td>${i === 0 ? `<td rowspan="${g.contracts.length}">${g.sites} موقع</td><td rowspan="${g.contracts.length}">${pbar(g.actual, g.cls === "critical" ? "#e34948" : "#2a78d6").replace(/>\d+%</, ">" + (g.actual * 100).toFixed(2) + "%<")}</td><td rowspan="${g.contracts.length}">${badge(g.cls, g.cls === "critical" ? "!" : "●", g.status)}</td>` : ""}</tr>`).join("")).join(""); })()}
      <tr><td></td><td><b>الإجمالي</b></td><td></td><td class="n"><b>${money(tot)}</b></td><td><b>${X.totalSites} موقع</b></td><td></td><td></td></tr>
      </tbody></table></div></div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>نطاق المشروع</h2><p style="line-height:1.9;margin:0">${esc(X.scope)}</p></div>
      <div class="card"><h2>خلفية</h2><div class="note" style="margin-top:0;line-height:1.9">${esc(X.note)}</div></div>
    </div>
    <div class="grid g-kpi" style="margin-top:16px"><div class="kpi"><div class="lbl">متوسط إنجاز مواقع المشاعر ومكة</div><div class="val"><span class="num">${pctTxt(avg)}</span></div><div class="foot2">متوسط بسيط لـ ${listed.length} موقعاً · ${fmtDual(X.reportDate)}</div></div></div>
    <h2 class="section-title">نسب إنجاز المواقع</h2>
    <div class="grid g-3">${X.areas.map(a => { const av = a.sites.reduce((s, x) => s + x[1], 0) / a.sites.length; return `<div class="card">
      <h2>${esc(a.name)} <span class="hint">${a.sites.length} مواقع · المتوسط ${pctTxt(av)}</span></h2>
      <div class="area-target ${a.cls}">${esc(a.target).replace(" · ", "<br>")}</div>
      <table class="tbl"><tbody>${a.sites.slice().sort((p, q) => q[1] - p[1]).map(x => `<tr><td>${esc(x[0])}</td><td style="width:45%">${secBar(x[1], secColor(x[1]))}</td></tr>`).join("")}</tbody></table></div>`; }).join("")}</div>
    <div class="legend" style="margin-top:8px"><span><i class="sw box" style="background:#16a34a"></i>50% فأكثر</span><span><i class="sw box" style="background:#eda100"></i>25% – 50%</span><span><i class="sw box" style="background:#e34948"></i>أقل من 25%</span></div>`;
  }

  // ---------- general landing page: totals across both branches ----------
  function renderHome(v, W) {
    const MP = W ? W.projects : [], X = window.SECURITY, D = S.done;
    const DP = D ? D.projects : [], DQ = D ? D.quantities : [];
    const makV = MP.reduce((a, p) => a + (p.value || 0), 0);
    const secN = X ? X.groups.reduce((a, g) => a + g.contracts.length, 0) : 0, secV = X ? X.groups.reduce((a, g) => a + SECV(g), 0) : 0;
    const doneV = DP.reduce((a, p) => a + (p.value || 0), 0);
    const ongN = MP.length + secN, ongV = makV + secV, allN = ongN + DP.length, allV = ongV + doneV;
    const t = doneTotals(DQ);
    const years = doneYears().filter(y => y).sort((a, b) => a - b);
    // funding breakdown across everything
    const fund = new Map(); const addF = (k, val) => { const f = fund.get(k) || { n: 0, v: 0 }; f.n++; f.v += val || 0; fund.set(k, f); };
    MP.forEach(p => addF(FUND_MAK, p.value));
    if (X) X.groups.forEach(g => g.contracts.forEach(c => addF(FUND_SEC, c.value)));
    DP.forEach(p => addF(fundOf(p) === NOFUND ? "غير محدد" : fundOf(p), p.value));
    const fundRows = [...fund].sort((a, b) => b[1].v - a[1].v);
    const kpi = (lbl, val, unit, foot) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}<small>${unit}</small></div><div class="foot2">${foot || ""}</div></div>`;
    const tile = (lbl, has, val, unit) => has ? `<div class="kpi"><div class="lbl">${lbl}</div><div class="val"><span class="num">${val}</span><small>${unit}</small></div></div>` : "";
    v.innerHTML = `
    <div class="grid g-kpi">
      ${kpi("إجمالي المشاريع", `<span class="num">${allN}</span>`, "مشروعاً", `${ongN} تحت التنفيذ · ${DP.length} مكتملاً`)}
      ${kpi("إجمالي القيمة", `<span class="num">${mil(allV)}</span>`, "مليون ريال", `<span class="num">${money(allV)}</span> ريال`)}
      ${kpi("تحت التنفيذ – حج 1448هـ", `<span class="num">${mil(ongV)}</span>`, "مليون ريال", `${ongN} مشروعاً · ${pct(allV ? ongV / allV : null, 0)} من الإجمالي`)}
      ${kpi("المشاريع المكتملة", `<span class="num">${mil(doneV)}</span>`, "مليون ريال", `${DP.length} مشروعاً${years.length ? ` · ${years[0]}–${years[years.length - 1]}هـ` : ""}`)}
    </div>
    <h2 class="section-title">الأثر التراكمي الحالي في المشاعر المقدسة فيما يخص التوسع بدورات المياه عن ما قبل عام 1445هـ</h2>
    ${cumKpis()}
    <div class="small muted" style="margin-top:6px">${esc(CUM_NOTE)}</div>
    ${seasonGoals()}
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2><a href="#overview">مشاريع تحت التنفيذ لخدمة حج 1448هـ</a> <span class="hint">${ongN} مشروعاً · ${mil(ongV)} مليون ريال</span></h2>
        <div class="scroll-x"><table class="tbl"><thead><tr><th>الفرع</th><th>العدد</th><th>القيمة (مليون ريال)</th><th>الإنجاز</th></tr></thead><tbody>
          <tr><td><a href="#overview"><b>المكاسب السريعة</b></a></td><td class="n">${MP.length}</td><td class="n">${mil(makV)}</td><td style="min-width:140px">${W ? pbar(weighted(MP, "actual"), "#2a78d6") : "—"}</td></tr>
          ${X ? `<tr><td><a href="#security"><b>المنظومة الأمنية</b></a><div class="small muted">${X.totalSites} موقع</div></td><td class="n">${secN}</td><td class="n">${mil(secV)}</td><td style="min-width:140px">${X.groups.map(g => `<div class="small t2" style="margin-bottom:2px">${esc(g.short)}</div>${pbar(g.actual, g.cls === "critical" ? "#e34948" : "#2a78d6")}`).join('<div style="height:6px"></div>')}</td></tr>` : ""}
        </tbody></table></div></div>
      <div class="card"><h2><a href="#done">المشاريع المكتملة</a> <span class="hint">${DP.length} مشروعاً · ${mil(doneV)} مليون ريال</span></h2>
        <div class="scroll-x"><table class="tbl"><thead><tr><th>موسم الحج</th><th>العدد</th><th>القيمة (مليون ريال)</th><th style="width:40%">النسبة من المكتملة</th></tr></thead><tbody>
          ${doneYears().slice().sort((a, b) => b - a).map(y => { const ps = DP.filter(p => (p.year || 0) === y), val = ps.reduce((a, p) => a + (p.value || 0), 0);
            return `<tr><td><a href="#done-${y}"><b>${y ? y + "هـ" : "غير محدد"}</b></a></td><td class="n">${ps.length}</td><td class="n">${mil(val)}</td><td>${pbar(doneV ? val / doneV : null, YEAR_COLORS[y] || "#2a78d6")}</td></tr>`; }).join("")}
        </tbody></table></div></div>
    </div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>قيمة المشاريع حسب موسم الحج <span class="hint">مليون ريال</span></h2><div class="chart-box tall"><canvas id="cHome"></canvas></div></div>
      <div class="card"><h2>عدد المشاريع حسب موسم الحج <span class="hint">مشروع</span></h2><div class="chart-box tall"><canvas id="cHomeN"></canvas></div></div>
    </div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>المشاريع حسب مصدر التمويل</h2><div class="scroll-x"><table class="tbl"><thead><tr><th>مصدر التمويل</th><th>العدد</th><th>القيمة (مليون ريال)</th><th style="width:38%">النسبة</th></tr></thead><tbody>
        ${fundRows.map(([k, f]) => `<tr><td>${esc(k)}</td><td class="n">${f.n}</td><td class="n">${mil(f.v)}</td><td>${pbar(allV ? f.v / allV : null, "#2a78d6")}</td></tr>`).join("")}
        <tr><td><b>الإجمالي</b></td><td class="n"><b>${allN}</b></td><td class="n"><b>${mil(allV)}</b></td><td></td></tr>
      </tbody></table></div></div>
    </div>
    <h2 class="section-title">منجزات المشاريع المكتملة</h2>
    <div class="grid g-kpi g-kpi7">
      ${tile("خطوط المياه", t.has.water, km(t.water), "كم")}${tile("خطوط الصرف الصحي", t.has.sewer, km(t.sewer), "كم")}
      ${tile("المحابس", t.has.valves, nf(t.valves), "محبس")}${tile("الشبكيات", t.has.networks, nf(t.networks), "شبكية")}
      ${tile("خزانات جديدة (إنشاء)", t.has.tanksNew, nf(t.tanksNew), "خزان")}${tile("خزانات مؤهلة (تأهيل)", t.has.tanksReh, nf(t.tanksReh), "خزان")}${tile("محطات الضخ", t.has.stations, nf(t.stations), "")}
      ${extraCounts(DQ).map(([c, n]) => tile(c, true, nf(n), "")).join("")}
    </div>`;
    const labels = years.map(y => y + "هـ").concat(["1448هـ"]);
    const stackTop = (fmt) => ({ id: "stackTop", afterDatasetsDraw(ch) { const ctx = ch.ctx; ctx.save(); ctx.font = "700 12px " + getComputedStyle(document.body).fontFamily; ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ch.data.labels.forEach((l, k) => { let sum = 0, top = Infinity, x = 0; ch.data.datasets.forEach((ds, di) => { const v = ds.data[k] || 0; if (!v) return; sum += v; const b = ch.getDatasetMeta(di).data[k]; if (b && b.y < top) { top = b.y; x = b.x; } }); if (sum) ctx.fillText(fmt(sum), x, top - 4); }); ctx.restore(); } });
    S.charts.push(new Chart($("#cHomeN"), { type: "bar", plugins: [stackTop(v => v)],
      data: { labels, datasets: [
        { label: "مكتملة", data: years.map(y => DP.filter(p => p.year === y).length).concat([0]), backgroundColor: years.map(y => YEAR_COLORS[y] || "#2a78d6").concat(["#2a78d6"]), borderRadius: 4, maxBarThickness: 46, stack: "s" },
        { label: "المكاسب السريعة (تحت التنفيذ)", data: years.map(() => 0).concat([MP.length]), backgroundColor: "#38bdf8", borderRadius: 4, maxBarThickness: 46, stack: "s" },
        ...(X ? [{ label: "المنظومة الأمنية (تحت التنفيذ)", data: years.map(() => 0).concat([secN]), backgroundColor: "#0e7fc4", borderRadius: 4, maxBarThickness: 46, stack: "s" }] : [])] },
      options: { maintainAspectRatio: false, layout: { padding: { top: 18 } }, onClick: (e, els) => { if (!els.length) return; const i = els[0].index; location.hash = i < years.length ? "#done-" + years[i] : (els[0].datasetIndex === 2 ? "#security" : "#overview"); },
        plugins: { legend: { display: false }, tooltip: { ...tooltipBase, filter: it => it.raw > 0, callbacks: { label: c => c.dataset.label + ": " + c.raw + " مشروعاً" } } },
        scales: { x: { reverse: true, stacked: true, grid: { display: false }, ticks: { color: "#e3ecf8" } }, y: { stacked: true, position: "right", beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(160,190,230,.14)" } } } } }));
    S.charts.push(new Chart($("#cHome"), { type: "bar", plugins: [stackTop(v => v.toFixed(2))],
      data: { labels, datasets: [
        { label: "مكتملة", data: years.map(y => +(DP.filter(p => p.year === y).reduce((a, p) => a + (p.value || 0), 0) / 1e6).toFixed(2)).concat([0]), backgroundColor: years.map(y => YEAR_COLORS[y] || "#2a78d6").concat(["#2a78d6"]), borderRadius: 4, maxBarThickness: 46, stack: "s" },
        { label: "المكاسب السريعة (تحت التنفيذ)", data: years.map(() => 0).concat([+(makV / 1e6).toFixed(2)]), backgroundColor: "#38bdf8", borderRadius: 4, maxBarThickness: 46, stack: "s" },
        ...(X ? [{ label: "المنظومة الأمنية (تحت التنفيذ)", data: years.map(() => 0).concat([+(secV / 1e6).toFixed(2)]), backgroundColor: "#0e7fc4", borderRadius: 4, maxBarThickness: 46, stack: "s" }] : [])] },
      options: { maintainAspectRatio: false, layout: { padding: { top: 18 } }, onClick: (e, els) => { if (!els.length) return; const i = els[0].index; location.hash = i < years.length ? "#done-" + years[i] : (els[0].datasetIndex === 2 ? "#security" : "#overview"); },
        plugins: { legend: { display: false }, tooltip: { ...tooltipBase, filter: it => it.raw > 0, callbacks: { label: c => c.dataset.label + ": " + c.raw.toFixed(2) + " مليون ريال" } } },
        scales: { x: { reverse: true, stacked: true, grid: { display: false }, ticks: { color: "#e3ecf8" } }, y: { stacked: true, position: "right", beginAtZero: true, grid: { color: "rgba(160,190,230,.14)" } } } } }));
  }
  function renderOverview(v, W) {
    const P = W.projects, prev = prevWeekOf(S.weekId);
    const total = P.reduce((s, p) => s + (p.value || 0), 0);
    const invT = P.some(p => p.invoiced != null) ? P.reduce((s, p) => s + (p.invoiced || 0), 0) : null;
    const wa = weighted(P, "actual"), wp = weighted(P, "planned");
    const counts = { good: 0, warning: 0, critical: 0, ontrack: 0 };
    P.forEach(p => { const f = perf(p); if (f.label === "منتظم") counts.ontrack++; else if (counts[f.cls] != null) counts[f.cls]++; });
    const prevWa = prev ? weighted(prev.projects, "actual") : null;

    v.innerHTML = `
    <div class="grid g-kpi">
      <div class="kpi"><div class="lbl">مشاريع المكاسب السريعة</div><div class="val">${P.length}<small>مشاريع</small></div><div class="foot2">${new Set(P.map(p => p.location)).size} مواقع (مشاعر ومكة)</div></div>
      <div class="kpi"><div class="lbl">إجمالي قيمة المكاسب السريعة</div><div class="val"><span class="num">${mil(total)}</span><small>مليون ريال</small></div><div class="foot2"><span class="num">${money(total)}</span> ريال</div></div>
      ${invT != null ? `<div class="kpi"><div class="lbl">إجمالي المستخلصات المرفوعة</div><div class="val"><span class="num">${mil(invT)}</span><small>مليون ريال</small></div><div class="foot2"><span class="num">${pct(total ? invT / total : null, 1)}</span> من قيمة المشاريع · شامل الضريبة</div></div>` : ""}
      <div class="kpi"><div class="lbl">الإنجاز الفعلي المتوسط</div><div class="val"><span class="num">${pct(wa)}</span></div><div class="foot2">المخطط <span class="num">${pct(wp)}</span> · الفرق <span class="num">${pts(wa != null && wp != null ? wa - wp : null)}</span> نقطة${prevWa != null ? ` · منذ الأسبوع السابق <span class="num">${pts(wa - prevWa)}</span>` : ""}</div></div>
      <div class="kpi"><div class="lbl">مؤشر الأداء الزمني</div><div class="val" style="font-size:20px">${counts.good} <small>متقدم</small></div><div class="foot2">${counts.ontrack} منتظم · ${counts.warning} متأخر · ${counts.critical} متعثر</div></div>
    </div>

    <h2 class="section-title">أثر مشاريع المكاسب السريعة</h2>
    <div class="grid g-4">${impactCols(W)}</div>

    <h2 class="section-title">مشاريع المكاسب السريعة لخدمة حج 1448هـ <span class="small muted" style="font-weight:400">التمويل: ${FUND_MAK}</span></h2>
    <div class="grid g-4">${P.map(p => projectCard(W, p, prev)).join("")}</div>

    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>المخطط مقابل الفعلي <span class="hint">نسبة الإنجاز لكل مشروع</span></h2>
        <div class="legend"><span><i class="sw box" style="background:var(--planned)"></i>المخطط</span><span><i class="sw box" style="background:var(--accent)"></i>الفعلي</span></div>
        <div class="chart-box"><canvas id="cPA" aria-label="مخطط الإنجاز المخطط مقابل الفعلي"></canvas></div></div>
      <div class="card"><h2>تطور الإنجاز الفعلي أسبوعياً <span class="hint">${S.weeks.length} أسبوع محفوظ</span></h2>
        ${S.weeks.length < 2 ? `<div class="legend">${P.map(p => `<span><i class="sw" style="background:${projColor(W, p.id)}"></i>${esc(shortName(p))}</span>`).join("")}</div><div class="chart-box"><canvas id="cTrend"></canvas></div><div class="small muted">يظهر الاتجاه بعد رفع تقرير الأسبوع القادم؛ النقطة الحالية من تقرير ${fmtDual(W.info.reportDate)}.</div>`
          : `<div class="legend">${P.map(p => `<span><i class="sw" style="background:${projColor(W, p.id)}"></i>${esc(shortName(p))}</span>`).join("")}</div><div class="chart-box"><canvas id="cTrend"></canvas></div>`}
      </div>
    </div>

    ${window.SPLAN ? `<div class="card" style="margin-top:16px"><h2>منحنى الإنجاز التراكمي الأسبوعي – إجمالي المشاريع الجارية</h2>
      <div class="legend"><span><i class="sw dash"></i>المخطط</span><span><i class="sw" style="background:#2a78d6"></i>الفعلي</span><span><i class="sw" style="background:#e3ecf8;width:2px;height:12px"></i>تاريخ التقرير</span></div>
      <div class="chart-box tall"><canvas id="cAgg"></canvas></div></div>` : ""}

    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h2>الخريطة الحية للمشاريع</h2><div class="map-pick" id="ovPick"></div>${mapBlock("ovMap", null)}</div>
      <div class="card"><h2>ملخص المشاريع</h2><div class="scroll-x">${summaryTable(W)}</div></div>
    </div>

    ${weekWorkCard(W)}`;

    // planned vs actual (horizontal bars, RTL)
    S.charts.push(new Chart($("#cPA"), {
      type: "bar",
      data: { labels: P.map(shortName), datasets: [
        { label: "المخطط", data: P.map(p => p.planned == null ? null : +(p.planned * 100).toFixed(2)), backgroundColor: "#94a3b8", borderRadius: 4, barPercentage: .8, categoryPercentage: .7 },
        { label: "الفعلي", data: P.map(p => p.actual == null ? null : +(p.actual * 100).toFixed(2)), backgroundColor: "#2a78d6", borderRadius: 4, barPercentage: .8, categoryPercentage: .7 },
      ] },
      options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { label: c => c.dataset.label + ": " + (c.raw == null ? "—" : c.raw.toFixed(2) + "%") } } },
        scales: { x: { reverse: true, beginAtZero: true, suggestedMax: 25, grid: { color: "rgba(160,190,230,.14)" }, ticks: { callback: v => v + "%" } }, y: { position: "right", grid: { display: false }, ticks: { color: "#e3ecf8" } } } },
    }));
    trendChart($("#cTrend"), W, P.map(p => p.id));
    aggCurve($("#cAgg"), W);
    initMap("ovMap", curLayerFilter(W), false).then(res => mapPicker($("#ovPick"), res, W));
  }

  // value-weighted cumulative S-curve of all ongoing projects, sampled every Saturday
  function aggCurve(canvas, W) {
    if (!canvas || !window.SPLAN) return;
    const day = t => t / 86400000, rep = parseISO(W.info.reportDate);
    const P = W.projects.filter(p => window.SPLAN[p.id] && p.value);
    if (!P.length) return;
    const planAt = (p, t) => { const SP = window.SPLAN[p.id]; if (t < parseISO(SP.start)) return 0; let v = 0; for (const [d, y] of SP.w) { if (parseISO(d) <= t) v = y; else break; } return v; };
    const sats = [...new Set(P.flatMap(p => window.SPLAN[p.id].w.map(r => parseISO(r[0]))))].sort((a, b) => a - b);
    const tv = P.reduce((a, p) => a + p.value, 0);
    const planned = sats.map(t => ({ x: day(t), y: +(P.reduce((a, p) => a + p.value * planAt(p, t), 0) / tv).toFixed(2) }));
    const am = new Map();
    S.weeks.filter(w => w.weekId <= S.weekId).forEach(w => {
      const t = satOf(w.weekId); if (t == null) return;
      let sv = 0, ok = true; for (const p of P) { const q = (w.data.projects || []).find(x => x.id === p.id); if (!q || q.actual == null) { ok = false; break; } sv += p.value * q.actual; }
      if (ok) am.set(day(t), +(sv / tv * 100).toFixed(2));
    });
    const actual = [...am.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
    const xs = planned.map(d => d.x), xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ticks = []; { const d0 = new Date(xmin * 86400000); let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1); while (day(t) <= xmax) { ticks.push(day(t)); const d = new Date(t); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); } }
    const repLine = { id: "repA", afterDatasetsDraw(ch) { if (rep == null) return; const x = ch.scales.x.getPixelForValue(day(rep)); const { top, bottom } = ch.chartArea; const g = ch.ctx; g.save(); g.strokeStyle = "rgba(230,240,255,.6)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore(); } };
    S.charts.push(new Chart(canvas, { type: "line",
      data: { datasets: [
        { label: "المخطط", data: planned, borderColor: "#94a3b8", backgroundColor: "#94a3b8", borderDash: [6, 4], borderWidth: 2, pointRadius: 2.5, tension: 0 },
        { label: "الفعلي", data: actual, borderColor: "#2a78d6", backgroundColor: "#2a78d6", borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, tension: 0 },
      ] },
      options: { maintainAspectRatio: false, parsing: false, interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { title: it => (new Date(it[0].raw.x * 86400000).getUTCDay() === 6 ? "السبت " : "") + fmtDual(new Date(it[0].raw.x * 86400000).toISOString().slice(0, 10)), label: c2 => c2.dataset.label + ": " + c2.raw.y.toFixed(2) + "%" } } },
        scales: { x: { type: "linear", reverse: true, min: xmin, max: xmax, afterBuildTicks: ax => { ax.ticks = ticks.filter(v => v >= xmin && v <= xmax).map(v => ({ value: v })); }, ticks: { callback: v => fmtMonth(v * 86400000) }, grid: { color: "rgba(160,190,230,.14)" } },
          y: { position: "right", min: 0, max: 100, ticks: { callback: v => v + "%" }, grid: { color: "rgba(160,190,230,.14)" } } } },
      plugins: [repLine] }));
  }

  function trendChart(canvas, W, pids, single) {
    if (!canvas) return;
    const weeks = S.weeks.filter(w => w.weekId <= S.weekId);
    const labels = weeks.map(w => fmtDate(w.weekId) + "م");
    const ds = pids.map(pid => {
      const p = W.projects.find(x => x.id === pid);
      return { label: shortName(p), data: weeks.map(w => { const q = (w.data.projects || []).find(x => x.id === pid); return q && q.actual != null ? +(q.actual * 100).toFixed(2) : null; }),
        borderColor: single ? "#2a78d6" : projColor(W, pid), backgroundColor: single ? "#2a78d6" : projColor(W, pid), borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true, tension: .25 };
    });
    S.charts.push(new Chart(canvas, { type: "line", data: { labels, datasets: ds },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { label: c => c.dataset.label + ": " + (c.raw == null ? "—" : c.raw.toFixed(2) + "%") } } },
        scales: { x: { reverse: true, grid: { display: false } }, y: { position: "right", beginAtZero: true, grid: { color: "rgba(160,190,230,.14)" }, ticks: { callback: v => v + "%" } } } } }));
  }

  function projectCard(W, p, prev) {
    const f = perf(p), el = elapsed(p, W.info.reportDate), c = projColor(W, p.id);
    const pp = prev && prev.projects.find(x => x.id === p.id);
    const d = pp && pp.actual != null && p.actual != null ? p.actual - pp.actual : null;
    return `<a class="pcard" href="#${slug(p.id)}" style="--pc:${c}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="loc"><i class="dot" style="background:${c}"></i>${esc(p.location || "")}</span>${badge(f.cls, f.icon, f.label)}</div>
      <h3>${esc(shortName(p))}</h3>
      <div class="meta"><span><span class="num">${money(p.value)}</span> ريال</span><span>${esc(p.contractor || "")}</span></div>
      <div class="bars">
        <div class="bar-row"><span class="bl">المخطط</span>${bar(p.planned, "planned")}<span class="bv">${pct(p.planned)}</span></div>
        <div class="bar-row"><span class="bl">الفعلي</span>${bar(p.actual, "", c)}<span class="bv">${pct(p.actual)}</span></div>
        <div class="bar-row"><span class="bl">المدة المنقضية</span>${bar(el, "elapsed")}<span class="bv">${pct(el, 1)}</span></div>
      </div>
      ${p.invoiced != null ? `<div class="small" style="margin-bottom:4px">المستخلصات المرفوعة: <span class="num">${money(p.invoiced)}</span> ريال${p.value ? ` <span class="muted">(<span class="num">${pct(p.invoiced / p.value, 1)}</span> من قيمة العقد)</span>` : ""}</div>` : ""}
      <div class="small muted">الفرق عن المخطط <span class="num">${pts(p.actual != null && p.planned != null ? p.actual - p.planned : null)}</span> نقطة${d != null ? ` · <span class="delta ${d >= 0 ? "up" : "down"}">${pts(d)}</span> منذ الأسبوع السابق` : ""}</div>
    </a>`;
  }
  function summaryTable(W) {
    return `<table class="tbl"><thead><tr><th>المشروع</th><th>المقاول</th><th>القيمة (ريال)</th><th>النهاية التعاقدية</th><th>المخطط</th><th>الفعلي</th><th>الأداء</th></tr></thead><tbody>
      ${W.projects.map(p => { const f = perf(p); return `<tr><td><a href="#${slug(p.id)}">${esc(shortName(p))}</a></td><td class="t2">${esc(p.contractor || "")}</td><td class="n">${money(p.value)}</td><td>${esc(p.endH || hijri(p.endG))}<div class="small muted">${p.endG ? fmtDate(p.endG) + "م" : ""}</div></td><td class="n">${pct(p.planned)}</td><td class="n"><b>${pct(p.actual)}</b></td><td>${badge(f.cls, f.icon, f.label)}</td></tr>`; }).join("")}
      <tr><td><b>الإجمالي</b></td><td></td><td class="n"><b>${money(W.projects.reduce((s, p) => s + (p.value || 0), 0))}</b></td><td></td><td class="n">${pct(weighted(W.projects, "planned"))}</td><td class="n"><b>${pct(weighted(W.projects, "actual"))}</b></td><td class="small muted">مرجّح بالقيمة</td></tr>
    </tbody></table>`;
  }
  // small line icons for impact bullets, picked by keywords in the text
  const IMP_ICONS = {
    toilet: '<path d="M7 3h4v6H7z"/><path d="M5 9h14a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z"/><path d="M9 14l-1 7h8l-1-7"/>',
    sewer: '<path d="M3 7h18"/><path d="M3 12h18"/><path d="M6 17c1.5 0 1.5 2 3 2s1.5-2 3-2 1.5 2 3 2 1.5-2 3-2"/>',
    tank: '<ellipse cx="12" cy="5" rx="7" ry="2.5"/><path d="M5 5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    pump: '<circle cx="12" cy="12" r="4"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
    valve: '<path d="M3 12h4l5-4v8l-5-4"/><path d="M21 12h-4l-5 4V8l5 4"/><path d="M12 8V4M9 4h6"/>',
    meter: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/><path d="M8 4h8"/>',
    power: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15 15.5c2.8-.5 6 1 6 4.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9"/>',
    pipe: '<path d="M3 9h7a4 4 0 0 1 4 4v8"/><path d="M3 5h7a8 8 0 0 1 8 8v8"/>',
    drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  };
  function impIcon(t) {
    const r = [[/دورات المياه|دورة|مجمع/, "toilet"], [/حققت|المستهدف/, "check"], [/صرف/, "sewer"], [/خزان/, "tank"], [/عداد|قياس/, "meter"],
      [/محابس|صمام|ضغط|تحكم/, "valve"], [/مضخ|ضخ/, "pump"], [/مولد|محول|كهرب/, "power"], [/موثوقية|طوارئ|مخاطر|اعتمادية|الإجهاد/, "shield"],
      [/حاج|مستفيد|مخيم|حجاج/, "people"], [/خط|شبك|وصلة|ربط|استبدال/, "pipe"], [/منطقة|مشعر|مكة|مزدلفة|عرفات|منى/, "pin"]];
    const k = (r.find(([re]) => re.test(t)) || [0, "drop"])[1];
    return `<svg class="imp-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IMP_ICONS[k]}</svg>`;
  }
  Object.assign(IMP_ICONS, {
    money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 9.5v5M17 9.5v5"/>',
    count: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    report: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  });
  function kpiIcon(t) {
    const r = [[/قيمة|تكلفة|ريال|التمويل|مستخلص|المستخلصات/, "money"], [/المقاول/, "people"], [/رقم العقد/, "count"], [/جهة الترسية/, "check"], [/بداية|الاستلام|النهاية|سنة الموسم/, "calendar"], [/مدة المشروع/, "clock"], [/إنجاز|الأداء|أداء/, "chart"], [/انتظار|مدة/, "clock"], [/بلاغ/, "report"], [/موسم|سنة|عام/, "calendar"],
      [/عدد المشاريع|إجمالي المشاريع|المشاريع|عقود|مشروع/, "count"], [/موقع|مواقع/, "pin"]];
    const hit = r.find(([re]) => re.test(t));
    return hit ? `<svg class="imp-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IMP_ICONS[hit[1]]}</svg>` : impIcon(t);
  }
  function headIcon(t) {
    const r = [[/خريطة/, "pin"], [/مخطط|منحنى|تطور|حسب|نسب/, "chart"], [/هدف|نطاق/, "check"], [/تمويل/, "money"], [/ملخص|تفاصيل|قائمة|جدول|العقود/, "count"],
      [/أثر|الأثر/, "shield"], [/منجزات|أعمال/, "pipe"], [/مشاريع/, "count"]];
    const hit = r.find(([re]) => re.test(t));
    return hit ? `<svg class="imp-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IMP_ICONS[hit[1]]}</svg>` : kpiIcon(t);
  }
  // add an icon to every KPI tile on the page (runs after each render)
  function decorateKpis() {
    // headings: card titles, section titles, impact column titles
    document.querySelectorAll("#view .card > h2, #view h2.section-title, #view h2.part-title, #view .imp-col > h3").forEach(h => {
      if (h.querySelector(".h-ic")) return;
      const t = (h.firstChild && h.firstChild.textContent) || h.textContent || "";
      const dot = h.querySelector(":scope > i.dot"); if (dot) dot.remove();
      const w = document.createElement("span"); w.className = "h-ic"; w.innerHTML = headIcon(h.textContent.replace(/\s+/g, " ")); h.prepend(w);
    });
    // project fact boxes
    document.querySelectorAll("#view .fact").forEach(f => {
      if (f.querySelector(".kpi-ic")) return;
      const l = f.querySelector(".k"); if (!l) return;
      const w = document.createElement("span"); w.className = "kpi-ic"; w.innerHTML = kpiIcon(l.textContent || ""); f.prepend(w);
    });
    // project objective bullets
    document.querySelectorAll("#view ul.objective").forEach(u => { if (u.classList.contains("imp-list")) return; u.classList.add("imp-list");
      u.querySelectorAll(":scope > li").forEach(li => { const t = li.textContent || ""; li.innerHTML = impIcon(t) + "<span>" + li.innerHTML + "</span>"; }); });
    document.querySelectorAll("#view .kpi").forEach(k => {
      if (k.querySelector(".kpi-ic")) return;
      const l = k.querySelector(".lbl"); if (!l) return;
      const w = document.createElement("span"); w.className = "kpi-ic"; w.innerHTML = kpiIcon(l.textContent || ""); k.prepend(w);
    });
  }
  const impLi = t => `<li>${impIcon(t)}<span>${esc(t)}</span></li>`;
  function impactCols(W) {
    const by = {};
    W.impact.forEach(r => { const a = r.area || "أخرى"; (by[a] = by[a] || []).push(r.text); });
    const areas = Object.keys(by);
    if (!areas.length) return `<div class="empty">لا توجد بيانات في ورقة «الأثر».</div>`;
    return areas.map(a => `<div class="card imp-col"><h3><i class="dot" style="background:var(--accent)"></i>${esc(a)}</h3><ul class="imp-list">${by[a].map(impLi).join("")}</ul></div>`).join("");
  }

  // ---------- project page ----------
  function renderProject(v, W, p) {
    const f = perf(p), el = elapsed(p, W.info.reportDate), c = projColor(W, p.id);
    const Q = W.quantities.filter(r => r.pid === p.id), SC = W.scopes.filter(r => r.pid === p.id), SU = W.supplies.filter(r => r.pid === p.id);
    const PE = W.permits.find(r => r.pid === p.id), PW = prevWeekOf(S.weekId);
    const scCount = {}; SC.forEach(s => { scCount[s.status || "—"] = (scCount[s.status || "—"] || 0) + 1; });
    const rep = parseISO(W.info.reportDate);
    const obj = String(p.objective || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
    const hasLayer = S.layers.some(l => l.pid === p.id);
    v.innerHTML = `
      <div class="card" style="border-top:3px solid ${c}">
        <div class="phead"><div><div class="small t2" style="margin-bottom:4px"><i class="dot" style="background:${c}"></i> ${esc(p.location || "")} · ${esc(p.id)}</div><h2>${esc(p.name)}</h2></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${badge("info", "●", p.status || "—")}${badge(f.cls, f.icon, f.label)}</div></div>
        <div class="facts">
          <div class="fact"><div class="k">المقاول</div><div class="v">${esc(p.contractor || "—")}</div></div>
          <div class="fact"><div class="k">قيمة العقد (ريال)</div><div class="v num">${money(p.value)}</div></div>
          ${p.invoiced != null ? `<div class="fact"><div class="k">المستخلصات المرفوعة (ريال)</div><div class="v num">${money(p.invoiced)}</div><div class="v2">${p.value ? pct(p.invoiced / p.value, 1) + " من قيمة العقد · " : ""}شامل الضريبة</div></div>` : ""}
          <div class="fact"><div class="k">بداية المشروع</div><div class="v">${esc(p.startH || hijri(p.startG) || "—")}</div><div class="v2">${p.startG ? fmtDate(p.startG) + "م" : ""}</div></div>
          <div class="fact"><div class="k">النهاية التعاقدية</div><div class="v">${esc(p.endH || hijri(p.endG) || "—")}</div><div class="v2">${p.endG ? fmtDate(p.endG) + "م" : ""}</div></div>
          <div class="fact"><div class="k">مدة المشروع</div><div class="v">${p.duration ?? "—"} أشهر ميلادية</div></div>
          <div class="fact"><div class="k">مصدر التمويل</div><div class="v">${FUND_MAK}</div></div>
        </div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>موقف الإنجاز <span class="hint">حتى ${fmtDual(W.info.reportDate)}</span></h2>
          <div class="rings">${ring(p.planned, "#94a3b8", "الإنجاز المخطط")}${ring(p.actual, c, "الإنجاز الفعلي", `الفرق <span class="num">${pts(p.actual != null && p.planned != null ? p.actual - p.planned : null)}</span> نقطة`)}${ring(el, "#7b8aa0", "المدة المنقضية")}</div>
          ${obj.length ? `<h3 style="font-size:14px;margin:12px 0 8px">هدف المشروع</h3><ul class="objective">${obj.map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="card"><h2>منحنى الإنجاز التراكمي (S-Curve) <span class="hint">${window.SPLAN && window.SPLAN[p.id] ? "أسبوعي — كل يوم سبت" : ""}</span></h2>
          <div class="legend"><span><i class="sw dash"></i>المخطط</span><span><i class="sw" style="background:${c}"></i>الفعلي</span><span><i class="sw" style="background:#e3ecf8;width:2px;height:12px"></i>تاريخ التقرير</span></div>
          <div class="chart-box tall"><canvas id="cS"></canvas></div></div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>كميات المشروع${PW ? ` <span class="hint">خلال الأسبوع: مقارنة بتقرير ${fmtDual(PW.info.reportDate || prevWeekId())}</span>` : ""}</h2><div class="scroll-x">${Q.length ? `<table class="tbl"><thead><tr><th>البند</th><th>الوحدة</th><th>التعاقدية</th><th>المنفذة</th><th>منفذ خلال الأسبوع</th><th>نسبة المنفذ</th></tr></thead><tbody>
          ${Q.map(q => { const r = q.contract ? (q.done ?? 0) / q.contract : null, d = weekDelta(q, PW); return `<tr><td>${esc(q.item)}${q.note ? `<div class="small muted">${esc(q.note)}</div>` : ""}</td><td>${esc(q.unit || "")}</td><td class="n">${nf(q.contract)}</td><td class="n">${q.done == null ? "—" : nf(q.done)}</td><td class="n">${deltaTxt(d)}</td><td>${pbar(q.done == null ? null : r, c)}</td></tr>`; }).join("")}
          </tbody></table>` : `<div class="empty">لا توجد كميات مسجلة.</div>`}</div></div>
        <div class="card"><h2>نطاقات المشروع <span class="hint">${SC.length} نطاق</span></h2>
          <div class="chips">${Object.entries(scCount).map(([k, n]) => badge(scopeCls(k), n, k)).join("")}</div>
          <div class="scroll-x"><table class="tbl"><tbody>${SC.map(s => `<tr><td class="muted n" style="width:28px">${s.n ?? ""}</td><td>${esc(s.scope)}${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ""}</td><td style="width:1%">${badge(scopeCls(s.status), "●", s.status || "—")}</td></tr>`).join("")}</tbody></table></div></div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>موقف التوريدات</h2><div class="scroll-x">${SU.length ? `<table class="tbl"><thead><tr><th>البند</th><th>التاريخ المخطط</th><th>الإجمالي</th><th>المورّد</th><th>النسبة</th></tr></thead><tbody>
          ${SU.map(s => { const r = s.total ? (s.supplied ?? 0) / s.total : null; const isD = /^\d{4}-\d{2}-\d{2}$/.test(s.plannedDate || ""); const late = isD && parseISO(s.plannedDate) < rep && r != null && r < 1;
            const st = r != null && r >= 1 ? badge("good", "✓", "مكتمل") : late ? badge("critical", "!", "تجاوز الموعد") : (s.note ? `<span class="small t2">${esc(s.note)}</span>` : "");
            return `<tr><td>${esc(s.item)}<div>${st}</div></td><td>${isD ? fmtDual(s.plannedDate) : esc(s.plannedDate || "—")}</td><td class="n">${nf(s.total)}</td><td class="n">${s.supplied == null ? "—" : nf(s.supplied)}</td><td>${pbar(s.supplied == null ? null : r, c)}</td></tr>`; }).join("")}
          </tbody></table>` : `<div class="empty">لا توجد توريدات مسجلة.</div>`}</div></div>
        <div class="card"><h2>موقف التصاريح</h2>${PE ? `<div class="permit-tiles">
            <div class="fact"><div class="k">تصاريح صادرة</div><div class="v">${PE.issued ?? "—"}</div><div class="v2">${PE.issuedDesc ? esc(PE.issuedDesc) : PE.issuedLen != null ? "بطول " + nf(PE.issuedLen) + " م.ط" : ""}</div></div>
            <div class="fact"><div class="k">تحت الإجراء</div><div class="v">${PE.pending ?? "—"}</div><div class="v2">${PE.pendingLen != null ? "بطول " + nf(PE.pendingLen) + " م.ط" : esc(PE.pendingDesc || "")}</div></div></div>
            ${PE.note ? `<div class="note">${esc(PE.note)}</div>` : ""}` : (PERMIT_LOG[p.id] ? "" : `<div class="empty">لا توجد بيانات تصاريح.</div>`)}
            ${PERMIT_LOG[p.id] ? `<h3 class="plog-h">تسلسل إجراءات التصريح</h3><ol class="plog">${PERMIT_LOG[p.id].map((t, i, a) => `<li class="${i === a.length - 1 ? "now" : i === a.length - 2 ? "ok" : ""}">${esc(t)}</li>`).join("")}</ol>` : ""}
</div>
      </div>
      <div class="card" style="margin-top:16px"><h2>خريطة المشروع ${hasLayer ? '<span class="hint">طبقات KMZ حية</span>' : '<span class="hint">صورة من التقرير — ارفع ملف KMZ ليصبح الموقع تفاعلياً</span>'}</h2>
        ${hasLayer ? mapBlock("pMap", p.id) : `<div class="static-map"><img src="img/${esc(p.id)}.jpg" alt="خريطة موقع ${esc(shortName(p))} من التقرير" onerror="this.parentNode.innerHTML='<div class=&quot;empty&quot;>لا توجد خريطة لهذا المشروع بعد — ارفع ملف KMZ من صفحة إدارة البيانات.</div>'"></div>`}
      </div>`;

    // S-curve on a day axis
    const day = t => t / 86400000;
    // S-curve values are cumulative at the END of each month: a date given as the 1st of a month is placed on that month's last day.
    const eom = t => { const d = new Date(t); return d.getUTCDate() === 1 ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) : t; };
    const SP = window.SPLAN && window.SPLAN[p.id];
    let planned, actual;
    if (SP) {
      // weekly plan (every Saturday) from the planning file; actual from the weekly reports, placed on their Saturday
      const st = parseISO(SP.start);
      planned = [{ x: day(st), y: 0 }].concat(SP.w.map(([d, v]) => ({ x: day(parseISO(d)), y: v })));
      const am = new Map(); if (st != null && st <= rep) am.set(day(st), 0);
      S.weeks.filter(w => w.weekId <= S.weekId).forEach(w => { const q = (w.data.projects || []).find(x => x.id === p.id); const t = satOf(w.weekId); if (q && q.actual != null && t != null) am.set(day(t), +(q.actual * 100).toFixed(2)); });
      actual = [...am.entries()].sort((x1, x2) => x1[0] - x2[0]).map(([x, y]) => ({ x, y }));
    } else {
      const sc = W.scurve.filter(r => r.pid === p.id && parseISO(r.month) != null).map(r => ({ ...r, t: eom(parseISO(r.month)) })).sort((a, b) => a.t - b.t);
      const start = parseISO(p.startG);
      const plannedMap = new Map();
      if (start != null) plannedMap.set(day(start), 0);
      sc.filter(r => r.planned != null).forEach(r => plannedMap.set(day(r.t), +(r.planned * 100).toFixed(2)));
      if (p.planned != null && rep != null) plannedMap.set(day(rep), +(p.planned * 100).toFixed(2)); // official planned value at the report date
      const planned0 = [...plannedMap.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
      const actualMap = new Map();
      if (start != null && start <= rep) actualMap.set(day(start), 0);
      sc.filter(r => r.actual != null && r.t <= rep).forEach(r => actualMap.set(day(r.t), +(r.actual * 100).toFixed(2)));
      S.weeks.filter(w => w.weekId <= S.weekId).forEach(w => { const q = w.data.projects.find(x => x.id === p.id); if (q && q.actual != null && parseISO(w.weekId) != null) actualMap.set(day(parseISO(w.weekId)), +(q.actual * 100).toFixed(2)); });
      const actual0 = [...actualMap.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
      planned = planned0; actual = actual0;
    }
    const xs = planned.map(d => d.x).concat(actual.map(d => d.x));
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ticks = []; if (isFinite(xmin)) { const d0 = new Date(xmin * 86400000); let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1); while (day(t) <= xmax) { ticks.push(day(t)); const d = new Date(t); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); } }
    const repLine = { id: "rep", afterDatasetsDraw(ch) { const x = ch.scales.x.getPixelForValue(day(rep)); const { top, bottom } = ch.chartArea; const g = ch.ctx; g.save(); g.strokeStyle = "rgba(230,240,255,.6)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore(); } };
    if (planned.length || actual.length) S.charts.push(new Chart($("#cS"), { type: "line",
      data: { datasets: [
        { label: "المخطط", data: planned, borderColor: "#94a3b8", backgroundColor: "#94a3b8", borderDash: [6, 4], borderWidth: 2, pointRadius: 3, tension: 0 },
        { label: "الفعلي", data: actual, borderColor: c, backgroundColor: c, borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, tension: 0 },
      ] },
      options: { maintainAspectRatio: false, parsing: false, interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { title: it => (new Date(it[0].raw.x * 86400000).getUTCDay() === 6 ? "السبت " : "") + fmtDual(new Date(it[0].raw.x * 86400000).toISOString().slice(0, 10)), label: c2 => c2.dataset.label + ": " + c2.raw.y.toFixed(2) + "%" } } },
        scales: { x: { type: "linear", reverse: true, min: xmin, max: xmax, afterBuildTicks: ax => { ax.ticks = ticks.filter(v => v >= xmin && v <= xmax).map(v => ({ value: v })); }, ticks: { callback: v => fmtMonth(v * 86400000) }, grid: { color: "rgba(160,190,230,.14)" } },
          y: { position: "right", min: 0, max: 100, ticks: { callback: v => v + "%" }, grid: { color: "rgba(160,190,230,.14)" } } } },
      plugins: [repLine] }));
    if (hasLayer) initMap("pMap", p.id, false);
  }

  // ---------- maps ----------
  function mapBlock(id, filter, tall) {
    return `<div class="map-wrap"><div id="${id}" class="map${tall ? " tall" : ""}" dir="ltr" role="region" aria-label="خريطة"></div><div class="map-empty" id="${id}-empty" hidden></div></div>`;
  }
  function layersFor(filter) {
    if (filter == null) return S.layers;
    if (filter instanceof Set) return S.layers.filter(l => filter.has(l.pid));
    return S.layers.filter(l => l.pid === filter);
  }
  async function loadGeo(layer) {
    if (S.geo[layer.id] && S.geo[layer.id].v === layer.updatedAt) return S.geo[layer.id].g;
    let g = null;
    if (layer.geo) { try { g = JSON.parse(layer.geo); } catch (e) { g = null; } }
    else if (layer.geoAsset) {
      try { const r = await fetch(blobURL(layer.geoAsset)); if (r.ok) g = await r.json(); } catch (e) { g = null; }
    }
    S.geo[layer.id] = { v: layer.updatedAt, g };
    return g;
  }
  // CAD exports: drop near-white tick marks (pipe-joint/chainage symbols) that look like gaps on the map,
  // and join the many 2-point segments of a polyline into continuous lines.
  const geoClean = new WeakMap();
  function nearWhite(c) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c || "")); return !!m && [1, 2, 3].every(i => parseInt(m[i], 16) >= 0xe6); }
  function joinLines(lines) {
    const k = p => p[0].toFixed(7) + "," + p[1].toFixed(7);
    const segs = lines.filter(l => l && l.length >= 2).map(l => l.slice()); const out = [];
    while (segs.length) {
      let cur = segs.shift(), grown = true;
      while (grown) {
        grown = false;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i], a = k(cur[0]), b = k(cur[cur.length - 1]), s0 = k(s[0]), s1 = k(s[s.length - 1]);
          if (b === s0) cur = cur.concat(s.slice(1)); else if (b === s1) cur = cur.concat(s.slice(0, -1).reverse());
          else if (a === s1) cur = s.slice(0, -1).concat(cur); else if (a === s0) cur = s.slice(1).reverse().concat(cur);
          else continue;
          segs.splice(i, 1); grown = true; break;
        }
      }
      out.push(cur);
    }
    return out;
  }
  function segLen(l) { let m = 0; for (let i = 1; i < l.length; i++) { const dy = (l[i][1] - l[i - 1][1]) * 111320, dx = (l[i][0] - l[i - 1][0]) * 111320 * Math.cos(l[i][1] * Math.PI / 180); m += Math.hypot(dx, dy); } return m; }
  function cleanGeo(g) {
    if (!g || !g.features) return g;
    if (geoClean.has(g)) return geoClean.get(g);
    const feats = [];
    for (const f of g.features) {
      const p = f.properties || {}, geom = f.geometry; if (!geom) continue;
      if (nearWhite(p.stroke) && !(p["fill-opacity"] > 0 && !nearWhite(p.fill))) continue; // white CAD symbols: invisible/gap-like on the map
      let ng = geom;
      const parts = geom.type === "GeometryCollection" ? geom.geometries || [] : null;
      if (parts && parts.length && parts.every(x => x && (x.type === "LineString" || x.type === "MultiLineString"))) {
        const lines = []; parts.forEach(x => x.type === "LineString" ? lines.push(x.coordinates) : x.coordinates.forEach(c => lines.push(c)));
        const j = joinLines(lines);
        if (j.length >= 3 && j.every(l => segLen(l) < 6)) continue; // a set of tiny separate ticks (joint/chainage marks), not a pipe
        ng = j.length === 1 ? { type: "LineString", coordinates: j[0] } : { type: "MultiLineString", coordinates: j };
      } else if (geom.type === "MultiLineString") {
        const j = joinLines(geom.coordinates);
        ng = j.length === 1 ? { type: "LineString", coordinates: j[0] } : { type: "MultiLineString", coordinates: j };
      }
      feats.push(ng === geom ? f : Object.assign({}, f, { geometry: ng }));
    }
    const out = Object.assign({}, g, { features: feats });
    geoClean.set(g, out);
    return out;
  }
  // progress-report layers (CAD colours): blue = completed, green = under execution, red = not started
  const ST = { done: { c: "#1d4ed8", t: "مكتمل" }, wip: { c: "#16a34a", t: "تحت التنفيذ" }, todo: { c: "#dc2626", t: "لم يبدأ" } };
  const VALVE = "#0f766e";
  const isProgLayer = l => !l.kind && (/progres|موقف\s*الأعمال|موقف الاعمال/i.test((l.name || "") + " " + (l.fileName || "")) || (l.fileColors && /^QW-/.test(l.pid || "")));
  // manual status overrides per layer id (Makkah royal-palaces supply line → under execution)
  const LAYER_ST = { "Lmwg953n4": "wip" };
  // per-feature overrides (Mina: line near Al-Khaif, camps 11-38 / 2-108 → completed)
  const FEAT_ST = { "Lmwga298i": { "Polyline [8FAB]:0": "done", "Polyline [8FAA]:0": "done", "Polyline [8FA9]:0": "done" } };
  function statusOf(props, layer) {
    if (layer && LAYER_ST[layer.id]) return LAYER_ST[layer.id];
    const fo = layer && FEAT_ST[layer.id]; if (fo && fo[props.name]) return fo[props.name];
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(props.stroke || props["icon-color"] || ""));
    if (!m) return null; const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16));
    if (b >= 180 && r <= 90 && g <= 170) return "done";
    if (g >= 180 && r <= 140 && b <= 90) return "wip";
    if (r >= 180 && g <= 90 && b <= 90) return "todo";
    return null;
  }
  function featureStyle(layer, props) {
    if (isProgLayer(layer)) { const st = statusOf(props, layer); return st ? { color: ST[st].c, weight: 3, opacity: 1, lineCap: "round", lineJoin: "round", fillColor: ST[st].c, fillOpacity: .25 } : { color: "#64748b", weight: 1.5, opacity: .7, fillOpacity: .1 }; }
    if (layer.kind) { const c = featKind(layer, props) === "sewer" ? SEWER : WATER; return { color: c, weight: 2.5, opacity: .95, fillColor: c, fillOpacity: .2 }; }
    const col = layer.fileColors && props.stroke ? props.stroke : layer.color || "#2a78d6";
    return { color: col, weight: Math.max(2, Math.min(4, props["stroke-width"] || 2.5)), opacity: .95, fillColor: layer.fileColors && props.fill ? props.fill : col, fillOpacity: .22 };
  }
  function popupHtml(layer, props, geom) {
    const skip = new Set(["name", "description", "_len", "_i", "_k", "_src", "label-color", "stroke", "stroke-width", "stroke-opacity", "fill", "fill-opacity", "visibility", "styleUrl"]);
    const rows = Object.entries(props).filter(([k, v]) => !skip.has(k) && v !== "" && v != null).slice(0, 14);
    let ll = null;
    try { const b = L.geoJSON(geom).getBounds(); const cc = b.getCenter(); ll = cc.lat.toFixed(6) + "," + cc.lng.toFixed(6); } catch (e) { }
    return `<b>${esc(props.name || "عنصر")}</b><div class="small muted">${esc(layer.name)}${layer.kind ? " · " + (featKind(layer, props) === "sewer" ? "صرف صحي" : "مياه") : ""}</div>
      ${props.description ? `<div style="margin-top:6px">${esc(stripHtml(props.description)).slice(0, 600)}</div>` : ""}
      ${isProgLayer(layer) && geom && geom.type !== "Point" && statusOf(props, layer) ? `<div style="margin-top:6px">الحالة: <b style="color:${ST[statusOf(props, layer)].c}">${ST[statusOf(props, layer)].t}</b></div>` : ""}
      ${props._len ? `<div style="margin-top:6px">الطول: <b>${fmtLen(props._len)}</b></div>` : ""}
      ${rows.length ? `<table>${rows.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(stripHtml(v))}</td></tr>`).join("")}</table>` : ""}
      ${ll ? `<div style="margin-top:8px"><a href="https://www.google.com/maps?q=${ll}" target="_blank" rel="noopener">فتح الموقع في خرائط Google ↗</a><div class="small muted num">${ll}</div></div>` : ""}`;
  }
  const valveIcon = L.divIcon({ className: "valve-pin", html: '<span></span>', iconSize: [9, 9], iconAnchor: [4.5, 4.5], popupAnchor: [0, -5] });
  const ptR = z => z <= 13 ? 1.2 : z <= 14 ? 1.5 : z <= 15 ? 1.8 : z <= 16 ? 2.2 : 3;
  async function initMap(id, filter, withSide, opts = {}) {
    const el = document.getElementById(id); if (!el) return null;
    const layers = layersFor(filter);
    const empty = document.getElementById(id + "-empty");
    const map = L.map(el, { zoomControl: true, attributionControl: false, preferCanvas: false, zoomSnap: .5 });
    S.maps.push(map);
    L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
    map.setView([21.40, 39.90], 12);
    if (window.OSMBase) { try { OSMBase.attach(map); } catch (e) { } }
    if (!layers.length) {
      empty.hidden = false;
      empty.innerHTML = `<b>لا توجد طبقات KMZ ${filter && !(filter instanceof Set) ? "لهذا المشروع" : "لهذا القسم"} بعد</b><span class="small">ارفع ملفات KMZ/KML من صفحة <a href="#data">إدارة البيانات</a> وستظهر هنا مباشرة لكل من يفتح الرابط.</span>`;
      return { map, groups: {} };
    }
    const groups = {}; let bounds = null;
    for (const layer of layers) {
      const grp = L.featureGroup();
      (layer.overlays || []).forEach(o => { if (o.assetId && o.bounds) { L.imageOverlay(blobURL(o.assetId), o.bounds, { opacity: .9 }).addTo(grp); } });
      const g = cleanGeo(await loadGeo(layer));
      if (g && g.features) {
        L.geoJSON(g, {
          filter: f => !(isProgLayer(layer) && f.geometry && f.geometry.type !== "Point" && !statusOf(f.properties || {}, layer) && ((f.properties || {})._len || 0) < 30),
          style: f => featureStyle(layer, f.properties || {}),
          pointToLayer: (f, ll) => isProgLayer(layer) ? L.marker(ll, { icon: valveIcon, title: "محبس" }) : L.circleMarker(ll, { radius: ptR(map.getZoom()), weight: 0.5, color: "#ffffff", fillColor: layer.kind ? (featKind(layer, f.properties) === "sewer" ? SEWER : WATER) : layer.fileColors && f.properties["marker-color"] ? f.properties["marker-color"] : (layer.color || "#2a78d6"), fillOpacity: 1 }),
          onEachFeature: (f, l) => {
            l.bindPopup(() => popupHtml(layer, f.properties || {}, f.geometry), { maxWidth: 320 });
            if (f.properties && f.properties.name && opts.labels) l.bindTooltip(esc(f.properties.name), { permanent: true, direction: "center", className: "lbl" });
            l._fid = layer.id + ":" + (f.properties ? f.properties._i : "");
          },
        }).addTo(grp);
      }
      grp.addTo(map); groups[layer.id] = grp;
      try { const b = grp.getBounds(); if (b.isValid()) bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); } catch (e) { }
    }
    // overview maps (several projects) open on the holy sites only; far features (Makkah city) stay on the map but don't drive the zoom
    if (bounds && bounds.isValid() && typeof filter !== "string") {
      const M = L.latLngBounds([21.30, 39.86], [21.45, 40.02]);
      if (M.intersects(bounds)) bounds = L.latLngBounds([Math.max(bounds.getSouth(), M.getSouth()), Math.max(bounds.getWest(), M.getWest())], [Math.min(bounds.getNorth(), M.getNorth()), Math.min(bounds.getEast(), M.getEast())]);
    }
    if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
    // point markers (manholes, valves…) stay small and grow slightly when zoomed in
    const sizePts = () => { const r = ptR(map.getZoom()); Object.values(groups).forEach(g => g.eachLayer(sub => sub.eachLayer && sub.eachLayer(l => { if (l instanceof L.CircleMarker) l.setRadius(r); }))); };
    map.on("zoomend", sizePts); sizePts();
    if (layers.some(isProgLayer)) {
      const lg = L.control({ position: "topright" });
      lg.onAdd = () => { const d = L.DomUtil.create("div", "map-legend prog"); d.innerHTML = `<b>موقف الأعمال</b>${Object.values(ST).map(x => `<span><i style="background:${x.c}"></i>${x.t}</span>`).join("")}${layers.some(l => isProgLayer(l) && l.pid === "QW-MINA") ? '<span><i class="vpin"></i>محبس</span>' : ""}`; return d; };
      lg.addTo(map);
    }
    if (layers.some(l => l.kind)) {
      const lg = L.control({ position: "topright" });
      lg.onAdd = () => { const d = L.DomUtil.create("div", "map-legend"); d.innerHTML = `<span><i style="background:${WATER}"></i>مياه</span><span><i style="background:${SEWER}"></i>صرف صحي</span>`; return d; };
      lg.addTo(map);
    }
    // Firefox lays the page out later than Chrome: keep the map in step with its box size,
    // otherwise only part of the map (and the basemap canvas) is drawn
    let fitB = bounds, touched = false, lastW = el.clientWidth, lastH = el.clientHeight;
    ["mousedown", "wheel", "touchstart", "keydown"].forEach(ev => el.addEventListener(ev, () => { touched = true; }, { passive: true }));
    const resync = () => {
      if (!map._container) return;
      const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      const grew = w !== lastW || h !== lastH; lastW = w; lastH = h;
      map.invalidateSize({ pan: false });
      if (grew && !touched && fitB && fitB.isValid()) map.fitBounds(fitB, { padding: [24, 24], maxZoom: 17, animate: false });
    };
    [50, 250, 700, 1500].forEach(t => setTimeout(resync, t));
    if (window.ResizeObserver) { try { const ro = new ResizeObserver(() => resync()); ro.observe(el); map.on("unload", () => ro.disconnect()); } catch (e) { } }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resync).catch(() => { });
    return { map, groups };
  }

  // project checkboxes above a map: show/hide each project's layers
  function mapPicker(box, res, W) {
    if (!box || !res || !res.map) return;
    const lays = layersFor(curLayerFilter(W)).filter(l => res.groups[l.id]);
    const pids = W.projects.map(p => p.id).filter(id => lays.some(l => l.pid === id));
    if (lays.some(l => l.pid === GEN_LAYER)) pids.push(GEN_LAYER);
    if (pids.length < 2) { box.remove(); return; }
    const name = id => id === GEN_LAYER ? "عام" : shortName(W.projects.find(p => p.id === id));
    box.innerHTML = `<label class="mp-all"><input type="checkbox" data-all checked>الكل</label>` +
      pids.map(id => `<label style="--pc:${id === GEN_LAYER ? "#64748b" : projColor(W, id)}"><input type="checkbox" value="${esc(id)}" checked><i></i>${esc(name(id))}</label>`).join("");
    const boxes = [...box.querySelectorAll("input[value]")], all = box.querySelector("[data-all]");
    const apply = fit => {
      const on = new Set(boxes.filter(b => b.checked).map(b => b.value)); let bounds = null;
      lays.forEach(l => { const g = res.groups[l.id]; if (on.has(l.pid)) { if (!res.map.hasLayer(g)) g.addTo(res.map); try { const b = g.getBounds(); if (b.isValid()) bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); } catch (e) { } } else if (res.map.hasLayer(g)) res.map.removeLayer(g); });
      all.checked = on.size === boxes.length; all.indeterminate = on.size > 0 && on.size < boxes.length;
      if (fit && bounds && bounds.isValid()) res.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
    };
    boxes.forEach(b => b.addEventListener("change", () => apply(true)));
    all.addEventListener("change", () => { boxes.forEach(b => b.checked = all.checked); apply(true); });
  }

  function layerOwnerName(pid) {
    const W = curWeek();
    const a = W && W.projects.find(p => p.id === pid); if (a) return shortName(a);
    const b = S.done && S.done.projects.find(p => p.id === pid); if (b) return doneShort(b) + (b.year ? " · " + b.year + "هـ" : "");
    return pid === GEN_LAYER ? "عام" : pid;
  }
  async function renderMapPage(v, filter, sec) {
    const opts = { labels: !!S.mapLabels };
    const shown = layersFor(filter);
    v.innerHTML = `<div class="map-layout">
      <div class="card" style="padding:10px">${mapBlock("bigMap", null, true)}</div>
      <div class="map-side">
        <div class="card"><h2>الطبقات <label class="check small t2" style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="lblT" ${opts.labels ? "checked" : ""}> إظهار الأسماء</label></h2>
          <div id="layerList" style="display:flex;flex-direction:column;gap:6px">${shown.length ? "" : '<div class="small muted">لا توجد طبقات بعد.</div>'}</div></div>
        <div class="card"><h2>العناصر <span class="hint" id="featCount"></span></h2><input type="text" id="featQ" placeholder="بحث بالاسم…" style="width:100%;margin-bottom:8px"><div class="feat-list" id="featList"></div></div>
        <div class="small muted" style="padding:0 4px">خريطة الأساس (شوارع، مبانٍ، مخيمات، أسماء أماكن) من OpenStreetMap — تظهر المباني والشوارع الفرعية عند التكبير. يمكن إخفاؤها من مربع «خريطة الأساس» أعلى الخريطة، وتحديث بياناتها من «إدارة البيانات». لكل عنصر رابط لفتحه في خرائط Google.</div>
      </div></div>`;
    const res = await initMap("bigMap", filter, true, opts);
    if (!res) return;
    const { map, groups } = res;
    const list = $("#layerList");
    if (shown.length) list.innerHTML = shown.map(l => `<label class="layer-item"><input type="checkbox" data-l="${esc(l.id)}" checked><i class="dot" style="background:${esc(l.color || "#2a78d6")}"></i><span class="ln"><b>${esc(l.name)}</b><small>${esc(layerOwnerName(l.pid))} · ${l.stats ? l.stats.features : 0} عنصر · ${fmtLen(l.stats ? l.stats.length : null)}</small></span></label>`).join("");
    list.querySelectorAll("input[data-l]").forEach(cb => cb.addEventListener("change", () => { const g = groups[cb.dataset.l]; if (!g) return; cb.checked ? g.addTo(map) : map.removeLayer(g); }));
    $("#lblT").addEventListener("change", e => { S.mapLabels = e.target.checked; render(); });
    // feature list
    const feats = [];
    Object.entries(groups).forEach(([lid, grp]) => grp.eachLayer(sub => { if (sub.eachLayer) sub.eachLayer(f => { if (f.feature) feats.push({ lid, f }); }); }));
    $("#featCount").textContent = feats.length + " عنصر";
    const draw = q => {
      const xs = feats.filter(x => !q || String(x.f.feature.properties.name || "").includes(q)).slice(0, 300);
      $("#featList").innerHTML = xs.length ? xs.map((x, i) => `<button class="feat" data-i="${feats.indexOf(x)}"><span>${esc(x.f.feature.properties.name || "بدون اسم")}</span><span class="fl">${x.f.feature.properties._len ? fmtLen(x.f.feature.properties._len) : ""}</span></button>`).join("") : '<div class="small muted">لا توجد عناصر.</div>';
    };
    draw("");
    $("#featQ").addEventListener("input", e => draw(e.target.value.trim()));
    $("#featList").addEventListener("click", e => {
      const b = e.target.closest(".feat"); if (!b) return; const x = feats[+b.dataset.i];
      const lyr = x.f; if (lyr.getBounds) map.fitBounds(lyr.getBounds(), { maxZoom: 18, padding: [30, 30] }); else if (lyr.getLatLng) map.setView(lyr.getLatLng(), 17);
      lyr.openPopup();
    });
  }

  // ---------- data management ----------
  function renderData(v, W) {
    const can = S.canWrite && !!S.db;
    const W0 = W || {};
    const targets = (W ? W.projects.map(p => [p.id, shortName(p)]) : []).concat(S.done ? S.done.projects.map(p => [p.id, doneShort(p)]) : [], [[GEN_LAYER, "عام"]]);
    const D = S.done;
    const tOpts = `<optgroup label="المشاريع الجارية – حج 1448">${(W ? W.projects : []).map(p => `<option value="${esc(p.id)}">${esc(shortName(p))}</option>`).join("")}</optgroup>` +
      doneYears().map(y => `<optgroup label="المشاريع المكتملة – ${y || "غير محدد"}">${D.projects.filter(p => (p.year || 0) === y).map(p => `<option value="${esc(p.id)}">${esc(p.id + " · " + doneShort(p))}</option>`).join("")}</optgroup>`).join("") +
      `<optgroup label="أخرى"><option value="${GEN_LAYER}">عام</option></optgroup>`;
    v.innerHTML = `
      ${!S.db ? `<div class="msg warn">الحفظ غير متاح في هذا العرض (يلزم تسجيل الدخول وصلاحية التعديل على الرابط). تُعرض البيانات للقراءة فقط.</div>` : !can ? `<div class="msg warn">صلاحيتك على هذا الرابط «مشاهدة» فقط — الرفع متاح للمالك ومن لديه صلاحية مساهم/محرر.</div>` : ""}
      <div class="grid g-2" style="margin-top:12px">
        <div class="card"><h2>1) رفع ملف Excel الأسبوعي</h2>
          <ol class="steps small"><li>افتح ملف الأسبوع الماضي وحدّث الأرقام و«تاريخ التقرير».</li><li>ارفعه هنا وراجع المعاينة ثم اضغط «حفظ ونشر».</li><li>يتحدّث الداشبورد فوراً لكل من يفتح الرابط، ويُحفظ كل أسبوع لعرض الاتجاه.</li></ol>
          <label class="drop" id="xlDrop" style="margin-top:12px"><input type="file" id="xlFile" accept=".xlsx,.xlsm,.xls" ${can ? "" : "disabled"}>اسحب الملف هنا أو اضغط للاختيار<div class="small muted">.xlsx</div></label>
          <div id="xlOut"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
            <button class="btn" id="dlWeek" ${W && S.downloads ? "" : "disabled"}>⬇ تنزيل Excel للأسبوع المعروض</button>
          </div>
          <div class="small muted" style="margin-top:6px">الملف المنزَّل بنفس هيكل القالب (بدون تنسيق) — مناسب كنقطة بداية للأسبوع التالي.</div>
        </div>
        <div class="card"><h2>2) رفع خرائط KMZ / KML</h2>
          <div class="form-row">
            <label>ربط الطبقة بـ<select id="kTarget" style="max-width:340px">${tOpts}</select></label>
            <label>استبدال طبقة موجودة<select id="kReplace"><option value="">— طبقة جديدة —</option>${S.layers.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}</select></label>
          </div>
          <div class="form-row">
            <label>اسم الطبقة<input type="text" id="kName" placeholder="يؤخذ من الملف إن تُرك فارغاً"></label>
            <label>اللون<select id="kColor">${PALETTE.map((c, i) => `<option value="${c}">لون ${i + 1}</option>`).join("")}<option value="">لون المشروع</option></select></label>
            <label class="check"><input type="checkbox" id="kFileCol" checked> استخدام ألوان الملف إن وُجدت</label>
          </div>
          <label class="drop" id="kmDrop"><input type="file" id="kmFile" accept=".kmz,.kml" ${can ? "" : "disabled"}>اسحب ملف KMZ أو KML هنا أو اضغط للاختيار<div class="small muted">الخطوط والنقاط والمضلعات وطبقات الصور (Ground Overlay)</div></label>
          <div id="kmOut">${S.kmMsg || ""}</div>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><h2>3) ملف المشاريع المكتملة <span class="hint">${D ? D.projects.length + " مشروعاً" : "لا توجد قائمة"}${D && D.uploadedAt ? " · آخر رفع " + new Date(D.uploadedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""}</span></h2>
        <div class="grid g-2">
          <div><ol class="steps small"><li>ورقة «المشاريع المكتملة»: صف لكل مشروع مع سنة الانتهاء الهجرية وهدف المشروع.</li><li>ورقة «منجزات المشاريع»: أطوال الخطوط والمحابس والشبكيات والخزانات لكل مشروع.</li><li>الرفع الجديد يستبدل القائمة كاملة؛ لا يلزم إعادة رفع ملفات KMZ.</li></ol>
            <div style="margin-top:12px"><button class="btn" id="dlDone" ${D && S.downloads ? "" : "disabled"}>⬇ تنزيل Excel الحالي للمشاريع المكتملة</button> <button class="btn" id="dlDoneKmz" ${D && S.downloads ? "" : "disabled"}>⬇ تنزيل KMZ واحد لكل المشاريع المكتملة</button> <button class="btn" id="dlStatic" ${(S.assets || S.downloads) && S.db ? "" : "disabled"}>⬆ تجهيز نسخة GitHub</button><div class="small muted" style="margin-top:6px">يُنزَّل كملف ZIP — فُكّ الضغط لتحصل على «المشاريع-المكتملة.kmz». مقسّم إلى مجلدات حسب سنة الانتهاء ثم حسب المشروع.</div></div></div>
          <div><label class="drop" id="cDrop"><input type="file" id="cFile" accept=".xlsx,.xlsm,.xls" ${can ? "" : "disabled"}>اسحب ملف المشاريع المكتملة هنا أو اضغط للاختيار<div class="small muted">.xlsx</div></label><div id="cOut"></div></div>
        </div></div>
      ${osmCard(can)}
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>الأسابيع المحفوظة <span class="hint">${S.source === "live" ? S.weeks.length + " أسبوع" : "غير متصل"}</span></h2><div class="scroll-x">
          ${S.weeks.length ? `<table class="tbl"><thead><tr><th>تاريخ التقرير</th><th>الملف</th><th>الإنجاز المرجّح</th><th></th></tr></thead><tbody>
          ${S.weeks.slice().reverse().map(w => `<tr><td>${fmtDual(w.weekId)}${w.weekId === S.weekId ? ' <span class="badge info">معروض</span>' : ""}</td><td class="small t2">${esc(w.sourceFile || "—")}${w.uploadedAt ? `<div class="muted">${new Date(w.uploadedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</div>` : ""}</td><td class="n">${pct(weighted(w.data.projects, "actual"))}</td>
            <td style="white-space:nowrap"><button class="btn sm" data-view="${esc(w.weekId)}">عرض</button> ${can && S.source === "live" ? `<button class="btn sm danger" data-delw="${esc(w.weekId)}">حذف</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">لا توجد أسابيع محفوظة.</div>'}</div></div>
        <div class="card"><h2>طبقات الخرائط <span class="hint">${S.layers.length} طبقة</span></h2><div class="scroll-x">
          ${S.layers.length ? `<table class="tbl"><thead><tr><th>الطبقة</th><th>مرتبطة بـ</th><th>العناصر</th><th>الطول</th><th></th></tr></thead><tbody>
          ${S.layers.map(l => { const t = targets.find(x => x[0] === l.pid); return `<tr><td><i class="dot" style="background:${esc(l.color || "#2a78d6")}"></i> ${esc(l.name)}<div class="small muted">${esc(l.fileName || "")} · ${l.updatedAt ? new Date(l.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""}</div></td><td class="small">${esc(t ? t[1] : l.pid)}</td><td class="n">${l.stats ? l.stats.features : "—"}${l.stats && l.stats.overlays ? " + " + l.stats.overlays + " صورة" : ""}</td><td class="n">${fmtLen(l.stats ? l.stats.length : null)}</td>
            <td style="white-space:nowrap">${can ? `<button class="btn sm" data-repl="${esc(l.id)}">تحديث</button> <button class="btn sm danger" data-dell="${esc(l.id)}">حذف</button>` : ""}</td></tr>`; }).join("")}</tbody></table>` : '<div class="empty">لم تُرفع أي خرائط بعد.</div>'}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><h2>كيف يعمل الربط</h2>
        <ul class="objective small"><li>ملف Excel هو مصدر البيانات: كل رفع يُنشئ (أو يستبدل) أسبوعاً بمفتاح «تاريخ التقرير».</li>
        <li>«رمز المشروع» يربط الأوراق ببعضها وبطبقات الخرائط؛ مشروع جديد = صف جديد برمز جديد ويظهر له تبويب تلقائياً.</li>
        <li>تحديث خريطة: اختر الطبقة في «استبدال طبقة موجودة» وارفع ملف KMZ المحدّث — يتغيّر عند الجميع مباشرة.</li>
        <li>الحقول الفارغة تُعرض «—» ولا تُحسب صفراً؛ الإنجاز الإجمالي مرجّح بقيمة العقد.</li></ul></div>`;

    // excel upload
    const xf = $("#xlFile"), xd = $("#xlDrop");
    const onX = file => file && handleExcel(file);
    xf.addEventListener("change", () => onX(xf.files[0]));
    dragDrop(xd, onX, can);
    // kmz upload
    const kf = $("#kmFile"), kd = $("#kmDrop");
    const onK = file => file && handleKmz(file);
    kf.addEventListener("change", () => onK(kf.files[0]));
    dragDrop(kd, onK, can);
    $("#kReplace").addEventListener("change", e => {
      const l = S.layers.find(x => x.id === e.target.value); if (!l) return;
      $("#kTarget").value = l.pid; $("#kName").value = l.name; $("#kColor").value = l.color || ""; $("#kFileCol").checked = !!l.fileColors;
    });
    $("#dlWeek").addEventListener("click", downloadWeek);
    $("#dlDone").addEventListener("click", downloadDone);
    $("#dlDoneKmz").addEventListener("click", downloadDoneKmz);
    $("#dlStatic") && $("#dlStatic").addEventListener("click", () => exportStatic(false));
    const cf = $("#cFile"); cf.addEventListener("change", () => cf.files[0] && handleDoneExcel(cf.files[0]));
    dragDrop($("#cDrop"), f => f && handleDoneExcel(f), can);
    if (S.cPending) showDonePending();
    v.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => { S.weekId = b.dataset.view; location.hash = "#overview"; render(); }));
    v.querySelectorAll("[data-delw]").forEach(b => b.addEventListener("click", () => confirmInline(b, "تأكيد الحذف؟", () => deleteWeek(b.dataset.delw))));
    v.querySelectorAll("[data-dell]").forEach(b => b.addEventListener("click", () => confirmInline(b, "تأكيد الحذف؟", () => deleteLayer(b.dataset.dell))));
    v.querySelectorAll("[data-repl]").forEach(b => b.addEventListener("click", () => { const s = $("#kReplace"); s.value = b.dataset.repl; s.dispatchEvent(new Event("change")); $("#kmDrop").scrollIntoView({ behavior: "smooth", block: "center" }); toast("اختر ملف KMZ المحدّث لهذه الطبقة"); }));
    wireOsm(can);
    if (S.pending) showPending();
  }
  function osmCard(can) {
    const O = window.OSMBase; if (!O) return "";
    const m = O.meta() || {}, st = O.state();
    const row = (k, label) => { const p = m[k]; return `<tr><td>${label}</td><td>${p ? `${nf(p.n)} عنصر${p.labels ? " · " + nf(p.labels) + " اسم" : ""}<div class="small muted">${esc(p.file || "")} · ${fmtDual((p.at || "").slice(0, 10))}</div>` : '<span class="muted">لم يُرفع</span>'}</td><td>${p && can ? `<button class="btn sm danger" data-osmdel="${k}">حذف</button>` : ""}</td></tr>`; };
    return `<div class="card" style="margin-top:16px"><h2>4) خريطة الأساس (OpenStreetMap) <span class="hint">${st === "ready" ? "مفعّلة" : st === "loading" ? "جارٍ التحميل…" : st === "error" ? "تعذّر التحميل" : "غير مرفوعة"}</span></h2>
      <div class="grid g-2">
        <div><ol class="steps small">
          <li>افتح الرابط من متصفح على الحاسب — يفتح موقع <b>overpass-turbo</b> ويشغّل الاستعلام تلقائياً (انتظر حتى يكتمل؛ إن ظهرت رسالة أن البيانات كبيرة اختر <b>continue anyway</b>).</li>
          <li>من زر <b>Export</b> أعلى الصفحة اختر <b>raw OSM data</b> (أو GeoJSON) واضغط <b>download</b>.</li>
          <li>ارفع الملف هنا. كرّر لكل رابط:
            <div style="margin:6px 0 2px"><a href="${esc(O.links.main)}" target="_blank" rel="noopener">① الشوارع والمخيمات واستعمالات الأراضي وأسماء الأماكن</a> <span class="muted">(<a href="${esc(O.alt.main)}" target="_blank" rel="noopener">رابط بديل</a>)</span></div>
            <div><a href="${esc(O.links.bld_mash)}" target="_blank" rel="noopener">② المباني والخيام — المشاعر (منى، مزدلفة، عرفات)</a> <span class="muted">(<a href="${esc(O.alt.bld_mash)}" target="_blank" rel="noopener">بديل</a>)</span></div>
            <div><a href="${esc(O.links.bld_mak)}" target="_blank" rel="noopener">③ المباني — وسط مكة</a> <span class="muted">(<a href="${esc(O.alt.bld_mak)}" target="_blank" rel="noopener">بديل</a>)</span></div></li>
        </ol>
        <div class="small muted">«الرابط البديل» يحمّل JSON مباشرة من خادم Overpass آخر — احفظ الصفحة بـ Ctrl+S ثم ارفعها. الداشبورد لا يتصل بخوادم خارجية لقيود الأمان، لذا تُنزَّل البيانات من المتصفح ثم تُرفع وتُحفظ لكل المشاهدين.</div></div>
        <div><label class="drop" id="osmDrop"><input type="file" id="osmFile" accept=".json,.geojson,application/json" ${can && S.assets ? "" : "disabled"}>اسحب ملف JSON هنا أو اضغط للاختيار<div class="small muted">${can && S.assets ? "يُحدَّد نوعه تلقائياً ويستبدل السابق من نفس النوع" : "يتطلب صلاحية «محرر»"}</div></label>
          <div id="osmOut">${S.osmMsg || ""}</div>
          <table class="tbl" style="margin-top:10px"><tbody>${row("main", "البيانات الأساسية")}${row("bld_mash", "مباني المشاعر")}${row("bld_mak", "مباني وسط مكة")}${m.bld ? row("bld", "المباني (سابق)") : ""}</tbody></table></div>
      </div></div>`;
  }
  function wireOsm(can) {
    const f = $("#osmFile"), d = $("#osmDrop"); if (!f) return;
    const out = t => { S.osmMsg = t; const o = $("#osmOut"); if (o) o.innerHTML = t; };
    const go = async file => {
      if (!file) return;
      try {
        const r = await OSMBase.importFile(file, t => out(`<div class="msg">${esc(t)}</div>`));
        out(`<div class="msg ok">تم حفظ ${r.part === "main" ? "البيانات الأساسية" : r.part === "bld_mak" ? "مباني وسط مكة" : "مباني المشاعر"}: ${nf(r.features)} عنصر${r.labels ? " · " + nf(r.labels) + " اسم" : ""}. تظهر الآن في كل الخرائط.</div>`);
      } catch (e) { out(`<div class="msg err">${esc(e && e.code === "invalid_argument" ? "الملف أكبر من المسموح أو لا تملك صلاحية الرفع." : (e && (e.message || e.code)) || e)}</div>`); }
      f.value = "";
    };
    f.addEventListener("change", () => go(f.files[0]));
    dragDrop(d, go, can && !!S.assets);
    document.querySelectorAll("[data-osmdel]").forEach(b => b.addEventListener("click", () => confirmInline(b, "تأكيد الحذف؟", async () => { try { await OSMBase.removePart(b.dataset.osmdel); toast("تم الحذف"); } catch (e) { toast("تعذّر الحذف"); } })));
  }
  function dragDrop(el, cb, enabled) {
    if (!enabled) { el.style.opacity = .5; el.style.cursor = "not-allowed"; return; }
    el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("over"); cb(e.dataTransfer.files[0]); });
  }
  function confirmInline(btn, label, fn) {
    if (btn.dataset.armed) { fn(); return; }
    btn.dataset.armed = "1"; const t = btn.textContent; btn.textContent = label;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = t; } }, 4000);
  }

  async function handleExcel(file) {
    const out = $("#xlOut");
    out.innerHTML = `<div class="msg">جارٍ قراءة ${esc(file.name)}…</div>`;
    try {
      const buf = await file.arrayBuffer();
      const res = HajjParser.parseWorkbook(XLSX, buf, SPEC, file.name);
      S.pending = res; showPending();
    } catch (e) { out.innerHTML = `<div class="msg err">تعذرت قراءة الملف: ${esc(e.message || e)}</div>`; }
  }
  function showPending() {
    const out = $("#xlOut"); if (!out || !S.pending) return;
    const { week, warnings, errors } = S.pending;
    const exists = S.weeks.some(w => w.weekId === week.weekId && !w.baseline);
    const prev = S.weeks.filter(w => !w.baseline && w.weekId < (week.weekId || "")).pop();
    const size = new Blob([JSON.stringify(week)]).size;
    if (size > 240000) errors.push("حجم بيانات الأسبوع كبير جداً (" + Math.round(size / 1024) + " KB) — الحد 240 KB.");
    out.innerHTML = `<div class="msg ${errors.length ? "err" : warnings.length ? "warn" : "ok"}">
      <b>معاينة:</b> تقرير ${fmtDual(week.weekId)} · ${week.projects.length} مشاريع · ${week.quantities.length} كمية · ${week.scopes.length} نطاق · ${week.supplies.length} توريد
      ${exists ? "<div>⚠ يوجد أسبوع بنفس التاريخ وسيتم استبداله.</div>" : ""}
      ${errors.length ? `<ul>${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${warnings.length ? `<details style="margin-top:6px"><summary>${warnings.length} ملاحظة</summary><ul>${warnings.slice(0, 40).map(e => `<li>${esc(e)}</li>`).join("")}</ul></details>` : ""}
      ${prev ? `<table class="tbl" style="margin-top:8px"><thead><tr><th>المشروع</th><th>الفعلي السابق</th><th>الفعلي الجديد</th></tr></thead><tbody>${week.projects.map(p => { const q = prev.data.projects.find(x => x.id === p.id); return `<tr><td>${esc(shortName(p))}</td><td class="n">${pct(q && q.actual)}</td><td class="n"><b>${pct(p.actual)}</b></td></tr>`; }).join("")}</tbody></table>` : ""}
    </div>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="xlSave" ${errors.length ? "disabled" : ""}>حفظ ونشر</button><button class="btn" id="xlCancel">إلغاء</button></div>`;
    $("#xlCancel").onclick = () => { S.pending = null; out.innerHTML = ""; $("#xlFile").value = ""; };
    $("#xlSave").onclick = saveWeek;
  }
  async function saveWeek() {
    const btn = $("#xlSave"); if (!S.pending || !S.db) return;
    btn.disabled = true; btn.textContent = "جارٍ الحفظ…";
    const { week } = S.pending;
    try {
      await S.db.doc("weeks/" + week.weekId).set({ weekId: week.weekId, uploadedAt: new Date().toISOString(), sourceFile: week.sourceFile || null, data: week });
      S.pending = null; S.weekId = week.weekId;
      toast("تم حفظ تقرير " + fmtDual(week.weekId) + " ونشره");
      location.hash = "#overview"; render();
    } catch (e) {
      btn.disabled = false; btn.textContent = "حفظ ونشر";
      $("#xlOut").insertAdjacentHTML("beforeend", `<div class="msg err">${e && e.code === "invalid_argument" ? "لا تملك صلاحية الحفظ على هذا الرابط." : e && e.code === "quota_exceeded" ? "امتلأت سعة قاعدة البيانات — احذف أسابيع قديمة." : "تعذر الحفظ: " + esc((e && (e.message || e.code)) || e)}</div>`);
    }
  }
  async function deleteWeek(id) {
    try { await S.db.doc("weeks/" + id).delete(); toast("تم حذف الأسبوع " + fmtDual(id)); if (S.weekId === id) S.weekId = null; }
    catch (e) { toast("تعذر الحذف: " + (e.code || e.message)); }
  }
  async function downloadWeek() {
    const W = (S.weeks.find(w => w.weekId === S.weekId) || S.weeks[S.weeks.length - 1] || {}).data; if (!W || !S.downloads) return; // raw report values
    try {
      const buf = HajjParser.weekToWorkbook(XLSX, W, SPEC);
      await S.downloads.save({ filename: "تقرير-مشاريع-الحج-" + W.weekId + ".xlsx", data: new Blob([buf]) });
    } catch (e) { if (e && e.code !== "declined") toast("تعذر التنزيل: " + (e.code || e.message)); }
  }

  async function handleKmz(file) {
    const out = $("#kmOut");
    out.innerHTML = `<div class="msg">جارٍ قراءة ${esc(file.name)}…</div>`; S.kmMsg = "";
    try {
      const buf = await file.arrayBuffer();
      const r = await HajjKmz.parse({ JSZip, toGeoJSON, DOMParser }, buf, file.name);
      if (!r.stats.features && !r.stats.overlays) throw new Error("الملف لا يحتوي على عناصر جغرافية.");
      const replaceId = $("#kReplace").value;
      const old = S.layers.find(l => l.id === replaceId);
      const id = old ? old.id : "L" + Date.now().toString(36);
      const pid = $("#kTarget").value;
      const W = curWeek();
      const dp = S.done && S.done.projects.find(p => p.id === pid);
      const color = $("#kColor").value || (W && W.projects.some(p => p.id === pid) ? projColor(W, pid) : dp ? (YEAR_COLORS[dp.year] || "#2a78d6") : "#2a78d6");
      const doc = { id, pid, name: $("#kName").value.trim() || r.docName || file.name.replace(/\.(kmz|kml)$/i, ""), color, fileColors: $("#kFileCol").checked,
        fileName: file.name, updatedAt: new Date().toISOString(), stats: r.stats, bbox: r.bbox, overlays: [], geo: null, geoAsset: null };
      if (dp) {
        doc.kind = kindOfType(dp.type); doc.fileColors = false; doc.color = doc.kind === "sewer" ? SEWER : WATER;
        r.geojson.features.forEach(ft => { const p = ft.properties; p._k = doc.kind === "mixed" ? (SEW_RE.test(Object.values(p).join(" ")) ? "sewer" : "water") : doc.kind; });
      }
      const json = JSON.stringify(r.geojson);
      const skipped = [];
      if (json.length < 180000) doc.geo = json;
      else {
        if (!S.assets) throw new Error("الملف كبير (" + Math.round(json.length / 1024) + " KB) ويحتاج صلاحية «محرر» لرفعه كملف مرفق.");
        const up = await S.assets.upload(new Blob([json], { type: "application/json" }), { type: "application/json" });
        doc.geoAsset = up.id;
      }
      for (const o of r.overlays) {
        if (!o.blob || !o.mime) { skipped.push(o.name + " (الصورة غير موجودة داخل الملف)"); continue; }
        if (!S.assets) { skipped.push(o.name + " (يتطلب صلاحية محرر)"); continue; }
        try { const up = await S.assets.upload(o.blob, { type: o.mime }); doc.overlays.push({ assetId: up.id, bounds: o.bounds, name: o.name }); }
        catch (e) { skipped.push(o.name + " (" + (e.code || "خطأ") + ")"); }
      }
      await S.db.doc("maps/" + id).set(doc);
      // clean up the replaced layer's files
      if (old && S.assets) {
        const keep = new Set([doc.geoAsset].concat(doc.overlays.map(o => o.assetId)));
        const ids = [old.geoAsset].concat((old.overlays || []).map(o => o.assetId)).filter(x => x && !keep.has(x));
        for (const a of ids) { try { await S.assets.delete(a); } catch (e) { } }
      }
      S.kmMsg = `<div class="msg ok">تم ${old ? "تحديث" : "إضافة"} الطبقة «${esc(doc.name)}»: ${r.stats.features} عنصر · ${fmtLen(r.stats.length)} خطوط${r.stats.overlays ? " · " + doc.overlays.length + " صورة" : ""}.${skipped.length ? `<div>لم تُرفع: ${skipped.map(esc).join("، ")}</div>` : ""}</div>`;
      const o2 = $("#kmOut"); if (o2) o2.innerHTML = S.kmMsg;
      const f2 = $("#kmFile"); if (f2) f2.value = "";
    } catch (e) {
      S.kmMsg = `<div class="msg err">${esc(e && e.code === "invalid_argument" ? "لا تملك صلاحية الحفظ أو أن البيانات أكبر من المسموح." : (e && (e.message || e.code)) || e)}</div>`;
      const o3 = $("#kmOut"); if (o3) o3.innerHTML = S.kmMsg;
    }
  }
  async function deleteLayer(id) {
    const l = S.layers.find(x => x.id === id); if (!l) return;
    try {
      await S.db.doc("maps/" + id).delete();
      if (S.assets) for (const a of [l.geoAsset].concat((l.overlays || []).map(o => o.assetId)).filter(Boolean)) { try { await S.assets.delete(a); } catch (e) { } }
      toast("تم حذف الطبقة");
    } catch (e) { toast("تعذر الحذف: " + (e.code || e.message)); }
  }

  // ---------- completed projects ----------
  function doneShort(p) { return p.short || String(p.name || p.id).replace(/^(مشروع|عقد)\s*[:：]?\s*/, "").replace(/^(تصميم و\s*تنفيذ|تصميم وتنفيذ)\s+(مشروع\s+)?/, ""); }
  function lenM(q) {
    const u = String(q.unit || "").replace(/\s/g, "");
    if (q.qty == null) return null;
    if (/^كم|كيلو/.test(u)) return q.qty * 1000;
    if (/م\.?ط|^م$|متر|^m$/i.test(u) || u === "") return q.qty;
    return null;
  }
  const isCount = q => { const u = String(q.unit || "").replace(/\s/g, ""); return u === "" || /عدد|^ع$|قطعة|وحدة/.test(u); };
  function doneTotals(qs) {
    const t = { water: 0, sewer: 0, valves: 0, networks: 0, tanks: 0, tanksNew: 0, tanksReh: 0, stations: 0, has: { water: false, sewer: false, valves: false, networks: false, tanks: false, tanksNew: false, tanksReh: false, stations: false } };
    qs.forEach(q => {
      const c = q.cat || "";
      if (/مياه/.test(c) && /خط/.test(c)) { const m = lenM(q); if (m != null) { t.water += m; t.has.water = true; } }
      else if (/صرف/.test(c)) { const m = lenM(q); if (m != null) { t.sewer += m; t.has.sewer = true; } }
      else if (/محابس|محبس|صمام/.test(c)) { if (q.qty != null && isCount(q)) { t.valves += q.qty; t.has.valves = true; } }
      else if (/شبكي/.test(c)) { if (q.qty != null && isCount(q)) { t.networks += q.qty; t.has.networks = true; } }
      else if (/خزان/.test(c)) { if (q.qty != null && isCount(q)) { t.tanks += q.qty; t.has.tanks = true; if (/تأهيل|تاهيل|رفع كفاءة/.test(q.item || "")) { t.tanksReh += q.qty; t.has.tanksReh = true; } else { t.tanksNew += q.qty; t.has.tanksNew = true; } } }
      else if (/محط/.test(c)) { if (q.qty != null && isCount(q)) { t.stations += q.qty; t.has.stations = true; } }
    });
    return t;
  }
  const km = m => (m / 1000).toFixed(2);
  function statusBadge(st) { st = (st || "").trim(); if (!st) return ""; return /منته|مكتمل|مستلم/.test(st) ? badge("good", "✓", st) : /تحت التنفيذ|جاري/.test(st) ? badge("warning", "●", st) : badge("info", "●", st); }
  function doneKpis(P, Q, label) {
    const t = doneTotals(Q), total = P.reduce((a, p) => a + (p.value || 0), 0);
    const fin = P.filter(p => /منته|مكتمل|مستلم/.test(p.status || "")).length;
    const k = (lbl, has, val, unit, foot) => has ? `<div class="kpi"><div class="lbl">${lbl}</div><div class="val"><span class="num">${val}</span><small>${unit}</small></div><div class="foot2">${foot || ""}</div></div>` : "";
    return `<div class="grid g-kpi g-kpi7">
      <div class="kpi"><div class="lbl">عدد المشاريع ${label || ""}</div><div class="val">${P.length}<small>مشروعاً</small></div><div class="foot2">${fin} منتهٍ${P.length - fin ? ` · ${P.length - fin} بحالة أخرى` : ""}</div></div>
      <div class="kpi"><div class="lbl">إجمالي التكلفة</div><div class="val"><span class="num">${mil(total)}</span><small>مليون ريال</small></div><div class="foot2"><span class="num">${money(total)}</span> ريال</div></div>
      ${k("أطوال خطوط المياه المنفذة", t.has.water, km(t.water), "كم", nf(t.water) + " م.ط")}
      ${k("أطوال خطوط الصرف الصحي", t.has.sewer, km(t.sewer), "كم", nf(t.sewer) + " م.ط")}
      ${k("المحابس", t.has.valves, nf(t.valves), "محبس")}
      ${k("الشبكيات", t.has.networks, nf(t.networks), "شبكية")}
      ${k("خزانات جديدة (إنشاء)", t.has.tanksNew, nf(t.tanksNew), "خزان")}
      ${k("خزانات مؤهلة (تأهيل)", t.has.tanksReh, nf(t.tanksReh), "خزان")}
      ${extraCounts(Q).map(([c, n]) => k(c, true, nf(n), "")).join("")}
    </div>`;
  }
  // completed project as a full-width horizontal strip
  function doneRow(p, Q, i) {
    const t = doneTotals(Q.filter(q => q.pid === p.id)), c = YEAR_COLORS[p.year] || "#2a78d6";
    const hasMap = S.layers.some(l => l.pid === p.id);
    const st = (lbl, val, unit) => `<div class="dst"><div class="k">${lbl}</div><div class="v"><span class="num">${val}</span>${unit ? ` <small>${unit}</small>` : ""}</div></div>`;
    const stats = [
      t.has.water ? st("خطوط مياه", km(t.water), "كم") : "",
      t.has.sewer ? st("خطوط صرف", km(t.sewer), "كم") : "",
      t.has.valves ? st("محابس", nf(t.valves)) : "",
      t.has.networks ? st("شبكيات", nf(t.networks)) : "",
      t.has.tanksNew ? st("خزانات جديدة", nf(t.tanksNew)) : "",
      t.has.tanksReh ? st("خزانات مؤهلة", nf(t.tanksReh)) : "",
      t.has.stations ? st("محطات ضخ", nf(t.stations)) : ""].join("") + extraCounts(Q.filter(q => q.pid === p.id)).map(([c, n]) => st(c, nf(n))).join("")
      + Q.filter(q => q.pid === p.id && (q.cat || "").trim() === "أخرى" && q.qty != null).map(q => st(esc(q.item || "أخرى"), nf(q.qty), /عدد/.test(q.unit || "عدد") ? "" : esc(q.unit))).join("");
    return `<a class="pcard drow2" href="#${cslug(p.id)}" style="--pc:${c}">
      <div class="dmain">
        <div class="loc"><span class="num">${i}.</span> <span class="num">${esc(p.id)}</span>${p.location ? " · " + esc(p.location) : ""}${/منته/.test(p.status || "") ? "" : " " + statusBadge(p.status)}</div>
        <h3>${esc(doneShort(p))}</h3>
        <div class="meta"><span><b class="num">${money(p.value)}</b> ريال</span>${p.type ? `<span>${esc(p.type)}</span>` : ""}${fundOf(p) !== NOFUND ? `<span class="fund">${esc(fundOf(p))}</span>` : ""}${p.awardedBy ? `<span>ترسية ${esc(p.awardedBy)}</span>` : ""}${p.contractor ? `<span>المقاول: ${esc(p.contractor)}</span>` : ""}${hasMap ? '<span class="maptag">◉ خريطة</span>' : ""}</div>
      </div>
      ${stats ? `<div class="dstats">${stats}</div>` : ""}
    </a>`;
  }
  // per-year list of completed projects as a table (replaces the card grid)
  function doneTable(ps, Q) {
    const tot = { v: 0, w: 0, s: 0, va: 0, n: 0, t: 0 };
    const cell = (has, val) => has ? `<span class="num">${val}</span>` : `<span class="muted">—</span>`;
    const rows = ps.map((p, i) => {
      const t = doneTotals(Q.filter(q => q.pid === p.id)), c = YEAR_COLORS[p.year] || "#2a78d6";
      tot.v += p.value || 0; tot.w += t.water; tot.s += t.sewer; tot.va += t.valves; tot.n += t.networks; tot.t += t.tanks;
      const hasMap = S.layers.some(l => l.pid === p.id);
      return `<tr class="drow" data-href="#${cslug(p.id)}" style="cursor:pointer">
        <td class="n muted">${i + 1}</td>
        <td class="n"><a href="#${cslug(p.id)}" style="color:${c}">${esc(p.id)}</a></td>
        <td style="min-width:260px"><a href="#${cslug(p.id)}">${esc(doneShort(p))}</a>${/منته/.test(p.status || "") ? "" : " " + statusBadge(p.status)}<div class="small muted">${esc(p.location || "")}</div></td>
        <td>${esc(p.type || "—")}</td>
        <td class="n"><span class="num">${money(p.value)}</span></td>
        <td class="small">${esc(fundOf(p) === NOFUND ? "—" : fundOf(p))}</td>
        <td class="small">${esc(p.awardedBy || "—")}</td>
        <td class="n">${cell(t.has.water, km(t.water))}</td>
        <td class="n">${cell(t.has.sewer, km(t.sewer))}</td>
        <td class="n">${cell(t.has.valves, nf(t.valves))}</td>
        <td class="n">${cell(t.has.networks, nf(t.networks))}</td>
        <td class="n">${cell(t.has.tanks, nf(t.tanks))}</td>
        <td>${hasMap ? '<span class="maptag">◉</span>' : ""}</td></tr>`;
    }).join("");
    const has = { w: false, s: false, va: false, n: false, t: false };
    ps.forEach(p => { const t = doneTotals(Q.filter(q => q.pid === p.id)); has.w ||= t.has.water; has.s ||= t.has.sewer; has.va ||= t.has.valves; has.n ||= t.has.networks; has.t ||= t.has.tanks; });
    const html = `<div class="card" style="padding:0"><div class="scroll-x"><table class="tbl dtbl"><thead><tr><th>#</th><th>رقم المشروع</th><th>اسم المشروع</th><th>النوع</th><th>التكلفة (ريال)</th><th>مصدر التمويل</th><th>جهة الترسية</th><th>خطوط مياه (كم)</th><th>خطوط صرف (كم)</th><th>محابس</th><th>شبكيات</th><th>خزانات</th><th>خريطة</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th></th><th></th><th>الإجمالي (${ps.length} مشروعاً)</th><th></th><th class="n"><span class="num">${money(tot.v)}</span></th><th></th><th></th><th class="n"><span class="num">${km(tot.w)}</span></th><th class="n"><span class="num">${km(tot.s)}</span></th><th class="n"><span class="num">${nf(tot.va)}</span></th><th class="n"><span class="num">${nf(tot.n)}</span></th><th class="n"><span class="num">${nf(tot.t)}</span></th><th></th></tr></tfoot>
    </table></div></div>`;
    // drop quantity columns that are empty for every project in this list (columns 8–12)
    const drop = [has.w, has.s, has.va, has.n, has.t].map((h, i) => h ? null : 8 + i).filter(x => x != null);
    if (!drop.length) return html;
    const box = document.createElement("div"); box.innerHTML = html;
    box.querySelectorAll("tr").forEach(tr => drop.slice().reverse().forEach(c => { const cell = tr.children[c - 1]; if (cell) cell.remove(); }));
    return box.innerHTML;
  }
  function doneCard(p, Q) {
    const t = doneTotals(Q.filter(q => q.pid === p.id));
    const chips = [];
    if (t.has.water) chips.push(`خطوط مياه <b class="num">${km(t.water)}</b> كم`);
    if (t.has.sewer) chips.push(`خطوط صرف <b class="num">${km(t.sewer)}</b> كم`);
    if (t.has.valves) chips.push(`<b class="num">${nf(t.valves)}</b> محبس`);
    if (t.has.networks) chips.push(`<b class="num">${nf(t.networks)}</b> شبكية`);
    if (t.has.tanksNew) chips.push(`<b class="num">${nf(t.tanksNew)}</b> خزان جديد`);
    if (t.has.tanksReh) chips.push(`<b class="num">${nf(t.tanksReh)}</b> خزان مؤهل`);
    const c = YEAR_COLORS[p.year] || "#2a78d6";
    const hasMap = S.layers.some(l => l.pid === p.id);
    return `<a class="pcard dcard" href="#${cslug(p.id)}" style="--pc:${c}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span class="loc"><span class="num">${esc(p.id)}</span>${p.location ? " · " + esc(p.location) : ""}</span>${/منته/.test(p.status || "") ? "" : statusBadge(p.status)}</div>
      <h3 class="clamp">${esc(doneShort(p))}</h3>
      <div class="meta"><span><span class="num">${money(p.value)}</span> ريال</span>${p.type ? `<span>${esc(p.type)}</span>` : ""}${fundOf(p) !== NOFUND ? `<span class="fund">${esc(fundOf(p))}</span>` : ""}${p.awardedBy ? `<span>ترسية ${esc(p.awardedBy)}</span>` : ""}${hasMap ? '<span class="maptag">◉ خريطة</span>' : ""}</div>
      ${chips.length ? `<div class="qchips">${chips.map(x => `<span>${x}</span>`).join("")}</div>` : ""}
    </a>`;
  }
  // funding-source filter for completed projects (null = all)
  const NOFUND = "غير محدد";
  // same source under different names → one label
  const FUND_ALIAS = { "إيرادات الشركة": "ميزانية شركة المياه الوطنية", "الميزانية العامة": "الميزانية العامة – الباب الرابع" };
  const fundOf = p => {
    let f = (p.funding || "").trim() || (/كدانة/.test(p.awardedBy || "") ? "شركة كدانة" : NOFUND);
    f = FUND_ALIAS[f] || f;
    // Kidana-funded projects: split by who awarded them
    if (/كدانة/.test(f)) f = /كدانة/.test(p.awardedBy || "") ? "تمويل وترسية شركة كدانة" : "تمويل كدانة – ترسية شركة المياه الوطنية";
    return f;
  };
  function fundOk(p) { return !S.doneFund || fundOf(p) === S.doneFund; }
  function fundBar(P0) {
    const counts = new Map(); P0.forEach(p => counts.set(fundOf(p), (counts.get(fundOf(p)) || 0) + 1));
    const keys = [...counts.keys()].sort((a, b) => a === NOFUND ? 1 : b === NOFUND ? -1 : counts.get(b) - counts.get(a));
    if (S.doneFund && !counts.has(S.doneFund)) S.doneFund = null;
    const chip = (k, t, n) => `<button type="button" class="fchip ${(S.doneFund || null) === k ? "on" : ""}" data-fund="${esc(k || "")}">${esc(t)} <span class="num">${n}</span></button>`;
    return `<div class="fundbar" role="group" aria-label="مصدر التمويل"><span class="flbl">مصدر التمويل:</span>${chip(null, "الكل", P0.length)}${keys.map(k => chip(k, k, counts.get(k))).join("")}</div>`;
  }
  function renderDone(v, yearKey) {
    const D = S.done;
    if (!D || !D.projects.length) { v.innerHTML = `<div class="empty">لا توجد قائمة مشاريع مكتملة بعد. ارفع ملف «المشاريع المكتملة» من صفحة <a href="#data">إدارة البيانات</a>.</div>`; return; }
    const year = yearKey == null ? null : +yearKey;
    const P0 = D.projects.filter(p => year == null || (p.year || 0) === year);
    const fb = fundBar(P0);
    const P = P0.filter(fundOk);
    const ids = new Set(P.map(p => p.id));
    const Q = D.quantities.filter(q => ids.has(q.pid));
    const years = doneYears();
    const byYear = years.map(y => ({ y, ps: D.projects.filter(p => (p.year || 0) === y && fundOk(p)) })).filter(g => g.ps.length);
    const groups = year == null ? byYear : byYear.filter(g => g.y === year);
    v.innerHTML = `
      ${doneKpis(P, Q, year ? "– " + year + "هـ" : "")}
      ${year ? seasonImpact(+year) : S.doneFund ? "" : seasonGoals(true)}
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>${year == null ? "التكلفة حسب سنة الانتهاء" : "مشاريع عام " + year + "هـ حسب التكلفة"} <span class="hint">مليون ريال</span></h2><div class="chart-box ${year == null ? "short" : "tall"}"><canvas id="cYear"></canvas></div></div>${year == null ? `<div class="card"><h2>عدد المشاريع حسب سنة الانتهاء <span class="hint">مشروع</span></h2><div class="chart-box short"><canvas id="cYearN"></canvas></div></div>` : ""}
        <div class="card"><h2>خريطة المشاريع المكتملة</h2>${mapBlock("dMap", null)}</div>
      </div>
      ${groups.map(g => `<h2 class="section-title" id="y${g.y}">مشاريع منتهية في عام ${g.y ? g.y + "هـ" : "غير محدد"} <span class="small muted" style="font-weight:400">${g.ps.length} مشروعاً · <span class="num">${mil(g.ps.reduce((a, p) => a + (p.value || 0), 0))}</span> مليون ريال</span></h2>
        <div class="dlist">${g.ps.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).map((p, i) => doneRow(p, D.quantities, i + 1)).join("")}</div>`).join("")}`;
    // chart
    const cv = $("#cYear");
    if (year == null) {
      const ys = years.slice().sort((a, b) => a - b);
      const topVals = { id: "topVals", afterDatasetsDraw(ch) { const ctx = ch.ctx; ctx.save(); ctx.font = "700 12px " + getComputedStyle(document.body).fontFamily; ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ch.getDatasetMeta(0).data.forEach((b, k) => { const v = ch.data.datasets[0].data[k]; if (v) ctx.fillText(v.toFixed(2), b.x, b.y - 4); }); ctx.restore(); } };
      S.charts.push(new Chart(cv, { type: "bar", plugins: [topVals],
        data: { labels: ys.map(y => y ? y + "هـ" : "غير محدد"), datasets: [{ label: "التكلفة", data: ys.map(y => +(D.projects.filter(p => (p.year || 0) === y && fundOk(p)).reduce((a, p) => a + (p.value || 0), 0) / 1e6).toFixed(2)), backgroundColor: ys.map(y => YEAR_COLORS[y] || "#2a78d6"), borderRadius: 4, maxBarThickness: 46 }] },
        options: { maintainAspectRatio: false, onClick: (e, els) => { if (els.length) location.hash = "#done-" + ys[els[0].index]; },
          plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { label: c => c.raw.toFixed(2) + " مليون ريال · " + D.projects.filter(p => (p.year || 0) === ys[c.dataIndex] && fundOk(p)).length + " مشروعاً" } } },
          layout: { padding: { top: 18 } }, scales: { x: { reverse: true, grid: { display: false }, ticks: { color: "#e3ecf8" } }, y: { position: "right", beginAtZero: true, grid: { color: "rgba(160,190,230,.14)" } } } } }));
      const topN = { id: "topN", afterDatasetsDraw(ch) { const ctx = ch.ctx; ctx.save(); ctx.font = "700 12px " + getComputedStyle(document.body).fontFamily; ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ch.getDatasetMeta(0).data.forEach((b, k) => { const v = ch.data.datasets[0].data[k]; if (v) ctx.fillText(v, b.x, b.y - 4); }); ctx.restore(); } };
      S.charts.push(new Chart($("#cYearN"), { type: "bar", plugins: [topN],
        data: { labels: ys.map(y => y ? y + "هـ" : "غير محدد"), datasets: [{ label: "عدد المشاريع", data: ys.map(y => D.projects.filter(p => (p.year || 0) === y && fundOk(p)).length), backgroundColor: ys.map(y => YEAR_COLORS[y] || "#2a78d6"), borderRadius: 6, maxBarThickness: 46 }] },
        options: { maintainAspectRatio: false, onClick: (e, els) => { if (els.length) location.hash = "#done-" + ys[els[0].index]; },
          plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { label: c => c.raw + " مشروعاً" } } },
          layout: { padding: { top: 18 } }, scales: { x: { reverse: true, grid: { display: false }, ticks: { color: "#e3ecf8" } }, y: { position: "right", beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(160,190,230,.14)" } } } } }));
    } else {
      const ps = P.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
      const col = YEAR_COLORS[year] || "#2a78d6";
      // full project name above each bar, value at the bar's end
      const ROW = 66; cv.parentNode.style.height = (ps.length * ROW + 30) + "px";
      const wrap = (ctx, text, w) => { const out = []; let line = ""; String(text).split(/\s+/).forEach(word => { const t = line ? line + " " + word : word; if (ctx.measureText(t).width > w && line) { out.push(line); line = word; } else line = t; }); if (line) out.push(line); return out; };
      const labelsPlugin = { id: "nameVal", afterDatasetsDraw(ch) {
        const ctx = ch.ctx, a = ch.chartArea, meta = ch.getDatasetMeta(0);
        ctx.save(); ctx.direction = "rtl";
        meta.data.forEach((bar, k) => {
          const p = ps[k]; if (!p) return;
          ctx.font = "600 12.5px " + getComputedStyle(document.body).fontFamily; ctx.fillStyle = "#e3ecf8"; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
          const lines = wrap(ctx, doneShort(p), a.right - a.left - 4).slice(0, 2);
          lines.forEach((ln, li) => ctx.fillText(ln, a.right, bar.y - bar.height / 2 - 3 - (lines.length - 1 - li) * 15));
          ctx.font = "700 12px " + getComputedStyle(document.body).fontFamily; ctx.textBaseline = "middle"; ctx.textAlign = "right"; ctx.fillStyle = "#ffffff";
          const val = (p.value || 0) / 1e6, txt = (val >= 1 ? val.toFixed(2) : val.toFixed(3)) + " مليون";
          ctx.fillText(txt, Math.min(bar.x, bar.base) - 6, bar.y);
        });
        ctx.restore();
      } };
      const mx = Math.max(...ps.map(p => (p.value || 0) / 1e6), 1);
      S.charts.push(new Chart(cv, { type: "bar", plugins: [labelsPlugin],
        data: { labels: ps.map(p => doneShort(p)), datasets: [{ label: "التكلفة", data: ps.map(p => +((p.value || 0) / 1e6).toFixed(3)), backgroundColor: col, borderRadius: 4, barThickness: 16 }] },
        options: { indexAxis: "y", maintainAspectRatio: false, layout: { padding: { top: 30 } }, onClick: (e, els) => { if (els.length) location.hash = "#" + cslug(ps[els[0].index].id); },
          plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: { title: it => doneShort(ps[it[0].dataIndex]), label: c => c.raw.toFixed(2) + " مليون ريال" } } },
          scales: { x: { reverse: true, beginAtZero: true, max: Math.ceil(mx * 1.3), grid: { color: "rgba(160,190,230,.14)" } }, y: { position: "right", grid: { display: false }, ticks: { display: false }, afterFit: sc => { sc.width = 0; } } } } }));
    }
    initMap("dMap", new Set(P.map(p => p.id)), false);
    v.querySelectorAll(".fchip").forEach(b => b.addEventListener("click", () => { S.doneFund = b.dataset.fund || null; render(); }));
  }
  // counted categories outside the standard ones (مضخات، مولدات، محولات…) get their own summary tile
  function extraCounts(Q) {
    const std = /خط|محابس|محبس|صمام|شبكي|خزان|محط|^أخرى$/;
    const m = new Map();
    Q.forEach(q => { const c = (q.cat || "").trim(); if (!c || std.test(c) || q.qty == null || !/عدد/.test(q.unit || "عدد")) return; m.set(c, (m.get(c) || 0) + q.qty); });
    return [...m];
  }
  function extraTiles(Q) {
    const std = /خط|محابس|محبس|صمام|شبكي|خزان|محط|^أخرى$/;
    const m = new Map();
    Q.forEach(q => { const c = (q.cat || "").trim(); if (!c || std.test(c) || q.qty == null || !/عدد/.test(q.unit || "عدد")) return; m.set(c, (m.get(c) || 0) + q.qty); });
    return [...m].map(([c, n]) => `<div class="fact"><div class="k">${esc(c)}</div><div class="v"><span class="num">${nf(n)}</span> عدد</div></div>`).join("");
  }
  // «أخرى» items, each with its own unit (shown in the summary since the details table was removed)
  function otherTiles(Q) {
    return Q.filter(q => (q.cat || "").trim() === "أخرى" && q.qty != null).map(q => `<div class="fact"><div class="k">${esc(q.item || "أخرى")}</div><div class="v"><span class="num">${nf(q.qty)}</span> ${esc(q.unit || "")}</div></div>`).join("");
  }
  // summarized project objectives per season (general-total page)
  const SEASON_GOALS = {
    1448: ["مصادر إمداد إضافية لمناطق منى 10 و11 وعرفات 3 و4 و5 وخزان التبريد بمزدلفة وقصر الصفا بمكة", "استبدال الخطوط القديمة بمشعر منى وعرفات ومزدلفة بسبب تعدد الانكسارات", "تركيب 91 محبساً بمشعر منى لتقليل زمن الإصلاح", "خط صرف لمعالجة الطفوحات بمنى (مربع 35)"],
    1442: ["تلبية الطلب المتزايد على المياه في عرفات بخط حلقي 800 مم يصل للمناطق المرتفعة", "زيادة نقل مياه التحلية من عرفات إلى مكة بنحو 20,000 م3/يوم", "رفع موثوقية محطة الضخ رقم 9 بالمولدات والمحولات الجديدة"],
    1443: ["دعم وارد خزانات 40 ألف بمنى ومزدلفة من خط الدائري الرابع", "دعم إمداد وسط منى (المنطقتان 4 و7) وتغذية خزانات ربوة الخيف والقصور والملك فهد", "خط وارد جديد لخزان المعيصم 90 ألف م3 وتغذية خزانات الحريق بمكة"],
    1444: ["تدعيم خزانات المعيصم و209 والقصور الملكية والبيعة ودعم المنطقتين 9 و11 بمنى", "تغذية طوارئ لعرفات وإمداد المناطق التطويرية بمزدلفة وشرق الربوة", "استبدال خطوط الحديد المجلفن والإسبستوس", "زيادة سعة صرف العزيزية"],
    1445: ["تغذية مجمعات دورات المياه الجديدة بطريق المشاة وعرفات ومزدلفة والجمرات", "دعم إمداد مناطق منى ومصادر إضافية لخزانات منى 40 والعيسائي ومزدلفة", "خدمة مباني مربع 38 ومخيمات الحرس الوطني ومناطق النزول بمزدلفة"],
    1446: ["خزان المعيصم 190 ألف م3 وخط نقل رئيسي للمنطقتين 8 و9 بمنى", "تأهيل خزانات منى وتنفيذ غرف محابس وشبكيات لرفع موثوقية الشبكة", "تغذية 61 مجمع دورات مياه وخطوط الرذاذ واستكمال منظومة الدائري الرابع"],
    1447: ["منظومة صرف صحي جديدة بمنى بسعة تصل إلى مليون م3 يومياً حتى 2070م", "إضافة مصدر تغذية للمشاعر المقدسة ومكة المكرمة من منظومة المغمس", "إضافة مصادر إمداد إضافية بمشعر منى وتركيب عدادات ذكية لتحسين عملية الفوترة", "تغذية 18 مجمع دورات مياه جديدة"],
  };
  function seasonGoals(doneOnly) {
    const ys = Object.keys(SEASON_GOALS).map(Number).filter(y => !doneOnly || y !== 1448).sort((a, b) => b - a);
    return `<h2 class="section-title">أهداف المشاريع حسب موسم الحج</h2>
    <div class="grid g-3">${ys.map(y => `<a class="card imp-col" href="${y === 1448 ? "#overview" : "#done-" + y}" style="text-decoration:none;color:inherit;border-inline-start:4px solid ${YEAR_COLORS[y] || "#3b8df0"}"><h3>موسم حج ${y}هـ${y === 1448 ? " (تحت التنفيذ)" : ""}</h3><ul class="imp-list">${SEASON_GOALS[y].map(impLi).join("")}</ul></a>`).join("")}</div>`;
  }
  // cumulative impact in the holy sites (source: slide «أثر مشاريع شركة المياه الوطنية في المشاعر المقدسة»)
  const CUM = { seasons: [1445, 1446, 1447], toilets: [16055, 21655, 23855], water: [29965, 100315, 129940], perToilet: [107, 61, 41], reports: [1214, 0, 0] };
  const CUM_NOTE = "وفقًا لما أعلنته شركة كِدانة، أسهمت المشاريع المنفذة خلال العامين الماضيين في تقليل مدة الانتظار على دورات المياه بنسبة 75%، وتحقق المستهدف لعدد المستفيدين من كل دورة (41 مستفيد/دورة).";
  function cumKpis() {
    const k = (lbl, val, foot) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val" style="font-size:22px">${val}</div><div class="foot2">${foot}</div></div>`;
    return `<div class="grid g-kpi g-kpi7">
      ${k("زيادة في عدد دورات المياه", `<span class="num">+7,800</span><small>دورة</small>`, `<span class="up">▲ من 16,055 إلى 23,855 دورة</span> بين موسمي 1445 و1447هـ`)}
      ${k("زيادة في كمية المياه", `<span class="num">+99,975</span><small>م³/يوم</small>`, `<span class="up">▲ من 29,965 إلى 129,940 م³/يوم</span> بين موسمي 1445 و1447هـ`)}
      ${k("المستفيدون لكل دورة", `<span class="num">41</span><small>مستفيد/دورة</small>`, `<span class="down">▼ من 107 إلى 41 مستفيد/دورة</span>`)}
      ${k("مدة الانتظار على دورات المياه", `<span class="num">75%</span><small>انخفاض</small>`, `<span class="down">▼ انخفضت</span> · وفق ما أعلنته شركة كدانة`)}
      ${k("عدد البلاغات", `<span class="num">0</span><small>بلاغ</small>`, `<span class="down">▼ من 1,214 إلى 0 بلاغ</span> منذ موسم 1446هـ`)}
    </div>`;
  }
  function cumChartCard(id) { return `<div class="card"><h2>التوسع التراكمي في الخدمات وأثره على خفض الضغط التشغيلي</h2><div class="chart-box tall"><canvas id="${id}"></canvas></div><div class="small muted" style="margin-top:6px">${esc(CUM_NOTE)}</div></div>`; }
  function cumChart(cv) {
    if (!cv) return;
    const lbl = { id: "cumLbl", afterDatasetsDraw(ch) { const ctx = ch.ctx; ctx.save(); ctx.font = "700 11.5px " + getComputedStyle(document.body).fontFamily; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ch.data.datasets.forEach((ds, di) => ch.getDatasetMeta(di).data.forEach((el, k) => { const v = ds.data[k]; if (v == null) return; ctx.fillStyle = ds.type === "line" ? ds.borderColor : "#ffffff"; ctx.fillText(nf(v), el.x, el.y - 6); })); ctx.restore(); } };
    S.charts.push(new Chart(cv, { type: "bar", plugins: [lbl],
      data: { labels: CUM.seasons.map(y => "موسم حج " + y + "هـ"), datasets: [
        { label: "عدد دورات المياه (تراكمي)", data: CUM.toilets, backgroundColor: "#3d8ae6", borderRadius: 4, maxBarThickness: 40, yAxisID: "y" },
        { label: "كمية المياه الإضافية م³/يوم (تراكمي)", data: CUM.water, backgroundColor: "#9fcdfa", borderRadius: 4, maxBarThickness: 40, yAxisID: "y" },
        { type: "line", label: "متوسط المستفيدين لكل دورة", data: CUM.perToilet, borderColor: "#fbbf24", backgroundColor: "#fbbf24", tension: .2, pointRadius: 4, yAxisID: "y2" },
        { type: "line", label: "عدد البلاغات", data: CUM.reports, borderColor: "#34d399", backgroundColor: "#34d399", tension: .2, pointRadius: 4, yAxisID: "y2" }] },
      options: { maintainAspectRatio: false, layout: { padding: { top: 18 } },
        plugins: { legend: { display: true, position: "bottom", labels: { color: "#e3ecf8", boxWidth: 12, font: { size: 11 } } }, tooltip: { ...tooltipBase, callbacks: { label: c => c.dataset.label + ": " + nf(c.raw) } } },
        scales: { x: { reverse: true, grid: { display: false }, ticks: { color: "#e3ecf8" } },
          y: { position: "right", beginAtZero: true, grid: { color: "rgba(160,190,230,.14)" }, ticks: { callback: v => nf(v) } },
          y2: { position: "left", beginAtZero: true, max: 1400, grid: { display: false }, ticks: { color: "#b9c8dd" } } } } }));
  }
  // per-season impact KPIs (same style as the general-total page)
  function cumSeasonKpis(y) {
    const i = CUM.seasons.indexOf(y); if (i < 0) return "";
    const pv = i > 0 ? i - 1 : null, f = n => nf(Math.abs(n));
    const k = (lbl, val, foot) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val" style="font-size:22px">${val}</div><div class="foot2">${foot}</div></div>`;
    const ch = (lbl, a, unit, good) => {
      if (pv == null) return k(lbl, `<span class="num">${nf(a[i])}</span><small>${unit}</small>`, "قيمة موسم " + y + "هـ");
      const d = a[i] - a[pv], up = d > 0, cls = (good === "down" ? !up : up) ? (up ? "up" : "down") : (up ? "up" : "down");
      return k(lbl, `<span class="num">${d === 0 ? "0" : (up ? "+" : "-") + f(d)}</span><small>${unit}</small>`,
        d === 0 ? `دون تغيير · ${nf(a[i])} ${unit}` : `<span class="${cls}">${up ? "▲" : "▼"} من ${nf(a[pv])} إلى ${nf(a[i])} ${unit}</span> مقارنة بموسم ${CUM.seasons[pv]}هـ`);
    };
    return `<h2 class="section-title">الأثر التراكمي للموسم <span class="small muted" style="font-weight:400">${pv == null ? "" : "مقارنة بموسم " + CUM.seasons[pv] + "هـ"}</span></h2>
    <div class="grid g-kpi">
      ${ch(pv == null ? "عدد دورات المياه (تراكمي)" : "زيادة في عدد دورات المياه", CUM.toilets, "دورة")}
      ${ch(pv == null ? "كمية المياه الإضافية (تراكمي)" : "زيادة في كمية المياه", CUM.water, "م³/يوم")}
      ${ch(pv == null ? "المستفيدون لكل دورة" : "تغير المستفيدين لكل دورة", CUM.perToilet, "مستفيد/دورة", "down")}
      ${ch(pv == null ? "عدد البلاغات" : "تغير عدد البلاغات", CUM.reports, "بلاغ", "down")}
    </div>`;
  }
  function cumSeasonCard(y) {
    const i = CUM.seasons.indexOf(y); if (i < 0) return "";
    const pv = i > 0 ? i - 1 : null, d = (a) => pv == null ? "" : ` <span class="small t2">(${a[i] - a[pv] >= 0 ? "+" : ""}${nf(a[i] - a[pv])})</span>`;
    return ["مؤشرات الأثر التراكمي للموسم", [
      "عدد دورات المياه (تراكمي): " + (pv == null ? nf(CUM.toilets[i]) + " دورة" : "ارتفع من " + nf(CUM.toilets[pv]) + " إلى " + nf(CUM.toilets[i]) + " دورة (زيادة " + nf(CUM.toilets[i] - CUM.toilets[pv]) + " دورة)"),
      "كمية المياه الإضافية (تراكمي): " + (pv == null ? nf(CUM.water[i]) + " م³/يوم" : "ارتفعت من " + nf(CUM.water[pv]) + " إلى " + nf(CUM.water[i]) + " م³/يوم (زيادة " + nf(CUM.water[i] - CUM.water[pv]) + " م³/يوم)"),
      "متوسط المستفيدين لكل دورة: " + (pv == null ? CUM.perToilet[i] + " مستفيد/دورة" : "انخفض من " + CUM.perToilet[pv] + " إلى " + CUM.perToilet[i] + " مستفيد/دورة"),
      "عدد البلاغات: " + nf(CUM.reports[i]) + " بلاغ" + (pv == null ? "" : CUM.reports[pv] > CUM.reports[i] ? " (انخفض من " + nf(CUM.reports[pv]) + ")" : CUM.reports[pv] === CUM.reports[i] ? " (دون تغيير)" : "")]];
  }
  // impact of the company's projects on expanding new toilet blocks/camps in Mina (Kidana), per Hajj season
  const IMPACT = {
    1444: { text: "تم تنفيذ خط مياه بطول (2.7) كم وخط صرف بطول (2.4) كم خلال موسم حج عام 1444هـ، حيث تم تمكين شركة كدانة من بناء مخيمات ودورات مياه جديدة بشرق الربوة، باستيعاب ما يزيد على (100) ألف حاج، وذلك من خلال تنفيذ خطوط مياه وصرف صحي، حيث تم التنفيذ خلال (45) يومًا.",
      stats: [["10", "مخيمات"], ["100", "ألف حاج طاقة استيعابية"], ["25,124", "م³/يوم كميات مياه"]] },
    1445: { text: "نفذت الشركة خط مياه بطول (15) كم وقطر (300) مم مما مكّن شركة كدانة من تنفيذ دورات مياه متنقلة على طريق المشاة، وتنفيذ مصدر تغذية في مزدلفة للجالية الهندية، وتعزيز الإمداد لحجاج أوروبا وشمال أمريكا في منى.",
      stats: [["247", "مجمعًا"], ["16,055", "دورة مياه"], ["29,965", "م³/يوم كميات مياه إضافية"]] },
    1446: { text: "نفذت الشركة منظومة مشاريع مياه لدعم منطقة الشعيبين بمشعر منى، شملت خزانًا بسعة (190) ألف م³ وخطًا ناقلًا بطول (6) كم، مما مكّن شركة كدانة من التوسع في إنشاء (61) مجمعًا لدورات المياه تضم (5,600) دورة لموسم حج 1446هـ، وذلك وفقاً لما تم توقيعه في المحضر.",
      stats: [["61", "مجمعًا"], ["5,600", "دورة مياه"], ["70,350", "م³/يوم كميات مياه"]] },
    1447: { text: "تم تنفيذ عدد (3) مشاريع مع ضغط مدة التنفيذ من (30) إلى (15) شهرًا والعمل على مدار (24) ساعة، مما مكّن شركة كدانة من التوسع في إنشاء (18) مجمعًا لدورات المياه تضم (2,200) دورة لموسم حج 1447هـ، وذلك وفقاً لما تم توقيعه في المحضر.",
      stats: [["18", "مجمعًا"], ["2,200", "دورة مياه"], ["29,625", "م³/يوم كميات مياه"]],
      done: "وبالتالي حققت الشركة جميع المستهدفات المطلوبة منها حسب ما تم التوافق عليه من قبل لجنة البنية التحتية" },
  };
  // impact of each season's projects (same layout as «أثر مشاريع المكاسب السريعة»)
  const SEASON_IMPACT = {
    1442: [
      ["مشعر عرفات", [
        "تنفيذ خط حلقي قطر 800 مم من خزان عرفات 50 ألف م3 يغطي المنطقتين التشغيليتين 1 و2",
        "ضمان وصول المياه للمناطق المرتفعة ومواكبة الزيادة في أعداد الحجاج"]],
      ["مياه التحلية", [
        "وصلة قطر 1400 مم من خزانات التحلية بعرفات إلى الخط الناقل لمكة قطر 1600 مم",
        "زيادة الطاقة الاستيعابية لنقل مياه التحلية بنحو 20,000 م3/يوم"]],
      ["موثوقية محطة الضخ رقم 9", [
        "استبدال المولدات القديمة لتأمين الطاقة الاحتياطية للمحطة",
        "استبدال محولات التغذية لزيادة القدرة الكهربائية الأساسية"]],
    ],
    1443: [
      ["مشعر منى", [
        "دعم وارد خزان 40 ألف الرئيسي وخزان المرحلة الثالثة من خط الدائري الرابع",
        "دعم إمداد شبكات وسط منى (المنطقتان 4 و7) بالربط على خط 1000 مم القائم",
        "استبدال 3 مضخات بمحطة منى 40 لتغذية خزانات ربوة الخيف والقصور الملكية والملك فهد"]],
      ["مشعر مزدلفة", [
        "دعم وارد خزان 40 ألف بمزدلفة من خط الدائري الرابع"]],
      ["مكة المكرمة", [
        "خط وارد جديد شاملاً المضخات لتغذية خزان المعيصم 90 ألف م3",
        "إيصال المياه لخزانات الحريق في جبل الكعبة والغزة التابعة لوزارة المالية"]],
    ],
    1444: [
      ["مشعر منى", [
        "تدعيم خزان المعيصم 90 وخزان 209 ودعم إمداد المنطقة 9",
        "تطوير منظومة ضخ خزان القصور الملكية وخزان البيعة العلوي المغذي لمنطقة الجمرات",
        "استكمال الخط الحلقي لمخيمات المنطقة 11 واستبدال خطوط الإسبستوس بخطوط دكتايل",
        "استبدال خطوط الحديد المجلفن لشبكة التكييف الصحراوي بخطوط بولي إيثيلين",
        "تغذية شبكات الحريق من خزان القصور الملكية"]],
      ["مشاعر عرفات ومزدلفة", [
        "خط رئيسي لتغذية مياه الطوارئ بعرفات من خط التوزيع الوارد من محطة الضخ 9",
        "إمداد المناطق التطويرية بمزدلفة وشرق الربوة بخطوط المياه والصرف الصحي"]],
      ["الصرف الصحي", [
        "زيادة سعة خطوط نقل الصرف الصحي بنقطة ربط العزيزية",
        "استيعاب تصرفات المناطق التطويرية بشرق الربوة"]],
    ],
    1445: [
      ["دورات المياه الجديدة", [
        "تغذية 110 مجمعات دورات مياه بطريق المشاة و40 مجمعاً بعرفات و12 مجمعاً بمزدلفة (مشاريع كدانة)",
        "إيصال المياه والصرف لأبراج دورات المياه بساحة الجمرات ومخيمات حجاج أوروبا وأمريكا",
        "دعم دورات المياه بمخيمات الحرس الوطني ومناطق النزول بمزدلفة"]],
      ["مشعر منى", [
        "دعم إمداد المناطق 1 و2 و3 و4 و5 و6 و10 و11 ومنطقة الشعيبين",
        "مصدر إضافي لخزان منى 40 الرئيسي وخزان العيسائي",
        "إيصال المياه والصرف لـ 11 مبنى سكن حجاج بمربع 38"]],
      ["مشعر مزدلفة", [
        "مصدر إضافي لخزان 10 آلاف بمزدلفة من الدائري الرابع",
        "مصدر إضافي لمزدلفة من خط عرفات القائم قطر 1600 مم",
        "دعم الإمداد لمنطقة أعالي الشعيبين"]],
    ],
    1446: [
      ["مشعر منى", [
        "خزان حديدي بسعة 190 ألف م3 بالمعيصم لضمان استدامة الإمداد",
        "خط نقل رئيسي لتغذية المنطقتين 8 و9 من خزان المعيصم",
        "خط ناقل لتغذية 61 مجمع دورات مياه بالمناطق 3 و4 و7 و9 و10",
        "تأهيل خزانات العيسائي وربوة الخيف والملك فهد"]],
      ["التحكم وموثوقية الشبكة", [
        "شبكيات وربط خطوط وارد ومنصرف خزانات عرفات ومزدلفة ومنى",
        "10 غرف محابس (تخفيض ضغط وفراشة) بمنى لتحسين التشغيل",
        "تغذية خطوط الرذاذ وبرادات المياه لتقليل الإجهاد الحراري"]],
      ["مكة المكرمة", [
        "استكمال منظومة الدائري الرابع ومحابس تخفيض الضغط لتخفيف الضغط على الدائري الثالث",
        "تحسين الإمداد لأجياد وتقليل الاعتماد على الصهاريج",
        "دعم إمداد قصر الصفا وتغذية مواقع حكومية"]],
    ],
    1447: [
      ["تعظيم الاستفادة من المغمس", [
        "مناورة تشغيلية لتغذية خزان الشهداء مباشرة من منظومة مياه المغمس بدون تشغيل محطة الضخ",
        "رفع موثوقية الشبكة لاستقبال الكميات الواردة من مجمع المغمس وتمكين المنظومة التشغيلية بمكة المكرمة من الاستفادة من كميات المياه الواردة",
        "تنفيذ مصدر تغذية إضافي لتعزيز الإمداد بالمنطقة المركزية وإيجاد لتقليل الاعتماد على الصهاريج",
        "تحسين كفاءة الشبكة لتغذية شمال وغرب مكة مباشرة من مجمع المغمس لتقليل الضغط على منظومة المعيصم خلال موسم الحج",
        "تغذية خزانات بطحاء قريش بسعة 40 ألف م3 من منظومة المغمس"]],
      ["الصرف الصحي", [
        "بناء منظومة صرف صحي جديدة في مشعر منى لتستوعب تدفقات تصل إلى مليون متر مكعب في اليوم",
        "خدمة مناطق 8، 9 (الشعيبين) والمجازر، وأجزاء من منطقة 3، 4، 10، 11",
        "تنفيذ خط صرف صحي رئيسي لمخيمات الحرس الوطني والمجاهدين لرفع الضرر البيئي",
        "تغذية عدد 18 مجمعاً جديداً لخدمات دورات المياه (2,200 دورة) وتوفير 29,625 م3/يوم كميات مغذية"]],
      ["تحسين الكفاءة وموثوقية الإمداد", [
        "إمداد مشعر منى بمصدر إضافي لتقليل مخاطر المصدر الواحد (خط 1,000 مم)",
        "تغذية مشعري منى ومزدلفة من منظومة المغمس",
        "توفير كميات مياه بسعة أكبر لتلبية الاحتياج المتزايد بالمشاعر",
        "تنفيذ مصدر تغذية إضافي للمناطق المرتفعة بمشعر منى (مناطق 2، 3، 5)",
        "تركيب 27 عداد قياس ذكي في المشاعر لتحسين القراءة والفوترة"]],
    ],
  };
  function seasonImpact(y) {
    let A = SEASON_IMPACT[y] || [];
    const I = IMPACT[y];
    if (I) A = A.concat([["التوسع في بناء دورات مياه جديدة بمشعر منى", [I.text].concat(I.stats.map(([n, l]) => /م³/.test(l) ? l.replace("م³/يوم ", "") + ": " + n + " م³/يوم" : n + " " + l)).concat(I.done ? [I.done] : [])]]);
    if (!A.length) return "";
    return `<h2 class="section-title">أثر مشاريع موسم حج ${y}هـ</h2>
    <div class="grid ${A.length >= 4 ? "g-4" : "g-3"}">${A.map(([a, items]) => `<div class="card imp-col"><h3><i class="dot" style="background:var(--accent)"></i>${esc(a)}</h3><ul class="imp-list">${items.map(impLi).join("")}</ul></div>`).join("")}</div>`;
  }
  function impactCard(y) {
    const I = IMPACT[y]; if (!I) return "";
    return `<div class="card impact" style="margin-top:16px;--pc:${YEAR_COLORS[y] || "#2a78d6"}">
      <h2>أثر مشاريع شركة المياه الوطنية على التوسع في بناء دورات مياه جديدة بمشعر منى <span class="hint">موسم حج ${y}هـ</span></h2>
      <div class="impact-body"><p>${esc(I.text)}</p>
        <div class="impact-stats">${I.stats.map(([n, l]) => `<div class="ist"><div class="v num">${n}</div><div class="k">${l}</div></div>`).join("")}</div></div>
      ${I.done ? `<div class="impact-done"><span class="ok" aria-hidden="true">✓</span><span>${esc(I.done)}</span></div>` : ""}</div>`;
  }
  function renderDoneProject(v, p) {
    const D = S.done, Q = D.quantities.filter(q => q.pid === p.id), t = doneTotals(Q), c = YEAR_COLORS[p.year] || "#2a78d6";
    const obj = String(p.objective || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
    const cats = new Map(); Q.forEach(q => { const k = q.cat || "أخرى"; if (!cats.has(k)) cats.set(k, []); cats.get(k).push(q); });
    const order = CATS.concat([...cats.keys()].filter(k => !CATS.includes(k)));
    const hasLayer = S.layers.some(l => l.pid === p.id);
    const tile = (lbl, has, val, unit) => has ? `<div class="fact"><div class="k">${lbl}</div><div class="v"><span class="num">${val}</span> ${unit}</div></div>` : "";
    v.innerHTML = `
      <div class="card" style="border-top:3px solid ${c}">
        <div class="phead"><div><div class="small t2" style="margin-bottom:4px"><a href="#done-${p.year || 0}">مشاريع ${p.year ? p.year + "هـ" : "غير محددة السنة"}</a> · <span class="num">${esc(p.id)}</span>${p.location ? " · " + esc(p.location) : ""}</div><h2>${esc(p.name)}</h2></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${statusBadge(p.status)}${p.type ? badge("info", "●", p.type) : ""}</div></div>
        <div class="facts">
          <div class="fact"><div class="k">التكلفة (ريال)</div><div class="v num">${money(p.value)}</div></div>
          <div class="fact"><div class="k">سنة الموسم</div><div class="v">${p.year ? p.year + "هـ" : "—"}</div></div>
          <div class="fact"><div class="k">الاستلام الابتدائي</div><div class="v">${esc(p.endH || hijri(p.endG) || "—")}</div><div class="v2">${p.endG ? fmtDate(p.endG) + "م" : ""}</div></div>
          <div class="fact"><div class="k">المقاول</div><div class="v">${esc(p.contractor || "—")}</div></div>
          ${p.startH || p.startG ? `<div class="fact"><div class="k">بداية المشروع</div><div class="v">${esc(p.startH || hijri(p.startG) || "—")}</div><div class="v2">${p.startG ? fmtDate(p.startG) + "م" : ""}</div></div>` : ""}
          <div class="fact"><div class="k">مصدر التمويل</div><div class="v">${esc(fundOf(p) === NOFUND ? "—" : fundOf(p))}</div></div>
          ${p.contractNo ? `<div class="fact"><div class="k">رقم العقد التشغيلي</div><div class="v num">${esc(p.contractNo)}</div></div>` : ""}
          ${p.awardedBy ? `<div class="fact"><div class="k">جهة الترسية</div><div class="v">${esc(p.awardedBy)}</div></div>` : ""}
        </div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <div class="card"><h2>هدف المشروع</h2>${obj.length ? `<ul class="objective">${obj.map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : `<div class="empty">لم يُدخل هدف المشروع بعد (عمود «هدف المشروع» في ملف المشاريع المكتملة).</div>`}
          ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}</div>
        <div class="card"><h2>ملخص المنجزات</h2><div class="facts" style="margin-top:0">
          ${tile("خطوط المياه", t.has.water, nf(t.water), "م.ط")}${tile("خطوط الصرف الصحي", t.has.sewer, nf(t.sewer), "م.ط")}
          ${tile("المحابس", t.has.valves, nf(t.valves), "عدد")}${tile("الشبكيات", t.has.networks, nf(t.networks), "عدد")}
          ${tile("خزانات جديدة (إنشاء)", t.has.tanksNew, nf(t.tanksNew), "عدد")}${tile("خزانات مؤهلة (تأهيل)", t.has.tanksReh, nf(t.tanksReh), "عدد")}${t.has.stations ? tile("محطات الضخ", true, nf(t.stations), "عدد") : ""}${extraTiles(Q)}${otherTiles(Q)}</div>${Object.values(t.has).some(Boolean) || extraTiles(Q) || otherTiles(Q) ? "" : `<div class="empty">لا توجد منجزات مسجلة لهذا المشروع.</div>`}</div>
      </div>
      <div class="card" style="margin-top:16px"><h2>خريطة المشروع ${hasLayer ? '<span class="hint">طبقات KMZ حية</span>' : ""}</h2>${mapBlock("cMap", p.id)}</div>`;
    initMap("cMap", p.id, false);
  }
  async function handleDoneExcel(file) {
    const out = $("#cOut"); out.innerHTML = `<div class="msg">جارٍ قراءة ${esc(file.name)}…</div>`;
    try { const buf = await file.arrayBuffer(); S.cPending = HajjParser.parseCompleted(XLSX, buf, CSPEC, file.name); showDonePending(); }
    catch (e) { out.innerHTML = `<div class="msg err">تعذرت قراءة الملف: ${esc(e.message || e)}</div>`; }
  }
  function showDonePending() {
    const out = $("#cOut"); if (!out || !S.cPending) return;
    const { data, warnings, errors } = S.cPending;
    const size = new Blob([JSON.stringify(data)]).size;
    if (size > 240000 && !errors.some(e => /حجم/.test(e))) errors.push("حجم البيانات كبير جداً (" + Math.round(size / 1024) + " KB) — الحد 240 KB.");
    const ys = [...new Set(data.projects.map(p => p.year || 0))].sort((a, b) => b - a);
    out.innerHTML = `<div class="msg ${errors.length ? "err" : warnings.length ? "warn" : "ok"}"><b>معاينة:</b> ${data.projects.length} مشروعاً · ${data.quantities.length} بند منجزات
      <div class="small">${ys.map(y => (y || "غير محدد") + ": " + data.projects.filter(p => (p.year || 0) === y).length).join(" · ")}</div>
      ${errors.length ? `<ul>${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${warnings.length ? `<details style="margin-top:6px"><summary>${warnings.length} ملاحظة</summary><ul>${warnings.slice(0, 40).map(e => `<li>${esc(e)}</li>`).join("")}</ul></details>` : ""}</div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="cSave" ${errors.length ? "disabled" : ""}>حفظ ونشر</button><button class="btn" id="cCancel">إلغاء</button></div>`;
    $("#cCancel").onclick = () => { S.cPending = null; out.innerHTML = ""; $("#cFile").value = ""; };
    $("#cSave").onclick = async () => {
      const btn = $("#cSave"); btn.disabled = true; btn.textContent = "جارٍ الحفظ…";
      try { await S.db.doc("completed/data").set({ ...data, uploadedAt: new Date().toISOString() }); S.cPending = null; toast("تم حفظ قائمة المشاريع المكتملة"); location.hash = "#done"; }
      catch (e) { btn.disabled = false; btn.textContent = "حفظ ونشر"; out.insertAdjacentHTML("beforeend", `<div class="msg err">${e && e.code === "invalid_argument" ? "لا تملك صلاحية الحفظ أو أن البيانات أكبر من المسموح." : "تعذر الحفظ: " + esc((e && (e.message || e.code)) || e)}</div>`); }
    };
  }
  async function downloadDone() {
    if (!S.done || !S.downloads) return;
    try { await S.downloads.save({ filename: "المشاريع-المكتملة.xlsx", data: new Blob([HajjParser.completedToWorkbook(XLSX, S.done, CSPEC)]) }); }
    catch (e) { if (e && e.code !== "declined") toast("تعذر التنزيل: " + (e.code || e.message)); }
  }

  // ---------- one KMZ with every completed project's layers (year folder → project folder → layer folder) ----------
  const xe = s => String(s == null ? "" : s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  function kmlColor(hex, a) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "") || [0, "2a", "78", "d6"]; return (a || "ff") + m[3] + m[2] + m[1]; }
  function kmlCoords(c) { return c.map(p => (+p[0]).toFixed(7) + "," + (+p[1]).toFixed(7) + (p[2] != null ? "," + p[2] : "")).join(" "); }
  function kmlGeom(g) {
    if (!g) return "";
    switch (g.type) {
      case "Point": return `<Point><coordinates>${kmlCoords([g.coordinates])}</coordinates></Point>`;
      case "LineString": return `<LineString><tessellate>1</tessellate><coordinates>${kmlCoords(g.coordinates)}</coordinates></LineString>`;
      case "Polygon": return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(g.coordinates[0] || [])}</coordinates></LinearRing></outerBoundaryIs>${g.coordinates.slice(1).map(r => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(r)}</coordinates></LinearRing></innerBoundaryIs>`).join("")}</Polygon>`;
      case "MultiPoint": return `<MultiGeometry>${g.coordinates.map(c => kmlGeom({ type: "Point", coordinates: c })).join("")}</MultiGeometry>`;
      case "MultiLineString": return `<MultiGeometry>${g.coordinates.map(c => kmlGeom({ type: "LineString", coordinates: c })).join("")}</MultiGeometry>`;
      case "MultiPolygon": return `<MultiGeometry>${g.coordinates.map(c => kmlGeom({ type: "Polygon", coordinates: c })).join("")}</MultiGeometry>`;
      case "GeometryCollection": return `<MultiGeometry>${(g.geometries || []).map(kmlGeom).join("")}</MultiGeometry>`;
    }
    return "";
  }
  function kmlPlacemark(ft, pid, lid, style) {
    const p = ft.properties || {}, data = [["project_id", pid], ["layer_id", lid]];
    Object.keys(p).forEach(k => { if (!k.startsWith("_") && !/^(stroke|fill|icon|label|marker)/.test(k) && k !== "name" && p[k] != null && typeof p[k] !== "object") data.push([k, p[k]]); });
    return `<Placemark><name>${xe(p.name || "")}</name><styleUrl>#${style}</styleUrl><ExtendedData>${data.map(([k, v]) => `<Data name="${xe(k)}"><value>${xe(v)}</value></Data>`).join("")}</ExtendedData>${kmlGeom(ft.geometry)}</Placemark>`;
  }
  async function downloadDoneKmz() {
    const D = S.done; if (!D || !S.downloads) return;
    const btn = $("#dlDoneKmz"); btn.disabled = true; const label = btn.textContent; btn.textContent = "جارٍ تجهيز الملف…";
    try {
      const ids = new Set(D.projects.map(p => p.id));
      const lays = S.layers.filter(l => ids.has(l.pid));
      let missing = 0, out = [];
      for (const y of doneYears()) {
        const ps = D.projects.filter(p => (p.year || 0) === y);
        let yf = "";
        for (const p of ps) {
          const pl = lays.filter(l => l.pid === p.id);
          let pf = "";
          for (const l of pl) {
            const g = await loadGeo(l); if (!g || !g.features) { missing++; continue; }
            pf += `<Folder><name>${xe(l.name)}</name><description>${xe("layer_id: " + l.id + (l.fileName ? " · " + l.fileName : ""))}</description>` +
              g.features.map(ft => { const k = (ft.properties && ft.properties._k) || l.kind; return kmlPlacemark(ft, p.id, l.id, k === "sewer" ? "sewer" : "water"); }).join("") + `</Folder>`;
          }
          yf += `<Folder><name>${xe(p.id + " · " + p.name)}</name><description>${xe([p.type, p.location, p.status].filter(Boolean).join(" · "))}</description><ExtendedData><Data name="project_id"><value>${xe(p.id)}</value></Data><Data name="year"><value>${xe(p.year || "")}</value></Data></ExtendedData>${pf || ""}</Folder>`;
        }
        out.push(`<Folder><name>${xe("مشاريع منتهية " + (y ? y + "هـ" : "غير محدد"))}</name>${yf}</Folder>`);
      }
      const st = (id, c) => `<Style id="${id}"><LineStyle><color>${kmlColor(c)}</color><width>4</width></LineStyle><PolyStyle><color>${kmlColor(c, "66")}</color></PolyStyle><IconStyle><color>${kmlColor(c)}</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`;
      const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>المشاريع المكتملة – خدمة الحج</name>${st("water", WATER)}${st("sewer", SEWER)}${out.join("")}</Document></kml>`;
      // .kmz is not on the downloads allowlist, so the KMZ goes inside a .zip (unzip → المشاريع-المكتملة.kmz)
      const kz = new JSZip(); kz.file("doc.kml", kml);
      const kmz = await kz.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      const outer = new JSZip(); outer.file("المشاريع-المكتملة.kmz", kmz);
      const blob = await outer.generateAsync({ type: "blob", compression: "STORE" });
      await S.downloads.save({ filename: "المشاريع-المكتملة-KMZ.zip", data: blob });
      toast(`تم تجهيز الملف: ${lays.length - missing} طبقة لـ ${new Set(lays.map(l => l.pid)).size} مشروعاً` + (missing ? ` (تعذر تحميل ${missing})` : ""));
    } catch (e) { if (e && e.code !== "declined") toast("تعذر التنزيل: " + (e.code || e.message)), console.error("kmz export", e); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------- boot ----------
  function useDoneBaseline() { if (window.DONE_BASELINE && !S.done) { S.done = window.DONE_BASELINE; S.doneSource = "baseline"; } }
  function useBaseline() {
    if (!window.BASELINE) return;
    S.weeks = [{ weekId: BASELINE.weekId, uploadedAt: null, sourceFile: BASELINE.sourceFile, data: BASELINE, baseline: true }];
    S.weekId = BASELINE.weekId;
  }
  function setBanner(t) { S.bannerText = t || ""; showBanner(); }
  function showBanner() { const b = $("#banner"); if (!S.bannerText || section() !== "cur") { b.hidden = true; return; } b.hidden = false; b.textContent = S.bannerText; }

  async function connect() {
    if (STATIC) { if (await useStatic()) return; S.source = "baseline"; render(); return; }
    if (!window.claude || typeof window.claude.use !== "function") {
      if (!connect._retry) { connect._retry = 1; setTimeout(connect, 1200); }
      S.source = "baseline"; render(); return;
    }
    S.source = "loading"; renderHeader(curWeek());
    let db = null;
    try { db = await window.claude.use("db"); } catch (e) { db = null; }
    if (!db) { if (await useSnapshot()) return; if (window.OSMBase) OSMBase.noStore(); S.source = "baseline"; render(); return; }
    S.db = db;
    try { S.user = await window.claude.use("user"); } catch (e) { S.user = null; }
    try { S.assets = await window.claude.use("assets"); } catch (e) { S.assets = null; }
    try { S.downloads = await window.claude.use("downloads"); } catch (e) { S.downloads = null; }
    let w = null; try { w = S.user ? await S.user.can("data.write") : null; } catch (e) { w = null; }
    S.canWrite = w !== false; S.isEditor = w === true || !!S.assets;
    if (window.OSMBase) OSMBase.setStore({ db, assets: S.assets, canWrite: S.canWrite && !!S.assets });
    if (window.OSMBase) OSMBase.onChange(() => { if (route() === "data") rerender(); });

    let gotWeeks = false;
    const timer = setTimeout(() => { if (!gotWeeks) { S.source = "baseline"; setBanner("تعذّر الوصول إلى البيانات المحفوظة حالياً — تُعرض بيانات التقرير المضمّنة (07 نوفمبر 2026)."); render(); } }, 10000);
    db.collection("weeks").orderBy("weekId", "asc").onSnapshot(snap => {
      if (!snap.metadata.fromCache) { gotWeeks = true; clearTimeout(timer); setBanner(null); }
      const rows = snap.docs.map(d => d.data()).filter(d => d && d.data && d.weekId);
      // weeks shipped with the page (pending.js) are shown until saved, and saved by an editor
      (window.PENDING_WEEKS || []).forEach(pw => { if (!pw || !pw.weekId) return; const i = rows.findIndex(r => r.weekId === pw.weekId), ex = i >= 0 ? rows[i] : null; if (ex && (ex.rev || 0) >= (pw.rev || 0)) return; if (ex) rows[i] = pw; else rows.push(pw); if (S.canWrite && !snap.metadata.fromCache && !savingPending[pw.weekId]) { savingPending[pw.weekId] = 1; db.doc("weeks/" + pw.weekId).set(pw).catch(() => { savingPending[pw.weekId] = 0; }); } });
      rows.sort((a, b) => a.weekId < b.weekId ? -1 : 1);
      if (!rows.length) {
        if (!snap.metadata.fromCache && S.canWrite && window.SEED_REF) seedImport(db);
        if (!snap.metadata.fromCache) { useBaseline(); S.source = "live"; setBanner("لا توجد أسابيع محفوظة بعد — تُعرض بيانات التقرير المضمّنة. ارفع ملف Excel من «إدارة البيانات» لبدء السجل."); }
      } else {
        const keep = S.weekId && rows.some(r => r.weekId === S.weekId) && S.weekId !== (S.weeks[S.weeks.length - 1] || {}).weekId;
        S.weeks = rows; S.source = "live";
        if (!keep) S.weekId = rows[rows.length - 1].weekId;
      }
      rerender();
    }, err => { clearTimeout(timer); S.source = "baseline"; setBanner("تعذّر تحميل البيانات المحفوظة — تُعرض بيانات التقرير المضمّنة."); rerender(); });
    if (S.canWrite) runImports(db);
    if (S.assets) setTimeout(async () => { try { const r = await db.doc("exports/static").get(); if (r.exists && r.data() && r.data().pending) { const t = setInterval(() => { if (S.weeks.length && !S.weeks[0].baseline && S.done && S.layers && S.layers.length) { clearInterval(t); exportStatic(true); } }, 1500); } } catch (e) { } }, 3000);
    // (public snapshot publishing is off in this copy)
    db.doc("completed/data").onSnapshot(snap => {
      if (snap.exists) {
        const d = snap.data();
        // large lists can be kept in a stored file: {dataAsset} points at JSON {projects, quantities}
        if (d && d.dataAsset && !Array.isArray(d.projects)) {
          fetch(blobURL(d.dataAsset)).then(r => r.ok ? r.json() : null).then(x => {
            if (x && Array.isArray(x.projects)) { S.done = { ...d, ...x }; S.doneSource = "live"; rerender(); }
          }).catch(() => { });
          return;
        }
        if (d && Array.isArray(d.projects)) { S.done = d; S.doneSource = "live"; }
      }
      else if (!snap.metadata.fromCache) { useDoneBaseline(); }
      rerender();
    }, () => { });
    db.collection("maps").onSnapshot(snap => {
      S.layers = snap.docs.map(d => d.data()).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
      rerender();
    }, () => { });
  }
  async function useStatic() {
    try {
      const r = await fetch("data/snapshot.json?v=" + (window.STATIC_VER || "")); if (!r.ok) return false;
      const d = await r.json(); if (!d || !Array.isArray(d.weeks) || !d.weeks.length) return false;
      S.staticAt = d.exportedAt || null;
      S.weeks = d.weeks.slice().sort((a, b) => a.weekId < b.weekId ? -1 : 1);
      S.weekId = S.weeks[S.weeks.length - 1].weekId;
      S.layers = (d.layers || []).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
      if (d.done && Array.isArray(d.done.projects)) { S.done = d.done; S.doneSource = "live"; }
      S.source = "snapshot";
      if (window.OSMBase) {
        if (d.basemap) OSMBase.setStore({ db: { doc: () => ({ onSnapshot: cb => { cb({ exists: true, data: () => d.basemap, metadata: {} }); return () => { }; } }) }, canWrite: false });
        else OSMBase.noStore();
      }
      render(); return true;
    } catch (e) { return false; }
  }
  // Export everything (weeks, maps, completed projects, basemap and every stored file) as a ZIP for a static copy (GitHub Pages)
  async function exportStatic(auto) {
    auto = auto === true;
    if (!S.db || !(S.assets || S.downloads)) return;
    const btn = $("#dlStatic"), label = btn ? btn.textContent : "";
    try {
      if (btn) { btn.disabled = true; btn.textContent = "جارٍ التجهيز…"; }
      let basemap = null; try { const b = await S.db.doc("basemap/osm").get(); basemap = b.exists ? b.data() : null; } catch (e) { }
      const snap = { exportedAt: new Date().toISOString(), weeks: S.weeks.filter(w => !w.baseline).map(w => ({ weekId: w.weekId, uploadedAt: w.uploadedAt || null, sourceFile: w.sourceFile || null, data: w.data })), layers: S.layers, done: S.done || null, basemap };
      const ids = new Set();
      (S.layers || []).forEach(l => { if (l.geoAsset) ids.add(l.geoAsset); (l.overlays || []).forEach(o => o.assetId && ids.add(o.assetId)); });
      if (basemap) ["main", "bld_mash", "bld_mak", "bld"].forEach(k => basemap[k] && basemap[k].assetId && ids.add(basemap[k].assetId));
      const z = new JSZip(); z.file("data/snapshot.json", JSON.stringify(snap));
      let n = 0, miss = 0;
      for (const id of ids) {
        try { const r = await fetch("/_blob/" + id); if (!r.ok) { miss++; continue; } z.file("data/blob/" + id, await r.arrayBuffer()); } catch (e) { miss++; }
        n++; if (btn) btn.textContent = "تحميل الملفات " + n + "/" + ids.size + "…";
      }
      if (btn) btn.textContent = "ضغط الملف…";
      const blob = await z.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
      if (S.assets) {
        if (btn) btn.textContent = "رفع النسخة…";
        // stored files accept text only: the ZIP is kept as base64 text in parts of 3 MB
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = rej; fr.readAsDataURL(blob); });
        const parts = [], N = 3000000;
        for (let i = 0; i < b64.length; i += N) { const up = await S.assets.upload(new Blob([b64.slice(i, i + N)], { type: "text/plain" }), { type: "text/plain" }); parts.push(up.id); if (btn) btn.textContent = "رفع الجزء " + parts.length + "…"; }
        await S.db.doc("exports/static").set({ parts, at: new Date().toISOString(), files: ids.size, missing: miss, bytes: blob.size, b64: b64.length, pending: false });
      }
      if (!auto && S.downloads) { try { await S.downloads.save({ filename: "dashboard-data.zip", data: blob }); } catch (e) { } }
      toast("تم تجهيز نسخة GitHub" + (miss ? " (تعذّر " + miss + " ملف)" : ""));
    } catch (e) { toast("تعذّر التصدير: " + (e.message || e)); }
    finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
  }
  // ---------- public snapshot ----------
  // Viewers who are not signed in to Claude cannot read the database. While an editor has the dashboard open,
  // the page saves a copy of the current data (weeks, maps, completed projects, basemap) as a stored file;
  // snapshot-ref.js points at that file, so shared viewers see the same latest week and maps.
  function hashStr(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ":" + t.length; }
  async function publishSnapshot(db) {
    try {
      if (!S.weeks.length || S.weeks[0].baseline) return;
      let basemap = null; try { const b = await db.doc("basemap/osm").get(); basemap = b.exists ? b.data() : null; } catch (e) { }
      const snap = { weeks: S.weeks.map(w => ({ weekId: w.weekId, uploadedAt: w.uploadedAt || null, sourceFile: w.sourceFile || null, data: w.data })), layers: S.layers, done: S.done || null, basemap };
      const txt = JSON.stringify(snap), h = hashStr(txt);
      const ref = db.doc("public/snapshot"); const cur = await ref.get();
      const old = cur.exists ? cur.data() : null;
      if (old && old.hash === h) return;
      const up = await S.assets.upload(new Blob([txt], { type: "application/json" }));
      await ref.set({ assetId: up.id, hash: h, at: new Date().toISOString(), lastWeek: S.weeks[S.weeks.length - 1].weekId });
      if (old && old.assetId && old.assetId !== up.id && old.assetId !== (window.SNAP_REF || {}).assetId) { try { await S.assets.delete(old.assetId); } catch (e) { } }
    } catch (e) { /* tried again on the next visit */ }
  }
  async function useSnapshot() {
    const R = window.SNAP_REF; if (!R || !R.assetId) return false;
    try {
      const r = await fetch("/_blob/" + R.assetId); if (!r.ok) return false;
      const d = await r.json(); if (!d || !Array.isArray(d.weeks) || !d.weeks.length) return false;
      S.weeks = d.weeks.slice().sort((a, b) => a.weekId < b.weekId ? -1 : 1);
      S.weekId = S.weeks[S.weeks.length - 1].weekId;
      S.layers = (d.layers || []).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
      if (d.done && Array.isArray(d.done.projects)) { S.done = d.done; S.doneSource = "live"; }
      S.source = "snapshot";
      if (window.OSMBase) {
        if (d.basemap) OSMBase.setStore({ db: { doc: () => ({ onSnapshot: cb => { cb({ exists: true, data: () => d.basemap, metadata: {} }); return () => { }; } }) }, canWrite: false });
        else OSMBase.noStore();
      }
      render(); return true;
    } catch (e) { return false; }
  }

  // One-time copy of the original dashboard's data (weeks, maps, completed projects, basemap) into this copy's empty database
  let seeding = false;
  async function seedImport(db) {
    if (seeding) return; seeding = true;
    try {
      const flag = await db.doc("imports/seed").get();
      if (flag.exists && flag.data() && flag.data().done) return;
      setBanner("جارٍ نسخ بيانات الداشبورد الأصلي إلى هذه النسخة…");
      const r = await fetch("/_blob/" + window.SEED_REF.assetId); if (!r.ok) throw new Error("seed " + r.status);
      let txt = await r.text();
      const M = window.SEED_REF.idMap || {}; for (const k in M) txt = txt.split(k).join(M[k]); // asset ids differ in this copy
      const d = JSON.parse(txt);
      for (const w of d.weeks || []) await db.doc("weeks/" + w.weekId).set({ weekId: w.weekId, uploadedAt: w.uploadedAt || null, sourceFile: w.sourceFile || null, data: w.data });
      for (const l of d.layers || []) if (l && l.id) await db.doc("maps/" + l.id).set(l);
      if (d.done) await db.doc("completed/data").set(d.done);
      if (d.basemap) await db.doc("basemap/osm").set(d.basemap);
      await db.doc("imports/seed").set({ done: true, at: new Date().toISOString(), weeks: (d.weeks || []).length, maps: (d.layers || []).length });
      setBanner(null); toast("تم نسخ بيانات الداشبورد الأصلي");
    } catch (e) { setBanner("تعذّر نسخ البيانات: " + (e.message || e) + " — أعد فتح الصفحة للمحاولة مرة أخرى."); }
    finally { seeding = false; }
  }

  // One-time import of weeks prepared as stored files (imports/weeks lists {weekId, asset}); never overwrites a saved week.
  const savingPending = {};
  async function runImports(db) {
    try {
      const ref = db.doc("imports/weeks");
      const d = await ref.get();
      if (!d.exists) return;
      const v = d.data();
      if (!v || v.done || !Array.isArray(v.items)) return;
      let n = 0;
      for (const it of v.items) {
        const ex = await db.doc("weeks/" + it.weekId).get();
        if (ex.exists && !it.overwrite) continue;
        const r = await fetch("/_blob/" + it.asset);
        if (!r.ok) continue;
        const w = await r.json();
        if (!w || !w.projects || w.weekId !== it.weekId) continue;
        await db.doc("weeks/" + it.weekId).set({ weekId: it.weekId, uploadedAt: new Date().toISOString(), sourceFile: w.sourceFile || null, data: w });
        n++;
      }
      await ref.update({ done: true, doneAt: new Date().toISOString(), imported: n });
      if (n) toast("تمت إضافة " + n + " أسابيع سابقة إلى السجل");
    } catch (e) { /* retried on the next visit */ }
  }

  // avoid re-rendering while the user is mid-way through the data page forms
  let rrT = null;
  function rerender() {
    clearTimeout(rrT);
    rrT = setTimeout(() => {
      const act = document.activeElement;
      if (route() === "data" && act && /INPUT|SELECT/.test(act.tagName) && act.type !== "file") { renderHeader(curWeek()); return; }
      const y = window.scrollY; render(); window.scrollTo(0, y);
    }, 120);
  }

  $("#weekSel").addEventListener("change", e => { S.weekId = e.target.value; render(); });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  window.addEventListener("resize", () => S.maps.forEach(m => m.invalidateSize()));
  useBaseline();
  useDoneBaseline();
  render();
  connect();
})();
