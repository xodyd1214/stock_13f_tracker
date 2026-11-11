"""Exercise the refresh against synthetic SEC responses and a pinned baseline."""
from pathlib import Path
import tempfile
import unittest

from refresh_13f import refresh_entity, refresh_period, source_rows
from sec_filing_integrity import reconcile_filing, resolve_period_snapshot
from sec_source_acquisition import Client
from test_filing_integrity_rebuilt import synthetic
from test_sec_source_acquisition import Fake, SUB


class Refresh13FTests(unittest.TestCase):
    def test_new_quarter_then_restatement_preserve_verified_previous_shares(self):
        june = synthetic(period='06-30-2026', filing='2026-08-10')
        september = synthetic(number=3, period='09-30-2026', filing='2026-10-28',
                              value='150', shares='15', voting='15')
        amendment = synthetic(number=1, kind='RESTATEMENT', period='09-30-2026',
                              filing='2026-11-10', value='200', shares='20', voting='20')
        name = 'SYNTHETIC TEST ENTITY'

        def client(*submissions):
            columns = {key: [filing[2][key] for filing in submissions] for key in june[2] if key != 'cik'}
            columns['primaryDocument'] = ['primary.xml'] * len(submissions)
            data = {SUB: {'cik': 1, 'name': name, 'filings': {'recent': columns, 'files': []}}}
            for primary, table, _, primary_url, table_url in submissions:
                data[primary_url] = primary
                data[table_url] = table
                data[primary_url.removesuffix('primary.xml') + 'index.json'] = {
                    'directory': {'item': [{'name': 'primary.xml'}, {'name': 'table.xml'}]}}
            return Client('Synthetic refresh test', transport=Fake(data), sleep=lambda _: None)

        def published(snapshot):
            return {'cik': '0000000001', 'legalName': name, 'reportDate': snapshot['reportDate'],
                    'sourceAccessions': snapshot['allKnownAccessions'], 'valueUsd': snapshot['equityValueUsd']}

        old = reconcile_filing(*june)
        previous = resolve_period_snapshot([old], [old['accession']])
        state = published(previous)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first = root / 'first'
            second = root / 'second'
            first.mkdir()
            second.mkdir()
            initial = client(june, september)
            self.assertEqual(refresh_period(initial, state), '2026-09-30')
            q3, removed, comparison, _ = refresh_entity(
                initial, first, state, '2026-09-30', source_rows(state['cik'], name, previous), None, [])
            self.assertEqual(removed['equity']['reportedValueUsd'], 100)
            self.assertEqual(q3['equityValueUsd'], 150)
            self.assertEqual(comparison['positions'], [['000000001', 10]])
            self.assertIsNone(refresh_period(initial, published(q3)))

            later = client(june, september, amendment)
            self.assertEqual(refresh_period(later, published(q3)), '2026-09-30')
            updated, removed, comparison, _ = refresh_entity(
                later, second, published(q3), '2026-09-30', source_rows(state['cik'], name, q3), comparison, [])
            self.assertEqual(removed['equity']['reportedValueUsd'], 150)
            self.assertEqual(updated['equityValueUsd'], 200)
            self.assertEqual(comparison['positions'], [['000000001', 10]])
            self.assertIsNone(refresh_period(later, published(updated)))
