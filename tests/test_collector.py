import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import collector_1year as c
from data_io import atomic_write_json

GURU = {'name': 'Test', 'fund': 'Fund', 'cik': 1}

def xml(option='', share_type='SH', value='1000', shares='10'):
    return f'''<informationTable xmlns="urn:sec"><infoTable><nameOfIssuer>Example &amp; Co</nameOfIssuer>
    <titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>{value}</value>
    <shrsOrPrnAmt><sshPrnamt>{shares}</sshPrnamt><sshPrnamtType>{share_type}</sshPrnamtType></shrsOrPrnAmt>
    <putCall>{option}</putCall></infoTable></informationTable>'''

def quarter(period, shares='10'):
    holdings, total = c.parse_xml_holdings(xml(shares=shares), '2026-01-01')
    return {'period': period, 'holdings': holdings, 'total_val': total,
            'filingDate': '2026-01-01', 'sourceUrl': 'https://www.sec.gov/example'}

class CollectorTests(unittest.TestCase):
    def test_values_use_filing_date_units(self):
        self.assertEqual(c.parse_xml_holdings(xml(), '2023-01-02')[1], 1000000)
        self.assertEqual(c.parse_xml_holdings(xml(), '2023-01-03')[1], 1000)

    def test_options_stock_principal_separate(self):
        text = '<SEC-DOCUMENT>' + ''.join('<XML>' + xml(o, s) + '</XML>' for o, s in [('', 'SH'), ('PUT', 'SH'), ('CALL', 'SH'), ('', 'PRN')])
        holdings, total = c.parse_xml_holdings(text, '2026-01-01')
        self.assertEqual(len(holdings), 4)
        self.assertEqual(total, 4000)
        self.assertTrue(all(h['weight'] == 25 for h in holdings.values()))

    def test_invalid_or_empty_rejected(self):
        for text in ['<html>denied</html>', '<informationTable/>', xml(value='NaN'), xml(shares='-2')]:
            with self.assertRaises(ValueError): c.parse_xml_holdings(text, '2026-01-01')

    def test_missing_or_gapped_prior_unknown(self):
        for quarters in [[quarter('2026-09-30')], [quarter('2026-09-30'), quarter('2026-03-31')]]:
            result = c.analyze_quarters(GURU, quarters)
            self.assertFalse(result['comparisonAvailable'])
            self.assertEqual(result['holdings'][0]['action'], 'UNKNOWN')
            self.assertIsNone(result['holdings'][0]['curPrice'])
            self.assertIsNone(result['holdings'][0]['estPrice'])

    def test_adjacent_quarter_and_aum(self):
        result = c.analyze_quarters(GURU, [quarter('2026-09-30', '20'), quarter('2026-06-30')])
        self.assertEqual(result['holdings'][0]['action'], 'ADD')
        self.assertEqual(result['holdings'][0]['sharesChangePct'], 100)
        self.assertEqual(result['holdings'][0]['reportedPrice'], 50)
        self.assertEqual(result['reportedValueUSD'], 1000)
        self.assertEqual(result['aum'], '$0.0M')

    def test_amendment_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Amendment'):
            c.select_filings({'form':['13F-HR/A'], 'reportDate':['2026-09-30'],
                             'filingDate':['2026-11-01'], 'accessionNumber':['0001']})

    @patch.object(c.time, 'sleep')
    @patch.object(c, 'fetch_guru_1year', return_value=None)
    def test_total_failure_preserves_bytes(self, fetch, sleep):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            original = b'{"Test": {"old": true}}\n'
            path.write_bytes(original)
            result = c.run_1year_sync(path, [GURU])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(result['failed'], ['Test'])

    @patch.object(c.time, 'sleep')
    @patch.object(c, 'fetch_guru_1year', side_effect=[{'fresh': True}, None])
    def test_partial_failure_keeps_other_fund(self, fetch, sleep):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            path.write_text('{"Other": {"old": true}}')
            c.run_1year_sync(path, [GURU, {**GURU, 'name':'Other'}])
            self.assertEqual(json.loads(path.read_text()), {'Test': {'fresh': True}, 'Other': {'old': True}})

    def test_invalid_serialization_keeps_existing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            path.write_text('{"old":true}')
            with self.assertRaises(ValueError): atomic_write_json(path, {'bad': float('nan')})
            self.assertEqual(path.read_text(), '{"old":true}')

    def test_options_have_no_per_share_equity_price(self):
        q = quarter('2026-09-30')
        q['holdings'], q['total_val'] = c.parse_xml_holdings(xml('CALL'), '2026-01-01')
        holding = c.analyze_quarters(GURU, [q])['holdings'][0]
        self.assertIsNone(holding['reportedPrice'])

    def test_malformed_cache_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            path.write_text('{bad json')
            with self.assertRaises(json.JSONDecodeError):
                c.run_1year_sync(path, [])
            self.assertEqual(path.read_text(), '{bad json')

    @patch('data_io.os.replace', side_effect=OSError('disk error'))
    def test_failed_atomic_replace_keeps_original(self, replace):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            path.write_text('{"old":true}')
            with self.assertRaises(OSError): atomic_write_json(path, {'fresh': True})
            self.assertEqual(path.read_text(), '{"old":true}')
            self.assertEqual(list(Path(directory).iterdir()), [path])

    @patch.object(c.time, 'sleep')
    @patch.object(c.requests, 'get')
    def test_information_table_discovery(self, get, sleep):
        listing = Mock(status_code=200)
        listing.json.return_value = {'directory':{'item':[{'name':'custom.xml'}]}}
        get.side_effect = [listing, Mock(status_code=404), Mock(status_code=404), Mock(status_code=200, text=xml())]
        holdings, total, url = c.fetch_information_table('https://www.sec.gov/folder/', 'a', '2026-01-01')
        self.assertEqual(total, 1000)
        self.assertTrue(url.endswith('/custom.xml'))

    @patch.object(c, 'fetch_information_table', side_effect=ValueError('failed'))
    @patch.object(c.requests, 'get')
    def test_latest_failure_does_not_promote_older(self, get, fetch):
        get.return_value.json.return_value = {'filings': {'recent': {'form':['13F-HR','13F-HR'],
            'reportDate':['2026-09-30','2026-06-30'], 'filingDate':['2026-11-01','2026-08-01'],
            'accessionNumber':['0001','0002']}}}
        self.assertIsNone(c.fetch_guru_1year(GURU))
        self.assertEqual(fetch.call_count, 1)

if __name__ == '__main__': unittest.main()
