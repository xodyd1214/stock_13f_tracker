"""Offline quote validation and publication-status regressions."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import price_fetcher as p


class QuoteFreshnessTests(unittest.TestCase):
    def test_current_quote_requires_valid_time_currency_and_price(self):
        fresh = {'price': 110, 'marketTime': 200000, 'currency': 'USD'}
        self.assertTrue(p.is_fresh_quote(fresh, 200060))
        for changes in ({'marketTime': None}, {'marketTime': True}, {'marketTime': 0},
                        {'marketTime': 200361}, {'marketTime': 100000},
                        {'stale': True}, {'price': float('nan')}, {'price': 0}, {'currency': 'JPY'}):
            with self.subTest(changes=changes):
                self.assertFalse(p.is_fresh_quote(dict(fresh, **changes), 200060))

    def test_historical_quote_is_preserved_but_does_not_report_current_refresh_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'), patch.object(p.time, 'time', return_value=200000):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"037833100":"AAPL"}')
            historical = {'price': 110, 'currency': 'USD', 'marketTime': 100000, 'stale': True}
            with patch.object(p, 'fetch_yahoo_price', return_value=historical):
                self.assertFalse(p.main())
            self.assertEqual(json.loads((root / 'realtime_prices.json').read_text())['AAPL'], historical)

    def test_future_or_equal_time_conflicts_do_not_replace_good_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'), patch.object(p.time, 'time', return_value=200000):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"037833100":"AAPL"}')
            cache = root / 'realtime_prices.json'
            original = b'{"AAPL":{"price":110,"currency":"USD","marketTime":199990}}\n'
            for incoming in [dict(price=5, currency='USD', marketTime=199990), dict(price=999, currency='USD', marketTime=200301)]:
                cache.write_bytes(original)
                with patch.object(p, 'fetch_yahoo_price', return_value=incoming):
                    self.assertFalse(p.main())
                self.assertEqual(cache.read_bytes(), original)

    def test_valid_quote_can_repair_future_corrupt_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'), patch.object(p.time, 'time', return_value=200000):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"037833100":"AAPL"}')
            cache = root / 'realtime_prices.json'
            cache.write_text('{"AAPL":{"price":999,"currency":"USD","marketTime":300000}}')
            current = {'price': 110, 'currency': 'USD', 'marketTime': 199990}
            with patch.object(p, 'fetch_yahoo_price', return_value=current):
                self.assertTrue(p.main())
            self.assertEqual(json.loads(cache.read_text())['AAPL'], current)
