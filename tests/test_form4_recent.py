from datetime import date
import gzip
import json
import unittest

from sec_form4_recent import INDEX_HEADER, collect, filing_path, validate_recent_snapshot


BUY = "0000001000-26-000001"
AMENDED = "0000001000-26-000002"
SECOND = "0000001000-26-000003"
FUND = "0000001001-26-000004"
AMENDMENT = "0000001000-26-000005"


def submission(accession, filed, *, form="4", issuer="1000", owner="Sample Director", file_number="001-456"):
    purchase = """<nonDerivativeTable><nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-11-03-05:00</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100</value></transactionShares>
        <transactionPricePerShare><value>7.25</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction></nonDerivativeTable>"""
    payload = purchase if form == "4" else "<dateOfOriginalSubmission>2026-11-04</dateOfOriginalSubmission>"
    return f"""<SEC-DOCUMENT>
ACCESSION NUMBER: {accession}
CONFORMED SUBMISSION TYPE: {form}
FILED AS OF DATE: {filed}
SEC FILE NUMBER: {file_number}
<DOCUMENT>
<TYPE>{form}
<XML><ownershipDocument>
  <documentType>{form}</documentType>
  <issuer><issuerCik>{issuer}</issuerCik><issuerName>Example Company</issuerName>
    <issuerTradingSymbol>EX</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>{owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship>
  </reportingOwner>
  {payload}
</ownershipDocument></XML>
</DOCUMENT>""".encode()


class RecentForm4Tests(unittest.TestCase):
    def setUp(self):
        prefix = "/Archives/edgar/daily-index/2026/QTR4/"
        self.directory = prefix + "index.json"
        self.first = prefix + "master.20261104.idx"
        self.second = prefix + "master.20261105.idx"
        self.responses = {
            "/files/company_tickers_exchange.json": json.dumps({
                "fields": ["cik", "name", "ticker", "exchange"],
                "data": [[i, f"Issuer {i}", f"T{i}", "NYSE"] for i in range(1000, 2000)],
            }).encode(),
            self.directory: json.dumps({"directory": {"item": [
                {"name": "master.20261104.idx"}, {"name": "master.20261105.idx"}
            ]}}).encode(),
            self.first: (INDEX_HEADER + "\n" + "\n".join([
                f"1000|Issuer|4|20261104|edgar/data/1000/{AMENDED}.txt",
                f"1002|Reporting owner|4|20261104|edgar/data/1002/{AMENDED}.txt",
                f"1000|Issuer|4|20261104|edgar/data/1000/{SECOND}.txt",
                f"1001|Fund|4|20261104|edgar/data/1001/{FUND}.txt",
            ])).encode(),
            self.second: (INDEX_HEADER + "\n" + "\n".join([
                f"1000|Issuer|4/A|20261105|edgar/data/1000/{AMENDMENT}.txt",
                f"1000|Issuer|4|20261105|edgar/data/1000/{BUY}.txt",
            ])).encode(),
            filing_path("1000", AMENDED) + ".txt": submission(AMENDED, "20261104"),
            filing_path("1000", SECOND) + ".txt": submission(SECOND, "20261104", owner="Another Director"),
            filing_path("1001", FUND) + ".txt": submission(FUND, "20261104", issuer="1001", file_number="811-12345"),
            filing_path("1000", AMENDMENT) + ".txt": submission(AMENDMENT, "20261105", form="4/A"),
            filing_path("1000", BUY) + ".txt": submission(BUY, "20261105"),
        }
        self.calls = []

    def get(self, path):
        self.calls.append(path)
        return self.responses[path]

    def test_replay_deduplicates_issuer_and_reporter_and_withholds_amended_and_fund_rows(self):
        result = collect(self.get, date(2026, 11, 5))
        self.assertEqual(result["verifiedFilings"], 5)
        self.assertEqual(result["coverage"]["through"], "2026-11-05")
        self.assertEqual([row["accessionNumber"] for row in result["transactions"]], [BUY, SECOND])
        self.assertTrue(all(row["transDate"] == "2026-11-03" for row in result["transactions"]))
        self.assertNotIn(filing_path("1002", AMENDED) + ".txt", self.calls)

        self.calls.clear()
        self.assertEqual(collect(self.get, date(2026, 11, 5), result), result)
        self.assertFalse(any(path.endswith(".txt") for path in self.calls))

        result["transactions"] = []
        with self.assertRaisesRegex(ValueError, "Invalid reconciled"):
            validate_recent_snapshot(result)

    def test_mismatched_filing_date_fails_instead_of_replacing_the_last_snapshot(self):
        path = filing_path("1000", BUY) + ".txt"
        self.responses[path] = submission(BUY, "20261104")
        with self.assertRaisesRegex(ValueError, "does not match its index"):
            collect(self.get, date(2026, 11, 5))

    def test_thirty_day_window_stays_anchored_to_latest_index(self):
        previous = collect(self.get, date(2026, 11, 5))
        self.assertEqual(previous["coverage"]["from"], "2026-10-07")
        directory = json.loads(self.responses[self.directory])
        for day in ("20261119", "20261125"):
            name = f"master.{day}.idx"
            directory["directory"]["item"].append({"name": name})
            self.responses[self.directory.replace("index.json", name)] = (INDEX_HEADER + "\n").encode()
        self.responses[self.directory] = json.dumps(directory).encode()
        self.calls.clear()
        weekend = collect(self.get, date(2026, 11, 21), previous)
        self.assertEqual(weekend["coverage"]["from"], "2026-10-21")
        self.assertEqual(weekend["coverage"]["through"], "2026-11-19")
        rolled = collect(self.get, date(2026, 11, 25), weekend)
        self.assertEqual(rolled["coverage"]["from"], "2026-10-27")
        self.assertEqual(collect(self.get, date(2026, 11, 26), rolled), rolled)
        self.assertFalse(any(path.endswith(".txt") for path in self.calls))

    def test_shorter_snapshot_backfills_missing_days_and_reuses_verified_days(self):
        previous = collect(self.get, date(2026, 11, 5))
        previous["coverage"]["from"] = "2026-10-23"
        directory = json.loads(self.responses[self.directory])
        older_index = "master.20261007.idx"
        directory["directory"]["item"].append({"name": older_index})
        self.responses[self.directory] = json.dumps(directory).encode()
        self.responses[self.directory.replace("index.json", older_index)] = (INDEX_HEADER + "\n").encode()
        self.calls.clear()
        full = collect(self.get, date(2026, 11, 5), previous)
        self.assertEqual(full["coverage"]["from"], "2026-10-07")
        self.assertEqual(full["days"][0]["date"], "2026-10-07")
        self.assertEqual(full["transactions"], previous["transactions"])
        self.assertFalse(any(path.endswith(".txt") for path in self.calls))

    def test_missing_original_only_skips_when_rebuilt_index_confirms_removal(self):
        missing = filing_path("1000", SECOND) + ".txt"
        quarter_path = "/Archives/edgar/full-index/2026/QTR4/master.gz"
        retained = f"1000|Issuer|4|2026-11-04|edgar/data/1000/{AMENDED}.txt"
        missing_row = f"1000|Issuer|4|2026-11-04|edgar/data/1000/{SECOND}.txt"

        def get(path):
            if path == missing:
                raise FileNotFoundError(path)
            return self.get(path)

        def use_quarter(rows):
            index = "\n".join(["Last Data Received: November 6, 2026",
                               "CIK|Company Name|Form Type|Date Filed|Filename", *rows])
            self.responses[quarter_path] = gzip.compress(index.encode())

        use_quarter([retained, missing_row])
        with self.assertRaises(FileNotFoundError):
            collect(get, date(2026, 11, 5))

        use_quarter([retained])
        result = collect(get, date(2026, 11, 5))
        self.assertEqual(result["days"][0]["removedAccessions"], [SECOND])
        self.assertEqual([row["accessionNumber"] for row in result["transactions"]], [BUY])
        self.assertEqual(collect(get, date(2026, 11, 5), result), result)
