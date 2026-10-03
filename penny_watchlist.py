#!/usr/bin/env python3
"""Build an NSE penny-stock watchlist gated on liquidity, delivery and institutions.

A price band alone is not a screen. Under INR 200 the list is 543 names, most of
which no one can get out of: a penny stock's danger is not its price, it is that
turnover is thin enough for one participant to set it. So the band is only the
first of four gates, and each later gate is there to reject a specific way the
earlier ones lie.

1. TradingView scanner -- the price band, companies only, sustained turnover,
   a ten-session volume burst against the ninety sessions before it, a positive
   move over the past week, and a close within 25% of the name's own all-time
   high. Turnover is in rupees, not shares: a share-count floor means twenty
   times more at INR 10 than at INR 200, so it screens price, not liquidity.

   The burst and the move are gated TOGETHER on purpose. Volume on its own is
   direction-blind -- the same bar prints when an early holder distributes into
   retail demand as when someone accumulates -- and measured unconditionally a
   volume gate is worth nothing at all. Paired with the price it moved, and only
   in a name already near its high, it pays.

2. NSE's full bhavcopy -- delivery percentage and trade count for that session.
   Relative volume counts contracts, and intraday churn is contracts. Delivery
   percentage is the fraction that actually settled into a demat account, which
   is the part institutions and positional buyers are responsible for, because
   they cannot square off intraday. Trade count rejects the low-float trap that
   relative volume walks straight into: one large order against a normally dead
   counter reads as 5x relative volume and is one participant, not interest.

3. NSE's shareholding-pattern filings -- FII and DII holding, quarter by quarter.
   This is the only one of the four that is not a market-microstructure measure:
   it says who owns the company rather than who traded it today. The filing index
   carries a submissionDate, which is when a quarter's figures actually became
   public -- weeks after the quarter ended -- so the comparison uses the newest
   quarter the market could already have seen, not the newest one that exists.

Every gate records what it dropped, so a list that comes back short says why.
Written only when all three sources succeed, so a blocked run leaves the
published file intact rather than replacing it with a thinner truth.

What this is worth, measured over 1,715 sessions (Oct 2019 - Sep 2026) against a
date- and liquidity-matched control, entered at the next session's open because
delivery data is published after the close: about +0.9% over a month and +1.7%
over three, both with intervals clear of zero. That is a real but small tilt, it
is soft in one of four regimes (the 2023-24 small-cap bull), and it was found by
searching a grid on this same history. Treat the list as a place to look, not as
a reason to buy.
"""

import datetime as dt
import http.cookiejar
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

OUT = pathlib.Path(__file__).parent / "penny-watchlist.json"
SCAN_URL = "https://scanner.tradingview.com/india/scan"
BHAV_URL = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date}.csv"
SHP_URL = ("https://www.nseindia.com/api/corporate-share-holdings-master"
           "?index=equities&symbol={symbol}")
SHP_PRIME = "https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern"

# --- The dials. Every one of these is a judgement call; they are together at the
# --- top so tuning the screen never means reading the parser.

# The user's band: what counts as a penny stock here.
MIN_PRICE = 10.0
MAX_PRICE = 200.0
# There is deliberately no market-cap band. One was shipped briefly -- INR 300cr
# to 10,000cr -- and it was wrong on three counts. It was never in the backtest
# at all (the bhavcopy carries no market cap, so every figure quoted in this file
# was measured on a universe gated by turnover alone), it disagreed with the
# 100cr floor the ATH list uses, and it silently dropped 29 real NSE companies
# that carry no market_cap_basic. Size is also the wrong question here: what
# matters about a penny stock is whether you can get out of it, which is
# turnover. market_cap_basic is still fetched, as a column, to be looked at.
#
# It was doing one useful job by accident -- TradingView gives fund units no
# market cap, so requiring one excluded ETFs, and gold and silver ETFs sit right
# in this price band. That job is now done explicitly by type == "stock", which
# removes all 262 of them and keeps the 29 companies.
# INR 3cr of turnover a day, averaged over 90 sessions. Sustained, so a single
# frantic week does not qualify a name that is otherwise untradeable. With no
# market-cap band this is the ONLY size-like gate, which is the right way round:
# a penny stock's risk is that you cannot leave it, and turnover is what says
# whether you can.
#
# Swept inside the finished screen it is flat -- 1cr, 2cr, 3cr, 5cr, 10cr and
# 20cr all land between +0.8% and +1.3% over a month with intervals clear of
# zero, in no order. So this number is a decision about the size of position you
# intend to take, not about return. Raise it if you trade bigger.
MIN_AVG_TURNOVER = 30_000_000
# The burst: the last ten sessions of turnover against the ninety before them.
# A single-day spike measured nothing (-0.30% excess over three months, interval
# clear of zero) because a spike is direction-blind -- the same bar prints when a
# holder distributes into retail demand as when someone accumulates. Ten sessions
# against ninety, paired with the price gate below, is the version that measures.
MIN_VOLUME_BURST = 1.5
# The burst has to have MOVED the price. This is the gate that separates
# accumulation from distribution, and it is worth about +0.4 points on its own
# once the rest is in place. Demanding a big move instead reverses that: over 20%
# in the window scores worse than requiring nothing, because by then it is over.
MIN_WEEK_MOVE = 0.0
# How far under its own all-time high a name may sit. This is the gate that makes
# the others work, and its direction is the opposite of the obvious one:
#
#   within 10% of the high   +1.85% excess   [+0.26, +3.52]
#   10-25% below             +0.56%
#   25-50% below             -1.84%
#   50-75% below             -1.73%          [-4.21, -0.88]
#   more than 75% below      -6.63%
#
# Monotone across five buckets and repeated on an independent window definition.
# A penny stock far below its high is usually there for a reason, and "cheap with
# room to run" is the losing side of this gradient.
MAX_BELOW_ATH = 0.25
# Of the volume that traded, the fraction that settled. Unconditionally this gate
# is worth little -- what survives on its own is the other end, an exclusion:
# below 20% delivery scores -2.72% excess [-3.88, -1.81]. Low delivery is a
# reliable way to be wrong; high delivery is not by itself a way to be right.
#
# On top of the ATH and price gates it does pay, taking the screen from +1.49% to
# +2.20% over three months. 50 rather than 60 because it keeps roughly twice the
# names at the same measured excess, and a tighter interval is worth more than a
# higher point estimate.
MIN_DELIVERY_PERCENT = 50.0
# Many participants, not one large one -- the check relative volume cannot make
# for itself, since one large order against a dead counter reads as a 5x spike.
# Kept for that tail, but honestly: above the turnover floor it excludes almost
# nothing, and removing it moves the measured result by 0.04 points. It is
# insurance, not a filter.
MIN_TRADES = 2_000
# Combined FII + DII holding, most recently PUBLISHED quarter, and it must not be
# falling against the quarter before.
#
# Backtested point-in-time over seven years, and it does not add return: with the
# gate, three-month excess is +0.64%; without it but with a filing on record,
# +0.69%; and the names the gate REJECTS score +0.79%. On the 2024-2026 window
# alone it looked strong (+1.50% against +0.27%), which is exactly the window
# every other gate also looked strong in and then failed outside of.
#
# Kept because ownership is worth seeing next to a penny stock, not because it
# predicts anything. Treat what it reports as context, not as a signal.
MIN_INSTITUTIONAL_PERCENT = 1.0

# Mainboard settlement series. BE is trade-to-trade -- how a symbol settles, not
# what the company is -- and is kept, matching build_list.py.
EQUITY_SERIES = ("EQ", "BE")
# A TradeBaba list is local and unbounded; only a push into Dhan is capped, and
# that cap is enforced at the push.
MAX_SYMBOLS = 1000
# The bhavcopy for a session is published after the close, so the 17:00 IST run
# may find only yesterday's. Walking back also carries the list over weekends
# and holidays rather than failing on them.
BHAV_LOOKBACK_DAYS = 6

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# TradingView column order; build() indexes into it, so the two must agree.
COLUMNS = [
    "name",
    "close",
    "volume",
    "market_cap_basic",
    "change",
    "AvgValue.Traded_10d",
    "AvgValue.Traded_90d",
    "High.All",
    "Perf.W",
    "float_shares_percent_current",
    "Perf.6M",
]


def request_payload():
    """Every numeric gate the scanner can apply, so stage two is a short list.

    The burst and the distance below the all-time high are both RATIOS of two
    columns, and the scanner rejects an expression as a filter's right operand
    (the same refusal ath_watchlist.py works around). So those two arrive as
    columns and are applied in shortlist(); everything else is a plain number
    against a plain field and is filtered server-side.
    """
    return {
        "columns": COLUMNS,
        "filter": [
            {"left": "exchange", "operation": "match", "right": "NSE"},
            {"left": "close", "operation": "in_range", "right": [MIN_PRICE, MAX_PRICE]},
            # Companies, not fund units: silver and gold ETFs trade in this exact
            # band, pass a delivery gate easily, and are not stocks.
            {"left": "type", "operation": "equal", "right": "stock"},
            {
                "left": "AvgValue.Traded_90d",
                "operation": "greater",
                "right": MIN_AVG_TURNOVER,
            },
            {"left": "Perf.W", "operation": "egreater", "right": MIN_WEEK_MOVE},
        ],
        "options": {"lang": "en"},
        "sort": {"sortBy": "Perf.W", "sortOrder": "desc"},
        "range": [0, 2000],
    }


def fetch_scan(opener=urllib.request.urlopen):
    body = json.dumps(request_payload()).encode()
    request = urllib.request.Request(
        SCAN_URL,
        data=body,
        headers={"User-Agent": UA, "Content-Type": "application/json"},
    )
    with opener(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("TradingView response did not contain data")
    return payload


def get(request):
    return urllib.request.urlopen(
        urllib.request.Request(
            request, headers={"User-Agent": UA, "Referer": "https://www.nseindia.com/"}
        ),
        timeout=60,
    ).read().decode("utf-8", "replace")


def parse_bhav(text):
    """SYMBOL -> the session's delivery figures.

    Returns the rows and the session they are actually FOR, which is not always
    the session that was asked for: NSE answers a weekend or holiday request with
    HTTP 200 and the previous session's file. Asking for Sunday 13 September 2026
    returns 11 September's data. Taking the requested date on trust publishes a
    wrong session_date, and would silently republish a stale session if the echo
    ever reached further back.

    The header and every field carry padding spaces, and DELIV_QTY/DELIV_PER are
    a literal "-" for series that do not settle by delivery, so neither the keys
    nor the numbers can be used as they arrive.
    """
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("bhavcopy was empty")
    header = [cell.strip() for cell in lines[0].split(",")]
    rows, session = {}, None
    for line in lines[1:]:
        cells = [cell.strip() for cell in line.split(",")]
        if len(cells) != len(header):
            continue
        row = dict(zip(header, cells))
        if session is None:
            session = parse_shp_date(row.get("DATE1"))
        if row.get("SERIES") not in EQUITY_SERIES:
            continue
        rows[row["SYMBOL"]] = row
    if not rows:
        raise ValueError("bhavcopy held no EQ/BE rows")
    if session is None:
        raise ValueError("bhavcopy carried no readable session date")
    return rows, session


def fetch_bhav(today=None, fetch=get):
    """The most recent published session, and which date that turned out to be."""
    today = today or dt.date.today()
    last = None
    for back in range(BHAV_LOOKBACK_DAYS + 1):
        day = today - dt.timedelta(days=back)
        try:
            # The session comes from inside the file, not from `day`.
            return parse_bhav(fetch(BHAV_URL.format(date=day.strftime("%d%m%Y"))))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            last = error
    raise ValueError(f"no NSE bhavcopy in the last {BHAV_LOOKBACK_DAYS} days: {last}")


def number(value):
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


# SEBI's shareholding taxonomy, by the local name of the dimension member each
# percentage is reported against. The rolled-up members are used rather than the
# sub-categories, so a filer that splits FPIs into categories one and two still
# totals correctly.
FII_MEMBER = "InstitutionsForeignMember"
DII_MEMBER = "InstitutionsDomesticMember"
PROMOTER_MEMBER = "ShareholdingOfPromoterAndPromoterGroupMember"
PUBLIC_MEMBER = "PublicShareholdingMember"
PERCENT_TAG = "ShareholdingAsAPercentageOfTotalNumberOfShares"


def shp_opener():
    """The filings API is cookie-gated the same way the IPO feed is."""
    jar = http.cookiejar.CookieJar()
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    o.addheaders = [
        ("User-Agent", UA),
        ("Accept-Language", "en-US,en;q=0.9"),
        ("Referer", SHP_PRIME),
    ]
    o.open(SHP_PRIME, timeout=60).read()
    return o


def parse_shp_xbrl(text):
    """Percentages by shareholder category out of one SEBI filing.

    Read by the LOCAL name of the element and of each context's dimension
    member, so the filer's namespace prefix does not matter. Some filings state
    a percentage as a fraction and some as a number out of a hundred; promoter
    plus public is the whole company either way, so that sum says which.
    """
    root = ET.fromstring(text)
    contexts = {}
    for element in root.iter():
        if element.tag.endswith("}context"):
            contexts[element.get("id")] = [
                (member.text or "").split(":")[-1]
                for member in element.iter()
                if member.tag.endswith("}explicitMember")
            ]
    values = {}
    for element in root.iter():
        if element.tag.split("}")[-1] != PERCENT_TAG:
            continue
        members = contexts.get(element.get("contextRef")) or []
        if len(members) != 1:
            continue
        try:
            values[members[0]] = float((element.text or "").strip())
        except ValueError:
            continue
    promoter = values.get(PROMOTER_MEMBER)
    public = values.get(PUBLIC_MEMBER)
    if promoter is None or public is None:
        raise ValueError("filing reported neither a promoter nor a public total")
    whole = promoter + public
    if 0.9 <= whole <= 1.1:
        scale = 100.0
    elif 90 <= whole <= 110:
        scale = 1.0
    else:
        raise ValueError(f"promoter plus public came to {whole}, not a whole company")
    return {
        "fii_percent": round(values.get(FII_MEMBER, 0.0) * scale, 4),
        "dii_percent": round(values.get(DII_MEMBER, 0.0) * scale, 4),
        "promoter_percent": round(promoter * scale, 4),
    }


def parse_shp_index(rows, asof):
    """The filings this symbol had already PUBLISHED by `asof`, newest first.

    A quarter's figures are filed weeks after the quarter ends -- June 2026's
    landed on 16 July -- so selecting by quarter-end date would compare against
    numbers nobody had yet. submissionDate is when it became public, and that is
    what decides whether it counts. A revised filing for a quarter already seen
    replaces it rather than adding a second entry for the same period.
    """
    filings = {}
    for row in rows:
        url = (row.get("xbrl") or "").strip()
        quarter = parse_shp_date(row.get("date"))
        filed = parse_shp_date(row.get("submissionDate")) or quarter
        if not url.startswith("https://") or quarter is None or filed is None:
            continue
        if filed > asof:
            continue
        seen = filings.get(quarter)
        if seen is None or seen[0] < filed:
            filings[quarter] = (filed, url)
    return [(q, filings[q][1]) for q in sorted(filings, reverse=True)]


def parse_shp_date(value):
    for fmt in ("%d-%b-%Y", "%d-%B-%Y"):
        try:
            return dt.datetime.strptime((value or "").strip(), fmt).date()
        except ValueError:
            continue
    return None


def fetch_holdings(symbols, asof=None, opener=None, pause=0.4):
    """The two most recently published quarters for each shortlisted name.

    One index call per symbol, then one filing per quarter compared. A symbol
    that cannot be read is dropped rather than failing the run; main() refuses
    to publish if that happens to most of them.
    """
    asof = asof or dt.date.today()
    o = opener or shp_opener()
    holdings, failed = {}, {}
    for index, symbol in enumerate(symbols):
        if index:
            time.sleep(pause)
        try:
            raw = o.open(SHP_URL.format(symbol=symbol), timeout=90).read()
            rows = json.loads(raw.decode("utf-8", "replace"))
            rows = rows if isinstance(rows, list) else rows.get("data") or []
            published = parse_shp_index(rows, asof)
            if len(published) < 2:
                raise ValueError("fewer than two published quarters on file")
            latest, previous = published[0], published[1]
            now = parse_shp_xbrl(o.open(latest[1], timeout=90).read().decode("utf-8", "replace"))
            time.sleep(pause)
            before = parse_shp_xbrl(o.open(previous[1], timeout=90).read().decode("utf-8", "replace"))
            holdings[symbol] = {
                **now,
                "quarter": latest[0].isoformat(),
                "previous_quarter": previous[0].isoformat(),
                "fii_percent_previous": before["fii_percent"],
                "dii_percent_previous": before["dii_percent"],
            }
        except (urllib.error.URLError, TimeoutError, OSError, ValueError,
                json.JSONDecodeError, ET.ParseError) as error:
            failed[symbol] = f"{type(error).__name__}: {error}"
    return holdings, failed


def shortlist(payload, bhav):
    """Stages one and two: the scanner's rows, then the session's delivery.

    Returns the survivors and a count per rejection reason, so a short list is
    explainable without rerunning anything.
    """
    dropped = {"not_nse": 0, "no_reference": 0, "burst": 0, "below_ath": 0,
               "not_in_bhavcopy": 0, "delivery": 0, "trades": 0}
    entries = {}
    for row in payload["data"]:
        qualified = str(row.get("s") or "").upper().strip()
        if ":" not in qualified:
            dropped["not_nse"] += 1
            continue
        exchange, symbol = qualified.split(":", 1)
        if exchange != "NSE" or not symbol:
            dropped["not_nse"] += 1
            continue
        if qualified in entries:
            continue
        values = row.get("d") or []
        if len(values) < len(COLUMNS):
            dropped["not_nse"] += 1
            continue
        close, turn10, turn90, ath = values[1], values[5], values[6], values[7]
        if not isinstance(ath, (int, float)) or ath <= 0 or not turn90:
            dropped["no_reference"] += 1
            continue
        # Both are ratios the scanner would not filter on, so they land here.
        burst = turn10 / turn90
        below_ath = 1.0 - close / ath
        if burst < MIN_VOLUME_BURST:
            dropped["burst"] += 1
            continue
        if below_ath > MAX_BELOW_ATH:
            dropped["below_ath"] += 1
            continue
        session = bhav.get(symbol)
        if session is None:
            dropped["not_in_bhavcopy"] += 1
            continue
        delivery = number(session.get("DELIV_PER"))
        trades = number(session.get("NO_OF_TRADES"))
        if delivery is None or delivery < MIN_DELIVERY_PERCENT:
            dropped["delivery"] += 1
            continue
        if trades is None or trades < MIN_TRADES:
            dropped["trades"] += 1
            continue
        entries[qualified] = {
            "symbol": symbol,
            "exchange": exchange,
            "qualified_symbol": qualified,
            "name": values[0],
            "close": values[1],
            "volume": values[2],
            "market_cap": values[3],
            "change": values[4],
            "avg_turnover_10d": turn10,
            "avg_turnover_90d": turn90,
            "volume_burst": round(burst, 2),
            "all_time_high": ath,
            "pct_below_ath": round(below_ath * 100, 2),
            "performance_week": values[8],
            "free_float_percent": values[9],
            "performance_6m": values[10],
            "series": session.get("SERIES"),
            "delivery_percent": delivery,
            "trades": trades,
            "delivery_quantity": number(session.get("DELIV_QTY")),
            "turnover_lacs": number(session.get("TURNOVER_LACS")),
        }
    return list(entries.values()), dropped


def build(entries, holdings, failed, today=None, session_date=None):
    """Stage three: keep the names institutions hold and are not leaving."""
    today = today or dt.date.today()
    dropped_institutional = 0
    kept = []
    for entry in entries:
        holding = holdings.get(entry["symbol"])
        if holding is None:
            continue
        combined = (holding["fii_percent"] or 0.0) + (holding["dii_percent"] or 0.0)
        previous = (holding["fii_percent_previous"] or 0.0) + (
            holding["dii_percent_previous"] or 0.0
        )
        # Not falling, rather than rising: a quarter where a holder stands still
        # is not a holder leaving, and requiring an increase every quarter
        # empties the list in any quarter the market is flat.
        if combined < MIN_INSTITUTIONAL_PERCENT or combined < previous:
            dropped_institutional += 1
            continue
        kept.append(
            {
                **entry,
                **holding,
                "institutional_percent": round(combined, 2),
                "institutional_percent_previous": round(previous, 2),
                "institutional_change": round(combined - previous, 2),
            }
        )

    matched = len(kept)
    # Rank by conviction in the session that got them here -- delivery first,
    # then how unusual the volume was -- then restore symbol order so the
    # published file diffs cleanly day to day.
    ranked = sorted(
        kept,
        key=lambda item: (item["delivery_percent"], item["volume_burst"]),
        reverse=True,
    )[:MAX_SYMBOLS]
    ordered = sorted(ranked, key=lambda item: item["qualified_symbol"])
    return {
        "watchlist_name": f"Penny {MIN_PRICE:g}-{MAX_PRICE:g}",
        "generated_on": today.isoformat(),
        "session_date": session_date.isoformat() if session_date else None,
        "sources": {
            "scan": SCAN_URL,
            "delivery": BHAV_URL.format(date="DDMMYYYY"),
            "shareholding": SHP_URL.format(symbol="SYMBOL"),
        },
        "market": "india",
        "exchange": "NSE",
        "criteria": {
            "price": [MIN_PRICE, MAX_PRICE],
            "instrument_type": "stock",
            "min_avg_turnover_90d": MIN_AVG_TURNOVER,
            "min_volume_burst_10d_over_90d": MIN_VOLUME_BURST,
            "min_week_move_percent": MIN_WEEK_MOVE,
            "max_percent_below_all_time_high": MAX_BELOW_ATH * 100,
            "min_delivery_percent": MIN_DELIVERY_PERCENT,
            "min_trades": MIN_TRADES,
            "min_institutional_percent": MIN_INSTITUTIONAL_PERCENT,
            "institutional_must_not_fall": True,
            "series": list(EQUITY_SERIES),
        },
        "count": len(ordered),
        "matched_total": matched,
        "truncated_to_cap": matched > MAX_SYMBOLS,
        "dropped_on_institutional": dropped_institutional,
        "shareholding_lookup_failed": failed,
        "symbols": [item["qualified_symbol"] for item in ordered],
        "entries": ordered,
    }


def main(argv=None):
    del argv
    try:
        scan = fetch_scan()
        bhav, session_date = fetch_bhav()
        entries, dropped = shortlist(scan, bhav)
        print(
            f"{len(scan['data'])} from the scanner, {len(entries)} after the "
            f"{session_date} session (dropped {dropped})",
            file=sys.stderr,
        )
        holdings, failed = fetch_holdings([entry["symbol"] for entry in entries])
        # An empty list is a real answer when nothing qualified, but not when the
        # shareholding source was simply unreachable -- screener.in rate-limits,
        # and every lookup failing would otherwise publish "nothing qualified"
        # and have the extension mirror that over the list already on screen.
        if entries and len(failed) > len(entries) / 2:
            raise ValueError(
                f"{len(failed)} of {len(entries)} shareholding lookups failed; "
                "refusing to publish a list the last gate could not screen"
            )
        payload = build(entries, holdings, failed, session_date=session_date)
    except (
        ValueError,
        urllib.error.URLError,
        OSError,
        json.JSONDecodeError,
    ) as error:
        raise SystemExit(f"penny list not updated: {error}")

    # Unlike the other two lists this one can legitimately come back empty: it
    # asks for something to have happened today. Publishing that is honest;
    # refusing to would leave a stale list looking current.
    previous = None
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
        except json.JSONDecodeError:
            pass
    if previous == payload:
        print(f"unchanged: {payload['count']} NSE penny stocks")
        return
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(OUT)
    print(f"wrote {payload['count']} NSE penny stocks ({payload['watchlist_name']})")


if __name__ == "__main__":
    main()
