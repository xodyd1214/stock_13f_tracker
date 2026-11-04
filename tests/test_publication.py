from pathlib import Path
import tempfile
import unittest
from validate_data import validate_output

class PublicationTests(unittest.TestCase):
    def test_only_reviewed_nonempty_outputs_are_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            for filename, payload in [('latest_form4_insiders.json', '{"a":1}'),
                                      ('realtime_prices.json', '{}'),
                                      ('realtime_prices.json', '{"AAPL":NaN}'),
                                      ('realtime_prices.json', '{"AAPL":1e400}'),
                                      ('latest_13f_holdings.json', '[1]'),
                                      ('latest_13f_holdings.json', '[{"guru":"Test","value":-1,"shares":1}]'),
                                      ('realtime_prices.json', '{"AAPL":{"price":0}}'),
                                      ('live_13f_analytics.json', '{"Test":{"holdings":[]}}'),
                                      ('latest_macro_indicators.json', '{"schemaVersion":2}'),
                                      ('latest_macro_indicators.json', '{"lastUpdated":"fake"}')]:
                path = Path(directory) / filename
                path.write_text(payload)
                with self.assertRaises(ValueError): validate_output(path)

    def test_valid_outputs_pass_without_modifying_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'latest_macro_indicators.json'
            data = '{"schemaVersion":2,"status":"partial","sources":{"nyFed":{"fetchStatus":"success"}},"collection":{"successfulSources":["nyFed"]}}\n'
            path.write_text(data)
            self.assertEqual(validate_output(path)['status'], 'partial')
            self.assertEqual(path.read_text(), data)

    def test_workflow_runs_safe_sources_independently_and_surfaces_errors(self):
        text = (Path(__file__).resolve().parents[1] / '.github/workflows/auto_sync.yml').read_text()
        for script in ('collector_1year.py', 'sec_collector.py', 'price_fetcher.py', 'macro_collector.py'):
            self.assertIn('run: python ' + script, text)
        self.assertEqual(text.count('continue-on-error: true'), 4)
        self.assertIn('steps.filings.outcome', text)
        self.assertIn('python validate_data.py "$file"', text)
        self.assertIn('exit 1', text)
        for script in ('sec_insider_collector.py', 'sec_13d_collector.py'):
            self.assertNotIn('python ' + script, text)

if __name__ == '__main__': unittest.main()
