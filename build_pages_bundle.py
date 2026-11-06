"""Prepare, never deploy, a hash-pinned GitHub Pages partial SEC display.

Only a new directory can be written. Every build replays retained raw SEC bytes
through the mandatory 43-label scope before creating its candidate pointer.
The exported public tree contains neither legacy holdings nor private evidence.
"""
import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from datetime import timedelta

from compact_projection import encode_rows, decode_rows, canonical
import sec_partial_stage as stage
from sec_filing_integrity import is_reported_equity

CONTRACT = 'exact_43_labels_42_entities_of_50'
ASSETS = ('index.html','app.js','style.css','google.svg','sec_display_loader.js',
          'ticker_map.json','realtime_prices.json','latest_macro_indicators.json',
          'market_symbols.json','latest_13d_filings.json','latest_form4_insiders.json','latest_form4_recent.json')
MAX_PROJECTION = 16 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024
MAX_SITE = 1024 * 1024 * 1024

class BundleError(ValueError):
    pass

def require(value, message):
    if not value:
        raise BundleError(message)

def encoded(value):
    return (canonical(value) + '\n').encode('utf-8')

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def regular(path):
    path = Path(path)
    require(path.absolute() == path.resolve() and path.is_file() and path.stat().st_nlink == 1,
            'Regular non-symlink, non-hardlinked file required: ' + str(path))
    return path

def validate_public(rows, coverage, manifest, scope):
    """Recheck transport invariants without granting raw-source certification."""
    require(scope['contract'] == CONTRACT and manifest['contract'] == CONTRACT, 'Wrong partial contract')
    require(manifest['partialDisplayEligible'] is True and manifest['releaseEligible'] is False
            and manifest['migrationReady'] is False, 'Full publication is not authorized')
    require((manifest['originalLabelCount'],manifest['availableLabelCount'],
             manifest['availableEntityCount'],manifest['pendingLabelCount']) == (50,43,42,7), 'Wrong coverage counts')
    require(len(coverage) == 50 and [r['label'] for r in coverage] == scope['originalLabels'], 'Coverage labels changed')
    eligible = {r['label']:r for r in scope['eligible']}
    pending = {r['label']:r for r in scope['pending']}
    totals = {}; seen = set()
    for row in rows:
        require(row['schemaVersion'] == 3 and row['verificationStatus'] == 'source_reconciled'
                and row['managerIdentityStatus'] == 'verified' and row['action'] == 'UNKNOWN', 'Unverified source row')
        require(is_reported_equity(row,scope.get('equityShareClassOverrides',[])), 'Non-equity row in projection')
        require(type(row['value']) is int and 0 <= row['value'] <= stage.MAX_SAFE
                and type(row['shares']) is int and 0 <= row['shares'] <= stage.MAX_SAFE, 'Unsafe financial value')
        require(row['valueUsd'] == row['value'] and row['sourceReportedValue'] * row['valueMultiplier'] == row['value'], 'Value reconciliation failed')
        require(row['sourceRowId'] not in seen, 'Repeated source row')
        seen.add(row['sourceRowId'])
        entry = totals.setdefault(row['cik'], {'count':0,'value':0,'legalName':row['legalName'],'period':row['period']})
        require(entry['legalName'] == row['legalName'] and entry['period'] == row['period'], 'Mixed entity snapshot')
        entry['count'] += 1; entry['value'] += row['value']
    for item in coverage:
        if item['label'] in pending:
            rule = pending[item['label']]
            require(item['status'] == 'verification_pending' and item['cik'] == rule['cik']
                    and item['reason'] == rule['reason'] and all(item[key] is None for key in
                    ('valueUsd','holdingsCount','reportDate','entityId')), 'Pending financial values or changed reason')
        else:
            rule = eligible[item['label']]
            require(item['status'] == 'available' and item['cik'] == rule['cik'] and item['entityId'] == rule['cik']
                    and item['legalName'] == rule['legalName'], 'Available identity changed')
            total = totals.get(item['cik'], {'count':0,'value':0,'legalName':item['legalName'],'period':item['reportDate']})
            require((total['count'],total['value'],total['legalName'],total['period']) ==
                    (item['holdingsCount'],item['valueUsd'],item['legalName'],item['reportDate']), 'Coverage totals differ')
    require(set(totals).issubset({r['cik'] for r in scope['eligible']}), 'Unrequested entity')
    require(sum(r['value'] for r in rows) == manifest['totalEquityValueUsd'] <= stage.MAX_SAFE, 'Aggregate mismatch')

def build_bundle(candidate, source_tree, new_destination, *, inputs_override=None, now=None):
    """Return receipt; receipt is not published inside the public site."""
    candidate = Path(candidate); source_tree = Path(source_tree)
    destination = Path(new_destination).absolute()
    require(destination == destination.resolve() and not destination.exists(), 'New non-symlink output directory required')
    require(destination.parent.is_dir(), 'Output parent must already exist')
    require(not destination.is_relative_to(candidate.resolve()), 'Output must not be inside the retained stage')
    verified = stage.verify_candidate(candidate, inputs_override=inputs_override, require_recent=True, now=now, include_artifacts=True)
    require(verified['activationEligible'] is True, 'Exact partial scope did not pass fresh replay')
    # Consume only the actual raw-source replay, never re-read mutable stored
    # financial files after verification. A later path edit cannot change output.
    artifacts = verified['replayedArtifacts']
    rows, coverage, saved = artifacts['holdings.json'],artifacts['coverage.json'],artifacts['manifest.json']
    evidence_location = (inputs_override or saved['inputs'])['evidenceManifest']
    require(not destination.is_relative_to(Path(evidence_location).resolve().parent), 'Output must not be inside retained evidence')
    policy_raw = regular(stage.SCOPE_PATH).read_bytes(); scope = stage.parse_json(policy_raw)
    require(sha(policy_raw) == saved['scopeSha256'], 'Scope policy changed after replay')
    validate_public(rows,coverage,saved,scope)
    projection = encode_rows(rows)
    require(canonical(decode_rows(projection)) == canonical(rows), 'Lossless row round trip failed')
    public = {k:deepcopy(v) for k,v in saved.items() if k != 'inputs'}
    public['holdingsRowCount'] = len(rows)
    public['evidenceHashes'] = {k:v for k,v in saved['inputs'].items() if k.endswith('Sha256')}
    public['sources'] = []
    active = {x['cik'] for x in scope['eligible']}
    for item in artifacts['history.json']:
        if item['cik'] not in active:
            continue
        require(item['snapshot'] is not None and item['error'] is None, 'Available source history missing')
        # Include all resolved snapshot components, even a component with zero
        # surviving equity rows. Superseded originals remain in private history.
        for filing in item['snapshot']['components']:
            public['sources'].append({'cik':item['cik'],'legalName':item['legalName'],
                'period':filing['period'],'filingDate':filing['filingDate'],
                'accession':filing['accession'],'sourceUrl':filing['tableUrl'],
                'primarySourceUrl':filing['primaryUrl'],'form':filing['form'],
                'amendmentType':filing['amendmentType'],'amendmentNumber':filing['amendmentNumber'],
                'tableSha256':filing['tableSha256'],'primarySha256':filing['primarySha256']})
    public_coverage = {'schemaVersion':1,'contract':CONTRACT,
        'counts':{'originalLabels':50,'availableLabels':43,'availableEntities':42,'pendingLabels':7},
        'labels':[{**deepcopy(item),'status':item['status'].replace('_','-')} for item in coverage]}
    payload = {'projection.json':encoded(projection),'manifest.json':encoded(public),'coverage.json':encoded(public_coverage)}
    require(len(payload['projection.json']) <= MAX_PROJECTION, 'Projection exceeds 16 MiB initial-load budget')
    require(len(payload['manifest.json']) <= 1024**2 and len(payload['coverage.json']) <= 1024**2, 'Metadata exceeds browser budget')
    descriptor = {'schemaVersion':1,'artifactType':'sec_13f_partial_pages_generation','scopeSha256':sha(policy_raw),
                  'files':{name:{'sha256':sha(raw),'bytes':len(raw)} for name,raw in payload.items()}}
    descriptor_raw = encoded(descriptor); generation = sha(descriptor_raw)
    pointer = {'schemaVersion':1,'contract':CONTRACT,'generationId':generation}
    config = {'contract':CONTRACT,'expectedScopeSha256':sha(policy_raw),
              'pointerPath':'sec-data/current.json','policyPath':'sec-data/display-policy.json'}
    prepared_files = {name:regular(source_tree/name).read_bytes() for name in ASSETS}
    prepared_files.update({'sec-display-config.js':('globalThis.SEC_DISPLAY_CONFIG = Object.freeze('+canonical(config)+');\n').encode(),
                          'sec-data/display-policy.json':policy_raw,'sec-data/current.json':encoded(pointer),'.nojekyll':b''})
    prefix = 'sec-data/generations/'+generation+'/'
    prepared_files.update({prefix+name:raw for name,raw in payload.items()}); prepared_files[prefix+'generation.json'] = descriptor_raw
    require(all(len(raw) < MAX_FILE for raw in prepared_files.values()), 'GitHub file-size limit exceeded')
    require(sum(map(len,prepared_files.values())) < MAX_SITE, 'GitHub Pages site-size limit exceeded')
    temporary = Path(tempfile.mkdtemp(prefix='.'+destination.name+'-', dir=destination.parent))
    try:
        for name,raw in prepared_files.items():
            path=temporary/name;path.parent.mkdir(parents=True,exist_ok=True)
            with path.open('xb') as handle:
                handle.write(raw);handle.flush();os.fsync(handle.fileno())
        require(sha(regular(stage.SCOPE_PATH).read_bytes()) == sha(policy_raw), 'Scope changed during build')
        finished = stage.clock(now)
        age = finished - stage.timestamp(public['acquisitionStartedAt'])
        require(timedelta(0) <= age <= timedelta(hours=24), 'Source evidence expired during build')
        require(all(p >= stage.due_period(finished.date()) for p in public['sourceReportDates']), 'Required filing period changed during build')
        require(not destination.exists(), 'Destination appeared during preparation')
        # Same-filesystem rename exposes only a complete local directory. This
        # does not assert CDN atomicity, push commits, or modify any live pointer.
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(temporary,ignore_errors=True)
        raise
    return {'schemaVersion':1,'artifactType':'local_partial_pages_preparation_receipt',
            'generationId':generation,'scopeSha256':sha(policy_raw),'verifiedAt':verified['verifiedAt'],'builtAt':finished.isoformat(),
            'lastChecked':public['lastChecked'],'availableLabels':43,'availableEntities':42,'pendingLabels':7,
            'holdingsRows':len(rows),'totalEquityValueUsd':public['totalEquityValueUsd'],
            'projectionBytes':len(payload['projection.json']),'siteBytes':sum(map(len,prepared_files.values())),
            'files':{name:{'sha256':sha(raw),'bytes':len(raw)} for name,raw in prepared_files.items()},
            'deployed':False,'browserVisualAcceptance':'not_run_previous_launch_denied'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage');parser.add_argument('source_tree');parser.add_argument('new_destination')
    parser.add_argument('--evidence-manifest');parser.add_argument('--identity-ledger');parser.add_argument('--request')
    args=parser.parse_args();overrides=None
    if any((args.evidence_manifest,args.identity_ledger,args.request)):
        parser.error('Use the Python API with all three inputs_override paths for explicitly verified relocated evidence.')
    print(json.dumps(build_bundle(args.stage,args.source_tree,args.new_destination),indent=2))

if __name__ == '__main__':
    main()
