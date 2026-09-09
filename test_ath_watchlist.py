import datetime as dt
import unittest

import ath_watchlist


class AthWatchlistTests(unittest.TestCase):
    def test_build_keeps_nse_exchange_and_dedupes(self):
        # columns: name, close, volume, market_cap, change, High.All
        payload = {"data": [
            {"s": "NSE:ZETA", "d": ["Zeta", 90, 10, 2e9, 1, 100]},
            {"s": "BSE:ZETA", "d": ["wrong exchange", 90, 10, 2e9, 1, 100]},
            {"s": "NSE:ZETA", "d": ["duplicate", 90, 10, 2e9, 1, 100]},
            {"s": "NSE:ALPHA", "d": ["Alpha", 80, 10, 2e9, 1, 100]},
        ]}
        result = ath_watchlist.build(payload, 20, dt.date(2026, 1, 2))
        self.assertEqual(result["symbols"], ["NSE:ALPHA", "NSE:ZETA"])
        self.assertEqual(result["entries"][0]["exchange"], "NSE")
        self.assertEqual(result["watchlist_name"], "ATH Below 20%")
        self.assertEqual(result["matched_total"], 2)

    def test_band_is_inclusive_and_excludes_outside(self):
        payload = {"data": [
            {"s": "NSE:ATATH", "d": ["at the high", 100, 1, 2e9, 0, 100]},
            {"s": "NSE:EDGE", "d": ["exactly 20% below", 80, 1, 2e9, 0, 100]},
            {"s": "NSE:DEEP", "d": ["21% below", 79, 1, 2e9, 0, 100]},
            {"s": "NSE:NOATH", "d": ["no all-time high", 90, 1, 2e9, 0, None]},
        ]}
        result = ath_watchlist.build(payload, 20, dt.date(2026, 1, 2))
        self.assertEqual(result["symbols"], ["NSE:ATATH", "NSE:EDGE"])

    def test_cap_keeps_the_names_closest_to_their_high(self):
        rows = [{"s": f"NSE:S{i:03d}", "d": [f"s{i}", 100 - i * 0.01, 1, 2e9, 0, 100]} for i in range(300)]
        result = ath_watchlist.build({"data": rows}, 20, dt.date(2026, 1, 2))
        self.assertEqual(result["count"], ath_watchlist.MAX_SYMBOLS)
        self.assertEqual(result["matched_total"], 300)
        self.assertTrue(result["truncated_to_cap"])
        self.assertLess(max(e["pct_below_ath"] for e in result["entries"]), 2.5)

    def test_threshold_validation(self):
        self.assertEqual(ath_watchlist.threshold("20"), 20.0)
        for value in ("0", "101", "nan", "nope"):
            with self.assertRaises(ValueError):
                ath_watchlist.threshold(value)

    def test_empty_result_is_rejected(self):
        with self.assertRaises(ValueError):
            ath_watchlist.build({"data": [{"s": "BSE:OLD", "d": []}]}, 20)

    def test_query_is_nse_and_original_filters_are_present(self):
        query = ath_watchlist.request_payload(20)
        by_field = {f["left"]: f for f in query["filter"]}
        self.assertEqual(by_field["exchange"]["right"], "NSE")
        # 100 crore in rupees
        self.assertEqual(by_field["market_cap_basic"]["right"], 1_000_000_000)
        self.assertEqual(by_field["market_cap_basic"]["operation"], "greater")
        # The scanner no longer accepts an expression as a filter's right
        # operand, so the band is applied in build() and High.All is a column.
        self.assertNotIn("close", by_field)
        self.assertIn("High.All", ath_watchlist.request_payload(20)["columns"])
        self.assertNotIn("markets", ath_watchlist.request_payload(20))


if __name__ == "__main__":
    unittest.main()
