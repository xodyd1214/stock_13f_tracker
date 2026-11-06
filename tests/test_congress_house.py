import unittest

from congress_house import add_row, source_url


class CongressHouseTests(unittest.TestCase):
    def test_preserves_owner_asset_type_and_reported_band(self):
        rows = []
        filing = {"kind": "ptr", "filed": "2026-11-05", "year": 2026, "id": "20035662"}
        record = {
            "asset": "Brokerage Account ⇒ NVIDIA Corporation - Common Stock (NVDA) [OP]",
            "owner": "SP", "value": "$1,001 -\n$15,000", "traded": "09/25/2026",
            "action": "S (partial)", "status": "Amended",
        }
        add_row(rows, record, filing)
        self.assertEqual(rows, [{
            "asset": "NVIDIA Corporation - Common Stock", "ticker": "NVDA",
            "assetType": "OP", "owner": "SP", "value": "$1,001 - $15,000",
            "traded": "2026-09-25", "action": "S (partial)", "status": "Amended",
        }])
        self.assertTrue(source_url(filing).endswith("/ptr-pdfs/2026/20035662.pdf"))

    def test_skips_ambiguous_values_and_assets_outside_scope(self):
        rows = []
        filing = {"kind": "annual", "year": 2025, "id": "10075701"}
        add_row(rows, {"asset": "Bank CD [BA]", "owner": "", "value": "$1,001 - $15,000"}, filing)
        add_row(rows, {"asset": "Broadcom (AVGO) [ST]", "owner": "", "value": "$5,000,001 -"}, filing)
        self.assertEqual(rows, [])
        self.assertTrue(source_url(filing).endswith("/financial-pdfs/2025/10075701.pdf"))
