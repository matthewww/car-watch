/**
 * Deterministic market metrics from accumulated watch history — no LLM.
 * Every number traces to data/listings.json (or its git history); metrics
 * with fewer than 3 samples are omitted rather than guessed. Writes
 * data/insights.json, which index.html renders and analyze.mjs feeds to
 * the model so it reasons over real numbers.
 *
 * Usage: node insights.mjs   (run-local.ps1 calls it after fetch, non-fatal)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DAY = 864e5;
const WEEK = 7 * DAY;

const med = (arr) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 10) / 10;
};

const data = JSON.parse(readFileSync("data/listings.json", "utf8"));
const out = { generatedAt: new Date().toISOString(), searches: {} };

let first = null;
for (const s of Object.values(data.searches))
  for (const l of s.listings)
    if (!first || l.firstSeen < first) first = l.firstSeen;
out.dataStart = first;
out.dataDays = Math.round((Date.now() - Date.parse(first)) / DAY);

// ---- git snapshots: per-week median ask per search (price trend) ----
const snaps = [];
try {
  const log = execSync('git log --format="%H %cI" -- data/listings.json', { encoding: "utf8" }).trim();
  for (const line of (log ? log.split("\n").reverse() : [])) {
    const [hash, date] = line.split(" ");
    try {
      const j = JSON.parse(execSync(`git show ${hash}:data/listings.json`, { encoding: "utf8", maxBuffer: 1e8 }));
      snaps.push({ ts: Date.parse(date), searches: j.searches ?? {} });
    } catch {}
  }
} catch {}

const weekOf = (ts) => Math.floor(ts / WEEK);

// ---- per-search metrics ----
for (const [key, s] of Object.entries(data.searches)) {
  const m = {};
  const gone = s.listings.filter((l) => l.removedAt && l.firstSeen);
  if (gone.length >= 3)
    m.daysOnMarket = {
      median: med(gone.map((l) => (Date.parse(l.removedAt) - Date.parse(l.firstSeen)) / DAY)),
      n: gone.length,
    };

  // price trend across weekly snapshots
  const byWeek = new Map();
  for (const sn of snaps) {
    const prices = (sn.searches[key]?.listings ?? []).filter((l) => !l.removedAt && l.price).map((l) => l.price);
    if (prices.length >= 3) {
      const w = weekOf(sn.ts);
      (byWeek.get(w) ?? byWeek.set(w, []).get(w)).push(...prices);
    }
  }
  const wk = [...byWeek.keys()].sort((a, b) => a - b);
  if (wk.length >= 2) {
    const a = med(byWeek.get(wk[0]));
    const b = med(byWeek.get(wk[wk.length - 1]));
    if (a > 0)
      m.trend = { first: a, last: b, pct: Math.round(((b - a) / a) * 1000) / 10, weeks: wk.length };
  }

  // supply flow (needs >= 2 weeks to mean anything). The baseline capture
  // imports the whole initial stock at once — exclude it from "new".
  const spanWk = (Date.now() - Date.parse(first)) / WEEK;
  if (spanWk >= 2) {
    const start = Math.min(...s.listings.map((l) => Date.parse(l.firstSeen)));
    m.supply = {
      newPerWeek: Math.round((s.listings.filter((l) => Date.parse(l.firstSeen) > start + 36e5).length / spanWk) * 10) / 10,
      gonePerWeek: Math.round((gone.filter((l) => Date.parse(l.removedAt) >= Date.parse(first)).length / spanWk) * 10) / 10,
    };
  }

  // price drops: how often, how big, and do drops precede removal
  const dropPcts = [];
  const goneAfterDrop = [];
  let liveWithDrop = 0, livePriced = 0;
  for (const l of s.listings) {
    const hist = (l.priceHistory ?? []).filter((h) => h.to < h.from);
    if (l.removedAt) {
      for (const h of hist) dropPcts.push(((h.from - h.to) / h.from) * 100);
      const lastDrop = hist[hist.length - 1];
      if (lastDrop && Date.parse(lastDrop.date) <= Date.parse(l.removedAt))
        goneAfterDrop.push((Date.parse(l.removedAt) - Date.parse(lastDrop.date)) / DAY);
    } else {
      if (l.price) livePriced++;
      if (hist.length) liveWithDrop++;
    }
  }
  if (dropPcts.length >= 3) {
    m.drops = { n: dropPcts.length, medianPct: med(dropPcts) };
    if (livePriced) m.drops.sharePct = Math.round((liveWithDrop / livePriced) * 100);
    if (goneAfterDrop.length >= 3) m.drops.goneAfterMedianDays = med(goneAfterDrop), (m.drops.goneAfterN = goneAfterDrop.length);
  }
  if (Object.keys(m).length) out.searches[key] = m;
}

// ---- global audit: does estUnder predict what actually moves? ----
const goneU = [], liveU = [];
for (const s of Object.values(data.searches))
  for (const l of s.listings)
    if (Number.isFinite(l.estUnder)) (l.removedAt ? goneU : liveU).push(l.estUnder);
if (goneU.length >= 10 && liveU.length >= 10) {
  const g = med(goneU), l = med(liveU);
  out.validation = { goneMedian: g, liveMedian: l, goneN: goneU.length, liveN: liveU.length, delta: Math.round(g - l) };
}

writeFileSync("data/insights.json", JSON.stringify(out, null, 1));
console.log(`insights: ${out.dataDays}d of history, ${snaps.length} snapshots, ${Object.keys(out.searches).length} searches with metrics`);
for (const [k, m] of Object.entries(out.searches)) {
  const parts = [];
  if (m.daysOnMarket) parts.push(`gone ~${m.daysOnMarket.median}d (n=${m.daysOnMarket.n})`);
  if (m.trend) parts.push(`ask ${m.trend.pct >= 0 ? "+" : ""}${m.trend.pct}%/${m.trend.weeks}wk`);
  if (m.supply) parts.push(`${m.supply.newPerWeek}/wk new, ${m.supply.gonePerWeek}/wk gone`);
  if (m.drops) parts.push(`drops ${m.drops.medianPct}% median` + (m.drops.goneAfterMedianDays != null ? `, gone ~${m.drops.goneAfterMedianDays}d later` : ""));
  console.log(`  ${k}: ${parts.join(" · ")}`);
}
if (out.validation)
  console.log(`  audit: gone estUnder ${out.validation.goneMedian} vs live ${out.validation.liveMedian} (delta ${out.validation.delta}, n=${out.validation.goneN}/${out.validation.liveN})`);
