"""Keep the last verified filing for each institution and report quarter."""
from collections import defaultdict
import os
from pathlib import Path
import re
import shutil
import tempfile

from build_pages_bundle import MAX_PROJECTION, encoded
from compact_projection import decode_rows, encode_rows
from sec_filing_integrity import classify_reported_position
from sec_partial_stage import check, sha, timestamp
from sec_source_acquisition import iso_date, parse_json

HEX = re.compile(r'[a-f0-9]{64}')


def quarter_snapshots(manifest, coverage, rows, comparisons):
    positions, sources = defaultdict(list), defaultdict(list)
    for row in rows:
        positions[row['cik']].append(row)
    for source in manifest['sources']:
        sources[source['cik']].append(source)
    labels = defaultdict(list)
    for item in coverage['labels']:
        if item['status'] == 'available':
            labels[item['cik']].append(item)
    result = defaultdict(dict)
    for cik, aliases in labels.items():
        period = aliases[0]['reportDate']
        date = iso_date(period)
        check((date.month, date.day) in {(3, 31), (6, 30), (9, 30), (12, 31)}, 'Invalid archive quarter')
        comparison = comparisons.get(cik)
        check(not comparison or comparison['period'] == period, 'Archive comparison period differs')
        result[period][cik] = (aliases, positions[cik], sources[cik], comparison)
    return result


def quarter_artifact_reader(directory, reference, scope_hash, period):
    generation = reference['generationId']
    check(HEX.fullmatch(generation), 'Invalid archive generation')
    directory = directory / generation
    raw = (directory / 'generation.json').read_bytes()
    descriptor = parse_json(raw)
    check(sha(raw) == generation and descriptor['scopeSha256'] == scope_hash and
          descriptor['reportPeriod'] == period, 'Archive descriptor differs')

    def artifact(name):
        raw = (directory / name).read_bytes()
        expected = (reference['comparisonSha256'] if name == 'holding-comparisons.json'
                    else descriptor['files'][name]['sha256'])
        check(expected == sha(raw), 'Archive artifact hash differs: ' + name)
        return parse_json(raw)

    return artifact


def read_quarter(directory, reference, scope_hash, period):
    artifact = quarter_artifact_reader(directory, reference, scope_hash, period)
    archive = {name: artifact(name)
               for name in ('manifest.json', 'coverage.json', 'projection.json')}
    comparisons = artifact('holding-comparisons.json')
    check(comparisons['generationId'] == reference['generationId'], 'Archive comparison generation differs')
    return (archive['manifest.json'], archive['coverage.json'], decode_rows(archive['projection.json']),
            {item['cik']: item for item in comparisons['managers']})


def write_quarter(directory, scope, scope_hash, period, entities, manifest):
    rows, sources, labels, comparisons = [], [], [], []
    for cik in sorted(entities):
        aliases, holdings, filings, comparison = entities[cik]
        labels.extend(aliases)
        rows.extend(holdings)
        sources.extend(filings)
        if comparison:
            comparisons.append(comparison)

    classification = {kind: {'rowCount': 0, 'reportedValueUsd': 0} for kind in
                      ('equity', 'equity_verified_fund_share')}
    for row in rows:
        kind = classify_reported_position(row, scope.get('equityShareClassOverrides', []))
        check(kind in classification, 'Non-equity row in quarter archive')
        classification[kind]['rowCount'] += 1
        classification[kind]['reportedValueUsd'] += row['value']

    summary = {key: manifest[key] for key in ('lastChecked', 'preparedAt', 'acquisitionStartedAt')}
    summary.update(schemaVersion=3, contract=scope['contract'], scopeSha256=scope_hash,
                   reportPeriod=period, sourceReportDates=[period], sources=sources,
                   holdingsRowCount=len(rows), totalEquityValueUsd=sum(row['value'] for row in rows),
                   comparisonManagersSha256=sha(encoded(comparisons)),
                   positionClassificationScope='archived_reported_equity', positionClassification=classification)
    coverage = {'schemaVersion': 1, 'contract': scope['contract'], 'labels': labels}
    projection = encoded(encode_rows(rows))
    check(len(projection) <= MAX_PROJECTION, 'Quarter projection exceeds the browser budget')
    payload = {'projection.json': projection, 'manifest.json': encoded(summary), 'coverage.json': encoded(coverage)}
    descriptor = encoded({'schemaVersion': 1, 'artifactType': 'sec_13f_quarter_generation', 'scopeSha256': scope_hash,
                          'reportPeriod': period,
                          'files': {name: {'bytes': len(raw), 'sha256': sha(raw)} for name, raw in payload.items()}})
    generation = sha(descriptor)
    comparison_data = encoded({'schemaVersion': 1, 'generationId': generation, 'managers': comparisons})
    check(len(comparison_data) <= 2 * 1024 * 1024, 'Quarter comparisons exceed the browser budget')
    payload.update({'generation.json': descriptor, 'holding-comparisons.json': comparison_data})
    if not (directory / generation).exists():
        with tempfile.TemporaryDirectory(dir=directory) as work:
            for name, raw in payload.items():
                (Path(work) / name).write_bytes(raw)
            Path(work).rename(directory / generation)
    return {'generationId': generation, 'comparisonSha256': sha(comparison_data), 'entityCount': len(entities)}


def archive_catalog(sec_data, scope):
    index = sec_data / 'quarters.json'
    scope_hash = sha((sec_data / 'display-policy.json').read_bytes())
    catalog = parse_json(index.read_bytes()) if index.exists() else {
        'schemaVersion': 1, 'contract': scope['contract'], 'scopeSha256': scope_hash, 'quarters': {}}
    check(catalog['scopeSha256'] == scope_hash and catalog['contract'] == scope['contract'], 'Quarter archive scope differs')
    return catalog


def superseded_comparison(cik, comparison, amended_sources):
    if not comparison:
        return False
    updated = amended_sources.get((comparison['previousPeriod'], cik))
    return updated is not None and {source['accession'] for source in comparison['sources']} != updated


def update_archive(sec_data, scope, *snapshots, amended_sources=None, comparison_updates=None):
    """Merge source-verified snapshots in acquisition order without dropping institutions."""
    directory = sec_data / 'quarters'
    index = sec_data / 'quarters.json'
    catalog = archive_catalog(sec_data, scope)
    scope_hash = catalog['scopeSha256']
    quarters = catalog['quarters']
    incoming = defaultdict(list)
    for manifest, coverage, rows, comparisons in snapshots:
        for period, entities in quarter_snapshots(manifest, coverage, rows, comparisons).items():
            incoming[period].append((manifest, entities))

    amended_sources = amended_sources or {}
    if amended_sources:
        from build_13f_comparisons import previous_quarter
        amended_periods = {period for period, _ in amended_sources}
        for period in quarters:
            if previous_quarter(period) in amended_periods:
                incoming.setdefault(period, [])
    comparison_updates = comparison_updates or {}
    for period, _ in comparison_updates:
        if period in quarters:
            incoming.setdefault(period, [])

    updated = False
    directory.mkdir(exist_ok=True)
    for period, versions in incoming.items():
        old = quarters.get(period)
        entities = {}
        reports = [manifest for manifest, _ in versions]
        if old:
            snapshot = read_quarter(directory, old, scope_hash, period)
            reports.append(snapshot[0])
            entities = quarter_snapshots(*snapshot)[period]
        changed = False
        for _, filings in versions:
            for cik, filing in filings.items():
                previous = entities.get(cik)
                if previous:
                    accessions = set(filing[0][0]['sourceAccessions'])
                    prior_accessions = set(previous[0][0]['sourceAccessions'])
                    if accessions == prior_accessions and previous[1:3] == filing[1:3]:
                        if not filing[3] or filing[3] == previous[3]:
                            continue
                    elif not prior_accessions < accessions:
                        continue
                entities[cik] = filing
                changed = True
        for cik, filing in entities.items():
            comparison = filing[3]
            replacement = comparison_updates.get((period, cik))
            if replacement and replacement[0] == filing[0][0]['sourceAccessions']:
                comparison = replacement[1]
            if superseded_comparison(cik, comparison, amended_sources):
                comparison = None
            if comparison != filing[3]:
                entities[cik] = (*filing[:3], comparison)
                changed = True
        if not changed:
            continue
        timing = {}
        for key, operation in [('acquisitionStartedAt', min), ('lastChecked', max), ('preparedAt', max)]:
            timing[key] = operation(timestamp(manifest[key]) for manifest in reports).isoformat()
        reference = write_quarter(directory, scope, scope_hash, period, entities, timing)
        if old and old['generationId'] != reference['generationId']:
            reference['previousGenerationId'] = old['generationId']
        quarters[period] = reference
        updated = True

    if updated:
        with tempfile.TemporaryDirectory(dir=sec_data) as work:
            pending = Path(work) / 'quarters.json'
            pending.write_bytes(encoded(catalog))
            os.replace(pending, index)
        retained = {version[key] for version in quarters.values()
                    for key in ('generationId', 'previousGenerationId') if key in version}
        for path in directory.iterdir():
            if path.is_dir() and HEX.fullmatch(path.name) and path.name not in retained:
                shutil.rmtree(path)
    return catalog
