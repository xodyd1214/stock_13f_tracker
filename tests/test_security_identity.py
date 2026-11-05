"""Security identity must never be inferred from an issuer-name collision."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import collector_1year as collector
import market_symbols as symbols


class SecurityIdentityTests(unittest.TestCase):
    def test_every_live_mapping_is_reviewed_and_has_provenance(self):
        mapping = json.loads((Path(symbols.__file__).parent / 'ticker_map.json').read_text())
        self.assertEqual(set(mapping), set(symbols.MARKET_SYMBOLS['reviewedCusips']))
        for cusip, ticker in mapping.items():
            with self.subTest(cusip=cusip):
                record = symbols.MARKET_SYMBOLS['reviewedCusips'][cusip]
                self.assertTrue(record['sourceUrl'].startswith('https://'))
                self.assertEqual(symbols.resolve_security_symbol(cusip), ticker)
                self.assertNotIn(cusip, symbols.MARKET_SYMBOLS['quarantinedCusips'])

    def test_21_verified_corrections_and_two_omissions(self):
        expected = {
            '81369Y209':'XLV', '81369Y308':'XLP', '81369Y407':'XLY',
            '81369Y506':'XLE', '81369Y605':'XLF', '81369Y704':'XLI',
            '81369Y803':'XLK', '81369Y852':'XLC', '81369Y860':'XLRE',
            'G02602103':'DOX', '133131102':'CPT', '133034108':'CAC',
            '40049J206':'TV', '479167108':'JOUT', '084670108':'BRK.A',
            '09259E108':'TCPC', '381430529':'GBIL', '64124P101':'NBH',
            '09290C780':'BAI', '007903107':'AMD', '81369Y100':'XLB',
            '464286772':'EWY', '464287234':'EEM'
        }
        for cusip, ticker in expected.items():
            self.assertEqual(symbols.resolve_security_symbol(cusip), ticker)

    def test_every_quarantined_or_non_equity_identity_stays_unresolved(self):
        for category in ('quarantinedCusips', 'nonEquityCusips'):
            for cusip in symbols.MARKET_SYMBOLS[category]:
                self.assertIsNone(symbols.resolve_security_symbol(cusip))
        for cusip in ('', None, '111111111', 'APPLE', 'BRK.B'):
            self.assertIsNone(symbols.resolve_security_symbol(cusip))
        self.assertIsNone(symbols.resolve_security_symbol('037833100', 'PRN'))
        self.assertIsNone(symbols.resolve_security_symbol('037833100', 'SH', 'CALL'))

    def test_historical_lifecycle_does_not_erase_identity(self):
        self.assertEqual(symbols.resolve_security_symbol('G4474Y214'), 'JHG')
        self.assertFalse(symbols.quote_eligible('JHG'))
        self.assertEqual(symbols.canonical_symbol('brk-b'), 'BRK.B')
        self.assertEqual(symbols.canonical_symbol('BRK-A'), 'BRK.A')
        self.assertNotEqual(symbols.canonical_symbol('BRK-B'), symbols.canonical_symbol('BRK-A'))

    def test_missing_provenance_or_unreviewed_lifecycle_fails_closed(self):
        with patch.dict(symbols.MARKET_SYMBOLS['reviewedCusips'], {
            '111111111': {'ticker':'AAPL'},
            '222222222': {'ticker':'AAPL','sourceUrl':'https://example.test/verified','quoteEligible':False}
        }):
            self.assertIsNone(symbols.resolve_security_symbol('111111111'))
            self.assertIsNone(symbols.resolve_security_symbol('222222222'))

    def test_collector_uses_reviewed_identity_and_preserves_unresolved_positions(self):
        def xml(cusip, share_type='SH'):
            return f'''<informationTable><infoTable><nameOfIssuer>Issuer</nameOfIssuer>
                <titleOfClass>COM</titleOfClass><cusip>{cusip}</cusip><value>500</value>
                <shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>{share_type}</sshPrnamtType></shrsOrPrnAmt>
                </infoTable></informationTable>'''
        for cusip, ticker in [('133131102','CPT'),('084670108','BRK.A'),('45817G201','45817G201')]:
            holdings, total = collector.parse_xml_holdings(xml(cusip), '2026-11-01')
            row = next(iter(holdings.values()))
            self.assertEqual(row['ticker'], ticker)
            self.assertEqual((row['cusip'], row['shares'], row['value'], total), (cusip, 10, 500, 500))
        holdings, _ = collector.parse_xml_holdings(xml('037833100', 'PRN'), '2026-11-01')
        self.assertEqual(next(iter(holdings.values()))['ticker'], '037833100')


if __name__ == '__main__':
    unittest.main()
