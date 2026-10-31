#!/usr/bin/env node
/**
 * One-off cross-model explorer: sweeps rival models on AutoTrader KZN with the
 * Duster search filters, parses tiles (same approach as fetch-listings.mjs but
 * generalised), then fits ONE pooled price model (year, km, auto, size tier,
 * make dummies) so estUnder is comparable across brands.
 * Writes data/explore.json (gitignored). Usage: node explore.mjs [make/model ...]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FILTERS = "?price=less-than-300000&year=more-than-2019&mileage=less-than-100000";
const url = (make, model, page) =>
  `https://www.autotrader.co.za/cars-for-sale/kwazulu-natal/p-${page}/${make}/${model}${FILTERS}`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const BASKET = [
  "suzuki/grand-vitara", "suzuki/vitara", "suzuki/brezza", "suzuki/vitara-brezza",
  "hyundai/creta", "hyundai/venue",
  "kia/seltos", "kia/sonet",
  "volkswagen/t-cross",
  "haval/jolion", "haval/jolion-pro",
  "chery/tiggo-4-pro", "chery/tiggo-7-pro",
  "toyota/urban-cruiser",
  "ford/ecosport",
  "nissan/magnite",
  "renault/kiger", "renault/duster", // baseline for comparability
  "mahindra/xuv300", "mahindra/xuv-3xo",
  "omoda/c5", "jetour/dashing",
  "honda/hr-v", "mitsubishi/asx",
];
/** rough size/segment tier (0 = sub-4m budget, 3 = small-family) */
const TIER = {
  "nissan/magnite": 0, "renault/kiger": 0, "suzuki/brezza": 1, "toyota/urban-cruiser": 1,
  "hyundai/venue": 1, "kia/sonet": 1, "ford/ecosport": 1, "mahindra/xuv300": 1,
  "volkswagen/t-cross": 1, "chery/tiggo-4-pro": 1, "suzuki/vitara": 2, "hyundai/creta": 2,
  "kia/seltos": 2, "haval/jolion": 2, "haval/jolion-pro": 2, "jetour/dashing": 2,
  "omoda/c5": 2, "suzuki/grand-vitara": 2, "renault/duster": 2, "mitsubishi/asx": 2,
  "chery/tiggo-7-pro": 3, "honda/hr-v": 3, "mahindra/xuv-3xo": 1,
};

const esc = (s) => s.replace(/[-]/g, "[\\s-]*");
const textify = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<img[^>]*>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const num = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10);

function parseTileText(text, makeRe, modelRe) {
  const out = {};
  const m = text.match(/R\s?(\d[\d\s]{4,8})/);
  if (m) { const p = num(m[1]); if (p >= 10000 && p <= 9999999) out.price = p; }
  const y = text.match(new RegExp(`((?:19|20)\\d{2})\\s*${makeRe}`, "i"));
  if (y) { const yr = num(y[1]); if (yr >= 1980 && yr <= 2030) out.year = yr; }
  const v = text.match(new RegExp(`(?:19|20)\\d{2}\\s*(?:${makeRe}\\s*)?(?:${modelRe}\\s*)?(.{2,60}?)\\s*(?:Used|New|Certified|Demo)\\b`, "i"));
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
  const d = text.match(
    /\b(?:Diesel|Petrol|Hybrid|Electric)\s+([A-Za-z0-9 .,&'’\-–]+?)\s*(?:\d\.\d\s*\(\d+\s*reviews?\)|no recent ratings)\s*([A-Za-z0-9 .,&'’\-–]+?)\s*Km from you/);
  if (d) { out.dealer = d[1].trim(); out.area = d[2].replace(/\s+,/g, ",").trim(); }
  return out;
}

function parsePage(html, make, model) {
  const hrefRe = new RegExp(`href="(\\/car-for-sale\\/${make}\\/${model}\\/[a-z0-9.\\-]+\\/(\\d+))"`, "gi");
  const marks = [...html.matchAll(hrefRe)];
  const byId = new Map();
  for (let i = 0; i < marks.length; i++) {
    const [, href, id] = marks[i];
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(start + 8000, html.length);
    const fields = parseTileText(textify(html.slice(start, end)), esc(make), esc(model));
    const rec = byId.get(id) ?? { id, url: `https://www.autotrader.co.za${href}` };
    for (const [k, val] of Object.entries(fields)) if (rec[k] === undefined) rec[k] = val;
    byId.set(id, rec);
  }
  return [...byId.values()]
    .map((r) => ({ ...r, make, model, group: groupFor(r.area, r.dealer) }))
    .filter((r) => r.price !== undefined || r.year !== undefined || r.variant !== undefined);
}

/** KZN pages can append "nearby/national" suggestion cars beyond the search
 * filters — drop anything over the price cap or clearly outside KZN. */
const PRICE_CAP = 300000;
const NON_KZN = ["johannesburg", "pretoria", "tshwane", "centurion", "sandton", "midrand",
  "randburg", "roodepoort", "krugersdorp", "soweto", "germiston", "boksburg", "benoni",
  "kempton", "alberton", "vanderbijlpark", "vereeniging", "nigel", "bryanston", "fourways",
  "eastgate", "westgate", "gleneagles", "selby", "the glen", "cape town", "stellenbosch",
  "george", "gqeberha", "port elizabeth", "east london", "bloemfontein", "kimberley",
  "mbombela", "nelpruit", "polokwane", "rustenburg", "mahikeng", "upington", "witbank",
  "emalahleni", "middelburg"];
const isKznListing = (l) =>
  !(l.price && l.price > PRICE_CAP) &&
  !NON_KZN.some((k) => `${l.area ?? ""} ${l.dealer ?? ""}`.toLowerCase().includes(k));

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

async function fetchText(u) {
  const res = await fetch(u, {
    headers: { "User-Agent": UA, "Accept-Language": "en-ZA,en;q=0.9" },
    signal: AbortSignal.timeout(45000),
  });
  // AutoTrader redirects exhausted province pages to other provinces — caller
  // must check res.url and only trust pages that stayed on kwazulu-natal
  if (res.status === 404) return { html: "", finalUrl: res.url };
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  return { html: await res.text(), finalUrl: res.url };
}

async function fetchModel(make, model) {
  const seen = new Map();
  let kznSeen = false, kznTotal = null;
  for (let page = 1; page <= 16; page++) {
    let html, finalUrl;
    try {
      ({ html, finalUrl } = await fetchText(url(make, model, page)));
    } catch { break; } // 500/timeout — other provinces' overflow pages
    if (!html) break;
    const isKzn = /\/kwazulu-natal\//.test(finalUrl);
    if (!isKzn) { if (kznSeen) break; continue; } // skip other provinces; stop after KZN block
    kznSeen = true;
    kznTotal ??= num(html.match(/Search\s+(\d+)\s+cars?/i)?.[1] ?? 0);
    const before = seen.size;
    for (const r of parsePage(html, make, model)) if (!seen.has(r.id)) seen.set(r.id, r);
    if (seen.size === before) break; // repeated page
    await new Promise((r) => setTimeout(r, 400));
  }
  return { total: kznTotal ?? 0, listings: [...seen.values()].filter(isKznListing) };
}

/** pooled price model: 1, yr-2019, km/10k, auto, sizeTier, make dummies */
function pooledScores(all) {
  const makes = [...new Set(all.map((l) => l.make))];
  const rows = all.filter((l) => l.price && l.year && l.km != null);
  if (rows.length < 40) return null;
  const p = 5 + makes.length - 1;
  const feat = (l) => {
    const f = [1, l.year - 2019, l.km / 10000, l.transmission === "Automatic" ? 1 : 0,
               TIER[`${l.make}/${l.model}`] ?? 1.5];
    for (let m = 1; m < makes.length; m++) f.push(l.make === makes[m] ? 1 : 0);
    return f;
  };
  const A = rows.map(feat);
  const y = rows.map((l) => l.price);
  const ata = Array.from({ length: p }, () => Array(p).fill(0));
  const aty = Array(p).fill(0);
  for (let i = 0; i < A.length; i++)
    for (let a = 0; a < p; a++) {
      aty[a] += A[i][a] * y[i];
      for (let b = 0; b < p; b++) ata[a][b] += A[i][a] * A[i][b];
    }
  for (let a = 0; a < p; a++) ata[a][a] += 1e-3;
  const M = ata.map((r, i) => [...r, aty[i]]);
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
    out.set(l, Math.round(est - l.price));
  });
  return out;
}

const basket = process.argv.slice(2).length ? process.argv.slice(2) : BASKET;
const models = {};
const all = [];
for (const [make, model] of basket.map((s) => s.split("/"))) {
  try {
    const { total, listings } = await fetchModel(make, model);
    models[`${make}/${model}`] = { total, count: listings.length, listings };
    all.push(...listings);
    console.log(`${make}/${model}: ${listings.length}/${total}`);
  } catch (e) {
    models[`${make}/${model}`] = { error: e.message };
    console.log(`${make}/${model}: ERROR ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

const est = pooledScores(all.filter(isKznListing));
if (est) for (const l of all) l.estUnder = est.get(l) ?? null;

await mkdir("data", { recursive: true });
await writeFile("data/explore.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), models, all }, null, 1));

// console summary: autos 2020+ then bargains
const live = all.filter((l) => !l.removedAt && l.price);
const autos = live.filter((l) => l.transmission === "Automatic" && (l.year ?? 0) >= 2020)
  .sort((a, b) => (b.estUnder ?? -9e9) - (a.estUnder ?? -9e9));
console.log(`\npooled fit on ${all.filter((l) => l.price && l.year).length} rows\n`);
console.log("AUTO 2020+ by value:");
for (const l of autos.slice(0, 20))
  console.log(`  ${String(l.estUnder ?? "?").padStart(7)}  ${l.make} ${l.model} ${l.year} ${l.variant ?? ""}  R${l.price.toLocaleString("en-ZA")}  ${l.km?.toLocaleString("en-ZA")}km  ${l.dealer ?? l.area ?? ""}`);
console.log("BARGAINS any trans (estUnder > 10k):");
for (const l of live.filter((l) => (l.estUnder ?? 0) > 10000).sort((a, b) => b.estUnder - a.estUnder).slice(0, 20))
  console.log(`  ${String(l.estUnder).padStart(7)}  ${l.make} ${l.model} ${l.year} ${l.variant ?? ""}  R${l.price.toLocaleString("en-ZA")}  ${l.km?.toLocaleString("en-ZA")}km ${l.transmission}  ${l.dealer ?? l.area ?? ""}`);