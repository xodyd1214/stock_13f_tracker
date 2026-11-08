"""Reconstructed fail-closed partial display preparation. Never publishes.

The mandatory adjacent scope is a reviewable policy, not an optional override.
Every verification replays immutable raw evidence; historical metadata is not
financial certification. All files below are NEW reconstructions.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from sec_source_acquisition import parse_json, canonical_cik, records, iso_date, official_url, xml_root
from sec_filing_integrity import reconcile_filing, resolve_period_snapshot, equity_rows, validate_share_class_policy

SCOPE_PATH = Path(__file__).with_name('partial_display_scope.json')
ARTIFACTS = ('holdings.json', 'history.json', 'manifest.json', 'coverage.json', 'quarantine.json')
MAX_SAFE = 2**53 - 1

class StageError(ValueError):
    pass

def check(condition, reason):
    if not condition:
        raise StageError(reason)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n').encode()

def timestamp(value):
    check(isinstance(value, str), 'Missing retrieval timestamp')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    check(result.tzinfo is not None, 'Timestamp timezone required')
    return result.astimezone(timezone.utc)

def clock(now=None):
    return timestamp(now) if isinstance(now, str) else (now or datetime.now(timezone.utc)).astimezone(timezone.utc)

def safe_path(root, relative):
    check(isinstance(relative, str) and relative and '\\' not in relative, 'Unsafe local path')
    path = Path(relative)
    check(not path.is_absolute() and all(p not in ('..', '.') for p in relative.split('/')) and '' not in relative.split('/'), 'Unsafe local path')
    target = root / path
    check(target.absolute() == target.resolve() and target.resolve().is_relative_to(root.resolve()), 'Symlink or escaping local path')
    check(target.is_file(), 'Missing raw source: ' + relative)
    return target

def safe_numbers(value):
    if isinstance(value, dict):
        for child in value.values(): safe_numbers(child)
    elif isinstance(value, list):
        for child in value: safe_numbers(child)
    elif type(value) is int:
        check(abs(value) <= MAX_SAFE, 'Unsafe JavaScript integer')
    elif isinstance(value, float):
        raise StageError('Floating-point financial value forbidden')

def due_period(as_of):
    """Required quarter after the SEC 45-day deadline, weekends/February holiday.

    Filing remains timely through the full deadline date. The February federal
    holiday is Washington's Birthday (third Monday), not a guessed fixed date.
    """
    def deadline(period):
        day=period+timedelta(days=45)
        while day.weekday()>=5 or (day.month==2 and day.weekday()==0 and 15<=day.day<=21):
            day+=timedelta(days=1)
        return day
    quarters = [date(y,m,d) for y in (as_of.year-1,as_of.year) for m,d in ((3,31),(6,30),(9,30),(12,31))]
    return max(p for p in quarters if deadline(p)<as_of).isoformat()

def scope_inputs(ledger_path, request_path):
    for path in (Path(ledger_path),Path(request_path),SCOPE_PATH):
        check(path.absolute()==path.resolve() and path.is_file(), 'Input must be a regular non-symlink path')
    scope_raw = SCOPE_PATH.read_bytes(); scope = parse_json(scope_raw)
    validate_share_class_policy(scope.get('equityShareClassOverrides',[]))
    ledger_raw, request_raw = Path(ledger_path).read_bytes(), Path(request_path).read_bytes()
    check(sha(ledger_raw) == scope['ledgerSha256'] and sha(request_raw) == scope['requestSha256'], 'Identity/request policy hash changed')
    ledger, request = parse_json(ledger_raw), parse_json(request_raw)
    labels = [x['original_deployed_label'] for x in ledger['labels']]
    check(labels == scope['originalLabels'] and len(labels) == len(set(labels)) == 50, 'Exact original 50 labels required')
    eligible, pending = scope['eligible'], scope['pending']
    check(len(eligible) == 43 and len({x['cik'] for x in eligible}) == 42 and len(pending) == 7, 'Invalid partial scope counts')
    check({x['label'] for x in eligible}.isdisjoint({x['label'] for x in pending}) and {x['label'] for x in eligible + pending} == set(labels), 'Scope partition changed')
    specs = request['managers']; ids = [canonical_cik(x['cik']) for x in specs]
    check(len(ids) == len(set(ids)) == 45, 'Exact 45 acquisition entities required')
    check(set(ids) == {x['proposed_reporting_cik'] for x in ledger['labels'] if x['selected_for_45_entity_acquisition']}, 'Request entity scope changed')
    by_label = {x['original_deployed_label']: x for x in ledger['labels']}
    for entry in eligible + pending:
        source = by_label[entry['label']]
        check(entry['cik'] == source['proposed_reporting_cik'] and source['fresh_sec_identity_verified'] is True, 'Identity scope mismatch')
    for entry in pending:
        check(entry['reason'] == by_label[entry['label']]['coverage_class'] and entry.get('integrityEvidence') == by_label[entry['label']].get('integrity_blocker'), 'Pending reason/evidence policy mismatch')
    for entry in eligible:
        check(entry['legalName'] == by_label[entry['label']]['proposed_sec_legal_name'], 'Legal-name scope mismatch')
    return scope, sha(scope_raw), ledger, request

class Evidence:
    """Hash every retrieval once globally, including failed-manager sources."""
    def __init__(self, manifest_path, now, share_class_policy=None):
        self.share_class_policy=share_class_policy or []
        check(Path(manifest_path).absolute()==Path(manifest_path).resolve(), 'Manifest must not traverse symlinks')
        self.path = Path(manifest_path).resolve(); self.root = self.path.parent
        self.manifest_raw = self.path.read_bytes(); self.manifest = parse_json(self.manifest_raw)
        check(self.manifest.get('schemaVersion') == 1 and self.manifest.get('requireAcquisitionProvenance') is True, 'Acquisition provenance required')
        self.report_path = safe_path(self.root, self.manifest['acquisitionReportPath'])
        self.report_raw = self.report_path.read_bytes(); self.report = parse_json(self.report_raw)
        self.verify_merge_provenance()
        self.raw, self.meta, self.order = {}, {}, {}; self.archive_bounds = {}
        inodes = set(); self.times = []
        active_paths = {x['path'] for x in self.report['retrievals']}
        all_retrievals = self.report['retrievals'] + self.report.get('unselectedRetrievals',[])
        all_retrievals = sorted(all_retrievals,key=lambda x:(timestamp(x['retrievedAt']),x['path'])) if self.manifest.get('mergeProvenance') else all_retrievals
        for index, item in enumerate(all_retrievals):
            path = item['path']; target = safe_path(self.root, path)
            inode = (target.stat().st_dev, target.stat().st_ino)
            check(path not in self.raw and inode not in inodes, 'Aliased/reused source path')
            inodes.add(inode); raw = target.read_bytes(); official_url(item['sourceUrl'])
            check(item.get('httpStatus') == 200 and type(item.get('bytes')) is int and len(raw) == item['bytes'] and sha(raw) == item['sha256'], 'Raw retrieval byte/hash/status mismatch')
            time = timestamp(item['retrievedAt']); check(time <= now, 'Future retrieval timestamp')
            check(not self.times or time >= self.times[-1], 'Retrieval chronology inconsistent')
            self.times.append(time); self.raw[path] = raw
            if path in active_paths:
                self.meta[path] = item; self.order[path] = index
        check(bool(self.times), 'Missing raw retrievals')
        check(now - min(self.times) <= timedelta(hours=24), 'Acquisition older than 24 hours')
    def verify_merge_provenance(self):
        provenance = self.manifest.get('mergeProvenance')
        if provenance is None:
            check(not self.report.get('unselectedRetrievals'), 'Unselected raw history requires merge provenance')
            return
        check(provenance==self.report.get('mergeProvenance'), 'Merge provenance differs between manifest/report')
        check(provenance.get('unselectedRetrievalsAreNotActiveConsistencyEvidence') is True, 'Invalid unselected evidence policy')
        request=safe_path(self.root,'request.json').read_bytes()
        check(sha(request)==provenance['requestSha256'], 'Merged request hash differs')
        selected=provenance['selectedRunByCik']; sources=provenance['sources']
        check(set(selected)=={m['cik'] for m in self.manifest['managers']}, 'Merge selected manager scope differs')
        check(len({x['runId'] for x in sources})==len(sources) and len({x['prefix'] for x in sources})==len(sources), 'Duplicate merge source run')
        active=[];unselected=[];expected_managers={};source_paths=set()
        def prefixed(value,prefix):
            if isinstance(value,list):return [prefixed(v,prefix) for v in value]
            if isinstance(value,dict):return {k:(prefix+'/'+v if (k=='path' or k.endswith('Path')) and isinstance(v,str) else prefixed(v,prefix)) for k,v in value.items()}
            return value
        for source in sources:
            run=source['runId'];prefix=source['prefix']
            check(isinstance(prefix,str) and re.fullmatch(r'runs/run-[0-9]+',prefix), 'Unsafe merge source prefix')
            raw=[]
            for key,hashkey in (('manifestPath','manifestSha256'),('reportPath','reportSha256')):
                check(source[key].startswith(prefix+'/') and source[key] not in source_paths, 'Aliased merge source metadata path')
                source_paths.add(source[key]);data=safe_path(self.root,source[key]).read_bytes()
                check(sha(data)==source[hashkey], 'Merge source metadata hash differs')
                raw.append(parse_json(data))
            original_manifest,original_report=raw
            check(not original_manifest.get('mergeProvenance') and not original_report.get('unselectedRetrievals'), 'Nested merge sources unsupported')
            for item in original_report['retrievals']:
                transformed={**item,'path':prefix+'/'+item['path']}
                owner=item['path'].split('/')[0]
                check(owner in selected, 'Unknown raw source owner')
                (active if selected[owner]==run else unselected).append(transformed)
            for manager in original_manifest['managers']:
                cik=manager['cik']
                if selected.get(cik)==run:
                    check(cik not in expected_managers, 'Duplicate selected manager')
                    expected_managers[cik]=prefixed(manager,prefix)
        order=lambda item:(timestamp(item['retrievedAt']),item['path'])
        check(sorted(active,key=order)==self.report['retrievals'] and sorted(unselected,key=order)==self.report.get('unselectedRetrievals',[]), 'Merged raw history partition differs')
        check(expected_managers=={m['cik']:m for m in self.manifest['managers']}, 'Selected manager differs from original source manifest')

    def get(self, path, url):
        check(path in self.raw and self.meta[path]['sourceUrl'] == url, 'Source missing from exact acquisition ledger')
        return self.raw[path]
    def diagnostics(self, manager):
        observations = []
        for accession, source in manager.get('filings', {}).items():
            item = {'accession':accession,'certified':False}
            try:
                primary = self.get(source['primaryPath'],source['primarySourceUrl']); table = self.get(source['tablePath'],source['tableSourceUrl'])
                xml_root(primary); xml_root(table)
                p, t = ET.fromstring(primary), ET.fromstring(table)
                for root in (p,t):
                    for node in root.iter(): node.tag = node.tag.rsplit('}',1)[-1]
                values = [n.text or '' for n in t.iter('value')]
                item.update(primarySha256=sha(primary),tableSha256=sha(table),coverValueRaw=[n.text for n in p.iter('tableValueTotal')],coverCountRaw=[n.text for n in p.iter('tableEntryTotal')],tableEntryCount=len(list(t.iter('infoTable'))),tableValuesRaw=values)
                if all(re.fullmatch(r'[0-9]+',v.strip()) for v in values):
                    item['tableSumRaw'] = sum(int(v) for v in values)
                    cover = item['coverValueRaw']
                    if len(cover)==1 and re.fullmatch(r'[0-9]+',(cover[0] or '').strip()): item['tableMinusCoverRaw'] = item['tableSumRaw']-int(cover[0])
            except (ValueError,KeyError,TypeError,ET.ParseError) as error: item['error']=str(error)
            observations.append(item)
        return observations

    def manager(self, manager, spec, *, comparison_periods=None):
        cik = canonical_cik(spec['cik']); root_url = f'https://data.sec.gov/submissions/CIK{cik}.json'
        check('acquisitionError' not in manager, manager.get('acquisitionError', 'Acquisition failure'))
        check(manager['cik'] == cik and manager['label'] == spec['label'], 'Manager/request identity mismatch')
        root_path = manager['submissionsPath']; sub = parse_json(self.get(root_path, root_url))
        check(canonical_cik(sub.get('cik')) == cik and sub.get('name') == spec['label'], 'Exact submissions CIK/name mismatch')
        check(manager['submissionsSourceUrl'] == root_url, 'Submissions URL mismatch')
        sections = sub['filings']; all_rows = records(sections['recent']); originals = [(root_path, root_url)]
        listed = sections['files']; check(isinstance(listed, list), 'Archive list missing')
        names = [x['name'] for x in listed]
        check(len(names) == len(set(names)) and set(names) == set(manager['archives']), 'All listed archives required')
        for item in listed:
            name = item['name']; check(re.fullmatch(rf'CIK{cik}-submissions-\d+\.json', name), 'Invalid archive name')
            source = manager['archives'][name]; url = f'https://data.sec.gov/submissions/{name}'
            check(source['sourceUrl'] == url, 'Archive URL mismatch')
            columns = parse_json(self.get(source['path'], url)); rows = records(columns)
            count = len(columns['form'])
            check(all(isinstance(v,list) and len(v)==count for v in columns.values()), 'Archive column lengths differ')
            check(len(set(columns['accessionNumber']))==count, 'Duplicate accession within archive')
            check(all(isinstance(a,str) and re.fullmatch(r'\d{10}-\d{2}-\d{6}',a) for a in columns['accessionNumber']), 'Invalid archive accession')
            check(type(item['filingCount']) is int and item['filingCount'] > 0 and len(columns['form']) == item['filingCount'], 'Archive filing count mismatch')
            dates = [iso_date(x) for x in columns['filingDate']]
            lower,upper=iso_date(item['filingFrom']),iso_date(item['filingTo'])
            self.archive_bounds.setdefault(cik,[]).append({'archive':name,'descriptorFilingFrom':lower.isoformat(),'descriptorFilingTo':upper.isoformat(),'observedFilingFrom':min(dates).isoformat(),'observedFilingTo':max(dates).isoformat(),'filingCount':count})
            check(lower<=upper and all(lower<=d<=upper for d in dates), 'Archive date outside inclusive descriptor bounds')
            all_rows += rows; originals.append((source['path'], url))
        merged = {}
        for row in all_rows:
            key = row['accessionNumber']
            check(key not in merged or row == merged[key], 'Conflicting submission metadata')
            merged[key] = row
        check(bool(merged), 'No known 13F filings')
        periods = [max(r['reportDate'] for r in merged.values())] if comparison_periods is None else comparison_periods
        if comparison_periods is None:
            check(spec.get('latestPeriods') == 1 and 'reportPeriods' not in spec and manager['reportPeriods'] == periods, 'Latest period required including notices')
        else:
            check(spec.get('reportPeriods') == manager['reportPeriods'] == periods, 'Explicit comparison periods required')
        selected = [r for r in merged.values() if r['reportDate'] in periods]
        check(not any(r['form'].startswith('13F-NT') for r in selected), 'Period notice: reporting manager review required')
        required = {r['accessionNumber'] for r in selected}
        check(set(manager['filings']) == required, 'Every known accession for latest period required')
        used = [path for path, _ in originals]; results = []; raw_filings = []
        for row in sorted(selected, key=lambda r: r['accessionNumber']):
            accession = row['accessionNumber']; source = manager['filings'][accession]
            base = f'https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace("-", "")}/'
            indexes = [p for p, m in self.meta.items() if m['sourceUrl'] == base + 'index.json']
            check(len(indexes) == 1, 'Unique accession index required')
            index = parse_json(self.get(indexes[0], base + 'index.json')); used += indexes
            items = index['directory']['item']; xml_names = []
            for item in items:
                name = item['name']; check(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name) and name not in ('.','..'), 'Unsafe accession filename')
                if name.lower().endswith('.xml'): xml_names.append(name)
            check(len(xml_names) == len(set(xml_names)) <= 50, 'Duplicate/excessive XML files')
            kinds = {'edgarSubmission': [], 'informationTable': []}
            for name in xml_names:
                matches = [p for p,m in self.meta.items() if m['sourceUrl'] == base + name]
                check(len(matches) == 1, 'Every indexed XML requires unique raw retrieval')
                path = matches[0]; raw = self.get(path, base + name); used.append(path)
                kind = xml_root(raw)
                if kind in kinds: kinds[kind].append(path)
            check(kinds['edgarSubmission'] == [source['primaryPath']] and kinds['informationTable'] == [source['tablePath']], 'Primary/table identity ambiguous')
            raw_filings.append((self.get(source['primaryPath'], source['primarySourceUrl']), self.get(source['tablePath'], source['tableSourceUrl']), {'cik':cik, **row}, source['primarySourceUrl'], source['tableSourceUrl']))
        # Require final distinct byte-identical copies, after every financial fetch,
        # with root last. A metadata assertion alone is never sufficient.
        final_orders = []
        for original, url in originals:
            matches = [p for p,m in self.meta.items() if m['sourceUrl'] == url and p != original]
            check(len(matches) == 1, 'Distinct final submissions/archive copy required')
            final = matches[0]
            check(self.get(final,url) == self.raw[original], 'Submissions changed during acquisition')
            check(self.order[final] > max(self.order[p] for p in used), 'Final metadata copy precedes financial acquisition')
            final_orders.append(self.order[final])
        check(final_orders[0] == max(final_orders), 'Final root must be last')
        results = [reconcile_filing(*args) for args in raw_filings]
        if comparison_periods is not None:
            snapshots = {}
            for period in periods:
                rows = [filing for filing in results if filing['reportDate'] == period]
                snapshots[period] = resolve_period_snapshot(rows, [filing['accession'] for filing in rows], self.share_class_policy)
            return snapshots
        return resolve_period_snapshot(results, sorted(required), self.share_class_policy), results

def build_candidate(evidence_manifest, ledger_path, request_path, *, as_of=None, now=None):
    now = clock(now); as_of = iso_date(as_of) if isinstance(as_of,str) else (as_of or now.date())
    check(as_of == now.date(), 'New preparation as_of must equal current date')
    scope, scope_hash, ledger, request = scope_inputs(ledger_path, request_path)
    share_class_policy=scope.get('equityShareClassOverrides',[])
    check(all(timestamp(source['checkedAt'])<=now for rule in share_class_policy for source in rule['evidence']), 'Future share-class evidence')
    evidence = Evidence(evidence_manifest, now, share_class_policy)
    if evidence.manifest.get('mergeProvenance'):
        check(evidence.manifest['mergeProvenance']['requestSha256']==scope['requestSha256'], 'Merged request differs from scope')
    specs = request['managers']; managers = evidence.manifest['managers']
    ids = [m['cik'] for m in managers]; requested = {s['cik'] for s in specs}
    check(evidence.report.get('schemaVersion') == 1, 'Unsupported acquisition report schema')
    failures = evidence.report.get('failures')
    check(isinstance(failures,list), 'Acquisition failure ledger missing')
    failed_ids = {m['cik'] for m in managers if 'acquisitionError' in m}
    check(len(failures)==len(failed_ids) and {f['cik'] for f in failures}==failed_ids, 'Acquisition failure ledger mismatch')
    check(evidence.report.get('requestedManagerCount')==len(specs) and evidence.report.get('completedManagerCount')==len(specs)-len(failed_ids), 'Acquisition counts mismatch')
    check(evidence.report.get('complete') is (not failed_ids) and evidence.manifest.get('acquisitionComplete') is (not failed_ids), 'Acquisition completeness mismatch')
    check(len(ids) == len(set(ids)) and set(ids) == requested, 'Missing/extra acquisition managers')
    by_cik = {m['cik']:m for m in managers}; snapshots = {}; history = []; errors = {}
    for spec in specs:
        cik = spec['cik']; manager = by_cik[cik]
        item = {'cik':cik, 'legalName':spec['label'], 'rawEvidence':deepcopy(manager), 'rawObservations':evidence.diagnostics(manager), 'filings':None, 'snapshot':None, 'error':None}
        try:
            snapshot, filings = evidence.manager(manager, spec)
            item['filings'] = filings; item['snapshot'] = snapshot
            check(snapshot['classificationSummary']['unresolved_share_class']['rowCount']==0, 'Unresolved share class requires explicit review')
            check(snapshot['reportDate'] >= due_period(as_of), 'Latest filing period older than standard 45-day due period')
            safe_numbers(snapshot); snapshots[cik] = snapshot
        except (ValueError,KeyError,TypeError,OSError) as error:
            errors[cik] = str(error); item['error'] = str(error)
        item['archiveBounds'] = evidence.archive_bounds.get(cik,[])
        history.append(item)
    pending = {x['label']:x for x in scope['pending']}; eligible = {x['label']:x for x in scope['eligible']}
    coverage = []; quarantine = []; holdings = []; emitted = set()
    for label in scope['originalLabels']:
        entry = pending.get(label) or eligible[label]; cik = entry['cik']; snapshot = snapshots.get(cik)
        reason = entry.get('reason') if label in pending else errors.get(cik)
        available = label not in pending and snapshot is not None and reason is None
        legal_name = next(x['proposed_sec_legal_name'] for x in ledger['labels'] if x['original_deployed_label']==label)
        coverage.append({'label':label,'legalName':legal_name,'cik':cik,'status':'available' if available else 'verification_pending','reason':reason,'reportDate':snapshot['reportDate'] if available else None,'valueUsd':snapshot['equityValueUsd'] if available else None,'holdingsCount':len(equity_rows(snapshot,share_class_policy)) if available else None,'identityVerified':True,'entityId':cik if available else None,'sourceFilingDate':snapshot['filingDate'] if available else None,'sourceAccessions':snapshot['allKnownAccessions'] if available else None,'sourceLinks':[{'accession':c['accession'],'filingDate':c['filingDate'],'primaryUrl':c['primaryUrl'],'tableUrl':c['tableUrl']} for c in snapshot['components']] if available else None})
        if not available:
            quarantine.append({'label':label,'cik':cik,'reason':reason or 'Fresh replay unavailable','replayError':errors.get(cik),'priorIntegrityEvidence':entry.get('integrityEvidence'),'currentReplay':deepcopy(snapshot),'currentRawObservations':next((x['rawObservations'] for x in history if x['cik']==cik),None),'automaticUnblock':False})
        elif cik not in emitted:
            emitted.add(cik)
            compact = [{k:c[k] for k in ('accession','filingDate','form','amendmentNumber','amendmentType','primarySha256','tableSha256')} for c in snapshot['components']]
            disclosures = [d for c in snapshot['components'] for d in c.get('confidentialDisclosures',[])]
            confidential = any((d.get('text') or '').strip().lower() not in ('','false','0','no') for d in disclosures)
            for row in equity_rows(snapshot,share_class_policy):
                holdings.append({**row,'schemaVersion':3,'provenance':'source_reconciled','verificationStatus':'source_reconciled','identityStatus':'verified','managerIdentityStatus':'verified','snapshotFilingDate':snapshot['filingDate'],'amendmentResolution':snapshot['resolution'],'sourceAccessions':snapshot['allKnownAccessions'],'snapshotComponents':deepcopy(compact),'reportScope':'reported_equity_only','confidentialWarning':'Confidential or omitted holdings disclosures may limit completeness.' if confidential else None,'guru':entry['legalName'],'fund':entry['legalName'],'legalName':entry['legalName'],'originalLabels':[x['label'] for x in scope['eligible'] if x['cik']==cik],'action':'UNKNOWN','snapshotId':snapshot['snapshotId']})
    available = [x for x in coverage if x['status']=='available']
    partial = len(available)==43 and len(emitted)==42 and {x['label'] for x in available}==set(eligible)
    manifest = {'schemaVersion':3,'contract':scope['contract'],'partialDisplayEligible':partial,'releaseEligible':False,'migrationReady':False,'originalLabelCount':50,'availableLabelCount':len(available),'availableEntityCount':len(emitted),'pendingLabelCount':50-len(available),'scopeSha256':scope_hash,'asOf':as_of.isoformat(),'preparedAt':now.isoformat(),'lastChecked':max(evidence.times).isoformat(),'acquisitionStartedAt':min(evidence.times).isoformat(),'freshnessLabel':'Checked at '+max(evidence.times).isoformat()+'; historical filing periods, partial coverage','sourceReportDates':sorted({x['reportDate'] for x in available}),'totalEquityValueUsd':sum(snapshots[c]['equityValueUsd'] for c in emitted),'inputs':{'evidenceManifest':str(Path(evidence_manifest).resolve()),'evidenceManifestSha256':sha(evidence.manifest_raw),'acquisitionReportSha256':sha(evidence.report_raw),'ledgerPath':str(Path(ledger_path).resolve()),'ledgerSha256':scope['ledgerSha256'],'requestPath':str(Path(request_path).resolve()),'requestSha256':scope['requestSha256']}}
    manifest['positionClassificationScope']='available_reporting_entities'
    manifest['positionClassification']={kind:{'rowCount':sum(snapshots[c]['classificationSummary'][kind]['rowCount'] for c in emitted),'reportedValueUsd':sum(snapshots[c]['classificationSummary'][kind]['reportedValueUsd'] for c in emitted)} for kind in ('equity','equity_verified_fund_share','option','principal','warrant','unresolved_share_class')}
    check(sum(x['rowCount'] for x in manifest['positionClassification'].values())==sum(len(snapshots[c]['rows']) for c in emitted),'Aggregate position count partition differs')
    check(sum(x['reportedValueUsd'] for x in manifest['positionClassification'].values())==sum(snapshots[c]['valueUsd'] for c in emitted),'Aggregate position value partition differs')
    output = dict(zip(ARTIFACTS,(holdings,history,manifest,coverage,quarantine))); safe_numbers(output)
    return output

def stage_candidate(evidence_manifest, ledger_path, request_path, new_destination, *, as_of=None, now=None):
    destination = Path(new_destination)
    check(destination.absolute()==destination.resolve() and not destination.exists(), 'New non-symlink destination required')
    result = build_candidate(evidence_manifest,ledger_path,request_path,as_of=as_of,now=now)
    destination.mkdir(parents=False,exist_ok=False)
    for name, value in result.items():
        with (destination/name).open('xb') as handle: handle.write(encoded(value))
    return result['manifest.json']

def verify_candidate(stage, *, inputs_override=None, require_recent=True, now=None, include_artifacts=False):
    check(Path(stage).absolute()==Path(stage).resolve(), 'Stage must not traverse symlinks')
    root = Path(stage).resolve(); manifest = parse_json(safe_path(root,'manifest.json').read_bytes()); current = clock(now)
    check(set(p.name for p in root.iterdir())==set(ARTIFACTS), 'Unexpected/missing stage artifacts')
    inputs = manifest['inputs']; locations = {key:inputs[key] for key in ('evidenceManifest','ledgerPath','requestPath')}
    if inputs_override is not None:
        check(isinstance(inputs_override,dict) and set(inputs_override)==set(locations), 'Relocation requires exactly three explicit input paths')
        locations.update(inputs_override)
    check(sha(SCOPE_PATH.read_bytes())==manifest['scopeSha256'], 'Saved scope policy hash differs')
    for key,hash_key in (('evidenceManifest','evidenceManifestSha256'),('ledgerPath','ledgerSha256'),('requestPath','requestSha256')):
        target=Path(locations[key])
        check(target.absolute()==target.resolve() and target.is_file(), 'Relocated input must be a regular non-symlink file')
        check(sha(target.read_bytes())==inputs[hash_key], 'Saved input hash differs: '+key)
    replay = build_candidate(locations['evidenceManifest'],locations['ledgerPath'],locations['requestPath'],as_of=manifest['asOf'],now=manifest['preparedAt'])
    # Locations are the only normalized fields. Raw/source/scope hashes and all
    # financial, status, provenance, and freshness fields still compare exactly.
    for key in locations:
        replay['manifest.json']['inputs'][key] = inputs[key]
    for name,value in replay.items():
        check(safe_path(root,name).read_bytes()==encoded(value), 'Deterministic replay differs: '+name)
    age = current-timestamp(manifest['acquisitionStartedAt']); check(age>=timedelta(0), 'Verification before acquisition')
    stale = age>timedelta(hours=24)
    current_period = all(p >= due_period(current.date()) for p in manifest['sourceReportDates'])
    if require_recent:
        check(not stale, 'Recent activation requires acquisition within 24 hours')
        check(current_period, 'Current standard 45-day due period not satisfied')
    result = {**manifest,'verifiedAt':current.isoformat(),'stale':stale or not current_period,'displayMode':'dated_historical_partial' if stale or not current_period else 'recent_partial','activationEligible':manifest['partialDisplayEligible'] and not stale and current_period,'freshnessLabel':('Stale; ' if stale or not current_period else '')+manifest['freshnessLabel']}

    if include_artifacts:
        result['replayedArtifacts'] = replay
    return result
