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

## Penny stocks: a volume burst that moved the price

`penny_watchlist.py` publishes `penny-watchlist.json`: NSE names trading between
₹10 and ₹200 where turnover has stepped up over the last two weeks, the price
went up with it, and the name is still near its own high.

A price band on its own is not a screen — under ₹200 there are 1,447 companies,
and what makes most of them dangerous is not the price but that turnover is thin
enough for one participant to set it. Each gate below rejects a specific way the
earlier ones lie.

**1. Companies you can get out of** (TradingView scanner, one request).
`type == "stock"`, because silver and gold ETFs trade in this exact band, clear a
delivery gate easily, and are not companies. **There is no market-cap band** —
what matters about a penny stock is whether you can leave it, and that is
turnover, not size. `AvgValue.Traded_90d ≥ ₹3cr/day`, measured in rupees rather
than shares: a share-count floor asks twenty times more business at ₹10 than at
₹200, so it screens price, not liquidity.

**2. A burst, not a spike** (`AvgValue.Traded_10d / AvgValue.Traded_90d ≥ 1.5`).
Ten sessions of turnover against the ninety before them. A *single-day* spike was
tried first and measured −0.30% excess over three months, with the interval clear
of zero — it actively cost return. A spike is direction-blind: the same bar
prints when an early holder distributes into retail demand as when someone
accumulates.

**3. The burst has to have moved the price** (`Perf.W ≥ 0`). This is what
separates accumulation from distribution, and it is the reason gate 2 works at
all. Demanding a *large* move reverses it — over 20% in the window scores worse
than requiring nothing, because by then it has happened.

**4. Near its own high, not far below it** (close within 25% of `High.All`). This
is the gate that makes the others work, and its direction is the opposite of the
obvious one:

| distance below the running high | 3-month excess | 95% CI |
|---|---|---|
| within 10% | **+1.85%** | [+0.26, +3.52] |
| 10–25% below | +0.56% | [−0.93, +2.21] |
| 25–50% below | −1.84% | [−3.56, +0.15] |
| 50–75% below | **−1.73%** | [−4.21, −0.88] |
| more than 75% below | −6.63% | — |

Monotone across five buckets and repeated on an independent window definition. A
penny stock far below its high is usually there for a reason; "cheap, with room
to run" is the losing side of this gradient.

**5. Delivery, not churn** (NSE's full bhavcopy, one request). `DELIV_PER ≥ 50` —
the fraction that actually settled into a demat account rather than being squared
off intraday. On its own this gate is weak; what survives unconditionally is the
*other* end, as an exclusion: below 20% delivery scores −2.72% [−3.88, −1.81].
Low delivery is a reliable way to be wrong. The same file gives `NO_OF_TRADES`,
and a 2,000-trade floor rejects the trap a volume gate walks into — one large
order against a dead counter looks like a burst and is one participant.

**6. Who actually owns it** (NSE shareholding filings, one index call plus two
filings per surviving name). Combined FII + DII ≥ 1% and not lower than the
previous quarter, read from the XBRL by rolled-up SEBI category. The filing index
carries a **`submissionDate`** and that is what decides which quarter counts:
June 2026's figures were filed on 16 July, so before that date the comparison
uses March. This gate did **not** add measurable return over seven years and is
kept because ownership is worth seeing next to a penny stock, not because it
predicts anything.

### What it is worth

Replayed over **1,715 NSE sessions (Oct 2019 – Sep 2026)** — corporate-action
adjusted, delisted names retained, ETFs excluded, entered at the **next session's
open** because delivery data is published after the close. Scored against the
mean of a date- and liquidity-matched pool, intervals from a block bootstrap over
dates:

| horizon | excess | 95% CI |
|---|---|---|
| 1 month | **+0.91%** | [+0.47, +3.08] |
| 3 months | **+1.73%** | [+0.40, +3.91] |

Real, small, and hedged by three things. It is soft in one of four regimes (the
2023–24 small-cap bull, −0.97%). It was found by searching a grid on this same
history. And the turnover floor is flat from ₹1cr to ₹20cr, so that number is a
decision about position size, not about return.

**What did not survive.** A one-day relative-volume spike: −0.30%, interval clear
of zero. Delivery as a *selection* rather than an exclusion. The FII/DII gate.
The trade-count floor. An earlier two-year version of this backtest showed +2.9%
and every gate looking useful; seven years and two independent re-derivations
reduced that to the table above. Each constant in `penny_watchlist.py` carries its
own measured result, including the ones that argue against themselves.

**How often it fires.** Median 2 names a session, mean 4.1; 18% of sessions are
empty and 11% surface more than ten. An empty day is a real answer and is
published as one — but if *most* shareholding lookups fail the run refuses to
publish at all, because "nothing qualified" and "the last gate was unreachable"
produce the same empty list and the extension mirrors it over the one on screen.

### Two traps, if you rebuild any of this

NSE's bhavcopy does **not** restate `PREV_CLOSE` on ex-dates — 0 of 361 events —
so anything chaining it books fake 60% losses on every split. And a request for a
non-trading day returns **HTTP 200 with the previous session's file**: asking for
Sunday 13 September 2026 returns 11 September's data. Read the session out of
`DATE1`, never from the date you asked for.

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

Settings → **Published lists** shows each mirrored list (**6-Month Stocks** and
**20% below ATH**): how many symbols it holds, when it last refreshed, and a per-list
**Refresh now**. A mirrored list is excluded from both backups: it is rebuilt from a
published file every day, so backing it up means pushing tens of KB GitHub already
hosts, once per edit.

A floating panel shows the target watchlist's current size and offers the same sync on
demand. `node extension/test.mjs` covers the pure logic, the cross-tab lock and the crypto
round trip; pass it a HAR of real traffic to additionally verify the payload format end
to end.

### TradingView

The same panel works on TradingView chart pages (`https://*.tradingview.com/chart*`),
no TradingView login needed. `extension/tradingview.js` runs in the page's `MAIN` world
and answers the same requests `main.js` answers on Dhan, so the panel, `bridge.js` and
the worker are shared:

- chart switching and the charted-row highlight use `window.TradingViewApi.activeChart()`;
- Last/Chg/Chg% and live ticks come from the page's own quote session
  (`getQuoteSessionInstance("simple")`);
- search uses TradingView's public symbol search, NSE stocks only;
- Bulk and the published lists resolve tickers against the quote session, and a
  company name through one search (exact ticker, sole hit, or a top hit whose name
  starts with it);
- Screener analysis, flags, sections, sorting, Space-to-advance and the shortcuts
  behave as on Dhan.

**To Dhan** is the one Dhan-only action: writing a Dhan watchlist needs Dhan's session,
so on a TradingView tab it says so instead.

A list can hold both shapes of symbol: Dhan's `NSEE<id>:<NAME>`, where NAME is usually
the company name (`NSEE7229:HCL TECHNOLOGIES`), and TradingView's `NSE:TICKER`
(TradingView spells `-` and `&` as `_`, e.g. `NSE:BAJAJ_AUTO`, `NSE:M_M`). Each page
translates the other site's symbols once and caches the result for the page. On
TradingView a Dhan NAME is checked as a ticker, then searched by company name. On
Dhan an `NSE:` ticker goes through `ScanWatchlist`, paired by the request it echoes
and tried with `-` and then `&`. The chart is reported back in the row's own
spelling, so the highlight, Alt+A and the flag shortcuts land on the existing row
rather than adding a second one. Search-add and Bulk also treat a Dhan row and an
`NSE:` hit with the same company name as one stock, so Bulk on TradingView does not
duplicate `NSEE16669:BAJAJ AUTO` as `NSE:BAJAJ_AUTO`. When the panel opens it asks the
page which stock is charted, so the highlight appears without a chart change. A ticker
Dhan only matches below its confidence bar (`MCDOWELL_N`) stays unresolved.

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
python3 ath_watchlist.py
python3 penny_watchlist.py
```

No dependencies beyond the Python standard library. `python3 -m pytest` covers the
two scanner-backed builders.
