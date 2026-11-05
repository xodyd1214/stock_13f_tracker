import unittest
import json
import io
import tempfile
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch
import price_fetcher as p

class PriceTests(unittest.TestCase):
    def test_reviewed_cusips_do_not_confuse_block_hrblock_or_bgin(self):
        mapping = json.loads((Path(p.__file__).parent / 'ticker_map.json').read_text())
        for cusip, expected in [('852234103', 'XYZ'), ('093671105', 'HRB'), ('G17429104', 'BGIN'), ('69702V107', 'PSBD'), ('892231101', 'TSQ')]:
            self.assertEqual(p.get_standard_ticker('Block', 'SQ', mapping, cusip), expected)
        self.assertEqual(mapping['G4474Y214'], 'JHG')
        self.assertNotIn('SQ', mapping.values())
        self.assertNotIn('852234AK9', mapping)
        self.assertIsNone(p.get_standard_ticker('Block', 'SQ', mapping, '852234AK9'))

    def test_unreviewed_legacy_cusip_never_overrides_supplied_ticker(self):
        mapping = {'45817G201': 'INTC', '69764K106': 'INTC'}
        self.assertIsNone(p.get_standard_ticker('Intellicheck', 'IDN', mapping, '45817G201'))
        self.assertIsNone(p.get_standard_ticker('Intelligent Protection', 'IPM', mapping, '69764K106'))

    def test_quarantined_square_name_collisions_cannot_fetch_block(self):
        mapping = json.loads((Path(p.__file__).parent / 'ticker_map.json').read_text())
        for cusip in ('71531U102', '55825T103', '558256103', '36468G103', '69181V107', '71531T105'):
            self.assertNotIn(cusip, mapping)
            for ticker in ('XYZ', 'SQ', ''):
                self.assertIsNone(p.get_standard_ticker('BLOCK INC', ticker, {'BLOCK INC': 'XYZ'}, cusip))

    @patch.object(p.time, 'sleep')
    def test_aliases_deduplicate_and_inactive_symbols_preserve_history(self, sleep):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)):
            root = Path(directory)
            (root / 'ticker_map.json').write_text(json.dumps({'852234103': 'SQ', 'G4474Y214': 'JHG', '852234AK9': 'SQ'}))
            (root / 'live_13f_analytics.json').write_text(json.dumps({'Fund': {'holdings': [
                {'name': 'Block', 'ticker': 'SQ', 'cusip': '852234103', 'shareType': 'SH'},
                {'name': 'Janus', 'ticker': 'JHG', 'shareType': 'SH'},
                {'name': 'Block note', 'ticker': 'SQ', 'cusip': '852234AK9', 'shareType': 'SH'}]}}))
            old = {'price': 51.95, 'changePct': -0.04, 'currency': 'USD', 'marketTime': 1782849603}
            cache = root / 'realtime_prices.json'
            cache.write_text(json.dumps({'JHG': old}))
            fresh = {'price': 87.63, 'currency': 'USD', 'marketTime': p.time.time()}
            with patch.object(p, 'fetch_yahoo_price', return_value=fresh) as fetch:
                self.assertTrue(p.main())
            fetch.assert_called_once_with('XYZ')
            result = json.loads(cache.read_text())
            self.assertEqual(result['JHG'], old)
            self.assertEqual(result['XYZ'], fresh)
            self.assertNotIn('SQ', result)

    @patch.object(p, 'fetch_yahoo_price')
    def test_inactive_only_is_not_failure_and_preserves_cache_bytes(self, fetch):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)):
            root = Path(directory)
            (root / 'ticker_map.json').write_text('{"G4474Y214":"JHG"}')
            cache = root / 'realtime_prices.json'
            original = b'{"JHG":{"price":51.95,"marketTime":1782849603}}\n'
            cache.write_bytes(original)
            self.assertTrue(p.main())
            fetch.assert_not_called()
            self.assertEqual(cache.read_bytes(), original)

    @patch.object(p.requests, 'get')
    def test_inactive_direct_fetch_never_calls_upstream(self, get):
        self.assertIsNone(p.fetch_yahoo_price('JHG'))
        get.assert_not_called()

    @patch.object(p.requests, 'get')
    def test_http_failure_reports_symbol_and_status(self, get):
        get.return_value.status_code = 404
        errors = io.StringIO()
        with redirect_stderr(errors):
            self.assertIsNone(p.fetch_yahoo_price('SQ'))
        self.assertIn('/XYZ?', get.call_args.args[0])
        self.assertIn('XYZ: HTTP 404', errors.getvalue())

    def test_ticker_precedes_issuer_mapping(self):
        self.assertIsNone(p.get_standard_ticker('Alphabet', 'GOOG', {'Alphabet':'GOOGL'}))
        self.assertIsNone(p.get_standard_ticker('Berkshire', 'BRK.B', {}))
        self.assertIsNone(p.get_standard_ticker('Alphabet unrelated', '012345678', {'Alphabet':'GOOGL'}))

    @patch.object(p.requests, 'get')
    def test_missing_timestamp_and_change_not_fabricated(self, get):
        get.return_value.status_code = 200
        get.return_value.json.return_value = {'chart':{'result':[{'meta': {'regularMarketPrice': 100}}]}}
        quote = p.fetch_yahoo_price('AAPL')
        self.assertIsNone(quote['marketTime'])
        self.assertIsNone(quote['changePct'])

    @patch.object(p.requests, 'get')
    def test_invalid_price_rejected(self, get):
        get.return_value.status_code = 200
        for price in [0, -1, float('nan'), float('inf')]:
            get.return_value.json.return_value = {'chart':{'result':[{'meta': {'regularMarketPrice': price}}]}}
            self.assertIsNone(p.fetch_yahoo_price('AAPL'))

    @patch.object(p.time, 'sleep')
    @patch.object(p, 'fetch_yahoo_price', return_value=None)
    def test_failed_refresh_preserves_cache_bytes(self, fetch, sleep):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'BASE_DIR', Path(directory)):
            (Path(directory) / 'ticker_map.json').write_text('{"037833100":"AAPL"}')
            cache = Path(directory) / 'realtime_prices.json'
            original = b'{"AAPL":{"price":10,"marketTime":123}}\n'
            cache.write_bytes(original)
            self.assertFalse(p.main())
            self.assertEqual(cache.read_bytes(), original)

if __name__ == '__main__': unittest.main()

