# dhan-watchlist

A rolling list of **NSE mainboard IPOs from the last 6 months**, rebuilt daily and
published as `watchlist.json`. The companion browser extension reads it and mirrors it
into a Dhan TradingView watchlist named **6-Month Stocks**.

## What's in the list

`build_list.py` reads NSE's past public issues feed
(`https://www.nseindia.com/api/public-past-issues`) and keeps records where:

- `securityType` is `EQ` or `BE` — mainboard.
- `listingDate` falls within the last 182 days.

`BE` is the trade-to-trade settlement bucket, applied at listing to smaller issues. It
describes how a symbol settles, not what the company is, so those are still mainboard
IPOs and are included. `SME`, `DEBT` and the `N*` bond series are excluded; the counts
that were dropped are recorded in `excluded_by_security_type` on every build.

This feed is used in preference to the equity master (`EQUITY_L.csv`) because it states
what each record *is*. The equity master only offers `DATE OF LISTING`, which is when a
symbol began trading *on NSE* — a long-listed BSE company migrating to NSE gets a fresh
date there, and those migrations arrive in bulk batches large enough to swamp the real
signal. Deriving IPOs from that column needed a same-day-count heuristic; this feed
needs none.

The feed is cookie-gated: requesting the API without first loading the page that uses it
returns nothing useful, so the script primes a cookie jar and reuses it.

## Output

```json
{
  "generated_on": "2026-09-09",
  "window_days": 182,
  "security_types": ["EQ", "BE"],
  "count": 53,
  "excluded_by_security_type": { "SME": 44, "N0": 25, "IV": 3, "DEBT": 1, "RR": 1 },
  "truncated_to_cap": false,
  "symbols": ["DEEPA", "PERNIASPOP", "..."],
  "listings": [
    {
      "symbol": "DEEPA",
      "name": "Deepa Jewellers Limited",
      "listed_on": "2026-09-08",
      "security_type": "EQ",
      "issue_price": "...",
      "ipo_opened_on": "..."
    }
  ]
}
```

`symbols` is newest-first and capped at 250, the Dhan watchlist limit.

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
