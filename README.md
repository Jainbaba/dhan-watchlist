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

### Symbols are reconciled against the equity master

The IPO feed's `symbol` is the *issue's* symbol, which is not always what the company
trades under on NSE. Amir Chand Jagdish Kumar (Exports) lists as `AEROPLANE`; LEAP India
lists as `LEAPIND`. Publishing the feed's value sends the extension looking for a ticker
that does not exist.

So each record is reconciled against `EQUITY_L.csv`, which is authoritative for what a
symbol is called and whether it trades on NSE at all: matched by symbol, else by
normalised company name, else dropped as not-on-NSE. Both outcomes are recorded in
`remapped_to_nse_symbol` and `dropped_not_on_nse` so neither is silent.

Each source is used only for what it is authoritative about — the IPO feed for *whether
this was an IPO*, the equity master for *what it is called*.

## Output

```json
{
  "generated_on": "2026-09-09",
  "window_days": 182,
  "security_types": ["EQ", "BE"],
  "count": 53,
  "excluded_by_security_type": { "SME": 44, "N0": 25, "IV": 3, "DEBT": 1, "RR": 1 },
  "remapped_to_nse_symbol": { "AMIRCHAND": "AEROPLANE", "LEAP": "LEAPIND" },
  "dropped_not_on_nse": [],
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

## Extension

`extension/` is an unpacked MV3 Chrome/Brave extension. Load it via
`brave://extensions` (or `chrome://extensions`) with Developer mode on and
**Load unpacked**.

It runs a content script in the `MAIN` world on `https://tv.dhan.co/*`. That
placement is not incidental: the API pins CORS to the `tv.dhan.co` origin, so a request
from a background service worker is refused, and the page's own `CryptoJS` and session
object are only reachable from the main world.

On page load it fetches `watchlist.json`, compares `generated_on` against the last build
applied (remembered in `localStorage`), and does nothing if they match. When the list is
newer it resolves every symbol first, then clears **6-Month Stocks** and refills it, so a
failed lookup leaves the watchlist untouched. The target is matched by name and never
created — if it is missing, the sync stops and says so.

Two tabs opening at once would otherwise interleave two clear-and-refill cycles, so a
sync claims a timestamped lock in `localStorage` first and a second tab stands down.
Symbols that come back with no confident match are named individually in the log rather
than quietly dropped, and any failure badges the launcher instead of passing silently.

### Screener

A TradeBaba browser side panel follows the active Dhan tab and renders the useful
Screener data locally: key ratios, editable saved ratios, pros and cons, quarterly
results, profit and loss growth, and the coloured shareholding pattern. Open it from
the extension toolbar icon; Chrome controls whether it sits on the left or right.
**Source** opens the original company page and **Retry** repeats a failed lookup.

The prototype also includes four sample NSE rows (Reliance, TCS, Infosys, and HDFC
Bank). Select a row to request a chart change in Dhan; the analysis updates only after
the chart watcher confirms the new symbol. Drag the browser side-panel edge wider to
see the sample list beside the financial tables. This control is read-only and does
not create or modify Dhan watchlists.

The background worker resolves Dhan's ticker or company name using Screener's search
and fetches its public HTML; `bridge.js` relays the result to the panel. The extension
does not embed Screener, so frame policy and CSP do not affect the analysis view.

After updating, reload the extension in `chrome://extensions` or `brave://extensions`,
then refresh the Dhan tab. Old content scripts cannot reconnect after an extension
reload. If “Receiving end does not exist” persists, check the extension's service
worker errors on that extensions page, then use **Retry** after fixing the worker.

A floating panel shows the target watchlist's current size and offers the same sync on
demand. `node extension/test.mjs` covers the pure logic, the cross-tab lock and the crypto
round trip; pass it a HAR of real traffic to additionally verify the payload format end
to end.

## Schedule

`.github/workflows/update.yml` runs at 11:30 UTC (17:00 IST) and again at 13:30 UTC
(19:00 IST), committing only when the symbol set actually changes. The first run sits
after the 15:30 close, so the ATH range reflects the day's settled prices. The second
exists because a blocked fetch would otherwise leave the list stale for a full day; it
costs nothing when the first run already succeeded. NSE rate-limits datacenter IPs and GitHub runners get
caught by it, so the fetch retries with backoff and the script refuses to write an empty
list — a blocked run leaves the last good `watchlist.json` in place rather than
publishing nothing.

Run it by hand from the Actions tab (`workflow_dispatch`) or locally:

```bash
python3 build_list.py
```

No dependencies beyond the Python standard library.
