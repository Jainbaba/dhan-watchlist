# dhan-watchlist

A rolling list of NSE **mainboard** symbols listed in the last 12 months, rebuilt
daily and published as `watchlist.json`. The companion browser extension reads it
and mirrors it into a Dhan TradingView watchlist.

## What's in the list

`build_list.py` reads NSE's published equity master
([EQUITY_L.csv](https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv))
and keeps rows where:

- `SERIES` is `EQ` — mainboard. `BE` and `BZ` are surveillance buckets, not new listings.
- `DATE OF LISTING` falls within the last 365 days.
- The listing date is **not** a bulk-migration day.

That last filter matters. `DATE OF LISTING` is when a symbol began trading *on NSE*,
which is not the IPO date: a long-listed BSE company that migrates to NSE gets a fresh
listing date. Those migrations arrive in large same-day batches, and they dominate the
raw numbers — on the first build, 386 symbols passed the date filter, but 219 of them
landed on just two days (135 on 2026-08-17, 84 on 2026-04-20) against no more than 4
on any other trading day of the year. Excluding days with more than 5 listings leaves
167 genuine new listings.

This is a heuristic, not a truth source. The CSV does not say whether a listing was an
IPO. `excluded_migration_days` in the output records exactly which days were dropped so
the filter stays auditable.

## Output

```json
{
  "generated_on": "2026-09-09",
  "window_days": 365,
  "count": 167,
  "excluded_migration_days": ["2026-04-20", "2026-08-17"],
  "count_before_migration_filter": 386,
  "truncated_to_cap": false,
  "symbols": ["DEEPA", "PERNIASPOP", "..."],
  "listings": [{ "symbol": "DEEPA", "name": "...", "listed_on": "2026-09-08", "isin": "..." }]
}
```

`symbols` is capped at 250, newest first, because that is the Dhan watchlist limit.

## Schedule

`.github/workflows/update.yml` runs at 03:30 UTC (09:00 IST) daily and commits only when
the symbol set actually changes. NSE rate-limits datacenter IPs and GitHub runners get
caught by it, so the fetch retries with backoff and the script refuses to write an empty
list — a blocked run leaves the last good `watchlist.json` in place rather than
publishing nothing.

Run it by hand from the Actions tab (`workflow_dispatch`) or locally:

```bash
python3 build_list.py
```

No dependencies beyond the Python standard library.
