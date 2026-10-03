import datetime as dt
import json
import unittest

import penny_watchlist as pw


BHAV = "\n".join(
    [
        "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, "
        "LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, "
        "NO_OF_TRADES, DELIV_QTY, DELIV_PER",
        "GOOD, EQ, 10-Sep-2026, 50, 50, 55, 49, 54, 54, 52, 900000, 468.00, 9000, 540000, 60.00",
        "CHURN, EQ, 10-Sep-2026, 50, 50, 55, 49, 54, 54, 52, 900000, 468.00, 9000, 90000, 10.00",
        "THIN, EQ, 10-Sep-2026, 50, 50, 55, 49, 54, 54, 52, 900000, 468.00, 12, 540000, 60.00",
        "TRUST, BE, 10-Sep-2026, 50, 50, 55, 49, 54, 54, 52, 900000, 468.00, 9000, 540000, 60.00",
        "BOND, N1, 10-Sep-2026, 50, 50, 55, 49, 54, 54, 52, 900000, 468.00, 9000, -, -",
    ]
)


def row(symbol, close=54.0, turn10=6e7, turn90=4e7, ath=60.0, week=8.0):
    """COLUMNS order: name, close, volume, mcap, change, turn10, turn90,
    High.All, Perf.W, float, perf6m. Defaults clear every gate: the burst is
    1.5x and the close sits 10% under its high."""
    return {
        "s": f"NSE:{symbol}",
        "d": [symbol, close, 900000, 5e9, 8.0, turn10, turn90, ath, week, 40.0, 30.0],
    }


def holding(fii, dii, fii_prev, dii_prev, promoter=55.0):
    return {
        "fii_percent": fii,
        "dii_percent": dii,
        "fii_percent_previous": fii_prev,
        "dii_percent_previous": dii_prev,
        "promoter_percent": promoter,
    }


class ParseBhavTests(unittest.TestCase):
    def test_strips_padding_and_keeps_only_equity_series(self):
        rows, session = pw.parse_bhav(BHAV)
        self.assertEqual(set(rows), {"GOOD", "CHURN", "THIN", "TRUST"})
        self.assertEqual(session, dt.date(2026, 9, 10))
        self.assertEqual(rows["GOOD"]["DELIV_PER"], "60.00")
        self.assertEqual(rows["TRUST"]["SERIES"], "BE")

    def test_the_session_comes_from_the_file_not_the_request(self):
        # NSE answers a Sunday request with HTTP 200 and Friday's file.
        rows, session = pw.parse_bhav(BHAV.replace("10-Sep-2026", "11-Sep-2026"))
        self.assertEqual(session, dt.date(2026, 9, 11))

    def test_empty_or_seriesless_bhavcopy_is_rejected(self):
        with self.assertRaises(ValueError):
            pw.parse_bhav("")
        header, _, bond = BHAV.splitlines()[0], None, BHAV.splitlines()[-1]
        with self.assertRaises(ValueError):
            pw.parse_bhav(header + "\n" + bond)

    def test_dash_delivery_is_not_a_number(self):
        self.assertIsNone(pw.number("-"))
        self.assertEqual(pw.number("1,234.5"), 1234.5)


class ShortlistTests(unittest.TestCase):
    def setUp(self):
        self.bhav, _ = pw.parse_bhav(BHAV)

    def test_delivery_and_trade_gates_each_drop_their_own(self):
        payload = {"data": [row("GOOD"), row("CHURN"), row("THIN"), row("ABSENT")]}
        entries, dropped = pw.shortlist(payload, self.bhav)
        self.assertEqual([e["symbol"] for e in entries], ["GOOD"])
        self.assertEqual(dropped["delivery"], 1)
        self.assertEqual(dropped["trades"], 1)
        self.assertEqual(dropped["not_in_bhavcopy"], 1)

    def test_other_exchanges_and_duplicates_are_dropped(self):
        payload = {
            "data": [
                row("GOOD"),
                {"s": "BSE:GOOD", "d": row("GOOD")["d"]},
                row("GOOD"),
                {"s": "GOOD", "d": row("GOOD")["d"]},
            ]
        }
        entries, dropped = pw.shortlist(payload, self.bhav)
        self.assertEqual(len(entries), 1)
        self.assertEqual(dropped["not_nse"], 2)

    def test_session_figures_are_carried_onto_the_entry(self):
        entries, _ = pw.shortlist({"data": [row("TRUST")]}, self.bhav)
        self.assertEqual(entries[0]["delivery_percent"], 60.0)
        self.assertEqual(entries[0]["trades"], 9000.0)
        self.assertEqual(entries[0]["series"], "BE")
        self.assertEqual(entries[0]["volume_burst"], 1.5)
        self.assertEqual(entries[0]["pct_below_ath"], 10.0)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.entries, _ = pw.shortlist(
            {"data": [row("GOOD"), row("TRUST")]}, pw.parse_bhav(BHAV)[0]
        )

    def test_keeps_held_and_steady_drops_shrinking_and_absent(self):
        holdings = {
            "GOOD": holding(3.0, 2.0, 2.5, 2.0),   # rising
            "TRUST": holding(1.0, 0.5, 4.0, 4.0),  # institutions leaving
        }
        result = pw.build(self.entries, holdings, {}, dt.date(2026, 9, 11))
        self.assertEqual(result["symbols"], ["NSE:GOOD"])
        self.assertEqual(result["dropped_on_institutional"], 1)
        self.assertEqual(result["entries"][0]["institutional_percent"], 5.0)
        self.assertEqual(result["entries"][0]["institutional_change"], 0.5)

    def test_flat_holding_survives_but_a_token_stake_does_not(self):
        holdings = {
            "GOOD": holding(2.0, 0.0, 2.0, 0.0),    # unchanged, above the floor
            "TRUST": holding(0.4, 0.1, 0.4, 0.1),   # unchanged, below the floor
        }
        result = pw.build(self.entries, holdings, {})
        self.assertEqual(result["symbols"], ["NSE:GOOD"])

    def test_a_failed_lookup_drops_the_symbol_and_is_recorded(self):
        result = pw.build(
            self.entries,
            {"GOOD": holding(3.0, 2.0, 2.0, 2.0)},
            {"TRUST": "http 404"},
        )
        self.assertEqual(result["symbols"], ["NSE:GOOD"])
        self.assertEqual(result["shareholding_lookup_failed"], {"TRUST": "http 404"})

    def test_an_empty_day_publishes_rather_than_raising(self):
        # Unlike the other two lists, "nothing happened today" is a real answer.
        result = pw.build(self.entries, {}, {}, session_date=dt.date(2026, 9, 10))
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["symbols"], [])
        self.assertEqual(result["session_date"], "2026-09-10")

    def test_criteria_are_published_with_the_list(self):
        result = pw.build(self.entries, {}, {})
        self.assertEqual(result["criteria"]["price"], [pw.MIN_PRICE, pw.MAX_PRICE])
        self.assertEqual(result["criteria"]["min_delivery_percent"], pw.MIN_DELIVERY_PERCENT)
        self.assertTrue(result["criteria"]["institutional_must_not_fall"])


XBRL = """<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:shp="http://nse/shp">
  <context id="c1"><entity><segment><explicitMember dimension="d">shp:{promoter}</explicitMember></segment></entity></context>
  <context id="c2"><entity><segment><explicitMember dimension="d">shp:{public}</explicitMember></segment></entity></context>
  <context id="c3"><entity><segment><explicitMember dimension="d">shp:{fii}</explicitMember></segment></entity></context>
  <context id="c4"><entity><segment><explicitMember dimension="d">shp:{dii}</explicitMember></segment></entity></context>
  <context id="c5"><entity><segment><explicitMember dimension="d">shp:MutualFundsOrUTIMember</explicitMember></segment></entity></context>
  <shp:{tag} contextRef="c1">{p}</shp:{tag}>
  <shp:{tag} contextRef="c2">{pub}</shp:{tag}>
  <shp:{tag} contextRef="c3">{f}</shp:{tag}>
  <shp:{tag} contextRef="c4">{d}</shp:{tag}>
  <shp:{tag} contextRef="c5">{mf}</shp:{tag}>
</xbrl>"""


def xbrl(p, pub, f, d, mf=0.01):
    return XBRL.format(tag=pw.PERCENT_TAG, promoter=pw.PROMOTER_MEMBER,
                       public=pw.PUBLIC_MEMBER, fii=pw.FII_MEMBER, dii=pw.DII_MEMBER,
                       p=p, pub=pub, f=f, d=d, mf=mf)


class XbrlTests(unittest.TestCase):
    def test_reads_the_rolled_up_categories(self):
        parsed = pw.parse_shp_xbrl(xbrl(0.2829, 0.7169, 0.1574, 0.1092))
        self.assertEqual(parsed["fii_percent"], 15.74)
        self.assertEqual(parsed["dii_percent"], 10.92)
        self.assertEqual(parsed["promoter_percent"], 28.29)

    def test_a_filing_stated_out_of_a_hundred_is_not_scaled_again(self):
        parsed = pw.parse_shp_xbrl(xbrl(28.29, 71.69, 15.74, 10.92, mf=8.42))
        self.assertEqual(parsed["fii_percent"], 15.74)
        self.assertEqual(parsed["promoter_percent"], 28.29)

    def test_a_missing_or_incoherent_total_is_rejected(self):
        with self.assertRaises(ValueError):   # promoter + public is not a company
            pw.parse_shp_xbrl(xbrl(0.10, 0.10, 0.05, 0.05))
        with self.assertRaises(ValueError):   # no public total at all
            pw.parse_shp_xbrl("<xbrl xmlns='http://www.xbrl.org/2003/instance'/>")

    def test_a_sub_category_is_not_mistaken_for_the_total(self):
        # MutualFundsOrUTI sits inside DII; only the rolled-up member counts.
        self.assertEqual(pw.parse_shp_xbrl(xbrl(0.28, 0.72, 0.15, 0.10, mf=0.09))["dii_percent"], 10.0)


class ShpIndexTests(unittest.TestCase):
    """The gate compares the newest quarter the market could already have seen."""

    ROWS = [
        {"date": "30-JUN-2026", "submissionDate": "16-JUL-2026", "xbrl": "https://n/jun26.xml"},
        {"date": "31-MAR-2026", "submissionDate": "18-APR-2026", "xbrl": "https://n/mar26.xml"},
        {"date": "31-DEC-2025", "submissionDate": "14-JAN-2026", "xbrl": "https://n/dec25.xml"},
    ]

    def test_a_quarter_not_yet_filed_is_not_used(self):
        # 1 July 2026: the June quarter has ended but was filed on the 16th.
        got = pw.parse_shp_index(self.ROWS, dt.date(2026, 7, 1))
        self.assertEqual([q.isoformat() for q, _ in got], ["2026-03-31", "2025-12-31"])

    def test_it_is_used_the_day_it_is_filed(self):
        got = pw.parse_shp_index(self.ROWS, dt.date(2026, 7, 16))
        self.assertEqual(got[0][0].isoformat(), "2026-06-30")

    def test_a_revision_replaces_its_quarter_rather_than_doubling_it(self):
        rows = self.ROWS + [
            {"date": "31-MAR-2026", "submissionDate": "02-MAY-2026", "xbrl": "https://n/mar26-rev.xml"}
        ]
        got = pw.parse_shp_index(rows, dt.date(2026, 7, 20))
        self.assertEqual(len(got), 3)
        self.assertEqual(dict((q.isoformat(), u) for q, u in got)["2026-03-31"],
                         "https://n/mar26-rev.xml")

    def test_rows_without_a_usable_filing_are_skipped(self):
        rows = [{"date": "30-JUN-2026", "submissionDate": "16-JUL-2026", "xbrl": ""},
                {"date": "bad", "submissionDate": "16-JUL-2026", "xbrl": "https://n/x.xml"}]
        self.assertEqual(pw.parse_shp_index(rows, dt.date(2026, 8, 1)), [])

    def test_date_parsing_accepts_both_month_spellings(self):
        self.assertEqual(pw.parse_shp_date("30-JUN-2026"), dt.date(2026, 6, 30))
        self.assertEqual(pw.parse_shp_date("30-June-2026"), dt.date(2026, 6, 30))
        self.assertIsNone(pw.parse_shp_date("nonsense"))


class FetchHoldingsTests(unittest.TestCase):
    class Fake:
        def __init__(self, symbol_fails=()):
            self.fails = set(symbol_fails)
        def open(self, url, timeout=None):
            for bad in self.fails:
                if f"symbol={bad}" in url:
                    raise OSError("http 429")
            class R:
                def __init__(self, body): self.body = body.encode()
                def read(self): return self.body
                def __enter__(self): return self
                def __exit__(self, *a): return False
            if "corporate-share-holdings-master" in url:
                return R(json.dumps([
                    {"date": "31-MAR-2026", "submissionDate": "18-APR-2026", "xbrl": "https://n/mar.xml"},
                    {"date": "31-DEC-2025", "submissionDate": "14-JAN-2026", "xbrl": "https://n/dec.xml"},
                ]))
            return R(xbrl(0.30, 0.70, 0.05, 0.02) if "mar" in url else xbrl(0.30, 0.70, 0.03, 0.02))

    def test_it_pairs_the_two_published_quarters(self):
        h, f = pw.fetch_holdings(["GOOD"], asof=dt.date(2026, 5, 1),
                                 opener=self.Fake(), pause=0)
        self.assertEqual(f, {})
        self.assertEqual(h["GOOD"]["fii_percent"], 5.0)
        self.assertEqual(h["GOOD"]["fii_percent_previous"], 3.0)
        self.assertEqual(h["GOOD"]["quarter"], "2026-03-31")

    def test_one_unreachable_symbol_does_not_stop_the_others(self):
        h, f = pw.fetch_holdings(["GOOD", "BAD"], asof=dt.date(2026, 5, 1),
                                 opener=self.Fake(symbol_fails=["BAD"]), pause=0)
        self.assertEqual(list(h), ["GOOD"])
        self.assertIn("BAD", f)


class BurstAndAthTests(unittest.TestCase):
    """The two ratio gates the scanner will not filter on, applied locally."""

    def setUp(self):
        self.bhav, _ = pw.parse_bhav(BHAV)

    def test_a_weak_burst_is_dropped(self):
        payload = {"data": [row("GOOD"), row("TRUST", turn10=4.4e7, turn90=4e7)]}
        entries, dropped = pw.shortlist(payload, self.bhav)
        self.assertEqual([e["symbol"] for e in entries], ["GOOD"])
        self.assertEqual(dropped["burst"], 1)

    def test_a_name_too_far_below_its_high_is_dropped(self):
        # 40% under the high, against a 25% limit.
        payload = {"data": [row("GOOD"), row("TRUST", close=54.0, ath=90.0)]}
        entries, dropped = pw.shortlist(payload, self.bhav)
        self.assertEqual([e["symbol"] for e in entries], ["GOOD"])
        self.assertEqual(dropped["below_ath"], 1)

    def test_the_ath_limit_is_inclusive_at_its_edge(self):
        exact = 54.0 / (1 - pw.MAX_BELOW_ATH)
        entries, _ = pw.shortlist({"data": [row("GOOD", ath=exact)]}, self.bhav)
        self.assertEqual(len(entries), 1)

    def test_a_missing_high_is_dropped_not_treated_as_zero(self):
        payload = {"data": [row("TRUST", ath=None), row("GOOD", turn90=0)]}
        entries, dropped = pw.shortlist(payload, self.bhav)
        self.assertEqual(entries, [])
        self.assertEqual(dropped["no_reference"], 2)


class RequestTests(unittest.TestCase):
    def test_every_gate_reaches_the_scanner(self):
        query = pw.request_payload()
        by_field = {f["left"]: f for f in query["filter"]}
        self.assertEqual(by_field["exchange"]["right"], "NSE")
        self.assertEqual(by_field["close"]["right"], [pw.MIN_PRICE, pw.MAX_PRICE])
        # Companies only. Without this, silver and gold ETFs trade in the band
        # and clear a delivery gate easily.
        self.assertEqual(by_field["type"]["right"], "stock")
        self.assertNotIn("market_cap_basic", by_field)
        self.assertIn("market_cap_basic", query["columns"])
        self.assertEqual(by_field["AvgValue.Traded_90d"]["right"], pw.MIN_AVG_TURNOVER)
        self.assertEqual(by_field["Perf.W"]["right"], pw.MIN_WEEK_MOVE)
        # The two ratio gates must NOT be sent: the scanner rejects an
        # expression as a right operand, and a silently dropped filter would
        # publish a list that skipped them.
        self.assertNotIn("High.All", by_field)
        self.assertIn("High.All", query["columns"])
        # shortlist() indexes into the row by position, so a reordered or
        # shortened column list silently mislabels every field.
        self.assertEqual(query["columns"], pw.COLUMNS)


class BhavcopyDateTests(unittest.TestCase):
    def test_walks_back_to_the_last_published_session(self):
        seen = []

        def fetch(url):
            seen.append(url)
            if "11092026" in url or "12092026" in url:
                raise OSError("http 404")
            return BHAV

        rows, day = pw.fetch_bhav(dt.date(2026, 9, 12), fetch=fetch)
        self.assertEqual(day, dt.date(2026, 9, 10))
        self.assertEqual(len(seen), 3)
        self.assertIn("GOOD", rows)

    def test_gives_up_rather_than_reaching_back_forever(self):
        def fetch(url):
            raise OSError("http 404")

        with self.assertRaises(ValueError):
            pw.fetch_bhav(dt.date(2026, 9, 12), fetch=fetch)


if __name__ == "__main__":
    unittest.main()


class PublishGuardTests(unittest.TestCase):
    """An empty list must mean "nothing qualified", never "the last gate broke"."""

    def test_a_wholesale_lookup_failure_refuses_to_publish(self):
        original = (pw.fetch_scan, pw.fetch_bhav, pw.fetch_holdings, pw.OUT)
        bhav = pw.parse_bhav(BHAV)[0]
        pw.fetch_scan = lambda: {"data": [row("GOOD"), row("TRUST")]}
        pw.fetch_bhav = lambda: (bhav, dt.date(2026, 9, 10))
        try:
            pw.fetch_holdings = lambda syms: ({}, {s: "http 429" for s in syms})
            with self.assertRaises(SystemExit) as caught:
                pw.main()
            self.assertIn("refusing to publish", str(caught.exception))
        finally:
            pw.fetch_scan, pw.fetch_bhav, pw.fetch_holdings, pw.OUT = original

    def test_a_single_failure_still_publishes_the_rest(self):
        original = (pw.fetch_scan, pw.fetch_bhav, pw.fetch_holdings, pw.OUT)
        bhav = pw.parse_bhav(BHAV)[0]
        import tempfile, pathlib, json as _json
        with tempfile.TemporaryDirectory() as tmp:
            pw.OUT = pathlib.Path(tmp) / "out.json"
            pw.fetch_scan = lambda: {"data": [row("GOOD"), row("TRUST")]}
            pw.fetch_bhav = lambda: (bhav, dt.date(2026, 9, 10))
            pw.fetch_holdings = lambda syms: (
                {"GOOD": holding(3.0, 2.0, 2.0, 2.0)}, {"TRUST": "http 429"}
            )
            try:
                pw.main()
                written = _json.loads(pw.OUT.read_text())
            finally:
                pw.fetch_scan, pw.fetch_bhav, pw.fetch_holdings, pw.OUT = original
        self.assertEqual(written["symbols"], ["NSE:GOOD"])
        self.assertEqual(written["shareholding_lookup_failed"], {"TRUST": "http 429"})
