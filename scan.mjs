// permit-watch scanner: one file, no dependencies, Node 20+.
// RESORT=dlr  -> City of Anaheim Accela building records (Disneyland Resort)
// RESORT=wdw  -> SFWMD environmental resource applications + CFTOD board documents (Walt Disney World)
//
// Writes:
//   data/scan/records.csv   every record the scanner has ever seen, latest state
//   data/scan/log.csv       every change ever detected (append only)
//   data/scan/health.json   per-source result of the last run
//   data/scan/events.txt    this run's changes in plain text (empty = nothing moved)
//
// It never touches data/permits.json (the hand-curated feed).

import fs from "node:fs";
import path from "node:path";

const RESORT = (process.env.RESORT || "").toLowerCase();
if (!["dlr", "wdw"].includes(RESORT)) {
  console.error("Set RESORT=dlr or RESORT=wdw");
  process.exit(2);
}
const DIR = "data/scan";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 180);
const now = new Date();
const stamp = now.toISOString().replace(/\.\d+Z$/, "Z");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdY = (d) =>
  `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const decode = (s) =>
  String(s)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (header, objs) =>
  [header.join(","), ...objs.map((o) => header.map((h) => csvCell(o[h])).join(","))].join("\n") + "\n";
function readCSVObjects(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  if (!rows.length) return [];
  const [h, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
}

function session() {
  const jar = new Map();
  return async function req(url, opts = {}) {
    const headers = { "User-Agent": UA, ...(opts.headers || {}) };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { ...opts, headers, redirect: "follow", signal: AbortSignal.timeout(90000) });
        for (const sc of res.headers.getSetCookie?.() || []) {
          const [pair] = sc.split(";");
          const eq = pair.indexOf("=");
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        if (res.status >= 500 && attempt < 3) { await sleep(3000 * attempt); continue; }
        return res;
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(3000 * attempt);
      }
    }
  };
}

const ACA = "https://aca-prod.accela.com/ANAHEIM";
const ACA_SEARCH = `${ACA}/Cap/CapHome.aspx?module=Building&TabName=Building`;
const ACA_STREETS = ["DISNEYLAND", "HARBOR", "MAGIC", "KATELLA", "WEST", "BALL"];
const DISNEY_DESC =
  /^\s*(DLR|DL|DCA|DTD|GCH|DLH|PPH|TDA|DRC)\b|\bDISNEY|\bEASTERN GATEWAY\b|\bTOY STORY (LOT|PARKING)\b/i;
const P = "ctl00$PlaceHolderMain$generalSearchForm$";

function hiddenFields(html) {
  const out = {};
  for (const tag of html.match(/<input[^>]*>/g) || []) {
    if (!/type="hidden"/i.test(tag)) continue;
    const n = tag.match(/name="([^"]+)"/);
    const v = tag.match(/value="([^"]*)"/);
    if (n) out[n[1]] = v ? decode(v[1]) : "";
  }
  return out;
}

async function acaSearch(street, start, end) {
  const req = session();
  const hdr = { Referer: ACA_SEARCH, Origin: "https://aca-prod.accela.com", "Content-Type": "application/x-www-form-urlencoded" };
  const page = await (await req(ACA_SEARCH)).text();
  const fields = { [P + "txtGSStartDate"]: mdY(start), [P + "txtGSEndDate"]: mdY(end), [P + "txtGSStreetName"]: street };
  const f1 = { ...hiddenFields(page), ...fields, __EVENTTARGET: "ctl00$PlaceHolderMain$btnNewSearch", __EVENTARGUMENT: "" };
  const res = await (await req(ACA_SEARCH, { method: "POST", headers: hdr, body: new URLSearchParams(f1) })).text();
  if (/cross-site request forgery/i.test(res)) throw new Error("Accela rejected the search (CSRF check)");
  if (/returned no results|no records found/i.test(res) && !/Showing \d+-\d+ of/.test(res)) return [];
  if (!/Showing \d+-\d+ of/.test(res)) throw new Error(`Accela search for ${street} returned no result grid`);
  const f2 = {
    ...hiddenFields(res), ...fields,
    __EVENTTARGET: "ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$gdvPermitListtop4btnExport", __EVENTARGUMENT: "",
  };
  await req(ACA_SEARCH, { method: "POST", headers: hdr, body: new URLSearchParams(f2) });
  const csvRes = await req(`${ACA}/Export2CSV.ashx?flag=${Date.now() % 10000}`, { headers: { Referer: ACA_SEARCH } });
  const text = await csvRes.text();
  if (!/^"?Application Date/.test(text)) throw new Error(`Accela export for ${street} was not a CSV`);
  const [h, ...rows] = parseCSV(text);
  return rows.map((r) => Object.fromEntries(h.map((k, i) => [clean(k), clean(r[i])])));
}

async function scanAnaheim() {
  const out = new Map();
  let calls = 0;
  const since = addDays(now, -LOOKBACK_DAYS);
  for (const street of ACA_STREETS) {
    for (let s = since; s < now; s = addDays(s, 30)) {
      const e = addDays(s, 29) > now ? now : addDays(s, 29);
      const rows = await acaSearch(street, s, e);
      calls++;
      for (const r of rows) {
        const num = r["Record Number"];
        if (!num || !DISNEY_DESC.test(r["Description"] || "")) continue;
        const parent = (num.match(/^(.*?)-REV\d+$/) || [])[1] || "";
        out.set(`anaheim:${num}`, {
          key: `anaheim:${num}`, source: "anaheim-accela", number: num, parent,
          date: r["Application Date"], type: r["Record Type"], status: r["Status"],
          address: r["Address"], title: r["Description"], expires: r["Expiration Date"], link: ACA_SEARCH,
        });
      }
      await sleep(1200);
    }
  }
  return { records: [...out.values()], note: `${calls} searches across ${ACA_STREETS.length} streets` };
}

const SFWMD =
  "https://geoweb.sfwmd.gov/agsext1/rest/services/Regulation_ApplicationPermits/EnvironmentalResourceApplications_RegPermitting/MapServer/16/query";
const WDW_BBOX = "-81.64,28.33,-81.49,28.44";
const WDW_KEEP = /LAKE BUENA VISTA|BAY LAKE|DISNEY|BUENA VISTA CONSTRUCTION|REEDY CREEK|CFTOD/i;

async function scanSFWMD() {
  const since = isoDay(addDays(now, -LOOKBACK_DAYS));
  const qs = new URLSearchParams({
    where: `AppReceivedDate >= DATE '${since}'`,
    geometry: WDW_BBOX, geometryType: "esriGeometryEnvelope", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields:
      "APP_NO,PERMIT_NO,PROJECT_NAME,AppTypeDesc,PermitType,FullNameOrCompany,ApplicantCompanyName,AppStatus,PermitStatus,AppReceivedDate,IssueDate,City,ProjectAcres",
    returnGeometry: "false", orderByFields: "AppReceivedDate DESC", resultRecordCount: "2000", f: "json",
  });
  const res = await session()(`${SFWMD}?${qs}`);
  const d = await res.json();
  if (d.error) throw new Error(`SFWMD: ${d.error.message || JSON.stringify(d.error)}`);
  const day = (ms) => (ms ? isoDay(new Date(ms)) : "");
  const records = [];
  let seen = 0;
  for (const { attributes: a } of d.features || []) {
    seen++;
    const hay = [a.City, a.PROJECT_NAME, a.FullNameOrCompany, a.ApplicantCompanyName].join(" | ");
    if (!WDW_KEEP.test(hay)) continue;
    records.push({
      key: `sfwmd:${a.APP_NO}`, source: "sfwmd-erp", number: a.APP_NO, parent: a.PERMIT_NO || "",
      date: day(a.AppReceivedDate), type: clean(a.AppTypeDesc || a.PermitType), status: clean(a.AppStatus),
      address: clean(a.City), title: clean(a.PROJECT_NAME),
      expires: day(a.IssueDate) ? `issued ${day(a.IssueDate)}` : "", link: "https://www.sfwmd.gov/regpermitting",
    });
  }
  return { records, note: `${seen} applications in the WDW box, ${records.length} kept` };
}

const CFTOD_MEDIA = "https://www.oversightdistrict.org/wp-json/wp/v2/media";
const CFTOD_KEEP = /agenda|packet|minutes|planning-board|\bbos\b|-bos-|pcb|resolution|budget|master-plan|comprehensive-plan/i;

async function scanCFTOD() {
  const req = session();
  const records = [];
  const since = addDays(now, -LOOKBACK_DAYS).toISOString().slice(0, 19);
  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    const qs = new URLSearchParams({
      per_page: "100", page: String(pageNo), orderby: "date", order: "desc", after: since,
      _fields: "id,date,title,source_url,mime_type",
    });
    const res = await req(`${CFTOD_MEDIA}?${qs}`, { headers: { Accept: "application/json" } });
    if (res.status === 400 && pageNo > 1) break;
    const txt = await res.text();
    if (!txt.trim().startsWith("[")) throw new Error(`CFTOD media API returned ${res.status}, not JSON`);
    const items = JSON.parse(txt);
    for (const m of items) {
      const file = decodeURIComponent(m.source_url.split("/").pop());
      if (m.mime_type !== "application/pdf" || !CFTOD_KEEP.test(file)) continue;
      records.push({
        key: `cftod:${m.id}`, source: "cftod-docs", number: file, parent: "",
        date: m.date.slice(0, 10),
        type: /packet/i.test(file) ? "Board packet" : /minutes/i.test(file) ? "Minutes" : /agenda/i.test(file) ? "Agenda" : "Document",
        status: "Posted", address: "Central Florida Tourism Oversight District",
        title: clean(decode(m.title?.rendered || file)), expires: "", link: m.source_url,
      });
    }
    if (items.length < 100) break;
  }
  return { records, note: `${records.length} board documents in window` };
}

const SOURCES = RESORT === "dlr"
  ? { "anaheim-accela": scanAnaheim }
  : { "sfwmd-erp": scanSFWMD, "cftod-docs": scanCFTOD };

const HEADER = ["key", "source", "number", "parent", "date", "type", "status", "address", "title", "expires", "link", "first_seen", "last_seen"];
const LOG_HEADER = ["detected_at", "kind", "key", "source", "number", "from", "to", "title", "link"];

fs.mkdirSync(DIR, { recursive: true });
const prevRows = readCSVObjects(path.join(DIR, "records.csv"));
const prev = new Map(prevRows.map((r) => [r.key, r]));
const firstRun = prevRows.length === 0;
const prevHealth = fs.existsSync(path.join(DIR, "health.json"))
  ? JSON.parse(fs.readFileSync(path.join(DIR, "health.json"), "utf8"))
  : { sources: {} };

const health = { resort: RESORT, run_at: stamp, lookback_days: LOOKBACK_DAYS, sources: {} };
const events = [];
const logRows = [];
const next = new Map(prev);

for (const [name, fn] of Object.entries(SOURCES)) {
  const t0 = Date.now();
  try {
    const { records, note } = await fn();
    health.sources[name] = { ok: true, records: records.length, note, seconds: Math.round((Date.now() - t0) / 1000) };
    for (const r of records) {
      const old = prev.get(r.key);
      const row = { ...r, first_seen: old?.first_seen || stamp, last_seen: stamp };
      next.set(r.key, row);
      if (!old) {
        if (!firstRun) {
          events.push(`NEW  ${r.source}  ${r.number}  ${r.date}  ${r.status}  ${r.title}`);
          logRows.push({ detected_at: stamp, kind: "NEW", key: r.key, source: r.source, number: r.number, from: "", to: r.status, title: r.title, link: r.link });
        }
      } else {
        if (old.status !== r.status) {
          events.push(`STATUS  ${r.source}  ${r.number}  ${old.status} -> ${r.status}  ${r.title}`);
          logRows.push({ detected_at: stamp, kind: "STATUS", key: r.key, source: r.source, number: r.number, from: old.status, to: r.status, title: r.title, link: r.link });
        }
        if (old.title !== r.title && old.title && r.title) {
          events.push(`DETAIL  ${r.source}  ${r.number}  description changed: ${r.title}`);
          logRows.push({ detected_at: stamp, kind: "DETAIL", key: r.key, source: r.source, number: r.number, from: old.title, to: r.title, title: r.title, link: r.link });
        }
      }
    }
  } catch (e) {
    health.sources[name] = { ok: false, error: String(e.message || e), seconds: Math.round((Date.now() - t0) / 1000) };
  }
  const was = prevHealth.sources?.[name]?.ok;
  const is = health.sources[name].ok;
  if (was === true && is === false) events.push(`SOURCE DOWN  ${name}: ${health.sources[name].error}`);
  if (was === false && is === true) events.push(`SOURCE BACK  ${name}`);
  if (was === undefined && is === false) events.push(`SOURCE DOWN  ${name}: ${health.sources[name].error}`);
}

const sorted = [...next.values()].sort((a, b) => String(b.first_seen).localeCompare(String(a.first_seen)) || String(a.key).localeCompare(String(b.key)));
fs.writeFileSync(path.join(DIR, "records.csv"), toCSV(HEADER, sorted));
const logFile = path.join(DIR, "log.csv");
if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, LOG_HEADER.join(",") + "\n");
if (logRows.length) fs.appendFileSync(logFile, logRows.map((o) => LOG_HEADER.map((h) => csvCell(o[h])).join(",")).join("\n") + "\n");
fs.writeFileSync(path.join(DIR, "health.json"), JSON.stringify(health, null, 2) + "\n");
fs.writeFileSync(path.join(DIR, "events.txt"), events.length ? events.join("\n") + "\n" : "");

const allFailed = Object.values(health.sources).every((s) => !s.ok);
console.log(JSON.stringify({ resort: RESORT, firstRun, records: sorted.length, events: events.length, health: health.sources }, null, 2));
if (firstRun) console.log("Baseline run: records saved, nothing reported as new.");
if (allFailed) process.exit(1);
