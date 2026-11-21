/* Weekly workbook <-> week object. Works in the browser (window.HajjParser) and in Node (module.exports). */
(function (root) {
  "use strict";

  function pad(n) { return String(n).padStart(2, "0"); }
  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function isBlank(v) { return v == null || (typeof v === "string" && v.trim() === ""); }

  function toDate(XLSX, v) {
    if (isBlank(v)) return null;
    if (typeof v === "number" && isFinite(v)) {
      const d = XLSX.SSF.parse_date_code(v);
      if (!d) return null;
      return d.y + "-" + pad(d.m) + "-" + pad(d.d);
    }
    if (v instanceof Date && !isNaN(v)) return v.getFullYear() + "-" + pad(v.getMonth() + 1) + "-" + pad(v.getDate());
    const s = clean(v);
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
    if (m) return m[3] + "-" + pad(+m[2]) + "-" + pad(+m[1]);
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/);
    if (m && months[m[2].toLowerCase()]) {
      const y = m[3].length === 2 ? "20" + m[3] : m[3];
      return y + "-" + pad(months[m[2].toLowerCase()]) + "-" + pad(+m[1]);
    }
    return null;
  }
  function toNum(v) {
    if (isBlank(v)) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const s = clean(v).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[,٬\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return null;
  }
  function toPct(v) {
    if (isBlank(v)) return null;
    if (typeof v === "string" && v.indexOf("%") >= 0) {
      const n = toNum(v.replace("%", ""));
      return n == null ? null : n / 100;
    }
    const n = toNum(v);
    if (n == null) return null;
    return n > 1.5 ? n / 100 : n; // tolerate 16.65 typed as a plain number
  }

  function convert(XLSX, v, t) {
    if (t === "num") return toNum(v);
    if (t === "pct") return toPct(v);
    if (t === "date") return toDate(XLSX, v);
    if (t === "dateortext") {
      if (typeof v === "number") return toDate(XLSX, v);
      const d = toDate(XLSX, v);
      return d || (isBlank(v) ? null : clean(v));
    }
    if (isBlank(v)) return null;
    return typeof v === "string" ? v.trim() : String(v);
  }

  function findSheet(wb, name) {
    if (wb.Sheets[name]) return wb.Sheets[name];
    const want = clean(name);
    const hit = wb.SheetNames.find(n => clean(n) === want);
    return hit ? wb.Sheets[hit] : null;
  }

  function readTable(XLSX, wb, spec, warn) {
    const ws = findSheet(wb, spec.sheet);
    if (!ws) { warn.push("الورقة «" + spec.sheet + "» غير موجودة — تُركت فارغة."); return []; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (!rows.length) return [];
    const header = rows[0].map(clean);
    const idx = {};
    spec.cols.forEach(([h, k]) => {
      const i = header.indexOf(clean(h));
      if (i < 0) warn.push("العمود «" + h + "» غير موجود في ورقة «" + spec.sheet + "».");
      idx[k] = i;
    });
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const obj = {}; let any = false;
      spec.cols.forEach(([h, k, t]) => {
        const i = idx[k];
        const raw = i >= 0 ? row[i] : null;
        const val = convert(XLSX, raw, t);
        if (val != null) any = true;
        obj[k] = val;
        if ((t === "num" || t === "pct") && val == null && !isBlank(raw)) {
          warn.push("«" + spec.sheet + "» صف " + (r + 1) + ": القيمة «" + clean(raw) + "» في عمود «" + h + "» ليست رقماً — اعتُبرت غير مُدخلة.");
        }
      });
      if (any) out.push(obj);
    }
    return out;
  }

  const WEEK_KEYS = ["projects", "quantities", "scopes", "supplies", "permits", "scurve", "impact"];
  function readWb(XLSX, data) {
    return XLSX.read(data, { type: data instanceof ArrayBuffer ? "array" : (typeof data === "string" ? "binary" : "buffer"), cellDates: false });
  }
  function hijriYear(s) { const m = String(s || "").match(/(1[34]\d\d)/); return m ? +m[1] : null; }

  // Completed projects workbook -> {projects, quantities}
  function parseCompleted(XLSX, data, CSPEC, fileName) {
    const wb = readWb(XLSX, data);
    const warn = [], errors = [];
    const projects = readTable(XLSX, wb, CSPEC.projects, warn);
    const quantities = readTable(XLSX, wb, CSPEC.quantities, warn);
    const ids = new Set();
    projects.forEach((p, i) => {
      if (!p.id) { errors.push("المشاريع المكتملة صف " + (i + 2) + ": رمز المشروع مفقود."); return; }
      if (ids.has(p.id)) errors.push("رمز المشروع «" + p.id + "» مكرر."); ids.add(p.id);
      if (p.year == null) p.year = hijriYear(p.endH);
      if (p.year == null) warn.push("المشروع " + p.id + ": سنة الانتهاء الهجرية غير محددة — سيظهر تحت «غير محدد».");
    });
    quantities.forEach(q => { if (q.pid && !ids.has(q.pid)) warn.push("منجزات: الرمز «" + q.pid + "» غير موجود في ورقة المشاريع المكتملة."); });
    if (!projects.length) errors.push("لا توجد مشاريع في ورقة «" + CSPEC.projects.sheet + "».");
    return { data: { projects, quantities, sourceFile: fileName || null }, warnings: Array.from(new Set(warn)), errors };
  }
  function tablesToWorkbook(XLSX, obj, specs, keys, infoRows) {
    const wb = XLSX.utils.book_new();
    if (infoRows) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(infoRows), infoRows.sheet);
    keys.forEach(k => {
      const spec = specs[k];
      const aoa = [spec.cols.map(c => c[0])];
      (obj[k] || []).forEach(r => aoa.push(spec.cols.map(([h, key, t]) => {
        const v = r[key];
        if (v == null) return "";
        if (t === "date" || (t === "dateortext" && /^\d{4}-\d{2}-\d{2}$/.test(v))) { const [y, m, d] = v.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
        return v;
      })));
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "yyyy-mm-dd" });
      spec.cols.forEach(([h, key, t], j) => { if (t !== "pct") return; for (let r = 1; r < aoa.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: j }); if (ws[ref] && typeof ws[ref].v === "number") ws[ref].z = "0.00%"; } });
      ws["!cols"] = spec.cols.map(([h, key]) => ({ wch: /name|objective|scope|note|text|item|contractor|site|plan/.test(key) ? 45 : 16 }));
      XLSX.utils.book_append_sheet(wb, ws, spec.sheet);
    });
    wb.Workbook = { Views: [{ RTL: true }] };
    return XLSX.write(wb, { bookType: "xlsx", type: "array" });
  }
  function completedToWorkbook(XLSX, obj, CSPEC) { return tablesToWorkbook(XLSX, obj, CSPEC, ["projects", "quantities"]); }

  function parseWorkbook(XLSX, data, SPEC, fileName) {
    const wb = readWb(XLSX, data);
    const warn = [];
    const info = {};
    const is = findSheet(wb, SPEC.info.sheet);
    if (!is) warn.push("الورقة «" + SPEC.info.sheet + "» غير موجودة.");
    else {
      const rows = XLSX.utils.sheet_to_json(is, { header: 1, raw: true, defval: null, blankrows: false });
      SPEC.info.keys.forEach(([label, key, t]) => {
        const row = rows.find(r => r && clean(r[0]) === clean(label));
        info[key] = row ? convert(XLSX, row[1], t) : null;
      });
    }
    const week = { info };
    WEEK_KEYS.forEach(k => { week[k] = readTable(XLSX, wb, SPEC[k], warn); });
    // validation
    const errors = [];
    if (!info.reportDate) errors.push("تاريخ التقرير مفقود أو غير صالح في ورقة «بيانات التقرير».");
    const ids = new Set();
    week.projects.forEach((p, i) => {
      if (!p.id) errors.push("المشاريع صف " + (i + 2) + ": رمز المشروع مفقود.");
      else if (ids.has(p.id)) errors.push("رمز المشروع «" + p.id + "» مكرر.");
      else ids.add(p.id);
      if (p.id && p.actual == null) warn.push("المشروع " + p.id + ": الإنجاز الفعلي غير مُدخل.");
    });
    ["quantities", "scopes", "supplies", "permits", "scurve"].forEach(k => {
      week[k].forEach(r => { if (r.pid && !ids.has(r.pid)) warn.push("ورقة «" + SPEC[k].sheet + "»: الرمز «" + r.pid + "» غير موجود في ورقة المشاريع."); });
    });
    week.weekId = info.reportDate || null;
    week.sourceFile = fileName || null;
    return { week, warnings: Array.from(new Set(warn)), errors };
  }

  // Export a week back to a workbook (plain, same structure) so a new week can start from it.
  function weekToWorkbook(XLSX, week, SPEC) {
    const wb = XLSX.utils.book_new();
    const infoRows = [["البند", "القيمة"]].concat(SPEC.info.keys.map(([label, key]) => [label, week.info[key] == null ? "" : week.info[key]]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(infoRows), SPEC.info.sheet);
    WEEK_KEYS.forEach(k => {
      const spec = SPEC[k];
      const aoa = [spec.cols.map(c => c[0])];
      (week[k] || []).forEach(r => aoa.push(spec.cols.map(([h, key, t]) => {
        const v = r[key];
        if (v == null) return "";
        if (t === "date" || (t === "dateortext" && /^\d{4}-\d{2}-\d{2}$/.test(v))) {
          const [y, m, d] = v.split("-").map(Number);
          return new Date(Date.UTC(y, m - 1, d));
        }
        return v;
      })));
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "yyyy-mm-dd" });
      spec.cols.forEach(([h, key, t], j) => {
        if (t !== "pct") return;
        for (let r = 1; r < aoa.length; r++) {
          const ref = XLSX.utils.encode_cell({ r, c: j });
          if (ws[ref] && typeof ws[ref].v === "number") ws[ref].z = "0.00%";
        }
      });
      ws["!cols"] = spec.cols.map(([h, key]) => ({ wch: /name|objective|scope|note|text|item|contractor|site|plan/.test(key) ? 45 : 16 }));
      if (!ws["!views"]) ws["!views"] = [{ RTL: true }];
      XLSX.utils.book_append_sheet(wb, ws, spec.sheet);
    });
    wb.Workbook = { Views: [{ RTL: true }] };
    return XLSX.write(wb, { bookType: "xlsx", type: "array" });
  }

  const api = { parseWorkbook, weekToWorkbook, parseCompleted, completedToWorkbook, hijriYear, toPct, toNum, toDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HajjParser = api;
})(typeof window !== "undefined" ? window : this);
