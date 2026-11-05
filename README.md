# Car Watch

Phone-friendly watcher for AutoTrader KZN searches with price alerts, value
scoring and an optional LLM analyst. The search list lives in `config.mjs`.

Live site: <https://matthewww.github.io/car-watch/>
Repo: <https://github.com/matthewww/car-watch>

## What it does
- `fetch-listings.mjs` — loops `config.mjs`, scrapes each search's KZN pages
  (zero dependencies, Node 18+), merges with the previous snapshot
  (firstSeen / priceHistory / removals after 2 consecutive misses) and fits a
  within-search price model (`estUnder`). Paint colour is back-filled from
  listing detail pages (a few per run, since tiles don't expose it). Writes
  `data/listings.json`, `data/diff.json`, and `data/alert.txt` when something
  changed. Baseline captures (first run of a search) never alert.
- `analyze.mjs` — optional LLM analyst (Together AI,
  `zai-org/GLM-5.3-Flash`, ≈ $0.002/run): per-search ranked shortlist with
  one-line reasons → `data/analysis.json` + extra alert lines. Runs only when
  `ANALYZE_API_KEY` is set; skips if nothing changed and analysis < 22 h old.
- `index.html` — static page (GitHub Pages): All-models tab + per-search tabs,
  area-group filter (Durban / Hillcrest & Pinetown / Pietermaritzburg /
  North Coast & Outer / Other), filters (Auto only, 2020+, both), sorting
  (incl. Value ↑), price sparklines, colour chips, NEW / price-drop / GONE
  badges, per-search landscape stats, "since your last visit" banner.
- `.github/workflows/push-alert.yml` — relays `data/alert.txt` to ntfy on push
  (the fetcher only writes alert.txt when something changed).
- `.github/workflows/update.yml` — manual/backup runner: **AutoTrader
  503-blocks GitHub-hosted runners**, so the regular schedule is the local
  Windows Task Scheduler task **CarWatch** (`run-local.ps1`): fetch → analyse
  → commit → push, triggered at logon with a 6 h throttle.

## Setup (done)
1. Repo + Pages deploy from `main` / root (above).
2. ntfy app → subscribe to topic `duster-watch-1r7tipbh8l`
   (repo secret `NTFY_TOPIC`).
3. Local task: `schtasks /query /tn CarWatch`.
4. Repo secret `ANALYZE_API_KEY` (Together AI key) enables the analyst.

## Notes
- `explore.mjs` — one-off multi-model sweep tool (superseded for the three
  watched searches; still useful for ad-hoc basket scans).
- KZN purity: province pages redirect across provinces when exhausted; the
  fetcher keeps only pages that stayed on kwazulu-natal and drops
  suggestion-section cars (price-cap + non-KZN area blacklist).