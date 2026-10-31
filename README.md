# Car Watch

Phone-friendly watcher for AutoTrader KZN searches with price alerts, value
scoring and an optional LLM analyst. Search list lives in `config.mjs` — one
object per model:

| key | Search | Filters |
|---|---|---|
| `duster` | Renault Duster | ≤ R300 000, 2019+, ≤ 100 000 km |
| `caddy` | VW Caddy | ≤ R300 000, ≤ 100 000 km (no year cap) |
| `jimny` | Suzuki Jimny | ≤ R300 000, ≤ 100 000 km (no year cap; 5-door flagged) |
| `seltos` | Kia Seltos | ≤ R300 000, 2019+, ≤ 100 000 km |
| `creta` | Hyundai Creta | ≤ R300 000, 2019+, ≤ 100 000 km |
| `hr-v` | Honda HR-V | ≤ R300 000, 2019+, ≤ 100 000 km |
| `corolla-cross` | Toyota Corolla Cross | ≤ R300 000, 2019+, ≤ 100 000 km |
| `mg-zs` | MG ZS | ≤ R300 000, 2019+, ≤ 100 000 km |
| `haval-h6` | Haval H6 | ≤ R300 000, 2019+, ≤ 100 000 km |
| `peugeot-2008` | Peugeot 2008 | ≤ R300 000, 2019+, ≤ 100 000 km |
| `proton-x70` | Proton X70 | ≤ R300 000, 2019+, ≤ 100 000 km |

Trade-in context: the Duster purchase is funded by trading a 2014 Duster
1.5 dCi 4x4; the Caddy/Jimny by trading a Peugeot 108.

Live site: <https://matthewww.github.io/car-watch/>
Repo: <https://github.com/matthewww/car-watch>

## What it does
- `fetch-listings.mjs` — loops `config.mjs`, scrapes each search's KZN pages
  (zero dependencies, Node 18+), merges with the previous snapshot
  (firstSeen / priceHistory / removals after 2 consecutive misses) and fits a
  within-search price model (`estUnder`). Writes `data/listings.json`,
  `data/diff.json`, and `data/alert.txt` when something changed. Baseline
  captures (first run of a search) never alert.
- `analyze.mjs` — optional LLM analyst (Together AI,
  `zai-org/GLM-5.3-Flash`, ≈ $0.002/run): per-search ranked shortlist with
  one-line reasons → `data/analysis.json` + extra alert lines. Runs only when
  `ANALYZE_API_KEY` is set; skips if nothing changed and analysis < 22 h old.
- `index.html` — static page (GitHub Pages): per-search tabs, area groups
  (Durban / Hillcrest & Pinetown / Pietermaritzburg / North Coast & Outer),
  filters (Auto only, 2020+, both), sorting (incl. Value ↑), NEW / price-drop /
  GONE badges, per-search landscape stats, "since your last visit" banner.
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
- `my-car.md` (trade-in details, ad draft) is gitignored — never pushed.
- `explore.mjs` — one-off multi-model sweep tool (superseded for the three
  watched searches; still useful for ad-hoc basket scans).
- KZN purity: province pages redirect across provinces when exhausted; the
  fetcher keeps only pages that stayed on kwazulu-natal and drops
  suggestion-section cars (price-cap + non-KZN area blacklist).