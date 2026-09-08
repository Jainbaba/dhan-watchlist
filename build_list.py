#!/usr/bin/env python3
"""Build a rolling list of recent NSE mainboard IPOs.

Source is NSE's past public issues feed, which states what each record is:
`securityType` separates mainboard (EQ, and BE for issues that list into the
trade-to-trade bucket) from SME, debt and bond issues. That beats deriving
"is this new?" from the equity master's DATE OF LISTING, which is really the
date a symbol started trading on NSE -- long-listed companies migrating from
another exchange get a fresh date there and arrive in bulk batches.

The feed is cookie-gated: fetching the API without first loading the page
that uses it returns nothing useful, so prime a cookie jar and reuse it.

Its `symbol` field is the issue's symbol, which is not always the symbol the
company trades under on NSE -- Amir Chand Jagdish Kumar (Exports) lists as
AEROPLANE, LEAP India as LEAPIND. So each record is reconciled against the
equity master, which is authoritative for what a symbol is called and whether
it trades on NSE at all. An issue matching neither by symbol nor by company
name is not on NSE and is dropped rather than published for a search that
cannot find it.

Writes watchlist.json only when the fetch and parse both succeed, so a
blocked NSE request leaves the previously published list intact.
"""

import csv
import datetime as dt
import http.cookiejar
import io
import re
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

PRIME_URL = "https://www.nseindia.com/market-data/all-upcoming-issues-ipo"
MASTER_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
FEED_URL = "https://www.nseindia.com/api/public-past-issues"
OUT = pathlib.Path(__file__).parent / "watchlist.json"

WINDOW_DAYS = 182
# Mainboard. BE is the trade-to-trade settlement bucket, applied at listing to
# smaller issues -- it says how a symbol settles, not what the company is, so
# those are still mainboard IPOs. SME, DEBT and the N* bond series are not.
MAINBOARD_TYPES = ("EQ", "BE")
# The API caps a watchlist at 250 symbols.
MAX_SYMBOLS = 250

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def opener():
    jar = http.cookiejar.CookieJar()
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    o.addheaders = [
        ("User-Agent", UA),
        ("Accept-Language", "en-US,en;q=0.9"),
        ("Referer", PRIME_URL),
    ]
    return o


def fetch_feed(attempts=4):
    """NSE rate-limits datacenter IPs, and GitHub runners get caught by it."""
    last = None
    for i in range(attempts):
        try:
            o = opener()
            # Priming request: sets the cookies the API checks for.
            o.open(PRIME_URL, timeout=60).read()
            with o.open(FEED_URL, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, TimeoutError, OSError,
                json.JSONDecodeError) as err:
            last = err
            wait = 5 * (i + 1)
            print(f"attempt {i + 1}/{attempts} failed: {err}; retrying in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"could not fetch {FEED_URL}: {last}")


def fetch_master(attempts=4):
    """The equity master: what each symbol is actually called on NSE."""
    last = None
    for i in range(attempts):
        try:
            with opener().open(MASTER_URL, timeout=60) as resp:
                text = resp.read().decode("utf-8", "replace")
            return list(csv.DictReader(io.StringIO(text)))
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = err
            wait = 5 * (i + 1)
            print(f"master attempt {i + 1}/{attempts} failed: {err}; retrying in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"could not fetch {MASTER_URL}: {last}")


def norm_name(name):
    """Company names differ in punctuation and suffix between the two sources."""
    upper = (name or "").upper()
    upper = re.sub(r"\b(LIMITED|LTD|PRIVATE|PVT|THE)\b", "", upper)
    return re.sub(r"[^A-Z0-9]", "", upper)


def parse_date(value):
    try:
        return dt.datetime.strptime((value or "").strip(), "%d-%b-%Y").date()
    except ValueError:
        return None


def build(feed, master, today):
    by_symbol = {r["SYMBOL"].strip().upper(): r for r in master}
    by_name = {}
    for row in master:
        by_name.setdefault(norm_name(row["NAME OF COMPANY"]), row)

    cutoff = today - dt.timedelta(days=WINDOW_DAYS)

    ipos = {}
    skipped_types = {}
    remapped = {}
    not_on_nse = []
    for row in feed:
        sec_type = (row.get("securityType") or "").strip()
        listed = parse_date(row.get("listingDate"))
        if listed is None or listed < cutoff:
            continue
        if sec_type not in MAINBOARD_TYPES:
            skipped_types[sec_type] = skipped_types.get(sec_type, 0) + 1
            continue
        symbol = (row.get("symbol") or "").strip().upper()
        if not symbol:
            continue

        # Reconcile against the master: the feed's symbol is the issue's, not
        # necessarily the one NSE trades it under.
        traded = symbol
        if symbol not in by_symbol:
            match = by_name.get(norm_name(row.get("company")))
            if match is None:
                not_on_nse.append(
                    {"symbol": symbol, "name": (row.get("company") or "").strip()}
                )
                continue
            traded = match["SYMBOL"].strip().upper()
            remapped[symbol] = traded
        symbol = traded
        # The feed repeats a symbol when an issue has multiple tranches.
        existing = ipos.get(symbol)
        if existing and parse_date(existing["listed_on"]) <= listed:
            continue
        ipos[symbol] = {
            "symbol": symbol,
            "name": (row.get("company") or "").strip(),
            "listed_on": listed.isoformat(),
            "security_type": sec_type,
            "issue_price": (row.get("issuePrice") or "").strip(),
            "ipo_opened_on": (row.get("ipoStartDate") or "").strip(),
        }

    listings = sorted(
        ipos.values(), key=lambda i: (i["listed_on"], i["symbol"]), reverse=True
    )
    truncated = len(listings) > MAX_SYMBOLS
    if truncated:
        listings = listings[:MAX_SYMBOLS]
    return listings, skipped_types, truncated, remapped, not_on_nse


def main():
    today = dt.date.today()
    listings, skipped_types, truncated, remapped, not_on_nse = build(
        fetch_feed(), fetch_master(), today
    )

    if not listings:
        raise SystemExit("refusing to publish an empty list")

    payload = {
        "generated_on": today.isoformat(),
        "source": FEED_URL,
        "window_days": WINDOW_DAYS,
        "security_types": list(MAINBOARD_TYPES),
        "count": len(listings),
        "excluded_by_security_type": dict(sorted(skipped_types.items())),
        "remapped_to_nse_symbol": dict(sorted(remapped.items())),
        "dropped_not_on_nse": not_on_nse,
        "truncated_to_cap": truncated,
        "symbols": [i["symbol"] for i in listings],
        "listings": listings,
    }

    previous = None
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
        except json.JSONDecodeError:
            pass
    if previous and previous.get("symbols") == payload["symbols"]:
        print(f"unchanged: {len(listings)} IPOs")
        return

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(listings)} IPOs from the last {WINDOW_DAYS} days"
          f" ({len(remapped)} remapped, {len(not_on_nse)} not on NSE)")


if __name__ == "__main__":
    main()
