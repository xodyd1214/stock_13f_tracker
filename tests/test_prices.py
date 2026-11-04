import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import price_fetcher as p

class PriceTests(unittest.TestCase):
    def test_ticker_precedes_issuer_mapping(self):
        self.assertEqual(p.get_standard_ticker('Alphabet', 'GOOG', {'Alphabet':'GOOGL'}), 'GOOG')
        self.assertEqual(p.get_standard_ticker('Berkshire', 'BRK.B', {}), 'BRK.B')
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
            (Path(directory) / 'ticker_map.json').write_text('{"Apple":"AAPL"}')
            cache = Path(directory) / 'realtime_prices.json'
            original = b'{"AAPL":{"price":10,"marketTime":123}}\n'
            cache.write_bytes(original)
            self.assertFalse(p.main())
            self.assertEqual(cache.read_bytes(), original)

if __name__ == '__main__': unittest.main()
