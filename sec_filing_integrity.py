"""Fail-closed SEC 13F reconciliation. No network, price inference, or source mutation.

Byte payloads must be retained by the caller; hashes bind this derived record to
those exact payloads. Tests use invented, clearly labelled synthetic fixtures.
"""
from copy import deepcopy
from datetime import date, datetime
import hashlib
import json
import re
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


class IntegrityError(ValueError):
    pass


def _fail(message):
    raise IntegrityError(message)


def normalize_cik(value):
    text = str(value)
    if not re.fullmatch(r'[0-9]{1,10}', text) or int(text) == 0:
        _fail('Invalid CIK')
    return str(int(text)).zfill(10)


def _xml(payload, root_name):
    if not isinstance(payload, bytes):
        _fail('XML payload must be original bytes')
    # Reject UTF-16/32 rather than allowing encoding to hide declaration tokens.
    if b'\x00' in payload or re.search(br'<!\s*(?:DOCTYPE|ENTITY)', payload, re.I):
        _fail('DTD, entities, and non-UTF8 XML are not permitted')
    try:
        root = ET.fromstring(payload)
    except (ET.ParseError, ValueError) as exc:
        raise IntegrityError('Malformed or extra XML') from exc
    for node in root.iter():
        node.tag = node.tag.rsplit('}', 1)[-1]
    if root.tag != root_name:
        _fail('Unexpected XML root')
    return root


def _node(root, path, required=True):
    current = root
    for part in path.split('/'):
        matches = [n for n in current if n.tag == part]
        if len(matches) > 1:
            _fail('Ambiguous XML tag: ' + path)
        if not matches:
            if required:
                _fail('Missing XML tag: ' + path)
            return None
        current = matches[0]
    return current


def _raw(root, path, required=True):
    node = _node(root, path, required)
    if node is None:
        return None
    if len(node):
        _fail('Unexpected nested content: ' + path)
    return node.text or ''


def _text(root, path, required=True):
    result = _raw(root, path, required)
    if result is None:
        return None
    result = result.strip()
    if required and not result:
        _fail('Empty XML tag: ' + path)
    return result


def _integer(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+', value.strip()):
        _fail('Invalid nonnegative integer: ' + name)
    return int(value.strip())


def _date(value, name):
    if not isinstance(value, str):
        _fail('Missing date: ' + name)
    for pattern, fmt in ((r'\d{4}-\d{2}-\d{2}', '%Y-%m-%d'),
                         (r'\d{2}-\d{2}-\d{4}', '%m-%d-%Y')):
        if re.fullmatch(pattern, value):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                break
    _fail('Invalid date: ' + name)


def _url(value, cik, accession):
    if not isinstance(value, str):
        _fail('Missing SEC source URL')
    parsed = urlsplit(value)
    prefix = '/Archives/edgar/data/' + str(int(cik)) + '/' + accession.replace('-', '') + '/'
    if (parsed.scheme != 'https' or parsed.netloc != 'www.sec.gov' or
            parsed.query or parsed.fragment or not parsed.path.startswith(prefix) or
            not re.fullmatch(r'[A-Za-z0-9_.-]+\.xml', parsed.path[len(prefix):]) or
            '..' in parsed.path[len(prefix):]):
        _fail('Source URL does not bind official SEC CIK/accession XML')
    return value


def _canonical(value):
    return ' '.join((value or '').upper().split())


def reconcile_filing(primary_bytes, table_bytes, expected_metadata, primary_url, table_url):
    expected = deepcopy(expected_metadata)
    primary = _xml(primary_bytes, 'edgarSubmission')
    table = _xml(table_bytes, 'informationTable')
    cik = normalize_cik(_text(primary, 'headerData/filerInfo/filer/credentials/cik'))
    accession = expected.get('accession', expected.get('accessionNumber'))
    if not isinstance(accession, str) or not re.fullmatch(r'\d{10}-\d{2}-\d{6}', accession):
        _fail('Invalid accession')
    if cik != normalize_cik(expected.get('cik')):
        _fail('Primary filer CIK differs from expected CIK')
    form = _text(primary, 'headerData/submissionType')
    if form not in ('13F-HR', '13F-HR/A', '13F-NT', '13F-NT/A') or form != expected.get('form'):
        _fail('Primary form differs from expected form')
    cover = _node(primary, 'formData/coverPage')
    period = _date(_text(cover, 'reportCalendarOrQuarter'), 'cover period')
    header_period = _text(primary, 'headerData/filerInfo/periodOfReport')
    if header_period is not None and _date(header_period, 'header period') != period:
        _fail('Header and cover periods disagree')
    if period != _date(expected.get('reportDate'), 'expected reportDate'):
        _fail('Report date mismatch')
    if (period.month, period.day) not in ((3, 31), (6, 30), (9, 30), (12, 31)):
        _fail('Report date must be a quarter end')
    filing_date = _date(expected.get('filingDate'), 'filingDate')
    if filing_date < period:
        _fail('Filing predates report period')
    # SEC primary XML commonly has no accession/filing date. If present, verify it.
    for tag in ('accessionNumber', 'filingDate'):
        matches = list(primary.iter(tag))
        if len(matches) > 1:
            _fail('Ambiguous primary ' + tag)
        if matches:
            value = (matches[0].text or '').strip()
            if (tag == 'accessionNumber' and value != accession) or (tag == 'filingDate' and _date(value, tag) != filing_date):
                _fail('Primary ' + tag + ' mismatch')
    report_type = _text(cover, 'reportType')
    if report_type not in ('13F HOLDINGS REPORT', '13F NOTICE', '13F COMBINATION REPORT'):
        _fail('Unknown reportType')
    if ('13F-NT' in form) != (report_type == '13F NOTICE'):
        _fail('Notice form/reportType mismatch')
    raw_amendment = _text(cover, 'isAmendment', False)
    amendment = raw_amendment
    if amendment is None and not form.endswith('/A'):
        amendment = 'false'
    if amendment not in ('true', 'false'):
        _fail('Invalid amendment flag')
    amendment = amendment == 'true'
    if amendment != form.endswith('/A'):
        _fail('Amendment flag/form mismatch')
    amendment_info = _node(cover, 'amendmentInfo', False)
    number, kind = 0, None
    if amendment:
        if amendment_info is None:
            _fail('Missing amendment metadata')
        # Current SEC schema puts amendmentNo on coverPage. Accept the
        # nested historical shape only when there is exactly one declaration.
        numbers = [_text(cover, 'amendmentNo', False), _text(amendment_info, 'amendmentNo', False)]
        numbers = [n for n in numbers if n is not None]
        if len(numbers) != 1:
            _fail('Missing or ambiguous amendment number')
        number = _integer(numbers[0], 'amendmentNo')
        kind = _text(amendment_info, 'amendmentType')
        if number < 1 or kind not in ('RESTATEMENT', 'NEW HOLDINGS'):
            _fail('Invalid amendment metadata')
    elif amendment_info is not None or _node(cover, 'amendmentNo', False) is not None:
        _fail('Unexpected amendment metadata')
    primary_url = _url(primary_url, cik, accession)
    table_url = _url(table_url, cik, accession)
    if primary_url == table_url:
        _fail('Primary and information table URLs must differ')
    hashes = {'primarySha256': hashlib.sha256(primary_bytes).hexdigest(),
              'tableSha256': hashlib.sha256(table_bytes).hexdigest()}
    multiplier = 1 if filing_date >= date(2023, 1, 3) else 1000
    summary = _node(primary, 'formData/summaryPage')
    count = _integer(_text(summary, 'tableEntryTotal'), 'tableEntryTotal')
    total = _integer(_text(summary, 'tableValueTotal'), 'tableValueTotal')
    rows = []
    if any(child.tag != 'infoTable' for child in table):
        _fail('Unexpected information-table child')
    for index, source in enumerate(table, 1):
        allowed = {'nameOfIssuer', 'titleOfClass', 'cusip', 'value', 'shrsOrPrnAmt',
                   'putCall', 'investmentDiscretion', 'otherManager', 'votingAuthority', 'figi'}
        if any(child.tag not in allowed for child in source):
            _fail('Unexpected information-row child')
        fields = {'issuer': 'nameOfIssuer', 'titleOfClass': 'titleOfClass', 'cusip': 'cusip',
                  'rawValue': 'value', 'shares': 'shrsOrPrnAmt/sshPrnamt',
                  'shareType': 'shrsOrPrnAmt/sshPrnamtType', 'putCall': 'putCall',
                  'investmentDiscretion': 'investmentDiscretion', 'otherManager': 'otherManager',
                  'Sole': 'votingAuthority/Sole', 'Shared': 'votingAuthority/Shared',
                  'None': 'votingAuthority/None', 'figi': 'figi'}
        raw = {key: _raw(source, path, key not in ('putCall', 'otherManager', 'figi'))
               for key, path in fields.items()}
        share_type = (raw['shareType'] or '').strip()
        option_source = (raw['putCall'] or '').strip()
        if raw['putCall'] is not None and not option_source:
            _fail('Explicit empty option declaration')
        # SEC XML enum spellings are Put/Call; preserve source spelling below.
        option = {'Put': 'PUT', 'Call': 'CALL'}.get(option_source, option_source)
        if share_type not in ('SH', 'PRN') or option not in ('', 'PUT', 'CALL'):
            _fail('Invalid share type or option')
        if not raw['issuer'].strip() or not raw['titleOfClass'].strip() or not re.fullmatch(r'[A-Za-z0-9*@#]{9}', raw['cusip'].strip()):
            _fail('Missing or invalid security identity')
        value = _integer(raw['rawValue'], 'value')
        shares = _integer(raw['shares'], 'shares')
        voting = {key: _integer(raw[key], 'voting ' + key) for key in ('Sole', 'Shared', 'None')}
        if not raw['investmentDiscretion'].strip():
            _fail('Missing discretion')
        row = {key: (raw[key] or '').strip() for key in ('issuer', 'titleOfClass', 'cusip', 'investmentDiscretion', 'otherManager', 'figi')}
        row.update({'shareType': share_type, 'putCall': option, 'shares': shares,
                    'rawValue': raw['rawValue'], 'sourceReportedValue': value,
                    'valueUsd': value * multiplier, 'votingAuthority': voting,
                    'rawSource': raw, 'sourceRow': index,
                    'sourceRowId': accession + ':' + hashes['tableSha256'] + ':' + str(index),
                    'accession': accession, 'primaryUrl': primary_url, 'tableUrl': table_url,
                    'sourceUnits': 'USD' if multiplier == 1 else 'THOUSANDS_USD', **hashes})
        rows.append(row)
    if count != len(rows) or total != sum(r['sourceReportedValue'] for r in rows):
        _fail('Primary summary count/value does not match information table')
    if report_type == '13F NOTICE' and rows:
        _fail('Notice cannot contain holdings')
    disclosures = []
    for node in primary.iter():
        if any(term in node.tag.lower() for term in ('confidential', 'omitted', 'denied', 'expired')):
            disclosures.append({'tag': node.tag, 'text': node.text or '', 'xml': ET.tostring(node, encoding='unicode')})
    result = {'cik': cik, 'accession': accession, 'form': form, 'reportDate': period.isoformat(),
              'filingDate': filing_date.isoformat(), 'acceptanceDateTime': expected.get('acceptanceDateTime'),
              'reportType': report_type, 'isAmendment': amendment, 'sourceIsAmendment': raw_amendment, 'amendmentNumber': number,
              'amendmentType': kind, 'rows': rows, 'sourceUnits': 'USD' if multiplier == 1 else 'THOUSANDS_USD',
              'valueMultiplier': multiplier, 'sourceReportedValue': total, 'valueUsd': total * multiplier,
              'sourceEntryCount': count, 'primaryUrl': primary_url, 'tableUrl': table_url,
              'confidentialDisclosures': disclosures, **hashes}
    if result['acceptanceDateTime'] is not None:
        _acceptance(result)
    result.update({'schemaVersion': 3, 'reconciliationStatus': 'matched', 'period': result['reportDate'],
                   'filerName': _text(cover, 'filingManager/name', False), 'accessionNumber': accession,
                   'reportedValueUSD': result['valueUsd'], 'sourceValueUnit': result['sourceUnits'],
                   'tableEntryTotal': count, 'tableValueTotalRaw': _raw(summary, 'tableValueTotal')})
    for row in rows:
        row.update({'name': row['issuer'], 'securityClass': row['titleOfClass'], 'value': row['valueUsd'],
                    'valueUnit': 'USD', 'sourceValue': row['rawValue'], 'sourceShares': row['rawSource']['shares'],
                    'sourceValueUnit': row['sourceUnits'], 'valueMultiplier': multiplier,
                    'sourceUrl': table_url, 'primarySourceUrl': primary_url, 'cik': cik, 'managerId': cik,
                    'period': result['reportDate'], 'filingDate': result['filingDate'],
                    'accessionNumber': accession, 'isOption': bool(row['putCall'])})
    return result


def validate_share_class_policy(policy):
    if not isinstance(policy,list):
        _fail('Share-class policy must be a list')
    seen=set()
    for rule in policy:
        if not isinstance(rule,dict) or set(rule)!={'cusip','issuer','titleOfClass','classification','evidence'}:
            _fail('Invalid share-class policy shape')
        if not re.fullmatch(r'[A-Za-z0-9*@#]{9}',rule.get('cusip','')) or rule['cusip'] in seen:
            _fail('Duplicate or invalid policy CUSIP')
        seen.add(rule['cusip'])
        if rule['classification']!='fund_share' or not all(isinstance(rule[k],str) and rule[k].strip() for k in ('issuer','titleOfClass')):
            _fail('Unsupported share-class policy')
        if not isinstance(rule['evidence'],list) or not rule['evidence']:
            _fail('Share-class evidence missing')
        for source in rule['evidence']:
            if not isinstance(source,dict) or set(source)!={'url','sha256','title','checkedAt'}:
                _fail('Share-class evidence shape')
            if not isinstance(source['url'],str) or not source['url'].startswith('https://') or not re.fullmatch(r'[a-f0-9]{64}',source['sha256']) or not source['title']:
                _fail('Share-class evidence invalid')
            _acceptance({'acceptanceDateTime':source['checkedAt']})
    return policy


def classify_reported_position(row, share_class_policy=None):
    """Total partition: source flags prevail over reviewed fund-name exceptions."""
    if row.get('shareType')=='PRN':
        return 'principal'
    if row.get('shareType')!='SH':
        return 'unresolved_share_class'
    if row.get('putCall') in ('PUT','CALL'):
        return 'option'
    if row.get('putCall')!='':
        return 'unresolved_share_class'
    if row.get('isOption') is True or row.get('optionType'):
        return 'unresolved_share_class'
    title=_canonical(row.get('titleOfClass',''))
    if re.search(r'\b(?:WARRANTS?|WTS)\b',title):
        return 'warrant'
    for rule in share_class_policy or []:
        raw=row.get('rawSource')
        if (row.get('cusip','').upper()==rule['cusip'].upper()
                and _canonical(row.get('issuer',''))==_canonical(rule['issuer'])
                and _canonical(row.get('name',''))==_canonical(rule['issuer'])
                and title==_canonical(rule['titleOfClass'])
                and isinstance(raw,dict) and 'putCall' in raw and raw['putCall'] is None):
            return 'equity_verified_fund_share'
    if re.search(r'\b(?:WT|OPTIONS?|CALLS?|PUTS?)\b',title):
        return 'unresolved_share_class'
    return 'equity'


def is_reported_equity(row, share_class_policy=None):
    return classify_reported_position(row,share_class_policy).startswith('equity')


def equity_rows(snapshot, share_class_policy=None):
    return deepcopy([row for row in snapshot['rows'] if is_reported_equity(row,share_class_policy)])


def _acceptance(filing):
    raw = filing.get('acceptanceDateTime')
    if not isinstance(raw, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', raw):
        _fail('Missing or invalid SEC acceptanceDateTime')
    try:
        timestamp = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError as exc:
        raise IntegrityError('Invalid SEC acceptanceDateTime') from exc
    # SEC's assigned filing date is independent of the timestamp's UTC date.
    # Preserve both source values; use the qualified timestamp only for order.
    return timestamp


def _financial_key(row):
    return (row['cusip'].upper(), _canonical(row['titleOfClass']), row['shareType'], row['putCall'],
            row['shares'], row['valueUsd'], _canonical(row['investmentDiscretion']),
            _canonical(row['otherManager']), tuple(int(row['votingAuthority'][key]) for key in ('Sole', 'Shared', 'None')))


def resolve_period_snapshot(filings, required_accessions, share_class_policy=None):
    """Resolve a complete, ordered amendment chain without mutating any input."""
    validate_share_class_policy(share_class_policy or [])
    entries = deepcopy(list(filings))
    required = list(required_accessions)
    if not entries or len(required) != len(set(required)):
        _fail('Missing filings or duplicate required accessions')
    accessions = [f['accession'] for f in entries]
    if len(accessions) != len(set(accessions)) or set(accessions) != set(required):
        _fail('Missing, duplicate, or unknown accession in chain')
    if len({(f['cik'], f['reportDate']) for f in entries}) != 1:
        _fail('Mixed filer or report periods')
    if any(f['reportType'] == '13F NOTICE' for f in entries):
        _fail('Notice is not a holdings snapshot')
    for filing in entries:
        if filing.get('acceptanceDateTime') is not None:
            _acceptance(filing)
    has_additions = any(f['amendmentType'] == 'NEW HOLDINGS' for f in entries)
    if not has_additions and any(not f.get('acceptanceDateTime') for f in entries):
        if len({f['filingDate'] for f in entries}) != len(entries):
            _fail('Missing acceptance timestamps for same-day ordering')
        times = [datetime.combine(_date(f['filingDate'], 'filingDate'), datetime.min.time()) for f in entries]
    else:
        times = [_acceptance(f) for f in entries]
    if len({t.tzinfo is None for t in times}) > 1 or len(set(times)) != len(times):
        _fail('Ambiguous acceptance ordering')
    entries = [f for _, f in sorted(zip(times, entries), key=lambda pair: pair[0])]
    if entries[0]['isAmendment'] or any(not f['isAmendment'] for f in entries[1:]):
        _fail('Missing or ambiguous original filing')
    for number, filing in enumerate(entries):
        if filing['amendmentNumber'] != number:
            _fail('Gapped or out-of-order amendment sequence')
        if filing['sourceEntryCount'] != len(filing['rows']) or filing['sourceReportedValue'] != sum(r['sourceReportedValue'] for r in filing['rows']) or filing['valueUsd'] != sum(r['valueUsd'] for r in filing['rows']):
            _fail('Unreconciled component summary')
    start = 0
    seen_addition = False
    for index, filing in enumerate(entries[1:], 1):
        if filing['amendmentType'] == 'NEW HOLDINGS':
            seen_addition = True
        elif filing['amendmentType'] == 'RESTATEMENT':
            if seen_addition:
                _fail('Addition before later restatement is ambiguous')
            start = index
        else:
            _fail('Unknown amendment type')
    components = entries[start:]
    rows, seen = [], set()
    for component in components:
        keys = {_financial_key(row) for row in component['rows']}
        if seen & keys:
            _fail('Repeated financial rows across components')
        seen.update(keys)
        rows.extend(component['rows'])
    identity = [{'accession': f['accession'], 'primarySha256': f['primarySha256'], 'tableSha256': f['tableSha256']} for f in entries]
    result = {key: deepcopy(entries[-1][key]) for key in ('cik', 'reportDate', 'filingDate', 'acceptanceDateTime', 'reportType')}
    result.update({'components': components, 'accessions': [f['accession'] for f in components],
                   'allKnownAccessions': [f['accession'] for f in entries],
                   'snapshotId': hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                   'resolution': 'LATEST_RESTATEMENT_PLUS_ADDITIONS' if start else 'ORIGINAL_PLUS_ADDITIONS',
                   'rows': rows, 'sourceReportedValue': sum(f['sourceReportedValue'] for f in components),
                   'sourceReportedValues': [{'accession': f['accession'], 'value': f['sourceReportedValue'], 'units': f['sourceUnits']} for f in components],
                   'valueUsd': sum(row['valueUsd'] for row in rows)})
    partition={kind:{'rowCount':0,'reportedValueUsd':0} for kind in
               ('equity','equity_verified_fund_share','option','principal','warrant','unresolved_share_class')}
    for row in rows:
        item=partition[classify_reported_position(row,share_class_policy)]
        item['rowCount']+=1;item['reportedValueUsd']+=row['valueUsd']
    if sum(item['rowCount'] for item in partition.values())!=len(rows) or sum(item['reportedValueUsd'] for item in partition.values())!=result['valueUsd']:
        _fail('Position partition did not reconcile')
    result['classificationSummary']=partition
    result['equityValueUsd'] = sum(row['valueUsd'] for row in equity_rows(result,share_class_policy))
    result.update({'schemaVersion': 3, 'reconciliationStatus': 'matched', 'period': result['reportDate'],
                   'componentAccessions': result['accessions'], 'resolutionType': result['resolution'],
                   'reportedValueUSD': result['valueUsd'], 'equityValueUSD': result['equityValueUsd'],
                   'equityRowCount': len(equity_rows(result,share_class_policy)), 'tableEntryTotal': len(rows)})
    return result
