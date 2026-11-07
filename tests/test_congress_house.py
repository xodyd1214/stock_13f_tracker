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

    def test_shares_require_an_explicit_quantity_for_the_matching_trade(self):
        filing = {"kind": "ptr", "filed": "2026-08-21"}
        record = {
            "asset": "Bloom Energy (BE) [ST]", "owner": "SP", "value": "$1,000,001 - $5,000,000",
            "traded": "07/24/2026", "action": "P", "status": "New",
        }
        for asset, action, notes, expected in (
            ("[ST]", "P", ["Purchased 10,000 shares."], "10000"),
            ("[ST]", "S (partial)", ["Sold 0.25 shares."], "0.25"),
            ("[EF]", "S", ["Sale of 1 share."], "1"),
            ("[OP]", "P", ["Purchased 10,000 shares."], None),
            ("[ST]", "P", ["Sold 10,000 shares."], None),
            ("[ST]", "P", ["Purchased 100 call options."], None),
            ("[ST]", "P", ["Purchased 10,000 shares.", "Shares: 5,000"], None),
            ("[ST]", "P", ["Owns 10,000 shares.", "Purchased 10 to 20 shares."], None),
            ("[ST]", "P", [], None),
        ):
            with self.subTest(asset=asset, action=action, notes=notes):
                rows = []
                add_row(rows, {**record, "asset": f"Bloom Energy (BE) {asset}", "action": action, "notes": notes}, filing)
                self.assertEqual(rows[0].get("shares"), expected)
