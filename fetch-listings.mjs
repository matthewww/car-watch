#!/usr/bin/env node
/**
 * AutoTrader KZN multi-search watcher (see config.mjs for the search list).
 * Per search: fetches all kwazulu-natal pages, parses listing tiles, merges
 * with the previous snapshot (firstSeen / lastSeen / priceHistory / removals)
 * and fits a within-search price model (estUnder).
 * Writes:
 *   data/listings.json  – { generatedAt, searches: { key: { label, url, meta, listings } } }
 *   data/diff.json      – per-search changes (only written when something changed)
 *   data/alert.txt      – human-readable alert lines (only when something changed)
 * No dependencies. Node 18+. Run: node fetch-listings.mjs
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SEARCHES } from "./config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");
const DIFF_FILE = path.join(DATA_DIR, "diff.json");
const ALERT_FILE = path.join(DATA_DIR, "alert.txt");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ALERT_LINE_CAP = 30;

const searchUrl = (s, page = 1) =>
  `https://www.autotrader.co.za/cars-for-sale/kwazulu-natal/p-${page}/${s.make}/${s.model}` +
  (s.filters ? `?${s.filters}` : "");

/** Area keywords (lowercase, checked top-down) -> display group. */
const GROUPS = [
  { name: "North Coast & Outer", any: ["springfield", "riverside", "umhlanga", "ballito", "richards bay", "la lucia", "mount edgecombe", "mt edgecombe", "phoenix", "tongaat", "verulam", "stanger", "empangeni", "oceans", "ladysmith"] },
  { name: "Hillcrest & Pinetown", any: ["hillcrest", "pinetown", "kloof", "gillitts", "bothas hill", "waterfall"] },
  { name: "Pietermaritzburg", any: ["maritzburg"] },
  { name: "Durban", any: ["durban", "mobeni", "old fort"] },
];

function groupFor(area, dealer) {
  const s = `${area ?? ""} ${dealer ?? ""}`.toLowerCase();
  for (const g of GROUPS) if (g.any.some((k) => s.includes(k))) return g.name;
  return "Other";
}

function textify(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const num = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10);
const esc = (s) => s.replace(/-/g, "[\\s-]*");

function parseTileText(text, makeRe, modelRe) {
  const out = {};
  const m = text.match(/R\s?(\d[\d\s]{4,8})/);
  if (m) { const p = num(m[1]); if (p >= 10000 && p <= 9999999) out.price = p; }
  const y = text.match(new RegExp(`((?:19|20)\\d{2})\\s*${makeRe}`, "i"));
  if (y) { const yr = num(y[1]); if (yr >= 1980 && yr <= 2030) out.year = yr; }
  const v = text.match(
    new RegExp(`(?:19|20)\\d{2}\\s*(?:${makeRe}\\s*)?(?:${modelRe}\\s*)?(.{2,60}?)\\s*(?:Used|New|Certified|Demo)\\b`, "i"));
  if (v) out.variant = v[1].trim();
  const c = text.match(/\b(Used|New|Certified|Demo)\b/);
  if (c) out.condition = c[1];
  const k = text.match(/(\d[\d\s]{2,9})\s*km\b/);
  if (k) { const km = num(k[1]); if (km >= 100 && km <= 999999) out.km = km; }
  const t = text.match(/\b(Automatic|Manual)\b/);
  if (t) out.transmission = t[1];
  const f = text.match(/\b(Diesel|Petrol|Hybrid|Electric)\b/);
  if (f) out.fuel = f[1];
  const fl = text.match(/\b(Great Price|Fair Price|High Price)\b/);
  if (fl) out.priceFlag = fl[1];
  const r = text.match(/(\d\.\d)\s*\((\d+)\s*reviews?\)/);
  if (r) { out.dealerRating = Number(r[1]); out.dealerReviews = num(r[2]); }
  else if (/no recent ratings/i.test(text)) { out.dealerRating = null; out.dealerReviews = null; }
  const d = text.match(
    /\b(?:Diesel|Petrol|Hybrid|Electric)\s+([A-Za-z0-9 .,&'’\-–]+?)\s*(?:\d\.\d\s*\(\d+\s*reviews?\)|no recent ratings)\s*([A-Za-z0-9 .,&'’\-–]+?)\s*Km from you/);
  if (d) {
    out.dealer = d[1].trim();
    out.area = d[2].replace(/\s*Km from you.*$/i, "").replace(/\s+,/g, ",").trim();
  }
  return out;
}

function parsePage(html, s) {
  const makeRe = esc(s.make);
  const modelRe = esc(s.model);
  const hrefRe = new RegExp(
    `href="(\\/car-for-sale\\/${makeRe}\\/${modelRe}\\/[a-z0-9.\\-]+\\/(\\d+))"`, "gi");
  const marks = [...html.matchAll(hrefRe)];
  const byId = new Map();
  for (let i = 0; i < marks.length; i++) {
    const [, href, id] = marks[i];
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(start + 8000, html.length);
    const fields = parseTileText(textify(html.slice(start, end)), makeRe, modelRe);
    const rec = byId.get(id) ?? { id, url: `https://www.autotrader.co.za${href}` };
    for (const [k, val] of Object.entries(fields)) if (rec[k] === undefined) rec[k] = val;
    byId.set(id, rec);
  }
  return [...byId.values()]
    .map((r) => ({ ...r, group: groupFor(r.area, r.dealer) }))
    // AutoTrader rotates one unrendered (zero-data) tile per page load — skip them
    .filter((r) => r.price !== undefined || r.year !== undefined || r.variant !== undefined);
}

/** KZN pages can append "nearby/national" suggestion cars beyond the search
 * filters — drop anything over the price cap or clearly outside KZN. */
const NON_KZN = ["johannesburg", "pretoria", "tshwane", "centurion", "sandton", "midrand",
  "randburg", "roodepoort", "krugersdorp", "soweto", "germiston", "boksburg", "benoni",
  "kempton", "alberton", "vanderbijlpark", "vereeniging", "nigel", "bryanston", "fourways",
  "eastgate", "westgate", "gleneagles", "selby", "the glen", "cape town", "stellenbosch",
  "george", "gqeberha", "port elizabeth", "east london", "bloemfontein", "kimberley",
  "mbombela", "nelpruit", "polokwane", "rustenburg", "mahikeng", "upington", "witbank",
  "emalahleni", "middelburg"];
const isKznListing = (l, priceCap) =>
  !(priceCap && l.price && l.price > priceCap) &&
  !NON_KZN.some((k) => `${l.area ?? ""} ${l.dealer ?? ""}`.toLowerCase().includes(k));

/** Fetch ALL kwazulu-natal pages for one search. AutoTrader redirects exhausted
 * province page slots to other provinces — only pages whose final URL stayed
 * on kwazulu-natal are kept; scanning stops once the KZN block ends. */
async function fetchSearch(s) {
  const byId = new Map();
  const trace = [];
  let kznSeen = false, kznFirstPage = null, kznTotal = null;
  for (let page = 1; page <= (s.pageCap ?? 8); page++) {
    const u = searchUrl(s, page);
    let res;
    try {
      res = await fetch(u, {
        headers: { "User-Agent": UA, "Accept-Language": "en-ZA,en;q=0.9" },
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      trace.push({ page, error: e.message });
      break;
    }
    if (!res.ok) {
      trace.push({ page, status: res.status });
      if (page === 1) break;
      continue;
    }
    const html = await res.text();
    const isKzn = /\/kwazulu-natal\//.test(res.url);
    if (!isKzn) { if (kznSeen) break; continue; }
    if (!kznSeen) { kznFirstPage = page; kznTotal = num(html.match(/Search\s+(\d+)\s+cars?/i)?.[1] ?? 0); }
    kznSeen = true;
    const before = byId.size;
    for (const rec of parsePage(html, s).filter((l) => isKznListing(l, s.priceCap))) {
      const old = byId.get(rec.id);
      if (old) { for (const [k, v] of Object.entries(rec)) if (old[k] === undefined) old[k] = v; }
      else byId.set(rec.id, rec);
    }
    if (byId.size === before && page > (kznFirstPage ?? 1)) break; // repeated page
  }
  if (!kznSeen) {
    throw new Error(`${s.key}: no kwazulu-natal pages found — trace ${JSON.stringify(trace)}`);
  }
  console.log(`${s.key}: ${byId.size} listings (KZN total ${kznTotal}, block at page ${kznFirstPage})`);
  return { listings: [...byId.values()], meta: { kznPage: kznFirstPage, kznTotal } };
}

/** Rough valuation: least-squares fit price ~ year, km, trim tier, auto, 4WD
 * across this search's live inventory (ridge-regularised). Positive = cheaper
 * than model expectation. */
const TIER = [["expression", 0], ["zen", 1], ["dynamique", 2], ["techroad", 2.5], ["intens", 3],
  ["glx", 2.5], ["gl", 1], ["executive", 2], ["premium", 2.5], ["comfort", 2], ["trend", 1.5],
  ["distinction", 2.5], ["luxury", 2.5], ["momentum", 1.5], ["deluxe", 2], ["xs", 2], ["xi", 1]];
const trimTier = (variant = "") =>
  TIER.find(([k]) => variant.toLowerCase().includes(k))?.[1] ?? 1.5;

function dealScores(listings) {
  const rows = listings.filter((l) => l.price && l.year && l.km != null && !l.removedAt);
  if (rows.length < 8) return null;
  const feat = (l) => [
    1,
    l.year - 2019,
    l.km / 10000,
    l.transmission === "Automatic" ? 1 : 0,
    trimTier(l.variant),
    /4wd|4x4/i.test(l.variant ?? "") ? 1 : 0,
  ];
  const A = rows.map(feat);
  const y = rows.map((l) => l.price);
  const p = A[0].length;
  const ata = Array.from({ length: p }, () => Array(p).fill(0));
  const aty = Array(p).fill(0);
  for (let i = 0; i < A.length; i++)
    for (let a = 0; a < p; a++) {
      aty[a] += A[i][a] * y[i];
      for (let b = 0; b < p; b++) ata[a][b] += A[i][a] * A[i][b];
    }
  for (let a = 0; a < p; a++) ata[a][a] += 1e-3; // ridge for stability
  const M = ata.map((r, i) => [...r, aty[i]]); // gaussian elimination
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < p; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
    }
  }
  const coef = Array(p).fill(0);
  for (let r = p - 1; r >= 0; r--) {
    coef[r] = M[r][p];
    for (let c = r + 1; c < p; c++) coef[r] -= M[r][c] * coef[c];
    coef[r] /= M[r][r];
  }
  const out = new Map();
  rows.forEach((l, i) => {
    let est = 0;
    for (let a = 0; a < p; a++) est += A[i][a] * coef[a];
    out.set(l.id, Math.round(est - l.price));
  });
  return out;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return null; }
}

const now = new Date();
const iso = now.toISOString();

const prevFile = (await readJson(LISTINGS_FILE)) ?? {};
// migrate the old single-search format (duster) if present
const prevSearches = prevFile.searches ??
  (prevFile.listings
    ? { duster: { label: "Renault Duster", url: prevFile.searchUrl, listings: prevFile.listings } }
    : {});

const searches = {};
const diffs = {};
const alertLines = [];

for (const s of SEARCHES) {
  const prev = prevSearches[s.key] ?? { listings: [] };
  const prevById = new Map(prev.listings.map((l) => [l.id, l]));
  const prevIds = new Set(prev.listings.filter((l) => !l.removedAt).map((l) => l.id));
  const baseline = prev.listings.length === 0; // first run: capture, don't alert

  const { listings: current, meta } = await fetchSearch(s);
  const currentIds = new Set(current.map((l) => l.id));

  const merged = current.map((cur) => {
    const old = prevById.get(cur.id);
    const history = old?.priceHistory ?? [];
    if (old?.price && cur.price && old.price !== cur.price) {
      history.push({ date: iso, from: old.price, to: cur.price });
    }
    return {
      ...cur,
      priceHistory: history,
      firstSeen: old?.firstSeen ?? iso,
      lastSeen: iso,
      lastMissing: null,
      removedAt: null,
    };
  });
  // a listing missing from the page is only confirmed gone after two consecutive runs
  const goneNow = prev.listings.filter((l) => !currentIds.has(l.id) && !l.removedAt);
  const gone = goneNow.map((l) => ({ ...l, removedAt: l.lastMissing ? iso : null, lastMissing: iso }));
  const all = [...merged, ...gone, ...prev.listings.filter((l) => l.removedAt)].slice(0, 400);

  const est = dealScores(merged);
  if (est) for (const l of merged) l.estUnder = est.get(l.id) ?? null;

  const newIds = merged.filter(
    (l) => !prevIds.has(l.id) || (!prevById.get(l.id)?.price && l.price)
  );
  const drops = [], rises = [];
  for (const l of merged) {
    const last = l.priceHistory[l.priceHistory.length - 1];
    if (last && last.date === iso) (last.to < last.from ? drops : rises).push(l);
  }
  const goneConfirmed = gone.filter((l) => l.removedAt && (l.variant || l.price));
  diffs[s.key] = {
    total: newIds.length + drops.length + rises.length + goneConfirmed.length,
    baseline, // first capture of this search — record, don't alert
    new: newIds.map((l) => l.id),
    dropped: drops.map((l) => ({ id: l.id, from: l.priceHistory.at(-1).from, to: l.priceHistory.at(-1).to })),
    increased: rises.map((l) => ({ id: l.id, from: l.priceHistory.at(-1).from, to: l.priceHistory.at(-1).to })),
    gone: goneConfirmed.map((l) => l.id),
  };

  const L = s.label;
  for (const id of diffs[s.key].new) {
    const l = merged.find((x) => x.id === id);
    if (baseline || !l?.price) continue;
    const val = l.estUnder >= 8000 ? ` · ≈R${Math.round(l.estUnder / 1000)}k under` : "";
    alertLines.push(`- **[${L}] NEW** · [${l.year ?? "?"} ${l.variant ?? l.trim} — R${l.price.toLocaleString("en-ZA")} · ${l.km?.toLocaleString("en-ZA") ?? "?"} km · ${l.dealer ?? l.group ?? ""}](${l.url})${val}`);
  }
  for (const d of diffs[s.key].dropped) {
    const l = merged.find((x) => x.id === d.id);
    if (l) alertLines.push(`- **[${L}] DROP** R${d.from.toLocaleString("en-ZA")} → R${d.to.toLocaleString("en-ZA")} — [${l.year ?? "?"} ${l.variant ?? l.trim} · ${l.dealer ?? ""}](${l.url})`);
  }
  for (const d of diffs[s.key].increased) {
    const l = merged.find((x) => x.id === d.id);
    if (l) alertLines.push(`- **[${L}] UP** R${d.from.toLocaleString("en-ZA")} → R${d.to.toLocaleString("en-ZA")} — [${l.year ?? "?"} ${l.variant ?? l.trim} · ${l.dealer ?? ""}](${l.url})`);
  }
  for (const id of diffs[s.key].gone) {
    const l = prevById.get(id);
    if (l) alertLines.push(`- **[${L}] GONE** ${l.year ?? "?"} ${l.variant ?? l.trim} — R${l.price?.toLocaleString("en-ZA") ?? "?"} · ${l.dealer ?? ""}`);
  }

  searches[s.key] = {
    label: s.label,
    url: searchUrl(s, meta.kznPage ?? 2),
    meta,
    listings: all.slice().sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const totalChanges = Object.values(diffs).reduce((n, d) => n + d.total, 0);
const diffPayload = { generatedAt: iso, total: totalChanges, searches: diffs };

// content-aware write: skip when nothing but timestamps / tile order changed
const canon = (data) =>
  JSON.stringify(
    Object.entries(data.searches)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v.label, v.meta, v.listings.map((l) => { const c = { ...l }; delete c.lastSeen; return c; })])
  );
if (prevFile.searches && canon({ searches }) === canon(prevFile)) {
  console.log("listings unchanged (timestamps/tile order only) — not rewritten");
} else {
  await writeFile(LISTINGS_FILE, JSON.stringify({ generatedAt: iso, searches }, null, 1));
}
if (totalChanges) await writeFile(DIFF_FILE, JSON.stringify(diffPayload, null, 1));
else await unlink(DIFF_FILE).catch(() => {});

if (alertLines.length) {
  const shown = alertLines.slice(0, ALERT_LINE_CAP);
  const extra = alertLines.length - shown.length;
  await writeFile(ALERT_FILE, shown.join("\n") + (extra > 0 ? `\n… and ${extra} more — see the site` : "") + "\n");
} else {
  await unlink(ALERT_FILE).catch(() => {});
}

console.log(`changes: ${totalChanges} across ${SEARCHES.length} searches`);
for (const s of SEARCHES) {
  const d = diffs[s.key];
  console.log(`  ${s.label}: ${searches[s.key].listings.filter((l) => !l.removedAt).length} live (new ${d.new.length}, dropped ${d.dropped.length}, up ${d.increased.length}, gone ${d.gone.length})`);
  const priced = searches[s.key].listings.filter((l) => !l.removedAt && l.price).map((l) => l.price);
  if (priced.length) {
    const lo = Math.min(...priced), hi = Math.max(...priced);
    console.log(`    price range R${lo.toLocaleString("en-ZA")} – R${hi.toLocaleString("en-ZA")}`);
  }
}