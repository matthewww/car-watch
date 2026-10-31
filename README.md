# Duster Watch

Phone-friendly tracker for AutoTrader KZN Renault Duster listings
(≤ R300 000, 2019+, ≤ 100 000 km): <https://www.autotrader.co.za/cars-for-sale/kwazulu-natal/p-2/renault/duster?price=less-than-300000&year=more-than-2019&mileage=less-than-100000>

## What it does
- `fetch-listings.mjs` — scrapes the search page (no dependencies, Node 18+),
  merges with the previous snapshot and writes `data/listings.json`,
  `data/diff.json`, and `data/alert.txt` when something changed.
- `index.html` — static page (GitHub Pages) grouping listings by area
  (Durban / Hillcrest & Pinetown / Pietermaritzburg / North Coast & Outer)
  with filters (Auto only, 2020+, Auto+2020+), sorting, and
  NEW / price-drop / GONE badges.
- `.github/workflows/push-alert.yml` — relays `data/alert.txt` to ntfy whenever
  a push changes it (the fetcher only writes alert.txt when something changed).
- `.github/workflows/update.yml` — manual/backup runner: **AutoTrader
  503-blocks GitHub-hosted runners**, so the regular schedule is the local
  Windows Task Scheduler task **DusterWatch** (4× daily via `run-local.ps1`,
  which fetches, analyses, commits and pushes).
- **Valuation**: each fetch fits a price model (year / km / trim / transmission /
  4WD) on the current inventory and stores `estUnder` per listing — shown on the
  site as "≈Rnk under/over" badges and a Value sort. Deterministic, no API needed.
- **LLM analyst (optional)**: `analyze.mjs` runs after fetch when repo secret
  `ANALYZE_API_KEY` is set (Together AI key; default model `zai-org/GLM-5.3-Flash`,
  ≈ $0.002 per run). Writes `data/analysis.json` — a ranked shortlist with
  one-line reasons rendered at the top of the site — and can add lines to the
  push alert. Uses only listing data, no personal info. Test locally with
  `$env:ANALYZE_API_KEY = "<key>"; node analyze.mjs`.

## Setup (one-time)
1. Repo: <https://github.com/matthewww/duster-watch> (public).
2. Pages deploys from `main` / root: <https://matthewww.github.io/duster-watch/>
3. Alerts: ntfy app → subscribe to topic `duster-watch-1r7tipbh8l`
   (secret `NTFY_TOPIC` already set in the repo).
4. Schedule: local task `DusterWatch` runs `run-local.ps1` at
   03:20 / 09:20 / 15:20 / 21:20 SAST (`schtasks /query /tn DusterWatch`).
   It needs the machine on; missed slots are caught up when available.
5. Optional manual CI run: Actions → update-listings → Run workflow (may 503).
6. To run locally by hand: `node fetch-listings.mjs` (then open the site via
   `npx serve .` — browsers block `file://` fetches).

## Notes
- If AutoTrader starts blocking GitHub-hosted runners (HTTP 403), fall back to
  a Windows Task Scheduler job running `node fetch-listings.mjs` + `git push`
  on a schedule.
- `my-car.md` (trade-in details, ad draft) is gitignored — it never gets pushed.