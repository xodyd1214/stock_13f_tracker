"""Reconstructed read-only SEC acquisition, independently tested; not recovered code.

Explicit user-agent and NEW destination required. No production/default paths,
credentials, cookies, publication or automated identity substitutions. Standard
urllib honors environment proxies and TLS verification. Redirects and security
denials stop the entire client. Successful evidence preserves exact raw bytes.

CLI: python sec_source_acquisition.py REQUEST.json NEW_DIRECTORY --user-agent APP
"""
import argparse
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import http.client
import json
from pathlib import Path
import re
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


class AcquisitionError(ValueError):
    pass


class AccessDenied(AcquisitionError):
    pass


class BodyLimit(AcquisitionError):
    def __init__(self, consumed):
        super().__init__('Response reached byte limit without proven completeness')
        self.consumed = consumed


def canonical_cik(value):
    if isinstance(value,bool) or not re.fullmatch(r'[0-9]{1,10}',str(value)) or int(value)==0:
        raise AcquisitionError('Invalid CIK')
    return str(int(value)).zfill(10)


def iso_date(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):
        raise AcquisitionError('Invalid SEC date')
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise AcquisitionError('Invalid SEC date') from error


def parse_json(raw):
    def pairs(items):
        result = {}
        for key,value in items:
            if key in result:
                raise AcquisitionError('Duplicate JSON key')
            result[key] = value
        return result
    def constant(_):
        raise AcquisitionError('Nonfinite JSON value')
    try:
        return json.loads(raw,object_pairs_hook=pairs,parse_constant=constant)
    except (ValueError,UnicodeError) as error:
        raise AcquisitionError('Malformed SEC JSON') from error


def official_url(url):
    if not isinstance(url,str):
        raise AcquisitionError('Invalid SEC URL')
    parts = urlsplit(url)
    if (parts.scheme!='https' or parts.netloc not in {'data.sec.gov','www.sec.gov'}
            or parts.query or parts.fragment or '%' in parts.path or '\\' in parts.path):
        raise AcquisitionError('Unexpected SEC URL')
    pattern = (r'/submissions/CIK\d{10}(?:-submissions-\d+)?\.json' if parts.netloc=='data.sec.gov'
               else r'/Archives/edgar/data/[1-9]\d*/\d{18}/[A-Za-z0-9_.-]+')
    if not re.fullmatch(pattern,parts.path) or any(s in {'.','..'} for s in parts.path.split('/')):
        raise AcquisitionError('Unexpected SEC URL path')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise AccessDenied('Unexpected redirect; no redirect followed')


class HTTPTransport:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self,url,headers,timeout,limit):
        request = urllib.request.Request(url,headers=headers,method='GET')
        try:
            response = self.opener.open(request,timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status in (401,403) or 300<=response.status<400:
                raise AccessDenied(f'SEC HTTP {response.status}; stopped')
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdigit() or int(length)>limit):
                raise AcquisitionError('Response Content-Length exceeds byte allowance or is malformed')
            raw = response.read(limit)
            if length is not None and len(raw)!=int(length):
                raise http.client.IncompleteRead(raw,int(length)-len(raw))
            if length is None and len(raw)==limit:
                raise BodyLimit(len(raw))
            return response.status,dict(response.headers),raw,response.geturl()


class Client:
    def __init__(self,user_agent,*,transport=None,sleep=time.sleep,monotonic=time.monotonic,
                 max_bytes=32*1024*1024,max_total_bytes=512*1024*1024,retries=3,interval=.25):
        if (not isinstance(user_agent,str) or not user_agent.strip()
                or any(ord(c)<32 or ord(c)>126 for c in user_agent)):
            raise AcquisitionError('Explicit printable identifying User-Agent required')
        if (type(max_bytes)is not int or type(max_total_bytes)is not int or max_bytes<=0
                or max_total_bytes<max_bytes or type(retries)is not int or not 0<=retries<=5
                or not isinstance(interval,(int,float)) or not .25<=interval<=60):
            raise AcquisitionError('Invalid client limits')
        self.transport=transport or HTTPTransport()
        self.sleep,self.monotonic=sleep,monotonic
        self.headers={'User-Agent':user_agent,'Accept-Encoding':'identity','Accept':'application/json, application/xml, text/xml'}
        self.max_bytes,self.max_total_bytes,self.retries,self.interval=max_bytes,max_total_bytes,retries,interval
        self.total=0;self.last=None;self.stopped=False;self.retry_blocked=False;self.budget_exhausted=False

    def charge(self,count):
        self.total+=count
        self.budget_exhausted=self.total>=self.max_total_bytes

    def get(self,url):
        official_url(url)
        if self.stopped:
            raise AccessDenied('Client stopped after security denial')
        if self.retry_blocked:
            raise AcquisitionError('Client stopped with unserved Retry-After')
        for attempt in range(self.retries+1):
            remaining=self.max_total_bytes-self.total
            if self.budget_exhausted or remaining<=0:
                raise AcquisitionError('Total byte budget exhausted')
            limit=min(self.max_bytes,remaining)
            if self.last is not None:
                self.sleep(max(0,self.interval-(self.monotonic()-self.last)))
            self.last=self.monotonic()
            try:
                status,headers,raw,final_url=self.transport(url,self.headers,30,limit)
                if final_url!=url or status in (401,403) or 300<=status<400:
                    raise AccessDenied('Security denial or unexpected redirect; stopped')
                if not isinstance(raw,bytes):
                    raise AcquisitionError('Transport body must be bytes')
                self.charge(len(raw))
                if len(raw)>limit:
                    raise AcquisitionError('Response exceeded byte allowance')
                lowered=raw[:16384].lower()
                if any(m in lowered for m in (b'undeclared automated tool',b'request rate threshold exceeded',b'access denied',b'blocked due to')):
                    raise AccessDenied('SEC security denial body; stopped')
                header={k.lower():v for k,v in headers.items()}
                if status==429 or 500<=status<=599:
                    retry_after=header.get('retry-after')
                    delay=2**attempt
                    if retry_after:
                        try:
                            if str(retry_after).isdigit():seconds=int(retry_after)
                            else:
                                target=parsedate_to_datetime(str(retry_after))
                                if target.tzinfo is None:raise ValueError('Timezone required')
                                seconds=max(0,(target-datetime.now(timezone.utc)).total_seconds())
                            delay=max(delay,seconds)
                        except (ValueError,TypeError,OverflowError) as error:
                            self.retry_blocked=True
                            raise AcquisitionError('Invalid Retry-After; refusing early retry') from error
                    if delay>60:
                        self.retry_blocked=True
                        raise AcquisitionError('Retry-After exceeds bounded wait; stopped rather than retry early')
                    if attempt==self.retries:
                        self.retry_blocked=bool(retry_after)
                        raise AcquisitionError(f'HTTP {status}; retry limit reached')
                    self.sleep(delay);continue
                if status!=200:raise AcquisitionError(f'SEC HTTP {status}')
                if header.get('content-encoding','identity').lower() not in ('','identity'):
                    raise AcquisitionError('Unexpected encoded response')
                return raw,{'sourceUrl':url,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),
                    'retrievedAt':datetime.now(timezone.utc).isoformat(),'httpStatus':200,'attempts':attempt+1,
                    'responseHeaders':{k:v for k,v in headers.items() if k.lower() in {'date','etag','last-modified','content-type'}}}
            except AccessDenied:
                self.stopped=True;raise
            except BodyLimit as error:
                self.charge(error.consumed);raise
            except (http.client.HTTPException,urllib.error.URLError,OSError) as error:
                self.charge(len(error.partial) if isinstance(error,http.client.IncompleteRead) else limit)
                reason=getattr(error,'reason',error)
                if isinstance(reason,ssl.SSLError) or re.search(r'(?i)(\b403\b|\b401\b|forbidden|access denied|certificate verify|policy.{0,20}denied)',str(reason)):
                    self.stopped=True
                    raise AccessDenied(f'Network security denial; stopped: {reason}') from error
                if attempt==self.retries:
                    raise AcquisitionError(f'Network retry limit: {type(error).__name__}: {reason}') from error
                self.sleep(2**attempt)
        raise AcquisitionError('Acquisition failed')


def records(columns):
    required=('form','reportDate','filingDate','accessionNumber')
    if not isinstance(columns,dict) or any(not isinstance(columns.get(k),list) for k in required):
        raise AcquisitionError('Malformed submissions columns')
    lengths={len(columns[k]) for k in required}
    if len(lengths)!=1:raise AcquisitionError('Submissions column lengths differ')
    count=len(columns['form'])
    if any(not isinstance(value,list) or len(value)!=count for value in columns.values()):
        raise AcquisitionError('Submissions column lengths differ')
    accessions=columns['accessionNumber']
    if any(not isinstance(value,str) or not re.fullmatch(r'\d{10}-\d{2}-\d{6}',value) for value in accessions):
        raise AcquisitionError('Invalid accession number')
    if len(set(accessions))!=count:
        raise AcquisitionError('Duplicate accession within submissions page')
    result=[]
    for i,form in enumerate(columns['form']):
        if form not in ('13F-HR','13F-HR/A','13F-NT','13F-NT/A'):continue
        row={k:columns[k][i] for k in required}
        for key in ('acceptanceDateTime',):
            if key in columns:row[key]=columns[key][i]
        period,filing=iso_date(row['reportDate']),iso_date(row['filingDate'])
        if period>filing or filing>datetime.now(timezone.utc).date():
            raise AcquisitionError('Future or inconsistent filing/report date')
        if not isinstance(row['accessionNumber'],str) or not re.fullmatch(r'\d{10}-\d{2}-\d{6}',row['accessionNumber']):
            raise AcquisitionError('Invalid accession number')
        result.append(row)
    return result


def xml_root(raw):
    try:decoded=raw.decode('utf-8-sig')
    except UnicodeError as error:raise AcquisitionError('Unsupported XML encoding') from error
    if '\x00' in decoded or re.search(r'<!\s*(DOCTYPE|ENTITY)',decoded,re.I):
        raise AcquisitionError('Unsafe XML declaration')
    try:return ET.fromstring(decoded).tag.rsplit('}',1)[-1]
    except ET.ParseError as error:raise AcquisitionError('Malformed XML document') from error


def save(root,path,raw):
    target=root/path;target.parent.mkdir(parents=True,exist_ok=True)
    with target.open('xb') as handle:handle.write(raw)


def acquire_manager(spec,root,client,retrievals):
    cik=canonical_cik(spec.get('cik'));url=f'https://data.sec.gov/submissions/CIK{cik}.json';snapshots={}
    def fetch(source,path,snapshot=False):
        raw,meta=client.get(source);save(root,path,raw);retrievals.append({'path':path,**meta})
        if snapshot:snapshots[source]=raw
        return raw
    path=f'{cik}/submissions.json';sub=parse_json(fetch(url,path,True))
    if not isinstance(sub,dict) or canonical_cik(sub.get('cik'))!=cik:raise AcquisitionError('Submissions CIK mismatch')
    name=sub.get('name')
    if not isinstance(name,str) or not name.strip():raise AcquisitionError('Missing SEC legal name')
    if spec.get('label',name)!=name:raise AcquisitionError('Requested label differs from exact SEC legal name')
    sections=sub.get('filings')
    if not isinstance(sections,dict) or not isinstance(sections.get('files'),list) or len(sections['files'])>1000:
        raise AcquisitionError('Malformed/excessive archive listing')
    all_rows=records(sections.get('recent'))
    result={'cik':cik,'label':name,'submissionsPath':path,'submissionsSourceUrl':url,'archives':{},'filings':{}}
    for item in sections['files']:
        archive=item.get('name') if isinstance(item,dict) else None
        if not isinstance(archive,str) or not re.fullmatch(rf'CIK{cik}-submissions-\d+\.json',archive):
            raise AcquisitionError('Unsafe archive name')
        if archive in result['archives']:raise AcquisitionError('Duplicate archive name')
        archive_url=f'https://data.sec.gov/submissions/{archive}';archive_path=f'{cik}/{archive}'
        columns=parse_json(fetch(archive_url,archive_path,True));rows=records(columns)
        if type(item.get('filingCount')) is not int or item['filingCount']<=0 or len(columns['form'])!=item['filingCount']:
            raise AcquisitionError('Archive count disagrees with descriptor')
        dates=[iso_date(x) for x in columns['filingDate']]
        start,end=iso_date(item.get('filingFrom')),iso_date(item.get('filingTo'))
        if start>end or any(not start<=observed<=end for observed in dates):
            raise AcquisitionError('Archive filing date outside descriptor bounds')
        all_rows.extend(rows)
        result['archives'][archive]={'path':archive_path,'sourceUrl':archive_url,
            'descriptor':dict(item),'observedFilingFrom':min(dates).isoformat(),
            'observedFilingTo':max(dates).isoformat(),'observedFilingCount':len(dates)}
    merged={}
    for row in all_rows:
        key=row['accessionNumber']
        if key in merged and merged[key]!=row:raise AcquisitionError('Conflicting accession metadata across submissions pages')
        merged[key]=row
    rows=list(merged.values());observed=sorted({r['reportDate'] for r in rows},reverse=True)
    if 'reportPeriods' in spec and 'latestPeriods' in spec:raise AcquisitionError('Select explicit periods or latestPeriods, not both')
    periods=spec.get('reportPeriods')
    if periods is None:
        count=spec.get('latestPeriods',1)
        if type(count)is not int or not 1<=count<=40:raise AcquisitionError('Invalid latestPeriods')
        periods=observed[:count]
        if len(periods)!=count:raise AcquisitionError('Insufficient observed report periods')
    if not isinstance(periods,list) or not periods or any(not isinstance(p,str) for p in periods) or len(set(periods))!=len(periods):
        raise AcquisitionError('Distinct explicit report periods required')
    for period in periods:
        parsed=iso_date(period)
        if (parsed.month,parsed.day) not in {(3,31),(6,30),(9,30),(12,31)} or period not in observed:
            raise AcquisitionError('Requested quarter-end period missing or invalid')
    result['reportPeriods']=sorted(periods,reverse=True)
    result['notices']=[r for r in rows if r['form'] in ('13F-NT','13F-NT/A')]
    if any(r['reportDate'] in periods for r in result['notices']):
        error=AcquisitionError('13F notice requires reporting-manager review; never zero holdings')
        error.notices=result['notices'];error.periods=result['reportPeriods'];raise error
    wanted=[r for r in rows if r['reportDate'] in periods]
    if len(wanted)>1000:raise AcquisitionError('Excessive requested filing count')
    for row in wanted:
        accession=row['accessionNumber'];base=f'https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace("-","")}/';prefix=f'{cik}/{accession}'
        index=parse_json(fetch(base+'index.json',prefix+'/index.json'))
        directory=index.get('directory') if isinstance(index,dict) else None
        items=directory.get('item') if isinstance(directory,dict) else None
        if not isinstance(items,list) or len(items)>1000:raise AcquisitionError('Malformed accession index')
        names=[]
        for item in items:
            name=item.get('name') if isinstance(item,dict) else None
            if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+',name) or name in ('.','..'):
                raise AcquisitionError('Unsafe accession item name')
            if name.lower().endswith('.xml'):names.append(name)
        if len(names)>50 or len(names)!=len(set(names)):raise AcquisitionError('Excessive/duplicate XML documents')
        found={'edgarSubmission':[],'informationTable':[]}
        for name in sorted(names):
            relative=prefix+'/'+name;kind=xml_root(fetch(base+name,relative))
            if kind in found:found[kind].append((relative,base+name))
        if any(len(v)!=1 for v in found.values()):raise AcquisitionError('Missing or ambiguous primary/table XML')
        p,t=found['edgarSubmission'][0],found['informationTable'][0]
        result['filings'][accession]={'primaryPath':p[0],'primarySourceUrl':p[1],'tablePath':t[0],'tableSourceUrl':t[1]}
    for i,source in enumerate(sorted(snapshots,key=lambda x:x==url)):
        if fetch(source,f'{cik}/consistency/{i}.json')!=snapshots[source]:
            raise AcquisitionError('Submissions changed during acquisition; new acquisition required')
    result['acquisition']={'validationVersion':1,'snapshotCheck':'unchanged',
        'scope':'All listed archives and root byte-rechecked with root last; not an atomic SEC snapshot'}
    return result


def acquire(request,destination,*,client):
    if not isinstance(request,dict) or not isinstance(request.get('managers'),list) or not request['managers'] or any(not isinstance(s,dict) for s in request['managers']):
        raise AcquisitionError('Nonempty manager request required')
    specs=request['managers'];ciks=[canonical_cik(s.get('cik')) for s in specs]
    if len(ciks)!=len(set(ciks)):raise AcquisitionError('Duplicate CIKs')
    root=Path(destination)
    if root.absolute()!=root.resolve():raise AcquisitionError('Destination must not traverse symlinks')
    root.mkdir(parents=False,exist_ok=False)
    retrievals=[];managers=[];failures=[]
    for spec,cik in zip(specs,ciks):
        try:managers.append(acquire_manager(spec,root,client,retrievals))
        except (AcquisitionError,OSError,TypeError,KeyError) as error:
            failures.append({'cik':cik,'reason':str(error),'accessDenied':isinstance(error,AccessDenied)})
            failed={k:spec[k] for k in ('label','reportPeriods','latestPeriods') if k in spec}
            failed.update(cik=cik,acquisitionError=str(error))
            if hasattr(error,'notices'):failed.update(notices=error.notices,reportPeriods=error.periods)
            managers.append(failed)
    report={'schemaVersion':1,'complete':not failures,'requestedManagerCount':len(specs),
        'completedManagerCount':len(specs)-len(failures),'failures':failures,'retrievals':retrievals,
        'networkAccessStopped':client.stopped,'retryAfterStopped':client.retry_blocked,'byteBudgetExhausted':client.budget_exhausted}
    manifest={'schemaVersion':1,'managers':managers,'acquisitionComplete':not failures,
        'requireAcquisitionProvenance':True,'acquisitionReportPath':'acquisition-report.json'}
    for name,value in [('evidence-manifest.json',manifest),('acquisition-report.json',report)]:
        save(root,name,(json.dumps(value,indent=2,allow_nan=False)+'\n').encode())
    return report


def _relative_path(value):
    if (not isinstance(value,str) or not value or Path(value).is_absolute() or '\\' in value
            or any(part in ('','.','..') for part in value.split('/'))):
        raise AcquisitionError('Unsafe provenance path')
    return value


def merge_runs(request_path, run_directories, destination):
    """Create a NEW transparent bundle; never overwrite or invent retrievals.

    Active retrievals belong to one selected run per manager. All other attempts,
    raw manifests/reports and raw files remain retained under runs/run-N/. Earlier
    partial runs are not retrospectively represented as complete acquisitions.
    """
    destination_root=Path(destination).absolute()
    for source_root in [Path(value).absolute() for value in run_directories]:
        if destination_root.is_relative_to(source_root) or source_root.is_relative_to(destination_root):
            raise AcquisitionError('Merge destination overlaps source run')
    request_raw=Path(request_path).read_bytes();request=parse_json(request_raw)
    if not isinstance(request,dict) or not isinstance(request.get('managers'),list):
        raise AcquisitionError('Invalid merge request')
    expected={}
    for spec in request['managers']:
        cik=canonical_cik(spec.get('cik'))
        if cik in expected:raise AcquisitionError('Duplicate merge request CIK')
        expected[cik]=spec
    if not expected or not run_directories:raise AcquisitionError('Nonempty merge inputs required')
    files={};sources=[];runs=[];selected={};all_ciks=set()
    for number,directory in enumerate(run_directories):
        root=Path(directory).absolute()
        if root!=root.resolve():raise AcquisitionError('Symlink merge input directory')
        prefix=f'runs/run-{number}'
        def read(relative):
            path=root/_relative_path(relative)
            if not path.is_file() or path.is_symlink() or path.absolute()!=path.resolve():
                raise AcquisitionError('Missing or symlink provenance source')
            return path.read_bytes()
        manifest_raw=read('evidence-manifest.json');report_raw=read('acquisition-report.json')
        manifest=parse_json(manifest_raw);report=parse_json(report_raw)
        if (not isinstance(manifest,dict) or manifest.get('schemaVersion')!=1
                or not isinstance(manifest.get('managers'),list)
                or not isinstance(report,dict) or report.get('schemaVersion')!=1
                or not isinstance(report.get('retrievals'),list) or not isinstance(report.get('failures'),list)):
            raise AcquisitionError('Malformed source run manifest/report')
        managers={}
        for spec in manifest['managers']:
            cik=canonical_cik(spec.get('cik'))
            if cik not in expected or cik in managers:raise AcquisitionError('Unexpected or duplicate source manager')
            if spec.get('label')!=expected[cik].get('label',spec.get('label')):
                raise AcquisitionError('Source run label differs from merge request')
            managers[cik]=spec;all_ciks.add(cik)
            if cik not in selected or 'acquisitionError' not in spec:selected[cik]=number
        failed={cik for cik,spec in managers.items() if 'acquisitionError' in spec}
        if (len(report['failures'])!=len(failed) or {row.get('cik') for row in report['failures']}!=failed
                or type(report.get('complete')) is not bool or report['complete']!= (not failed)
                or manifest.get('acquisitionComplete')!=report['complete']
                or type(report.get('requestedManagerCount')) is not int or report['requestedManagerCount']!=len(managers)
                or type(report.get('completedManagerCount')) is not int or report['completedManagerCount']!=len(managers)-len(failed)):
            raise AcquisitionError('Source acquisition outcome contradicts manager coverage')
        sources.append({'runId':number,'prefix':prefix,
            'manifestPath':prefix+'/evidence-manifest.json','manifestSha256':hashlib.sha256(manifest_raw).hexdigest(),
            'reportPath':prefix+'/acquisition-report.json','reportSha256':hashlib.sha256(report_raw).hexdigest()})
        files[prefix+'/evidence-manifest.json']=manifest_raw;files[prefix+'/acquisition-report.json']=report_raw
        items=[];seen=set()
        for item in report['retrievals']:
            if not isinstance(item,dict):raise AcquisitionError('Malformed retrieval metadata')
            relative=_relative_path(item.get('path'));cik=relative.split('/')[0]
            if relative in seen or cik not in managers:raise AcquisitionError('Duplicate or unscoped retrieval path')
            seen.add(relative);raw=read(relative);official_url(item.get('sourceUrl'))
            try:stamp=datetime.fromisoformat(item['retrievedAt'].replace('Z','+00:00'))
            except (ValueError,KeyError,TypeError,AttributeError) as error:raise AcquisitionError('Invalid retrieval timestamp') from error
            if (stamp.tzinfo is None or stamp.utcoffset().total_seconds()!=0 or stamp>datetime.now(timezone.utc)
                    or type(item.get('httpStatus')) is not int or item['httpStatus']!=200
                    or type(item.get('bytes')) is not int or item['bytes']!=len(raw)
                    or item.get('sha256')!=hashlib.sha256(raw).hexdigest()):
                raise AcquisitionError('Retrieval provenance differs from raw source')
            target=prefix+'/'+relative
            if target in files:raise AcquisitionError('Provenance path collision')
            files[target]=raw;items.append((cik,{**item,'path':target}))
        runs.append((managers,items,report['failures']))
    if all_ciks!=set(expected):raise AcquisitionError('Merge inputs omit requested managers')
    active=[];unselected=[];managers=[];failures=[]
    for number,(_,items,_) in enumerate(runs):
        for cik,item in items:(active if selected[cik]==number else unselected).append(item)
    for cik in expected:
        number=selected[cik];prefix=sources[number]['prefix']
        spec=json.loads(json.dumps(runs[number][0][cik]))
        if 'acquisitionError' in spec:
            failures.append(dict(next(item for item in runs[number][2] if item['cik']==cik)))
        else:
            spec['submissionsPath']=prefix+'/'+_relative_path(spec['submissionsPath'])
            for entry in spec.get('archives',{}).values():entry['path']=prefix+'/'+_relative_path(entry['path'])
            for entry in spec['filings'].values():
                for key in ('primaryPath','tablePath'):entry[key]=prefix+'/'+_relative_path(entry[key])
            paths=[spec['submissionsPath']]+[v['path'] for v in spec.get('archives',{}).values()]
            paths += [v[key] for v in spec['filings'].values() for key in ('primaryPath','tablePath')]
            if any(path not in files for path in paths):raise AcquisitionError('Selected manager source absent from ledger')
        managers.append(spec)
    key=lambda item:(datetime.fromisoformat(item['retrievedAt'].replace('Z','+00:00')),item['path'])
    active.sort(key=key);unselected.sort(key=key)
    provenance={'description':'New merge of fresh runs, preserving each original raw source and its actual retrieval time.',
        'requestSha256':hashlib.sha256(request_raw).hexdigest(),'sources':sources,
        'selectedRunByCik':selected,'unselectedRetrievalsAreNotActiveConsistencyEvidence':True}
    manifest={'schemaVersion':1,'managers':managers,'acquisitionComplete':not failures,
        'requireAcquisitionProvenance':True,'acquisitionReportPath':'acquisition-report.json','mergeProvenance':provenance}
    report={'schemaVersion':1,'complete':not failures,'requestedManagerCount':len(expected),
        'completedManagerCount':len(expected)-len(failures),'failures':failures,'retrievals':active,
        'unselectedRetrievals':unselected,'mergeProvenance':provenance}
    files['request.json']=request_raw
    files['evidence-manifest.json']=(json.dumps(manifest,indent=2,allow_nan=False)+'\n').encode()
    files['acquisition-report.json']=(json.dumps(report,indent=2,allow_nan=False)+'\n').encode()
    root=Path(destination)
    if root.absolute()!=root.resolve():raise AcquisitionError('Symlink merge destination')
    root.mkdir(parents=False,exist_ok=False)
    for path,raw in files.items():save(root,path,raw)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request');parser.add_argument('destination');parser.add_argument('--user-agent',required=True)
    args=parser.parse_args()
    try:
        report=acquire(parse_json(Path(args.request).read_bytes()),args.destination,client=Client(args.user_agent))
        print(json.dumps({k:report[k] for k in ('complete','requestedManagerCount','completedManagerCount','failures')}))
        return 0 if report['complete'] else 1
    except (AcquisitionError,OSError) as error:
        print(f'Acquisition blocked: {error}');return 1


if __name__=='__main__':raise SystemExit(main())
