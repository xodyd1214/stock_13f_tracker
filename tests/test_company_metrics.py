import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
import re
from unittest.mock import MagicMock, patch

from company_metrics import (
    COMPANIES, EASTERN, ELIGIBLE_KEYS, assemble, collect, quote_metrics,
    requested_companies, rsi14, trailing_eps,
)


class CompanyMetricsTests(unittest.TestCase):
    def test_request_allowlist_matches_published_firestore_rules(self):
        rules = Path(__file__).resolve().parents[1] / 'firestore.rules'
        covered = re.findall(r"'(\d{10}:[A-Z]{1,5}(?:[.-][A-Z])?)'", rules.read_text())
        self.assertEqual(set(covered), set(ELIGIBLE_KEYS))
        self.assertLessEqual(len(covered), 200)

    def test_requests_deduplicate_and_rsi_publishes_without_eps(self):
        session = MagicMock()
        origin = 'projects/alpha13f-e9be4/databases/(default)/documents/companyMetricRequests/'
        cost = {'document': {'name': origin + '0000909832:COST',
                             'fields': {'requested': {'booleanValue': True}}}}
        session.post.return_value.json.return_value = [cost, cost, {'readTime': '2026-11-25T21:30:00Z'},
            {'document': {'name': origin + '0000000001:COST', 'fields': cost['document']['fields']}}]
        self.assertEqual(requested_companies(session), {'COST'})
        previous = {'schemaVersion': 1, 'symbols': dict.fromkeys(COMPANIES)}
        today = datetime(2026, 11, 25, 16, 30, tzinfo=EASTERN)
        with patch('company_metrics.fetch_json', return_value={}), \
             patch('company_metrics.quote_metrics', return_value=(today.date(), 100, 42, [])) as quotes:
            updated, failed = collect(previous, today, session, {'COST': {}})
        self.assertFalse(failed)
        quotes.assert_called_once()
        row = updated['symbols']['COST']
        self.assertEqual((row['rsi14'], row['perTtm'], row['perReason']), (42, None, 'eps_unavailable'))

    def test_rsi_uses_wilder_smoothing_and_keeps_numeric_extremes(self):
        self.assertEqual(rsi14(list(range(15))), 100)
        self.assertEqual(rsi14(list(range(15, 0, -1))), 0)
        self.assertEqual(rsi14([10] * 15), 50)
        self.assertIsNone(rsi14([10] * 14))
        self.assertEqual(rsi14([100, 101] * 8), 53.57)

    def test_intraday_bar_is_excluded_until_market_close_is_observed(self):
        today = datetime(2026, 11, 24, 15, 35, tzinfo=EASTERN)
        image = {'chart': {'result': [{
            'meta': {'symbol': 'AAPL', 'instrumentType': 'EQUITY', 'currency': 'USD',
                     'exchangeTimezoneName': 'America/New_York',
                     'regularMarketTime': today.timestamp(),
                     'currentTradingPeriod': {'regular': {'end': today.replace(hour=16, minute=0).timestamp()}}},
            'timestamp': [datetime(2026, 11, d, 9, 30, tzinfo=EASTERN).timestamp() for d in (23, 24)],
            'indicators': {'quote': [{'close': [120, 125]}], 'adjclose': [{'adjclose': [119, 125]}]}
        }]}}
        self.assertEqual(quote_metrics(image, 'AAPL', today)[:2], (date(2026, 11, 23), 120))
        after_close = today.replace(hour=16, minute=10)
        self.assertEqual(quote_metrics(image, 'AAPL', after_close)[0], date(2026, 11, 23))
        image['chart']['result'][0]['meta']['regularMarketTime'] = today.replace(hour=16, minute=0).timestamp()
        self.assertEqual(quote_metrics(image, 'AAPL', after_close)[:2], (date(2026, 11, 24), 125))

    def test_annual_and_ytd_are_distinguished_and_split_is_flagged(self):
        def fact(start, end, value):
            start, end = date.fromisoformat(start), date.fromisoformat(end)
            return (start, end), (end + timedelta(days=25), '', Decimal(value))
        annual = fact('2025-01-01', '2025-12-31', '4.00')
        current = fact('2026-01-01', '2026-06-30', '2.80')
        previous = fact('2025-01-01', '2025-06-30', '1.60')
        self.assertEqual(trailing_eps(dict([annual]))['method'], 'annual')
        self.assertIsNone(trailing_eps(dict([annual, current])))
        earnings = trailing_eps(dict([annual, current, previous]))
        self.assertEqual((earnings['start'], earnings['end'], earnings['eps'], earnings['method']),
                         ('2025-07-01', '2026-06-30', 5.2, 'annual_ytd'))
        price = date(2026, 11, 23), 104, 48.5
        self.assertEqual(assemble('0000320193', (*price, []), earnings, 'success')['perTtm'], 20)
        split = assemble('0000320193', (*price, [date(2026, 2, 1)]), earnings, 'success')
        self.assertEqual((split['perTtm'], split['perReason'], split['rsi14']), (None, 'split', 48.5))
