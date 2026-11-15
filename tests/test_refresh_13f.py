"""Exercise the refresh against synthetic SEC responses and a pinned baseline."""
from pathlib import Path
import tempfile
import unittest

from archive_13f import read_quarter, update_archive
from refresh_13f import refresh_entity, refresh_period, source_rows
from sec_filing_integrity import reconcile_filing, resolve_period_snapshot
from sec_partial_stage import sha, snapshot_holdings
from sec_source_acquisition import Client
from test_filing_integrity_rebuilt import synthetic
from test_sec_source_acquisition import Fake, SUB


class Refresh13FTests(unittest.TestCase):
    def test_archive_keeps_displaced_quarters_and_merges_later_reporters(self):
        scope = {'contract': 'test'}
        name = 'Synthetic manager'

        def filing(cik, period, raw_period, filed):
            args = synthetic(period=raw_period, filing=filed)
            args[0] = args[0].replace(b'<cik>1</cik>', f'<cik>{int(cik)}</cik>'.encode())
            args[2]['cik'] = cik
            args[3] = args[3].replace('/data/1/', f'/data/{int(cik)}/')
            args[4] = args[4].replace('/data/1/', f'/data/{int(cik)}/')
            record = reconcile_filing(*args)
            snapshot = resolve_period_snapshot([record], [record['accession']])
            label = {'label': cik, 'legalName': name, 'cik': cik, 'status': 'available',
                     'reportDate': period, 'sourceAccessions': snapshot['allKnownAccessions']}
            return label, snapshot_holdings(snapshot, name, [cik], []), source_rows(cik, name, snapshot)

        def edition(*filings):
            labels, rows, sources = zip(*filings)
            manifest = dict.fromkeys(('lastChecked', 'preparedAt', 'acquisitionStartedAt'), '2027-01-15T00:00:00+00:00')
            manifest['sources'] = [source for group in sources for source in group]
            return manifest, {'labels': list(labels)}, [row for group in rows for row in group], {}

        q2 = filing('0000000001', '2026-06-30', '06-30-2026', '2026-08-08')
        q3a = filing('0000000001', '2026-09-30', '09-30-2026', '2026-11-09')
        q3b = filing('0000000002', '2026-09-30', '09-30-2026', '2026-11-10')
        q4 = filing('0000000001', '2026-12-31', '12-31-2026', '2027-01-10')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'display-policy.json').write_bytes(b'{}')
            first = update_archive(root, scope, edition(q2))
            second = update_archive(root, scope, edition(q3a))
            third = update_archive(root, scope, edition(q4, q3b))
            self.assertEqual(first['quarters']['2026-06-30'], third['quarters']['2026-06-30'])
            self.assertEqual(third['quarters']['2026-09-30']['previousGenerationId'],
                             second['quarters']['2026-09-30']['generationId'])
            self.assertEqual([item['entityCount'] for _, item in sorted(third['quarters'].items())], [1, 2, 1])
            _, archived_coverage, archived_rows, _ = read_quarter(
                root / 'quarters', third['quarters']['2026-09-30'], sha(b'{}'), '2026-09-30')
            self.assertEqual({row['cik'] for row in archived_coverage['labels']}, {'0000000001', '0000000002'})
            self.assertEqual({row['period'] for row in archived_rows}, {'2026-09-30'})
            self.assertEqual(update_archive(root, scope, edition(q4, q3b)), third)

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
