#!/usr/bin/env node
/**
 * Optional LLM analyst — runs after fetch-listings.mjs when ANALYZE_API_KEY is
 * set (exits silently otherwise). Two API calls:
 *   1. per-search ranked shortlists -> data/analysis.json: searches.{key}
 *   2. if a fresh discovery sweep exists: candidate-model ranking -> analysis.discovery
 * Also appends prefixed alert lines to data/alert.txt. Non-fatal: always exits 0.
 * Config (env): ANALYZE_API_KEY, ANALYZE_BASE_URL (default Together AI),
 *               ANALYZE_MODEL (default zai-org/GLM-5.3-Flash, ~3c/day)
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { BOOT_LITRES } from "./config.mjs";

const readJsonSafe = async (file) => {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
};

const KEY = process.env.ANALYZE_API_KEY;
if (!KEY) { console.log("analyst skipped: ANALYZE_API_KEY not set"); process.exit(0); }
const BASE = process.env.ANALYZE_BASE_URL || "https://api.together.xyz/v1";
const MODEL = process.env.ANALYZE_MODEL || "zai-org/GLM-5.3-Flash";

/** buyer criteria per search key (fallback for unlisted keys) */
const CRITERIA = {
  duster:
    "wants Automatic, 2020 or newer, but will consider ANY standout bargain; diesel preferred over petrol; trading in a 2014 Duster 1.5 dCi 4x4 (older high-km 4x4 — dealers may lowball it, multi-franchise groups more likely to take it in trade)",
  caddy:
    "hard caps: R300 000 and 100 000 km (funded partly by trading in a Peugeot 108); wants the LOWEST-PRICED mechanically viable options (panel van or Kombi); flag suspiciously cheap units as verify-carefully; multi-franchise dealers welcome for the trade",
  jimny:
    "hard caps: R300 000 and 100 000 km (funded partly by trading in a Peugeot 108); no year cap so older gens appear — wants LOWEST-PRICED mechanically viable options; prefers 2-door (3-door) Jimnys — call out 5-door models explicitly; multi-franchise dealers welcome for the trade",
  seltos:
    "same buyer as the duster search: Automatic, 2020+, considers any standout bargain; 433 L boot makes it boot-qualified; 1.6 petrol + 1.5CRDi diesel autos both relevant; trading in a 2014 Duster 1.5 dCi 4x4 — multi-franchise dealers preferred for the trade",
  creta:
    "same buyer as the duster search: Automatic, 2020+, considers any standout bargain; 433 L boot; note 2019-early-2020 cars are the older gen1 (400 L boot, 1.6 motors) vs gen2 1.5 — call that out when relevant; 1.5D/1.6D diesel autos are especially relevant; trading in a 2014 Duster 1.5 dCi 4x4",
  "hr-v":
    "few listings expected — Honda reliability is the draw; 2021-and-earlier = old gen (448 L boot + Magic Seats), the 2022+ hybrid is 304 L — call that out if one appears; CVT auto preferred; trading in a 2014 Duster 1.5 dCi 4x4",
  "corolla-cross":
    "440 L boot qualifies; Toyota badge = resale and reliability priority; all CVT autos, no diesel; hybrid XS/XR mostly above the cap — note when one appears; Xi is base spec (cloth, manual aircon) vs XS/XR; verify suspiciously-cheap near-new units carefully; trading in a 2014 Duster 1.5 dCi 4x4",
  "mg-zs":
    "443 L boot qualifies outright (pre-facelift ~2018-21 ZS is ~400 L — check year per listing); 2022+ facelift: 1.5 NA + 4AT or hybrid; MG SA 5-yr warranty; resale unproven; trading in a 2014 Duster 1.5 dCi 4x4",
  "haval-h6":
    "560 L boot, C-SUV class bigger than the duster; 2.0T 7DCT or HEV, fuel ~9.8 L/100 km; GWM/Haval multi-franchise dealers are good trade candidates; 2021-22 units may retain 5-yr/100k warranty; resale unproven",
  "peugeot-2008":
    "434 L boot, 2020+ gen2 only (all in-cap autos are 6AT); PureTech 1.2T wet-belt engine — service history is critical; strong cabin; resale knock; trading in a 2014 Duster 1.5 dCi 4x4",
};

async function askModel(prompt, maxTokens) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: maxTokens, // reasoning models spend some budget on reasoning_content
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${BASE}`);
    const content = String((await res.json()).choices?.[0]?.message?.content ?? "");
    if (process.env.ANALYZE_DEBUG) {
      console.log(`debug content (${content.length} chars):`, JSON.stringify(content.slice(0, 300)));
    }
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonish = (fenced ? fenced[1] : content).match(/\{[\s\S]*\}/);
    if (jsonish) {
      const raw = jsonish[0];
      for (const candidate of [raw, raw.replace(/,\s*([}\]])/g, "$1")]) {
        try { return JSON.parse(candidate); } catch {}
      }
    }
    if (attempt < 2) {
      console.log("analyst: empty/invalid response, retrying");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

try {
  const data = (await readJsonSafe("data/listings.json")) ?? { searches: {} };
  let diff = { total: 0, searches: {} };
  try { diff = (await readJsonSafe("data/diff.json")) ?? diff; } catch {}
  const discovery = (await readJsonSafe("data/discovery.json")) ?? null;
  if (!Object.keys(data.searches ?? {}).length) throw new Error("no searches in listings.json");

  // nothing changed anywhere and we produced a fresh analysis recently -> skip,
  // unless a discovery sweep just landed (then rank the candidates)
  const discFresh = discovery?.generatedAt && Date.now() - Date.parse(discovery.generatedAt) < 26 * 3600e3;
  if (!diff.total && !discFresh) {
    const prevA = await readJsonSafe("data/analysis.json");
    if (prevA?.generatedAt && Date.now() - Date.parse(prevA.generatedAt) < 22 * 3600e3) {
      console.log("analyst: no changes and analysis <22h old — skipped");
      process.exit(0);
    }
  }

  // ---- call 1: per-search shortlists -------------------------------------
  const sections = [];
  for (const [key, s] of Object.entries(data.searches)) {
    const live = s.listings.filter((l) => !l.removedAt && l.price);
    const d = diff.searches?.[key] ?? { total: 0, new: [], dropped: [], gone: [] };
    const changedIds = new Set([...(d.new ?? []), ...(d.dropped ?? []).map((x) => x.id), ...(d.gone ?? [])]);
    const brief = live
      .slice()
      .sort((a, b) => a.price - b.price)
      .filter((l, i) => i < 25 || changedIds.has(String(l.id)))
      .map((l) => ({
        id: l.id, year: l.year, variant: l.variant, price: l.price, km: l.km,
        trans: l.transmission, fuel: l.fuel, dealer: l.dealer, area: l.area,
        estUnder: l.estUnder,
      }));
    const changes = d.total
      ? `Changes this run: ${JSON.stringify({ new: d.new, dropped: d.dropped, gone: d.gone })}` +
        (d.baseline ? " — THIS WAS THE FIRST CAPTURE of this search (baseline). Set expectations in the headline but do NOT produce alert lines for it." : "")
      : "No changes this run.";
    sections.push(
      `### Search "${key}" (${s.label})\nBuyer criteria: ${CRITERIA[key] ?? "general landscape overview"}\n` +
      `Listings (cheapest first): ${JSON.stringify(brief)}\n${changes}`
    );
  }

  const mainPrompt = `You are a used-car buying analyst watching several AutoTrader KZN searches for one buyer.
estUnder = Rands below a price model fitted on that search's current inventory (positive = good value). Use it, km and year in your reasoning.

${sections.join("\n\n")}

Respond ONLY with JSON, no other text:
{"searches": { "<key>": {"headline": "<one sentence, max 25 words: state of this market and the best move>",
  "shortlist": [{"id": <id>, "note": "<max 20 words, with numbers>"}, ...max 3],
  "alerts": ["<max 1 line, only if genuinely notable, else empty array>"]}, ... }}
Provide an entry for EVERY search key above. Rank shortlists by desirability. Be concise — the response must fit comfortably in the token budget.`;

  const parsed = await askModel(mainPrompt, 10000);
  if (!parsed?.searches) throw new Error("model returned no per-search JSON after retry");

  // ---- call 2: discovery candidate ranking (only when a fresh sweep exists)
  let discResult = null;
  if (discovery?.candidates?.length) {
    const cands = discovery.candidates.slice(0, 15).map((c) => ({
      key: c.key, count: c.count, autos: c.autos, min: c.min, max: c.max,
      boot: BOOT_LITRES[c.key] ?? "unknown — verify",
    }));
    const discPrompt = `You are a used-car buying analyst. A weekly AutoTrader KZN sweep found models NOT currently
watched by the buyer (standard filters: ≤R300 000, ≤100 000 km, 2019+, KZN only).
Buyer lens: boot ≥430 L is the established bar (treat 410-430 sliding-bench designs as borderline-qualifying); reliability and dealer network valued; autos preferred.
Candidates (boot = litres, seats up): ${JSON.stringify(cands)}

Rank which (if any) are worth ADDING as a watched search, using the boot figures.
Respond ONLY with JSON, no other text:
{"headline": "<max 25 words>", "shortlist": [{"id": "<make/model key>", "note": "<max 20 words>"}, ...max 3]}
If none are worth adding, return an empty shortlist and say why in the headline.`;
    discResult = await askModel(discPrompt, 3000);
    if (discResult?.headline) console.log(`analyst [discovery]: ${discResult.headline}`);
  }

  // ---- merge, write, alert ------------------------------------------------
  const byLabel = new Map(Object.entries(data.searches).map(([k, v]) => [k, v.label]));
  const out = { generatedAt: new Date().toISOString(), model: MODEL, searches: {} };
  const alertNew = [];
  for (const [key, s] of Object.entries(data.searches)) {
    const a = parsed.searches[key] ?? {};
    out.searches[key] = { headline: a.headline ?? "", shortlist: a.shortlist ?? [], alerts: a.alerts ?? [] };
    if (a.headline) console.log(`analyst [${s.label}]: ${a.headline}`);
    const d = diff.searches?.[key] ?? { total: 0, baseline: false };
    if (d.total && !d.baseline && Array.isArray(a.alerts)) {
      for (const line of a.alerts.slice(0, 1)) {
        alertNew.push(`[${byLabel.get(key) ?? key}] ${line}`);
      }
    }
  }
  out.discovery = discResult;

  const prevAnalysis = await readJsonSafe("data/analysis.json");
  const relevant = (x) =>
    JSON.stringify([
      Object.entries(x.searches ?? {}).map(([k, v]) => [k, v.headline, v.shortlist]),
      x.discovery ?? null,
    ]);
  if (prevAnalysis && relevant(out) === relevant(prevAnalysis)) {
    console.log("analyst: no change in notes — not rewritten");
  } else {
    await writeFile("data/analysis.json", JSON.stringify(out, null, 1));
  }

  if (alertNew.length) {
    const prev = await readFile("data/alert.txt", "utf8").catch(() => "");
    await writeFile("data/alert.txt", prev + (prev ? "\n" : "") + alertNew.join("\n") + "\n");
  }
} catch (e) {
  console.log(`analyst skipped: ${e.message}`);
  process.exit(0);
}