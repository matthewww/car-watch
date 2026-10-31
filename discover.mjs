#!/usr/bin/env node
/**
 * Weekly discovery sweep: make-level census of AutoTrader KZN under the
 * standard filters (≤R300k, 2019+, ≤100k km). For every make in MAKES, parses
 * its KZN block pages, tallies per-model stats, and flags models NOT in
 * config.mjs as watch candidates (≥2 in-cap listings, ≥1 automatic).
 * Writes data/discovery.json. Failure-tolerant per make.
 * Run manually (node discover.mjs) or weekly via CarWatch.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SEARCHES, BOOT_LITRES } from "./config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY_FILE = path.join(ROOT, "data", "discovery.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FILTERS = "price=less-than-300000&year=more-than-2019&mileage=less-than-100000";
const PRICE_CAP = 300000;
const PAGE_CAP = 10; // deep enough that big makes (toyota/hyundai ~350-675 in-cap) can't hide models

const MAKES = [
  "baic", "bmw", "chery", "changan", "citroen", "fiat", "ford", "gwm", "haval",
  "honda", "hyundai", "isuzu", "jeep", "jetour", "kia", "mahindra", "mazda",
  "mg", "mitsubishi", "nissan", "omoda", "opel", "peugeot", "renault",
  "suzuki", "toyota", "volkswagen",
];

const NON_KZN = ["johannesburg", "pretoria", "tshwane", "centurion", "sandton", "midrand",
  "randburg", "roodepoort", "krugersdorp", "soweto", "germiston", "boksburg", "benoni",
  "kempton", "alberton", "vanderbijlpark", "vereeniging", "nigel", "bryanston", "fourways",
  "eastgate", "westgate", "gleneagles", "selby", "the glen", "cape town", "stellenbosch",
  "george", "gqeberha", "port elizabeth", "east london", "bloemfontein", "kimberley",
  "mbombela", "nelpruit", "polokwane", "rustenburg", "mahikeng", "upington", "witbank",
  "emalahleni", "middelburg"];
const isKznListing = (l) =>
  !(PRICE_CAP && l.price && l.price > PRICE_CAP) &&
  !NON_KZN.some((k) => `${l.area ?? ""} ${l.dealer ?? ""}`.toLowerCase().includes(k));

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
  const t = text.match(/\b(Automatic|Manual)\b/);
  if (t) out.transmission = t[1];
  const f = text.match(/\b(Diesel|Petrol|Hybrid|Electric)\b/);
  if (f) out.fuel = f[1];
  const d = text.match(
    /\b(?:Diesel|Petrol|Hybrid|Electric)\s+([A-Za-z0-9 .,&'’\-–]+?)\s*(?:\d\.\d\s*\(\d+\s*reviews?\)|no recent ratings)\s*([A-Za-z0-9 .,&'’\-–]+?)\s*Km from you/);
  if (d) { out.dealer = d[1].trim(); out.area = d[2].replace(/\s+,/g, ",").trim(); }
  return out;
}

/** Parse a make-level page: tiles keyed by listing id, grouped by model slug. */
function parsePage(html, make) {
  const hrefRe = new RegExp(
    `href="(\\/car-for-sale\\/${make}\\/([a-z0-9.\\-]+)\\/[a-z0-9.\\-]+\\/(\\d+))"`, "gi");
  const marks = [...html.matchAll(hrefRe)];
  const byId = new Map();
  for (let i = 0; i < marks.length; i++) {
    const [, href, model, id] = marks[i];
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(start + 5000, html.length);
    const fields = parseTileText(textify(html.slice(start, end)));
    const rec = byId.get(id) ?? { id, model, url: `https://www.autotrader.co.za${href}` };
    for (const [k, v] of Object.entries(fields)) if (rec[k] === undefined) rec[k] = v;
    byId.set(id, rec);
  }
  return [...byId.values()];
}

async function fetchMake(make) {
  const byId = new Map();
  let kznSeen = false, kznTotal = null;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const u = `https://www.autotrader.co.za/cars-for-sale/kwazulu-natal/p-${page}/${make}?${FILTERS}`;
    let res;
    try {
      res = await fetch(u, {
        headers: { "User-Agent": UA, "Accept-Language": "en-ZA,en;q=0.9" },
        signal: AbortSignal.timeout(45000),
      });
    } catch { break; }
    if (!res.ok) { if (page === 1) break; continue; }
    const html = await res.text();
    const isKzn = /\/kwazulu-natal\//.test(res.url);
    if (!isKzn) { if (kznSeen) break; continue; }
    if (!kznSeen) kznTotal = num(html.match(/Search\s+(\d+)\s+cars?/i)?.[1] ?? 0);
    kznSeen = true;
    const before = byId.size;
    for (const rec of parsePage(html, make).filter(isKznListing)) {
      const old = byId.get(rec.id);
      if (old) { for (const [k, v] of Object.entries(rec)) if (old[k] === undefined) old[k] = v; }
      else byId.set(rec.id, rec);
    }
    if (byId.size === before) break; // repeated page
  }
  return { byId, kznTotal: kznSeen ? kznTotal : null };
}

const watched = new Set(SEARCHES.map((s) => `${s.make}/${s.model}`));
const makes = {};
const candidates = [];
const iso = new Date().toISOString();

for (const make of MAKES) {
  try {
    const { byId, kznTotal } = await fetchMake(make);
    const models = {};
    for (const t of byId.values()) {
      if (!t.price) continue;
      const m = (models[t.model] ??= { count: 0, autos: 0, min: Infinity, max: 0, sample: t.url });
      m.count++;
      if (t.transmission === "Automatic") m.autos++;
      m.min = Math.min(m.min, t.price);
      m.max = Math.max(m.max, t.price);
    }
    makes[make] = { kznTotal, models };
    for (const [model, m] of Object.entries(models)) {
      const key = `${make}/${model}`;
      if (watched.has(key)) continue;
      if (m.count >= 2 && m.autos >= 1) {
        candidates.push({ key, make, model, count: m.count, autos: m.autos, min: m.min, max: m.max, sample: m.sample, boot: BOOT_LITRES[key] ?? "unknown — verify" });
      }
    }
    console.log(`${make}: ${Object.keys(models).length} models in-cap (KZN total ${kznTotal ?? "-"})`);
  } catch (e) {
    makes[make] = { error: e.message };
    console.log(`${make}: ERROR ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

candidates.sort((a, b) => b.autos - a.autos || b.count - a.count || a.min - b.min);
await writeFile(DISCOVERY_FILE, JSON.stringify({ generatedAt: iso, filters: FILTERS, makes, candidates }, null, 1));
console.log(`\ndiscovery: ${candidates.length} candidates written to data/discovery.json`);
for (const c of candidates.slice(0, 12)) {
  console.log(`  ${c.key}: ${c.count} in-cap, ${c.autos} auto, R${c.min.toLocaleString("en-ZA")}–R${c.max.toLocaleString("en-ZA")}`);
}