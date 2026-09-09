#!/usr/bin/env python3
"""Build a bounded NSE TradingView watchlist for stocks near their all-time high."""

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import sys
import urllib.error
import urllib.request

OUT = pathlib.Path(__file__).parent / "ath-watchlist.json"
SCAN_URL = "https://scanner.tradingview.com/india/scan"
MAX_SYMBOLS = 250
DEFAULT_THRESHOLD = 20.0
UA = "Mozilla/5.0 (compatible; dhan-watchlist/1.0)"


def threshold(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("ATH threshold must be a finite number between 0 and 100")
    if not math.isfinite(number) or not 0 < number <= 100:
        raise ValueError("ATH threshold must be a finite number between 0 and 100")
    return number


def request_payload(percent):
    """NSE equities above the market-cap floor, with each one's all-time high.

    The scanner used to accept `close between [High.All*0.8, High.All]`, but it
    now rejects a filter whose right operand is an expression ("Incompatible
    types: number and null"), and the older `markets`/`symbols` keys make it
    refuse the body outright. So ask for High.All as a column and apply the
    band in build(): one request either way, and no dependency on server-side
    expression support.
    """
    del percent  # the band is applied locally, in build()
    return {
        "columns": ["name", "close", "volume", "market_cap_basic", "change", "High.All"],
        "filter": [
            {"left": "market_cap_basic", "operation": "greater", "right": 1000000000},
            {"left": "exchange", "operation": "match", "right": "NSE"},
        ],
        "options": {"lang": "en"},
        "sort": {"sortBy": "change", "sortOrder": "desc"},
        "range": [0, 6000],
    }


def fetch_scan(percent, opener=urllib.request.urlopen):
    body = json.dumps(request_payload(percent)).encode()
    request = urllib.request.Request(
        SCAN_URL, data=body, headers={"User-Agent": UA, "Content-Type": "application/json"}
    )
    with opener(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("TradingView response did not contain data")
    return payload


def build(payload, percent, today=None):
    """Normalize rows, retain the exchange identity, sort, dedupe, and cap."""
    today = today or dt.date.today()
    entries = {}
    for row in payload["data"]:
        qualified = str(row.get("s") or "").upper().strip()
        if ":" not in qualified:
            continue
        exchange, symbol = qualified.split(":", 1)
        if exchange != "NSE" or not symbol:
            continue
        values = row.get("d") or []
        close = values[1] if len(values) > 1 else None
        ath = values[5] if len(values) > 5 else None
        # The band, inclusive at both ends: a stock sitting exactly at its
        # all-time high is in range, and so is one exactly `percent` below.
        if not isinstance(close, (int, float)) or not isinstance(ath, (int, float)) or ath <= 0:
            continue
        if not (ath * (1 - percent / 100) <= close <= ath):
            continue
        entry = {
            "symbol": symbol,
            "exchange": exchange,
            "qualified_symbol": qualified,
            "name": values[0] if len(values) > 0 else "",
            "close": close,
            "volume": values[2] if len(values) > 2 else None,
            "market_cap": values[3] if len(values) > 3 else None,
            "change": values[4] if len(values) > 4 else None,
            "all_time_high": ath,
            "pct_below_ath": round((1 - close / ath) * 100, 2),
        }
        entries.setdefault(qualified, entry)
    matched = len(entries)
    # Far more names qualify than a Dhan watchlist holds (793 vs 250 on
    # 2026-09-10), so the cap decides what gets published. Rank by closeness to
    # the all-time high and keep the tightest, rather than the alphabetically
    # first, then restore symbol order for a stable diff.
    ranked = sorted(entries.values(), key=lambda item: item["pct_below_ath"])[:MAX_SYMBOLS]
    truncated = matched > MAX_SYMBOLS
    ordered = sorted(ranked, key=lambda item: item["qualified_symbol"])
    if not ordered:
        raise ValueError("refusing to publish an empty ATH list")
    return {
        "watchlist_name": f"ATH Below {percent:g}%",
        "generated_on": today.isoformat(),
        "source": SCAN_URL,
        "market": "india",
        "exchange": "NSE",
        "threshold_percent": percent,
        "ath_window": {"minimum_close_pct": 100 - percent, "maximum_close_pct": 100},
        "filter_semantics": "market cap > INR 100cr (1e9); close between High.All*lower and High.All, inclusive, applied locally",
        "count": len(ordered),
        "matched_total": matched,
        "truncated_to_cap": truncated,
        "symbols": [item["qualified_symbol"] for item in ordered],
        "entries": ordered,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", default=os.environ.get("ATH_THRESHOLD_PERCENT", DEFAULT_THRESHOLD))
    args = parser.parse_args(argv)
    try:
        percent = threshold(args.threshold)
        payload = build(fetch_scan(percent), percent)
    except (ValueError, urllib.error.URLError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"ATH list not updated: {error}")
    previous = None
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
        except json.JSONDecodeError:
            pass
    if previous == payload:
        print(f"unchanged: {payload['count']} NSE stocks")
        return
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(OUT)
    print(f"wrote {payload['count']} NSE stocks ({payload['watchlist_name']})")


if __name__ == "__main__":
    main()
