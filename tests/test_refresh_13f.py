"""Exercise the refresh against synthetic SEC responses and a pinned baseline."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from archive_13f import read_quarter, update_archive
from refresh_13f import refresh, refresh_entity, refresh_period, source_rows
from sec_filing_integrity import reconcile_filing, resolve_period_snapshot
from sec_partial_stage import sha, snapshot_holdings
from sec_source_acquisition import Client
from test_filing_integrity_rebuilt import synthetic
from test_sec_source_acquisition import Fake, SUB


CIK = '0000000001'
NAME = 'SYNTHETIC TEST ENTITY'
Q2 = '2026-06-30'
Q3 = '2026-09-30'


def make_client(*submissions, archives=()):
    columns = {key: [filing[2][key] for filing in submissions] for key in submissions[0][2] if key != 'cik'}
    columns['primaryDocument'] = ['primary.xml'] * len(submissions)
    data = {SUB: {'cik': 1, 'name': NAME, 'filings': {'recent': columns, 'files': list(archives)}}}
    for primary, table, _, primary_url, table_url in submissions:
        data[primary_url] = primary
        data[table_url] = table
        data[primary_url.removesuffix('primary.xml') + 'index.json'] = {
            'directory': {'item': [{'name': 'primary.xml'}, {'name': 'table.xml'}]}}
    return Client('Synthetic refresh test', transport=Fake(data), sleep=lambda _: None)


def published(snapshot):
    return {'label': NAME, 'status': 'available', 'cik': CIK, 'legalName': NAME, 'reportDate': snapshot['reportDate'],
            'sourceAccessions': snapshot['allKnownAccessions'], 'valueUsd': snapshot['equityValueUsd']}


def resolve_original(filing):
    original = reconcile_filing(*filing)
    return resolve_period_snapshot([original], [original['accession']])


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
        previous = resolve_original(june)
        state = published(previous)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first = root / 'first'
            second = root / 'second'
            first.mkdir()
            second.mkdir()
            initial = make_client(june, september)
            self.assertEqual(refresh_period(initial, state), '2026-09-30')
            q3, removed, comparison, _ = refresh_entity(
                initial, first, state, Q3, source_rows(CIK, NAME, previous), None, [])
            self.assertEqual(removed['equity']['reportedValueUsd'], 100)
            self.assertEqual(q3['equityValueUsd'], 150)
            self.assertEqual(comparison['positions'], [['000000001', 10]])
            self.assertIsNone(refresh_period(initial, published(q3)))

            later = make_client(june, september, amendment)
            self.assertEqual(refresh_period(later, published(q3)), '2026-09-30')
            updated, removed, comparison, _ = refresh_entity(
                later, second, published(q3), Q3, source_rows(CIK, NAME, q3), comparison, [])
            self.assertEqual(removed['equity']['reportedValueUsd'], 150)
            self.assertEqual(updated['equityValueUsd'], 200)
            self.assertEqual(comparison['positions'], [['000000001', 10]])
            self.assertIsNone(refresh_period(later, published(updated)))

    def test_rollover_skips_irrelevant_archive_and_isolates_unverified_prior_amendment(self):
        june = synthetic(period='06-30-2026', filing='2026-08-10')
        september = synthetic(number=3, period='09-30-2026', filing='2026-10-28')
        broken = synthetic(number=1, kind='RESTATEMENT', period='06-30-2026', filing='2026-11-10')
        broken[1] = broken[1].replace(b'<value>100</value>', b'<value>101</value>')
        descriptor = {'name': f'CIK{CIK}-submissions-001.json', 'filingFrom': '2014-04-08',
                      'filingTo': '2015-01-07', 'filingCount': 1}
        client = make_client(june, september, broken, archives=[descriptor])
        previous = resolve_original(june)
        with tempfile.TemporaryDirectory() as work:
            snapshot, _, comparison, _ = refresh_entity(
                client, Path(work).resolve(), published(previous), Q3, source_rows(CIK, NAME, previous), None, [])
        self.assertEqual(snapshot['reportDate'], Q3)
        self.assertIsNone(comparison)
        self.assertNotIn(broken[4], client.transport.calls)
        self.assertFalse(any(call.endswith(descriptor['name']) for call in client.transport.calls))

    def test_new_quarter_notice_publishes_a_reason_without_refreshing_holdings(self):
        june = synthetic(period='06-30-2026', filing='2026-08-10')
        notice = synthetic(number=3, period='09-30-2026', filing='2026-10-28')
        notice[2]['form'] = '13F-NT'
        previous = resolve_original(june)
        manifest = {'sources': source_rows(CIK, NAME, previous), 'lastChecked': '2026-08-10T00:00:00+00:00'}
        coverage = {'labels': [published(previous)]}
        rows = snapshot_holdings(previous, NAME, [NAME], [])
        with tempfile.TemporaryDirectory() as work:
            root = Path(work).resolve()
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            with patch('refresh_13f.load_generation', return_value=({}, 'active', manifest, coverage, rows, {})), \
                 patch('refresh_13f.historical_quarters', return_value=[]), patch('refresh_13f.publish') as publish:
                self.assertTrue(refresh(root, first, make_client(june, notice)))
                self.assertEqual(manifest['filingHoldbacks'][CIK], {
                    'period': Q3, 'accession': notice[2]['accessionNumber'], 'form': '13F-NT',
                    'reason': 'reporting_notice',
                })
                self.assertEqual(manifest['lastChecked'], '2026-08-10T00:00:00+00:00')
                self.assertEqual(coverage['labels'][0]['reportDate'], Q2)
                self.assertIs(publish.call_args.args[4], rows)
                self.assertTrue(refresh(root, second, make_client(june, notice)))
                publish.assert_called_once()

    def test_late_amendment_updates_archive_and_drops_superseded_comparison(self):
        june = synthetic(period='06-30-2026', filing='2026-08-10')
        september = synthetic(number=3, period='09-30-2026', filing='2026-10-28',
                              value='150', shares='15', voting='15')
        amendment = synthetic(number=1, kind='RESTATEMENT', period='06-30-2026',
                              filing='2026-11-10', value='200', shares='20', voting='20')
        q2, q3 = resolve_original(june), resolve_original(september)
        comparison = {'cik': CIK, 'period': Q3, 'previousPeriod': Q2, 'positions': [['000000001', 10]],
                      'sources': [{'accession': june[2]['accessionNumber']}]}
        scope = {'contract': 'test'}

        def bundle(snapshot, comparisons):
            manifest = dict.fromkeys(('lastChecked', 'preparedAt', 'acquisitionStartedAt'), '2026-10-30T00:00:00+00:00')
            manifest['sources'] = source_rows(CIK, NAME, snapshot)
            return (manifest, {'labels': [published(snapshot)]}, snapshot_holdings(snapshot, NAME, [NAME], []),
                    comparisons)

        active = bundle(q3, {CIK: comparison})
        with tempfile.TemporaryDirectory() as work:
            root = Path(work).resolve()
            (root / 'display-policy.json').write_bytes(b'{}')
            (root / 'evidence').mkdir()
            update_archive(root, scope, bundle(q2, {}), active)
            with patch('refresh_13f.load_generation', return_value=(scope, 'active', *active)), \
                 patch('refresh_13f.validate_generation'), patch('refresh_13f.publish') as publish:
                self.assertFalse(refresh(root, root / 'evidence', make_client(june, september, amendment)))
            catalog = update_archive(root, scope)
            archived = read_quarter(root / 'quarters', catalog['quarters'][Q2], sha(b'{}'), Q2)
            self.assertEqual(archived[1]['labels'][0]['sourceAccessions'],
                             [june[2]['accessionNumber'], amendment[2]['accessionNumber']])
            self.assertEqual(archived[2][0]['shares'], 20)
            archived = read_quarter(root / 'quarters', catalog['quarters'][Q3], sha(b'{}'), Q3)
            self.assertEqual(archived[2][0]['shares'], 15)
            self.assertEqual(archived[3], {})
            self.assertEqual(publish.call_args.args[5], {})
