#!/usr/bin/env node
/**
 * Optional LLM analyst — runs on the schedule after fetch-listings.mjs
 * when the ANALYZE_API_KEY env var / repo secret is set (exits silently otherwise).
 *
 * Reads data/listings.json + data/diff.json, asks the model for a ranked
 * shortlist with one-line reasons, writes data/analysis.json (rendered by the
 * site) and appends its own alert lines to data/alert.txt. Non-fatal: always
 * exits 0 so a model outage never breaks the data pipeline.
 *
 * Config (env): ANALYZE_API_KEY, ANALYZE_BASE_URL (default Together AI),
 *               ANALYZE_MODEL (default zai-org/GLM-5.3-Flash, ~3c/day at 4 runs)
 */
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANALYZE_API_KEY;
if (!KEY) { console.log("analyst skipped: ANALYZE_API_KEY not set"); process.exit(0); }
const BASE = process.env.ANALYZE_BASE_URL || "https://api.together.xyz/v1";
const MODEL = process.env.ANALYZE_MODEL || "zai-org/GLM-5.3-Flash";

try {
  const d = JSON.parse(await readFile("data/listings.json", "utf8"));
  let diff = { total: 0, new: [], dropped: [], gone: [] };
  try { diff = JSON.parse(await readFile("data/diff.json", "utf8")); } catch {}
  const byId = new Map(d.listings.map((l) => [l.id, l]));

  const brief = d.listings
    .filter((l) => !l.removedAt && l.price)
    .map((l) => ({
      id: l.id, year: l.year, variant: l.variant, price: l.price, km: l.km,
      trans: l.transmission, fuel: l.fuel, dealer: l.dealer, area: l.area,
      estUnder: l.estUnder,
    }))
    .sort((a, b) => a.price - b.price);

  const pick = (id) => {
    const l = byId.get(id) ?? {};
    return { id, year: l.year, variant: l.variant, price: l.price, km: l.km, dealer: l.dealer };
  };
  const changes = diff.total
    ? `Changes this run: ${JSON.stringify({
        new: diff.new.map(pick).filter((l) => l.price),
        dropped: diff.dropped,
        gone: diff.gone.map(pick).filter((l) => l.price || l.variant),
      })}`
    : "No changes this run.";

  const prompt = `You are a used-car buying analyst for a Renault Duster watcher (AutoTrader KZN, <=R300 000, 2019+, <=100 000 km).
Buyer criteria: wants Automatic, 2020 or newer, but will consider ANY standout bargain; diesel preferred over petrol; values dealers likely to accept a trade-in (multi-franchise groups: GWM/Haval, Hyundai, KIA, Durban Multifranchise).
estUnder = Rands below a price model fitted on the current inventory (positive = good value, negative = overpriced). Use it, km and year in your reasoning.

Listings (sorted by price):
${JSON.stringify(brief)}

${changes}

Respond ONLY with JSON, no other text:
{"headline": "<one sentence: state of this market and the best move>",
 "shortlist": [{"id": <id>, "note": "<one line: why this car for this buyer, with numbers>"}, ...max 4],
 "alerts": ["<0-2 very short lines flagging changes worth a push notification>"]}
Rank the shortlist by desirability for this buyer.`;

  const callModel = () =>
    fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 6000, // reasoning models spend some budget on reasoning_content
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(90000),
    });

  let out = null;
  for (let attempt = 1; attempt <= 2 && !out; attempt++) {
    const res = await callModel();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${BASE}`);
    const content = String((await res.json()).choices?.[0]?.message?.content ?? "");
    if (process.env.ANALYZE_DEBUG) {
      console.log(`debug content (${content.length} chars):`, JSON.stringify(content.slice(0, 400)));
    }
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonish = (fenced ? fenced[1] : content).match(/\{[\s\S]*\}/);
    if (jsonish) out = JSON.parse(jsonish[0]);
    else if (attempt < 2) {
      console.log("analyst: empty/invalid response, retrying");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!out) throw new Error("model returned no JSON after retry");
  out.generatedAt = new Date().toISOString();
  out.model = MODEL;
  await writeFile("data/analysis.json", JSON.stringify(out, null, 1));
  console.log(`analyst: ${out.headline} (${out.shortlist?.length ?? 0} picks)`);

  if (diff.total && Array.isArray(out.alerts) && out.alerts.length) {
    const prev = await readFile("data/alert.txt", "utf8").catch(() => "");
    await writeFile("data/alert.txt", prev + (prev ? "\n" : "") + out.alerts.join("\n") + "\n");
  }
} catch (e) {
  console.log(`analyst skipped: ${e.message}`);
  process.exit(0);
}