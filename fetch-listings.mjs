#!/usr/bin/env node
/**
 * AutoTrader KZN Duster watcher.
 * Fetches the search page, parses listing tiles, merges with the previous
 * snapshot (firstSeen / lastSeen / priceHistory / removedAt) and writes:
 *   data/listings.json  – full dataset used by the site
 *   data/diff.json      – machine-readable changes vs previous run
 *   data/alert.txt      – human-readable alert text (only when something changed)
 *
 * No dependencies. Node 18+. Run: node fetch-listings.mjs
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");
const DIFF_FILE = path.join(DATA_DIR, "diff.json");
const ALERT_FILE = path.join(DATA_DIR, "alert.txt");

const SEARCH_URL =
  "https://www.autotrader.co.za/cars-for-sale/kwazulu-natal/p-2/renault/duster" +
  "?price=less-than-300000&year=more-than-2019&mileage=less-than-100000";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Area keywords (lowercase, checked top-down) -> display group. */
const GROUPS = [
  { name: "North Coast & Outer", any: ["springfield", "riverside", "umhlanga", "ballito", "richards bay", "la lucia", "mount edgecombe", "mt edgecombe", "phoenix", "tongaat", "verulam", "stanger", "empangeni", "oceans"] },
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

function parseTileText(text) {
  const out = {};
  const m = text.match(/R\s?(\d[\d\s]{4,8})/);
  if (m) { const p = num(m[1]); if (p >= 10000 && p <= 9999999) out.price = p; }
  const y = text.match(/((?:19|20)\d{2})\s*Renault Duster/);
  if (y) { const yr = num(y[1]); if (yr >= 1980 && yr <= 2030) out.year = yr; }
  const v = text.match(/Renault Duster\s*(.{2,60}?)\s*(Used|New|Certified|Demo)\b/);
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
    /\b(?:Diesel|Petrol|Hybrid|Electric)\s+([A-Za-z0-9 .,&'’\-–]+?)\s*(?:\d\.\d\s*\(\d+\s*reviews?\)|no recent ratings)\s*([A-Za-z0-9 .,&'’\-–]+?)\s*Km from you/
  );
  if (d) {
    out.dealer = d[1].trim();
    out.area = d[2].replace(/\s*Km from you.*$/i, "").replace(/\s+,/g, ",").trim();
  }
  return out;
}

/** Rough valuation: least-squares fit price ~ year, km, trim tier, auto, 4WD
 * across the current live inventory (ridge-regularised, 16-ish points).
 * Returns Map(id -> estUnder) where positive = cheaper than model expectation. */
const TIER = [["expression", 0], ["zen", 1], ["dynamique", 2], ["techroad", 2.5], ["intens", 3]];
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
    /4wd/i.test(l.variant ?? "") ? 1 : 0,
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

function parsePage(html) {
  const hrefRe = /href="(\/car-for-sale\/renault\/duster\/([a-z0-9-]+)\/(\d+))"/g;
  const marks = [...html.matchAll(hrefRe)];
  const byId = new Map();
  for (let i = 0; i < marks.length; i++) {
    const [, href, trim, id] = marks[i];
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(start + 8000, html.length);
    const fields = parseTileText(textify(html.slice(start, end)));
    const rec = byId.get(id) ?? { id, trim, url: `https://www.autotrader.co.za${href}` };
    for (const [k, val] of Object.entries(fields)) {
      if (rec[k] === undefined) rec[k] = val; // first clean value wins
    }
    byId.set(id, rec);
  }
  return [...byId.values()]
    .map((r) => ({
      ...r,
      group: groupFor(r.area, r.dealer),
      incomplete: r.price === undefined,
    }))
    // AutoTrader rotates one unrendered (zero-data) tile per page load — skip them
    .filter((r) => r.price !== undefined || r.year !== undefined || r.variant !== undefined);
}

async function fetchPage() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(SEARCH_URL, {
      headers: { "User-Agent": UA, "Accept-Language": "en-ZA,en;q=0.9" },
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) return res.text();
    if (attempt === 2) throw new Error(`HTTP ${res.status} from AutoTrader`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return null; }
}

const now = new Date();
const iso = now.toISOString();
const current = parsePage(await fetchPage());
const currentIds = new Set(current.map((l) => l.id));

await import("node:fs/promises").then((fs) => fs.mkdir(DATA_DIR, { recursive: true }));
const prev = (await readJson(LISTINGS_FILE)) ?? { listings: [] };
const prevById = new Map(prev.listings.map((l) => [l.id, l]));
const prevIds = new Set(prev.listings.filter((l) => !l.removedAt).map((l) => l.id));

const listings = current.map((cur) => {
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
// a listing missing from the page is only confirmed gone after two consecutive
// runs — AutoTrader occasionally fails to render a tile
const goneNow = prev.listings.filter((l) => !currentIds.has(l.id) && !l.removedAt);
const gone = goneNow.map((l) => ({ ...l, removedAt: l.lastMissing ? iso : null, lastMissing: iso }));
const all = [...listings, ...gone, ...prev.listings.filter((l) => l.removedAt)].slice(0, 200);

const est = dealScores(listings);
if (est) for (const l of listings) l.estUnder = est.get(l.id) ?? null;

const newIds = current.filter(
  (l) => !prevIds.has(l.id) || (!prevById.get(l.id)?.price && l.price)
);
const drops = [];
const rises = [];
for (const l of listings) {
  const last = l.priceHistory[l.priceHistory.length - 1];
  if (last && last.date === iso) (last.to < last.from ? drops : rises).push(l);
}
const goneConfirmed = gone
  .filter((l) => l.removedAt && (l.variant || l.price)); // phantoms never alerted

const diff = {
  generatedAt: iso,
  total: newIds.length + drops.length + rises.length + goneConfirmed.length,
  new: newIds.map((l) => l.id),
  dropped: drops.map((l) => ({ id: l.id, from: l.priceHistory.at(-1).from, to: l.priceHistory.at(-1).to })),
  increased: rises.map((l) => ({ id: l.id, from: l.priceHistory.at(-1).from, to: l.priceHistory.at(-1).to })),
  gone: goneConfirmed.map((l) => l.id),
};

await writeFile(LISTINGS_FILE, JSON.stringify({ generatedAt: iso, searchUrl: SEARCH_URL, listings: all }, null, 1));
await writeFile(DIFF_FILE, JSON.stringify(diff, null, 1));

// human-readable alert (only when something changed)
const byId = new Map(all.map((l) => [l.id, l]));
const lines = [];
for (const id of diff.new) {
  const l = byId.get(id);
  if (l?.price) {
    const val = l.estUnder >= 8000 ? ` · ≈R${Math.round(l.estUnder / 1000)}k under` : "";
    lines.push(`NEW  ${l.year ?? "?"} ${l.variant ?? l.trim}  R${l.price.toLocaleString("en-ZA")}  ${l.km?.toLocaleString("en-ZA") ?? "?"} km  ${l.dealer ?? ""} (${l.group})${val}\n     ${l.url}`);
  }
}
for (const d of diff.dropped) {
  const l = byId.get(d.id);
  if (l) lines.push(`DROP R${d.from.toLocaleString("en-ZA")} -> R${d.to.toLocaleString("en-ZA")}  ${l.year ?? "?"} ${l.variant ?? l.trim}  ${l.dealer ?? ""}\n     ${l.url}`);
}
for (const d of diff.increased) {
  const l = byId.get(d.id);
  if (l) lines.push(`UP   R${d.from.toLocaleString("en-ZA")} -> R${d.to.toLocaleString("en-ZA")}  ${l.year ?? "?"} ${l.variant ?? l.trim}  ${l.dealer ?? ""}\n     ${l.url}`);
}
for (const id of diff.gone) {
  const l = prevById.get(id);
  if (l?.variant || l?.price) lines.push(`GONE ${l.year ?? "?"} ${l.variant ?? l.trim}  R${l.price?.toLocaleString("en-ZA") ?? "?"}  ${l.dealer ?? ""}\n     ${l.url}`);
}
if (lines.length) await writeFile(ALERT_FILE, lines.join("\n") + "\n");
else await unlink(ALERT_FILE).catch(() => {});

console.log(`parsed ${current.length} listings (${listings.filter((l) => l.incomplete).length} incomplete)`);
console.log(`kept ${all.length} records incl. ${all.filter((l) => l.lastMissing || l.removedAt).length} pending-gone/removed`);
console.log(`changes: ${diff.total} (new ${diff.new.length}, dropped ${diff.dropped.length}, up ${diff.increased.length}, gone ${diff.gone.length})`);
for (const g of [...new Set(listings.map((l) => l.group))]) {
  console.log(`  ${g}: ${listings.filter((l) => l.group === g).length}`);
}
if (est) {
  const named = listings
    .filter((l) => l.estUnder != null)
    .map((l) => [l.estUnder, `${l.year} ${l.variant}`])
    .sort((a, b) => b[0] - a[0]);
  const tag = (e) =>
    `${e[1]} — ≈R${Math.round(Math.abs(e[0]) / 1000)}k ${e[0] >= 0 ? "under" : "over"}`;
  console.log(`  best value:  ${tag(named[0])}`);
  console.log(`  worst value: ${tag(named[named.length - 1])}`);
}
if (lines.length) console.log(`alert written to data/alert.txt (${lines.length} items)`);