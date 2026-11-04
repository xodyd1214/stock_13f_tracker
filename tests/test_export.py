import json
from pathlib import Path
import tempfile
import unittest
import sec_collector

class ExportTests(unittest.TestCase):
    def test_valid_equity_export_preserves_unupdated_funds(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'history.json', Path(directory) / 'latest.json'
            holding = {'action':'ADD', 'shareType':'SH', 'putCall':None, 'securityClass':'COM', 'value':100, 'shares':2}
            fund = {'schemaVersion':2, 'valueUnit':'USD', 'latestPeriod':'2026-09-30', 'sourceUrl':'https://www.sec.gov/example',
                    'fund':'Test Fund', 'filingDate':'2026-11-01', 'fetchedAt':'2026-11-02T00:00:00Z',
                    'holdings':[holding, {**holding, 'putCall':'CALL'}, {**holding, 'shareType':'PRN'}, {**holding, 'action':'SOLD OUT'}]}
            source.write_text(json.dumps({'Test':fund, 'Legacy':{'old':True}}))
            target.write_text(json.dumps([{'guru':'Test','old':True,'period':'2026-06-30','filingDate':'2026-08-01'}, {'guru':'Legacy','old':True}]))
            result = sec_collector.export_latest(source, target)
            rows = json.loads(target.read_text())
            self.assertEqual(result['updatedFunds'], ['Test'])
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0], {'guru':'Legacy','old':True})
            self.assertEqual(rows[1]['period'], '2026-09-30')
            self.assertEqual(rows[1]['valueUnit'], 'USD')
            self.assertFalse(rows[1]['isOption'])

    def test_unverified_history_or_corrupt_cache_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'history.json', Path(directory) / 'latest.json'
            source.write_text('{"Legacy":{"old":true}}')
            for previous in ['[{"guru":"Legacy","old":true}]', '{']:
                target.write_text(previous)
                with self.assertRaises(ValueError): sec_collector.export_latest(source, target)
                self.assertEqual(target.read_text(), previous)

    def test_older_period_filing_or_unknown_baseline_preserves_bytes(self):
        holding = {'action':'UNKNOWN','shareType':'SH','putCall':None,'securityClass':'COM','value':100,'shares':2}
        fund = {'schemaVersion':2,'valueUnit':'USD','latestPeriod':'2026-09-30','filingDate':'2026-11-01',
                'sourceUrl':'https://www.sec.gov/example','fund':'Test Fund','fetchedAt':'2026-11-02T00:00:00Z','holdings':[holding]}
        for period, filed in [('2026-12-31','2027-02-01'), ('2026-09-30','2026-11-02'), (None,None)]:
            with self.subTest(period=period, filed=filed), tempfile.TemporaryDirectory() as directory:
                source, target = Path(directory) / 'history.json', Path(directory) / 'latest.json'
                source.write_text(json.dumps({'Test':fund}))
                original = json.dumps([{'guru':'Test','period':period,'filingDate':filed,'old':True}]) + '\n'
                target.write_text(original)
                with self.assertRaises(ValueError): sec_collector.export_latest(source,target)
                self.assertEqual(target.read_text(),original)

    def test_regressed_fund_is_preserved_while_independent_fund_updates(self):
        holding = {'action':'UNKNOWN','shareType':'SH','putCall':None,'securityClass':'COM','value':100,'shares':2}
        fund = {'schemaVersion':2,'valueUnit':'USD','latestPeriod':'2026-09-30','filingDate':'2026-11-01',
                'sourceUrl':'https://www.sec.gov/example','fund':'Test Fund','fetchedAt':'2026-11-02T00:00:00Z','holdings':[holding]}
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'history.json', Path(directory) / 'latest.json'
            source.write_text(json.dumps({'Old':fund,'New':fund}))
            old = {'guru':'Old','period':'2026-12-31','filingDate':'2027-02-01','old':True}
            target.write_text(json.dumps([old]))
            result = sec_collector.export_latest(source,target)
            self.assertEqual(result['updatedFunds'],['New'])
            self.assertIn('Old',result['skippedFunds'])
            rows = json.loads(target.read_text())
            self.assertEqual(rows[0],old)
            self.assertEqual(rows[1]['action'],'UNKNOWN')

if __name__ == '__main__': unittest.main()
