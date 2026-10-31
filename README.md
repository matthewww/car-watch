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
- `.github/workflows/update.yml` — runs 4× daily on GitHub Actions, commits
  data changes, pushes an alert if configured.

## Setup (one-time)
1. Create a GitHub repo and push this folder.
2. Repo **Settings → Pages** → Deploy from branch → `main` / root.
3. Alerts (optional): install the [ntfy app](https://ntfy.sh) on your phone,
   subscribe to a random topic (e.g. `duster-watch-<random>`), and add repo
   secret `NTFY_TOPIC` with that topic name.
4. To run locally: `node fetch-listings.mjs`, then open `index.html`.

## Notes
- If AutoTrader starts blocking GitHub-hosted runners (HTTP 403), fall back to
  a Windows Task Scheduler job running `node fetch-listings.mjs` + `git push`
  on a schedule.
- `my-car.md` (trade-in details, ad draft) is gitignored — it never gets pushed.