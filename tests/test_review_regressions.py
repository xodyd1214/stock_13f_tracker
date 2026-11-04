"""Regression cases found during the pre-merge review."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import collector_1year as c
import price_fetcher as p
from test_collector import GURU, quarter, xml


class ReviewRegressionTests(unittest.TestCase):
    def test_class_wording_changes_do_not_create_trades(self):
        prior = quarter('2026-06-30')
        latest = quarter('2026-09-30')
        latest['holdings'], latest['total_val'] = c.parse_xml_holdings(
            xml().replace('>COM<', '>Common Stock<'), '2026-11-01')
        result = c.analyze_quarters(GURU, [latest, prior])
        self.assertEqual(len(result['holdings']), 1)
        self.assertEqual(result['holdings'][0]['action'], 'HOLD')
        self.assertEqual(result['holdings'][0]['sharesChangePct'], 0)

    def test_distinct_cusips_options_and_principal_remain_separate(self):
        documents = [xml(), xml().replace('037833100', '02079K305'), xml('CALL'), xml('PUT'), xml(share_type='PRN')]
        holdings, total = c.parse_xml_holdings(''.join('<XML>'+doc+'</XML>' for doc in documents), '2026-11-01')
        self.assertEqual(len(holdings), 5)
        self.assertEqual(total, 5000)

    def test_history_regression_preserves_bytes_and_reports_failure(self):
        previous = {'schemaVersion': 2, 'latestPeriod': '2026-09-30', 'filingDate': '2026-11-01'}
        candidates = [dict(previous, latestPeriod='2026-06-30'), dict(previous, filingDate='2026-10-31'), {'schemaVersion': 2}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.json'
            original = json.dumps({'Test': previous}).encode() + b'\n'
            for candidate in candidates:
                path.write_bytes(original)
                with patch.object(c, 'fetch_guru_1year', return_value=candidate), patch.object(c.time, 'sleep'):
                    result = c.run_1year_sync(path, [GURU])
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(result['failed'], ['Test'])
                self.assertEqual(result['updated'], [])

    def test_newer_history_is_published(self):
        previous = {'schemaVersion': 2, 'latestPeriod': '2026-06-30', 'filingDate': '2026-08-01'}
        candidate = dict(previous, latestPeriod='2026-09-30', filingDate='2026-11-01')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.json'
            path.write_text(json.dumps({'Test': previous}))
            with patch.object(c, 'fetch_guru_1year', return_value=candidate), patch.object(c.time, 'sleep'):
                result = c.run_1year_sync(path, [GURU])
            self.assertEqual(json.loads(path.read_text())['Test'], candidate)
            self.assertEqual(result['updated'], ['Test'])

    def test_partial_price_success_publishes_good_quote_but_returns_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"Apple":"AAPL","Microsoft":"MSFT"}')
            cache = root / 'realtime_prices.json'
            old = {'price': 10, 'marketTime': 100}
            cache.write_text(json.dumps({'MSFT': old}))
            fresh = {'price': 200, 'marketTime': 200}
            with patch.object(p, 'fetch_yahoo_price', side_effect=lambda ticker: fresh if ticker == 'AAPL' else None):
                self.assertFalse(p.main())
            self.assertEqual(json.loads(cache.read_text()), {'MSFT': old, 'AAPL': fresh})

    def test_older_or_undated_price_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"Apple":"AAPL"}')
            cache = root / 'realtime_prices.json'
            original = b'{"AAPL":{"price":200,"marketTime":200}}\n'
            for market_time in [100, None]:
                cache.write_bytes(original)
                with patch.object(p, 'fetch_yahoo_price', return_value={'price': 10, 'marketTime': market_time}):
                    self.assertFalse(p.main())
                self.assertEqual(cache.read_bytes(), original)

    def test_newer_price_is_published_and_returns_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)), patch.object(p.time, 'sleep'):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"Apple":"AAPL"}')
            cache = root / 'realtime_prices.json'
            cache.write_text('{"AAPL":{"price":10,"marketTime":100}}')
            fresh = {'price': 200, 'marketTime': 200}
            with patch.object(p, 'fetch_yahoo_price', return_value=fresh):
                self.assertTrue(p.main())
            self.assertEqual(json.loads(cache.read_text()), {'AAPL': fresh})
