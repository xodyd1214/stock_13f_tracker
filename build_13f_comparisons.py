"""Build an optional public quarter comparison from retained SEC acquisitions."""
import argparse
from datetime import date, timedelta
from pathlib import Path

from compact_projection import canonical
from sec_filing_integrity import equity_rows
from sec_partial_stage import Evidence, check, clock, sha
from sec_source_acquisition import parse_json


def previous_quarter(period):
    current = date.fromisoformat(period)
    return (current.replace(month=current.month - 2, day=1) - timedelta(days=1)).isoformat()


def public_holdings_report(snapshot):
    return all(component['reportType'] == '13F HOLDINGS REPORT' and all(
        item['text'].strip().lower() in ('false', '0', 'no')
        for item in component['confidentialDisclosures']) for component in snapshot['components'])


def positions(snapshot, policy):
    result = {}
    for row in equity_rows(snapshot, policy):
        cusip = row['cusip'].upper()
        if cusip not in result:
            result[cusip] = (set(), 0)
        classes, shares = result[cusip]
        classes.add(' '.join(row['titleOfClass'].upper().split()))
        result[cusip] = (classes, shares + row['shares'])
    return result


def compare(current, previous, policy):
    earlier = positions(previous, policy)
    earlier_cusips = {row['cusip'].upper() for row in previous['rows']}
    can_check_absence = public_holdings_report(current) and public_holdings_report(previous)
    pairs = []
    for cusip, (classes, shares) in sorted(positions(current, policy).items()):
        if len(classes) != 1 or not 0 < shares < 2**53:
            continue
        if cusip in earlier:
            prior_classes, prior_shares = earlier[cusip]
            if prior_classes == classes and 0 <= prior_shares < 2**53:
                pairs.append([cusip, prior_shares])
        elif can_check_absence and cusip not in earlier_cusips:
            pairs.append([cusip, None])
    return pairs


def build(sec_data, evidence_root, output):
    now = clock()
    pointer = parse_json((sec_data / 'current.json').read_bytes())
    generation = pointer['generationId']
    directory = sec_data / 'generations' / generation
    raw = (directory / 'generation.json').read_bytes()
    check(sha(raw) == generation, 'Current generation hash differs')
    descriptor = parse_json(raw)

    def artifact(name):
        raw = (directory / name).read_bytes()
        check(descriptor['files'][name] == {'bytes': len(raw), 'sha256': sha(raw)}, 'Current artifact hash differs')
        return parse_json(raw)

    policy_bytes = (sec_data / 'display-policy.json').read_bytes()
    check(sha(policy_bytes) == descriptor['scopeSha256'], 'Current scope hash differs')
    policy = parse_json(policy_bytes).get('equityShareClassOverrides', [])
    manifest = artifact('manifest.json')
    available = {row['cik']: row for row in artifact('coverage.json')['labels'] if row['status'] == 'available'}
    comparisons = []
    for cik, entity in sorted(available.items()):
        period = entity['reportDate']
        prior = previous_quarter(period)
        spec = {'cik': cik, 'label': entity['legalName'], 'reportPeriods': [period, prior]}
        try:
            evidence = Evidence(evidence_root / cik / 'evidence-manifest.json', now, policy)
            managers = evidence.manifest['managers']
            check(len(managers) == 1 and evidence.report['complete'], 'Incomplete comparison acquisition')
            snapshots = evidence.manager(managers[0], spec, comparison_periods=[period, prior])
            current, previous = snapshots[period], snapshots[prior]
            hashes = lambda item: (item['accession'], item['primarySha256'], item['tableSha256'])
            published = {hashes(item) for item in manifest['sources'] if item['cik'] == cik}
            check(published == {hashes(item) for item in current['components']} and
                  sorted(current['allKnownAccessions']) == sorted(entity['sourceAccessions']), 'Current filings differ from published generation')
            pairs = compare(current, previous, policy)
            if pairs:
                comparisons.append({'cik': cik, 'period': period, 'previousPeriod': prior, 'positions': pairs,
                                    'sources': [{'accession': component['accession'], 'filingDate': component['filingDate'],
                                                 'sourceUrl': component['tableUrl']} for component in previous['components']]})
        except (ValueError, KeyError, TypeError, OSError) as error:
            print(f'{cik} {entity["legalName"]}: {error}')

    check(bool(comparisons), 'No verified quarter comparisons')
    payload = (canonical({'schemaVersion': 1, 'generationId': generation, 'managers': comparisons}) + '\n').encode()
    with output.open('xb') as handle:
        handle.write(payload)
    print(f'{len(comparisons)}/{len(available)} reporting entities, {sum(len(item["positions"]) for item in comparisons)} positions')
    print(sha(payload))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sec_data', type=Path)
    parser.add_argument('evidence_root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.sec_data, args.evidence_root, args.output)
