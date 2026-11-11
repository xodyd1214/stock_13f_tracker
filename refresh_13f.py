"""Refresh reviewed Form 13F entities using verified SEC filings and the active snapshot."""
import argparse
from collections import defaultdict
from copy import deepcopy
import os
from pathlib import Path
import re
import shutil
import tempfile

from build_13f_comparisons import compare, positions, previous_quarter, public_holdings_report
from build_pages_bundle import MAX_PROJECTION, encoded, validate_public
from compact_projection import decode_rows, encode_rows
from sec_filing_integrity import resolve_period_snapshot, validate_share_class_policy
from sec_partial_stage import Evidence, SCOPE_PATH, check, clock, safe_numbers, sha, snapshot_holdings
from sec_source_acquisition import Client, acquire, canonical_cik, parse_json, records

HEX = re.compile(r'[a-f0-9]{64}')
SEC_USER_AGENT = 'AlphaInsiderTracker xodyd1214@gmail.com'


def load_generation(sec_data):
    policy_bytes = (sec_data / 'display-policy.json').read_bytes()
    check(policy_bytes == SCOPE_PATH.read_bytes(), 'Published policy differs from the reviewed scope')
    scope = parse_json(policy_bytes)
    pointer = parse_json((sec_data / 'current.json').read_bytes())
    generation = pointer['generationId']
    check(HEX.fullmatch(generation) and pointer['contract'] == scope['contract'], 'Invalid active generation')
    directory = sec_data / 'generations' / generation
    descriptor_bytes = (directory / 'generation.json').read_bytes()
    descriptor = parse_json(descriptor_bytes)
    check(sha(descriptor_bytes) == generation and descriptor['scopeSha256'] == sha(policy_bytes), 'Active generation hash differs')

    def artifact(name):
        raw = (directory / name).read_bytes()
        check(descriptor['files'][name] == {'bytes': len(raw), 'sha256': sha(raw)}, 'Active artifact hash differs: ' + name)
        return parse_json(raw)

    rows = decode_rows(artifact('projection.json'))
    manifest = artifact('manifest.json')
    coverage = artifact('coverage.json')
    validate_generation(rows, coverage, manifest, scope)
    comparison_path = directory / 'holding-comparisons.json'
    comparison_hash = pointer.get('comparisonSha256')
    if comparison_hash is None:
        config = (sec_data.parent / 'sec-display-config.js').read_text()
        legacy_hash = re.search(r'"comparisonSha256":"([a-f0-9]{64})"', config)
        comparison_hash = legacy_hash[1] if legacy_hash else None
        comparison_path = sec_data / 'holding-comparisons.json'
    comparisons = {}
    if comparison_hash:
        raw = comparison_path.read_bytes()
        payload = parse_json(raw)
        check(sha(raw) == comparison_hash and payload['generationId'] == generation, 'Active comparison hash differs')
        comparisons = {item['cik']: item for item in payload['managers']}
    return scope, generation, manifest, coverage, rows, comparisons


def validate_generation(rows, coverage, manifest, scope):
    labels = [{**row, 'status': row['status'].replace('-', '_')} for row in coverage['labels']]
    validate_public(rows, labels, manifest, scope)
    safe_numbers(manifest)
    partition = manifest['positionClassification']
    check(all(item['rowCount'] >= 0 and item['reportedValueUsd'] >= 0 for item in partition.values()), 'Invalid position partition')
    check(sum(partition[k]['rowCount'] for k in ('equity', 'equity_verified_fund_share')) == len(rows), 'Position count differs')
    check(sum(partition[k]['reportedValueUsd'] for k in ('equity', 'equity_verified_fund_share')) == manifest['totalEquityValueUsd'], 'Position value differs')


def refresh_period(client, current):
    cik = current['cik']
    raw, _ = client.get(f'https://data.sec.gov/submissions/CIK{cik}.json')
    submissions = parse_json(raw)
    check(canonical_cik(submissions['cik']) == cik and submissions['name'] == current['legalName'], 'SEC reporter identity differs')
    filings = records(submissions['filings']['recent'])
    period = max((row['reportDate'] for row in filings), default='')
    if period > current['reportDate']:
        return period
    if period == current['reportDate'] and any(
        row['reportDate'] == period and row['accessionNumber'] not in current['sourceAccessions'] for row in filings
    ):
        return period
    return None


def resolve(filings, period, policy, accessions=None):
    period_filings = [filing for filing in filings if filing['reportDate'] == period
                      and (accessions is None or filing['accession'] in accessions)]
    expected = accessions if accessions is not None else [filing['accession'] for filing in period_filings]
    return resolve_period_snapshot(period_filings, expected, policy)


def source_hashes(components):
    return {(item['accession'], item['primarySha256'], item['tableSha256']) for item in components}


def source_rows(cik, name, snapshot):
    return [
        {'cik': cik, 'legalName': name, 'period': snapshot['reportDate'], 'filingDate': item['filingDate'],
         'accession': item['accession'], 'sourceUrl': item['tableUrl'], 'primarySourceUrl': item['primaryUrl'],
         'form': item['form'], 'amendmentType': item['amendmentType'], 'amendmentNumber': item['amendmentNumber'],
         'tableSha256': item['tableSha256'], 'primarySha256': item['primarySha256']}
        for item in snapshot['components']
    ]


def refresh_comparison(cik, current, prior, baseline, existing, policy):
    period = current['reportDate']
    if prior is not None:
        pairs = compare(current, prior, policy)
        sources = [{'accession': item['accession'], 'filingDate': item['filingDate'], 'sourceUrl': item['tableUrl']}
                   for item in prior['components']]
    elif existing and existing['period'] == period:
        old = positions(baseline, policy)
        new = positions(current, policy)
        allows_absence = public_holdings_report(current)
        pairs = [[cusip, shares] for cusip, shares in existing['positions']
                 if cusip in old and cusip in new and old[cusip][0] == new[cusip][0]
                 and new[cusip][1] > 0 and (shares is not None or allows_absence)]
        sources = existing['sources']
    else:
        return None
    if pairs:
        return {'cik': cik, 'period': period, 'previousPeriod': previous_quarter(period),
                'positions': pairs, 'sources': sources}
    return None


def refresh_entity(client, evidence_dir, current, period, published_sources, existing_comparison, policy):
    cik, name = current['cik'], current['legalName']
    periods = sorted({period, current['reportDate']}, reverse=True)
    spec = {'cik': cik, 'label': name, 'reportPeriods': periods}
    directory = evidence_dir / cik
    report = acquire({'managers': [spec]}, directory, client=client)
    check(report['complete'], '; '.join(item['reason'] for item in report['failures']))
    evidence = Evidence(directory / 'evidence-manifest.json', clock(), policy)
    filings, _ = evidence.filing_records(evidence.manifest['managers'][0], spec,
                                         comparison_periods=periods, require_latest=True)
    baseline = resolve(filings, current['reportDate'], policy, current['sourceAccessions'])
    check(source_hashes(baseline['components']) == source_hashes(published_sources)
          and baseline['equityValueUsd'] == current['valueUsd'], 'Published baseline differs from the SEC source')
    snapshot = resolve(filings, period, policy)
    check(snapshot['classificationSummary']['unresolved_share_class']['rowCount'] == 0,
          'Unresolved share class requires review')
    check(period > current['reportDate'] or set(current['sourceAccessions']) < set(snapshot['allKnownAccessions']),
          'No newer reconciled filing')
    # The already published previous quarter provides a verified comparison
    # even if a separate amendment to that older quarter is still under review.
    prior = baseline if baseline['reportDate'] == previous_quarter(period) else None
    comparison = refresh_comparison(cik, snapshot, prior, baseline, existing_comparison, policy)
    proof = {'evidenceManifestSha256': sha(evidence.manifest_raw), 'acquisitionReportSha256': sha(evidence.report_raw),
             'checkedAt': max(evidence.times).isoformat()}
    return snapshot, baseline['classificationSummary'], comparison, proof


def publish(sec_data, previous_generation, manifest, coverage, rows, comparisons, scope):
    validate_generation(rows, coverage, manifest, scope)
    projection = encoded(encode_rows(rows))
    check(len(projection) <= MAX_PROJECTION, 'Projection exceeds the browser budget')
    payload = {'projection.json': projection, 'manifest.json': encoded(manifest), 'coverage.json': encoded(coverage)}
    descriptor = encoded({'schemaVersion': 1, 'artifactType': 'sec_13f_partial_pages_generation',
                          'scopeSha256': manifest['scopeSha256'],
                          'files': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in payload.items()}})
    generation = sha(descriptor)
    pointer = {'schemaVersion': 1, 'contract': scope['contract'], 'generationId': generation}
    comparison_data = encoded({'schemaVersion': 1, 'generationId': generation,
                               'managers': [comparisons[cik] for cik in sorted(comparisons)]})
    check(len(comparison_data) <= 2 * 1024 * 1024, 'Quarter comparisons exceed the browser budget')
    pointer['comparisonSha256'] = sha(comparison_data)
    payload.update({'generation.json': descriptor, 'holding-comparisons.json': comparison_data})
    generations = sec_data / 'generations'
    with tempfile.TemporaryDirectory(dir=generations) as work:
        stage = Path(work) / generation
        stage.mkdir()
        for name, data in payload.items():
            (stage / name).write_bytes(data)
        stage.rename(generations / generation)
        next_pointer = Path(work) / 'current.json'
        next_pointer.write_bytes(encoded(pointer))
        os.replace(next_pointer, sec_data / 'current.json')
    # Keep the prior generation available for readers that already loaded its pointer.
    for directory in generations.iterdir():
        if HEX.fullmatch(directory.name) and directory.name not in {generation, previous_generation}:
            shutil.rmtree(directory)
    return generation


def refresh(sec_data, evidence_dir, client):
    scope, generation, manifest, coverage, rows, comparisons = load_generation(sec_data)
    policy = scope.get('equityShareClassOverrides', [])
    validate_share_class_policy(policy)
    labels_by_cik = defaultdict(list)
    for label in coverage['labels']:
        if label['status'] == 'available':
            labels_by_cik[label['cik']].append(label)
    rows_by_cik, sources_by_cik = defaultdict(list), defaultdict(list)
    for row in rows:
        rows_by_cik[row['cik']].append(row)
    for source in manifest['sources']:
        sources_by_cik[source['cik']].append(source)

    changed = 0
    failed = 0
    for cik, labels in labels_by_cik.items():
        current = labels[0]
        try:
            period = refresh_period(client, current)
            if period is None:
                continue
            snapshot, old_partition, comparison, proof = refresh_entity(
                client, evidence_dir, current, period, sources_by_cik[cik], comparisons.get(cik), policy)
            name = current['legalName']
            holdings = snapshot_holdings(snapshot, name, [label['label'] for label in labels], policy)
            sources = source_rows(cik, name, snapshot)
            partition = deepcopy(manifest['positionClassification'])
            for kind, counts in partition.items():
                for key in counts:
                    counts[key] += snapshot['classificationSummary'][kind][key] - old_partition[kind][key]
                    check(counts[key] >= 0, 'Snapshot partition cannot replace published counts')
            safe_numbers(snapshot)
        except (ValueError, OSError, KeyError, TypeError) as error:
            print(f'{cik} {current["legalName"]}: {error}. Keeping published snapshot.', flush=True)
            failed += 1
            if client.stopped or client.retry_blocked or client.budget_exhausted:
                break
            continue

        rows_by_cik[cik] = holdings
        sources_by_cik[cik] = sources
        manifest['positionClassification'] = partition
        manifest.setdefault('refreshEvidence', {})[cik] = proof
        comparisons.pop(cik, None)
        if comparison:
            comparisons[cik] = comparison
        for label in labels:
            label.update(reportDate=period, valueUsd=snapshot['equityValueUsd'], holdingsCount=len(holdings),
                         sourceFilingDate=snapshot['filingDate'], sourceAccessions=snapshot['allKnownAccessions'],
                         sourceLinks=[{'accession': s['accession'], 'filingDate': s['filingDate'],
                                       'primaryUrl': s['primarySourceUrl'], 'tableUrl': s['sourceUrl']} for s in sources])
        changed += 1
        print(f'{cik} {name}: {period} verified, {len(holdings)} rows', flush=True)

    if changed:
        rows = [row for items in rows_by_cik.values() for row in items]
        now = clock()
        latest = max(item['checkedAt'] for item in manifest['refreshEvidence'].values())
        manifest.update(asOf=now.date().isoformat(), preparedAt=now.isoformat(), lastChecked=latest,
                        freshnessLabel=f'Latest source verification {latest}; mixed-period partial coverage',
                        sourceReportDates=sorted({labels[0]['reportDate'] for labels in labels_by_cik.values()}),
                        sources=[row for items in sources_by_cik.values() for row in items],
                        totalEquityValueUsd=sum(row['value'] for row in rows), holdingsRowCount=len(rows))
        generation = publish(sec_data, generation, manifest, coverage, rows, comparisons, scope)
    print(f'Updated {changed} reporting entities; {failed} failed checks; generation {generation}', flush=True)
    return bool(failed)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    args = parser.parse_args()
    evidence_dir = args.evidence_dir.resolve()
    evidence_dir.mkdir()
    raise SystemExit(refresh(Path(__file__).resolve().parent / 'sec-data', evidence_dir, Client(SEC_USER_AGENT)))
