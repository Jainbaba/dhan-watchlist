#!/usr/bin/env python3
"""Build a rolling list of recent NSE mainboard listings.

Source is NSE's published equity master (EQUITY_L.csv), which carries a
DATE OF LISTING per symbol. Two caveats drive the filtering below:

  * SERIES tells mainboard from the rest. EQ is mainboard; BE and BZ are
    surveillance/trade-to-trade buckets, not new listings.
  * DATE OF LISTING is the date the symbol started trading on NSE, which is
    not the IPO date. When a long-listed BSE company migrates to NSE it gets
    a fresh listing date, and those migrations arrive in large same-day
    batches (135 symbols on one date, 84 on another, against <=4 on every
    other trading day of the year).

Writes watchlist.json only when the fetch and parse both succeed, so a
blocked NSE request leaves the previously published list intact.
"""

import csv
import datetime as dt
import io
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

CSV_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
OUT = pathlib.Path(__file__).parent / "watchlist.json"

WINDOW_DAYS = 365
MAINBOARD_SERIES = "EQ"
# ponytail: same-day count is a heuristic for "this was a migration batch, not
# a listing day". The real signal (was this an IPO?) is not in this CSV. If NSE
# ever migrates companies in dribs of <=5/day this lets them through; switch to
# an actual IPO feed if that starts mattering.
MAX_LISTINGS_PER_DAY = 5
# The API caps a watchlist at 250 symbols.
MAX_SYMBOLS = 250

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/csv,*/*",
    "Referer": "https://www.nseindia.com/",
}


def fetch(url, attempts=4):
    """NSE rate-limits datacenter IPs, and GitHub runners get caught by it."""
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = err
            wait = 5 * (i + 1)
            print(f"attempt {i + 1}/{attempts} failed: {err}; retrying in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"could not fetch {url}: {last}")


def parse(text, today):
    cutoff = today - dt.timedelta(days=WINDOW_DAYS)
    rows = csv.DictReader(io.StringIO(text))
    # Header fields carry leading spaces in the published file.
    clean = lambda row, name: (row.get(name) or "").strip()

    recent = []
    for row in rows:
        if clean(row, " SERIES") != MAINBOARD_SERIES:
            continue
        raw_date = clean(row, " DATE OF LISTING")
        try:
            listed = dt.datetime.strptime(raw_date, "%d-%b-%Y").date()
        except ValueError:
            continue
        if listed < cutoff:
            continue
        recent.append({
            "symbol": clean(row, "SYMBOL"),
            "name": clean(row, "NAME OF COMPANY"),
            "listed_on": listed.isoformat(),
            "isin": clean(row, " ISIN NUMBER"),
        })

    per_day = {}
    for item in recent:
        per_day[item["listed_on"]] = per_day.get(item["listed_on"], 0) + 1
    batch_days = sorted(d for d, n in per_day.items() if n > MAX_LISTINGS_PER_DAY)

    listings = [i for i in recent if per_day[i["listed_on"]] <= MAX_LISTINGS_PER_DAY]
    listings.sort(key=lambda i: (i["listed_on"], i["symbol"]), reverse=True)

    truncated = False
    if len(listings) > MAX_SYMBOLS:
        listings = listings[:MAX_SYMBOLS]
        truncated = True

    return listings, batch_days, len(recent), truncated


def main():
    today = dt.date.today()
    listings, batch_days, before_filter, truncated = parse(fetch(CSV_URL), today)

    if not listings:
        raise SystemExit("refusing to publish an empty list")

    payload = {
        "generated_on": today.isoformat(),
        "source": CSV_URL,
        "window_days": WINDOW_DAYS,
        "count": len(listings),
        "excluded_migration_days": batch_days,
        "count_before_migration_filter": before_filter,
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
        print(f"unchanged: {len(listings)} symbols")
        return

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(listings)} symbols "
          f"({before_filter} before excluding {len(batch_days)} migration days)")


if __name__ == "__main__":
    main()
