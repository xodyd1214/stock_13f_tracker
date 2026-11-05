"""Offline synthetic transport tests; no live retrievals or evidence claims."""
import copy
from datetime import datetime,timedelta,timezone
from email.utils import format_datetime
import hashlib
import http.client
import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from sec_source_acquisition import (Client,HTTPTransport,AccessDenied,AcquisitionError,
    NoRedirect,acquire,official_url,parse_json,records,xml_root,merge_runs)

CIK='0000000001';ACC='0000000001-26-000001';PERIOD='2026-06-30'
SUB=f'https://data.sec.gov/submissions/CIK{CIK}.json'
BASE=f'https://www.sec.gov/Archives/edgar/data/1/{ACC.replace("-","")}/'


def cols(acc=ACC,period=PERIOD,form='13F-HR'):
    return {'form':[form],'reportDate':[period],'filingDate':['2026-08-14'],
            'accessionNumber':[acc],'acceptanceDateTime':['2026-08-14T12:00:00.000Z'],
            'primaryDocument':['xslForm13F_X02/primary.xml']}


def fixture():
    return {SUB:{'cik':1,'name':'SYNTHETIC TEST ENTITY','filings':{'recent':cols(),'files':[]}},
            BASE+'index.json':{'directory':{'item':[{'name':'primary.xml'},{'name':'table.xml'}]}},
            BASE+'primary.xml':b'<edgarSubmission/>',BASE+'table.xml':b'<informationTable/>'}


class Fake:
    def __init__(self,data):self.data=data;self.calls=[];self.limits=[]
    def __call__(self,url,headers,timeout,limit):
        self.calls.append(url);self.limits.append(limit)
        item=self.data[url]
        if isinstance(item,list):item=item.pop(0)
        if isinstance(item,Exception):raise item
        if isinstance(item,tuple):return item
        return 200,{},item if isinstance(item,bytes) else json.dumps(item).encode(),url


class AcquisitionTests(unittest.TestCase):
    def run_acq(self,data=None,specs=None):
        fake=Fake(fixture() if data is None else data)
        client=Client('Synthetic fixture test',transport=fake,sleep=lambda _:None)
        with tempfile.TemporaryDirectory() as parent:
            root=Path(parent)/'new'
            report=acquire({'managers':specs or [{'cik':CIK,'latestPeriods':1}]},root,client=client)
            manifest=json.loads((root/'evidence-manifest.json').read_text())
            for item in report['retrievals']:
                raw=(root/item['path']).read_bytes()
                self.assertEqual(item['sha256'],hashlib.sha256(raw).hexdigest())
                self.assertEqual(item['bytes'],len(raw))
                self.assertEqual(item['httpStatus'],200)
                self.assertEqual(datetime.fromisoformat(item['retrievedAt']).utcoffset(),timedelta(0))
            return report,manifest,fake

    def test_happy_raw_xml_and_real_execution_metadata(self):
        before=datetime.now(timezone.utc)
        report,manifest,fake=self.run_acq()
        self.assertTrue(report['complete'])
        self.assertTrue(manifest['requireAcquisitionProvenance'])
        self.assertEqual(manifest['acquisitionReportPath'],'acquisition-report.json')
        spec=manifest['managers'][0]
        self.assertEqual(spec['label'],'SYNTHETIC TEST ENTITY')
        self.assertEqual(spec['reportPeriods'],[PERIOD])
        self.assertEqual(spec['filings'][ACC]['primarySourceUrl'],BASE+'primary.xml')
        self.assertEqual(fake.calls[-1],SUB)
        self.assertGreaterEqual(datetime.fromisoformat(report['retrievals'][0]['retrievedAt']),before)

    def archive_fixture(self):
        data=fixture();name=f'CIK{CIK}-submissions-001.json';url=f'https://data.sec.gov/submissions/{name}'
        data[SUB]['filings']={'recent':{k:[] for k in cols()},'files':[
            {'name':name,'filingCount':1,'filingFrom':'2026-08-14','filingTo':'2026-08-14'}]}
        data[url]=cols()
        return data,name,url

    def test_archived_accession_rechecked_before_root(self):
        data,name,url=self.archive_fixture();report,manifest,fake=self.run_acq(data)
        self.assertTrue(report['complete']);self.assertIn(name,manifest['managers'][0]['archives'])
        self.assertEqual(fake.calls[-2:],[url,SUB])

    def test_archive_enclosing_bounds_preserved_without_source_changes(self):
        data,name,url=self.archive_fixture()
        descriptor=data[SUB]['filings']['files'][0]
        descriptor.update(filingFrom='2026-08-01',filingTo='2026-08-16')
        before=copy.deepcopy(data)
        report,manifest,_=self.run_acq(data)
        self.assertTrue(report['complete'])
        archive=manifest['managers'][0]['archives'][name]
        self.assertEqual(archive['descriptor'],descriptor)
        self.assertEqual(archive['observedFilingFrom'],'2026-08-14')
        self.assertEqual(archive['observedFilingTo'],'2026-08-14')
        self.assertEqual(data,before)

    def test_duplicate_truncated_or_out_of_range_archive_rejected(self):
        for fault in ('duplicate','truncated','outside','optional_length'):
            data,_,url=self.archive_fixture()
            if fault=='duplicate':
                for key in data[url]:data[url][key]*=2
                data[SUB]['filings']['files'][0]['filingCount']=2
            elif fault=='truncated':data[SUB]['filings']['files'][0]['filingCount']=2
            elif fault=='outside':data[url]['filingDate']=['2026-08-15']
            else:data[url]['isInlineXBRL']=[]
            with self.subTest(fault=fault):self.assertFalse(self.run_acq(data)[0]['complete'])

    def test_latest_period_not_latest_filing_date(self):
        data=fixture();recent=data[SUB]['filings']['recent'];old=cols('0000000001-26-000002','2026-03-31','13F-HR/A')
        old['filingDate']=['2026-09-01']
        for k in recent:recent[k].extend(old[k])
        report,manifest,_=self.run_acq(data)
        self.assertTrue(report['complete']);self.assertEqual(manifest['managers'][0]['reportPeriods'],[PERIOD])
        self.assertEqual(list(manifest['managers'][0]['filings']),[ACC])

    def test_every_same_period_amendment_acquired(self):
        data=fixture();acc='0000000001-26-000002';amend=cols(acc,form='13F-HR/A')
        for k in data[SUB]['filings']['recent']:data[SUB]['filings']['recent'][k].extend(amend[k])
        for url,value in list(data.items()):
            if url.startswith(BASE):data[url.replace(ACC.replace('-',''),acc.replace('-',''))]=copy.deepcopy(value)
        report,manifest,_=self.run_acq(data)
        self.assertTrue(report['complete']);self.assertEqual(set(manifest['managers'][0]['filings']),{ACC,acc})

    def test_missing_or_ambiguous_xml_fails(self):
        for name in ('primary.xml','table.xml'):
            data=fixture();data[BASE+'index.json']['directory']['item']=[{'name':name}]
            self.assertFalse(self.run_acq(data)[0]['complete'])
        data=fixture();data[BASE+'index.json']['directory']['item'].append({'name':'extra.xml'});data[BASE+'extra.xml']=b'<informationTable/>'
        self.assertFalse(self.run_acq(data)[0]['complete'])

    def test_notice_is_not_zero_holdings(self):
        data=fixture();data[SUB]['filings']['recent']['form']=['13F-NT']
        report,manifest,fake=self.run_acq(data)
        self.assertFalse(report['complete']);self.assertEqual(manifest['managers'][0]['notices'][0]['form'],'13F-NT')
        self.assertEqual(fake.calls,[SUB]);self.assertNotIn('filings',manifest['managers'][0])

    def test_changed_root_or_archive_fails_snapshot(self):
        data=fixture();changed=copy.deepcopy(data[SUB]);changed['name']='CHANGED'
        data[SUB]=[data[SUB],changed]
        self.assertIn('changed during',self.run_acq(data)[0]['failures'][0]['reason'])
        data,_,url=self.archive_fixture();changed=cols(form='13F-HR/A');data[url]=[data[url],changed]
        self.assertIn('changed during',self.run_acq(data)[0]['failures'][0]['reason'])

    def test_malformed_submissions_archive_and_index(self):
        for change in ('missing_filings','bad_recent','bad_archive_count','bad_archive_dates','bad_index'):
            data=fixture()
            if change=='missing_filings':data[SUB]['filings']=None
            if change=='bad_recent':data[SUB]['filings']['recent']['reportDate']=[]
            if change.startswith('bad_archive'):
                data,_,_=self.archive_fixture()
                key='filingCount' if change.endswith('count') else 'filingTo'
                data[SUB]['filings']['files'][0][key]=2 if key=='filingCount' else '2026-08-13'
            if change=='bad_index':data[BASE+'index.json']={'directory':None}
            with self.subTest(change=change):self.assertFalse(self.run_acq(data)[0]['complete'])

    def test_exact_legal_label_no_fuzzy_identity(self):
        report,_,_=self.run_acq(specs=[{'cik':CIK,'label':'Famous person','latestPeriods':1}])
        self.assertFalse(report['complete'])
        self.assertIn('exact SEC legal name',report['failures'][0]['reason'])

    def test_partial_failure_never_disappears(self):
        data=fixture();data['https://data.sec.gov/submissions/CIK0000000002.json']=b'bad json'
        report,manifest,_=self.run_acq(data,[{'cik':CIK},{'cik':'2','submissionsPath':'unsafe','filings':{}}])
        self.assertFalse(report['complete']);self.assertEqual(report['completedManagerCount'],1)
        self.assertEqual(len(manifest['managers']),2);self.assertNotIn('submissionsPath',manifest['managers'][1])

    def test_denial_stops_entire_client_and_remaining_managers(self):
        for failure in ((403,{},b'no',SUB),(200,{},b'access denied',SUB),
                urllib.error.URLError(OSError('Tunnel connection failed: 403 Forbidden')),
                urllib.error.URLError(ssl.SSLError('certificate verify failed')),
                (200,{},b'{}','https://evil.example/')):
            report,_,fake=self.run_acq({SUB:failure},[{'cik':CIK},{'cik':'2'}])
            self.assertTrue(report['networkAccessStopped']);self.assertEqual(fake.calls,[SUB])

    def test_no_redirect_or_proxy_bypass(self):
        with self.assertRaises(AccessDenied):NoRedirect().redirect_request()
        with patch('urllib.request.build_opener') as opener:HTTPTransport()
        self.assertEqual(len(opener.call_args.args),1);self.assertIsInstance(opener.call_args.args[0],NoRedirect)

    def test_budgets_latch_and_transport_receives_remaining(self):
        limits=[]
        def transport(url,headers,timeout,limit):limits.append(limit);return 200,{},b'x'*limit,url
        client=Client('Fixture',transport=transport,sleep=lambda _:None,max_bytes=4,max_total_bytes=6)
        client.get(SUB);client.get(SUB)
        for _ in range(3):
            with self.assertRaisesRegex(AcquisitionError,'budget exhausted'):client.get(SUB)
        self.assertEqual(limits,[4,2])
        client=Client('Fixture',transport=Fake({SUB:b'12345'}),max_bytes=4)
        with self.assertRaisesRegex(AcquisitionError,'byte allowance'):client.get(SUB)

    def test_incomplete_read_is_bounded_and_retains_report(self):
        report,manifest,fake=self.run_acq({SUB:http.client.IncompleteRead(b'{',20)})
        self.assertFalse(report['complete']);self.assertEqual(len(fake.calls),4)
        self.assertIn('IncompleteRead',manifest['managers'][0]['acquisitionError'])

    def test_retry_after_numeric_and_date_never_retry_early(self):
        for value in ('120',format_datetime(datetime.now(timezone.utc)+timedelta(seconds=120)),'invalid'):
            fake=Fake({SUB:(429,{'Retry-After':value},b'',SUB)});client=Client('Fixture',transport=fake,sleep=lambda _:None)
            with self.assertRaises(AcquisitionError):client.get(SUB)
            with self.assertRaisesRegex(AcquisitionError,'unserved'):client.get(SUB)
            self.assertEqual(fake.calls,[SUB])
        delays=[];value=format_datetime(datetime.now(timezone.utc)+timedelta(seconds=30))
        fake=Fake({SUB:[(503,{'Retry-After':value},b'',SUB),b'{}']})
        client=Client('Fixture',transport=fake,sleep=delays.append,monotonic=lambda:0)
        self.assertEqual(client.get(SUB)[1]['attempts'],2);self.assertGreater(delays[0],28);self.assertIn(.25,delays)

    def test_unsafe_urls_json_and_xml(self):
        for url in (SUB+'?a=b',SUB.replace('https:','http:'),SUB.replace('data.sec.gov','data.sec.gov.evil'),BASE+'../x',BASE+'%2e%2e'):
            with self.assertRaises(AcquisitionError):official_url(url)
        for raw in (b'{',b'{"a":1,"a":2}',b'{"a":NaN}'):
            with self.assertRaises(AcquisitionError):parse_json(raw)
        for raw in (b'<!DOCTYPE x><x/>',b'<x>',b'\xff'):
            with self.assertRaises(AcquisitionError):xml_root(raw)

    def merge_fixture(self,parent):
        parent=Path(parent);request={'managers':[{'cik':CIK,'label':'SYNTHETIC TEST ENTITY','latestPeriods':1}]}
        request_path=parent/'request.json';request_path.write_text(json.dumps(request))
        initial=fixture();initial[BASE+'index.json']['directory']['item']=[{'name':'primary.xml'}]
        roots=[parent/'initial',parent/'retry']
        for root,data in zip(roots,[initial,fixture()]):
            acquire(request,root,client=Client('Synthetic fixture',transport=Fake(data),sleep=lambda _:None))
        return request_path,roots

    def test_merge_preserves_attempts_and_selects_one_complete_history(self):
        with tempfile.TemporaryDirectory() as parent:
            request,roots=self.merge_fixture(parent);destination=Path(parent)/'merged'
            before={str(path):path.read_bytes() for root in roots for path in root.rglob('*') if path.is_file()}
            report=merge_runs(request,roots,destination)
            self.assertTrue(report['complete']);self.assertEqual(report['completedManagerCount'],1)
            self.assertTrue(report['unselectedRetrievals'])
            self.assertTrue(all(x['path'].startswith('runs/run-1/') for x in report['retrievals']))
            self.assertTrue(all(x['path'].startswith('runs/run-0/') for x in report['unselectedRetrievals']))
            self.assertEqual(report['mergeProvenance']['selectedRunByCik'],{CIK:1})
            for number,root in enumerate(roots):
                original=json.loads((root/'acquisition-report.json').read_text())
                chosen=report['retrievals'] if number==1 else report['unselectedRetrievals']
                self.assertEqual(len(chosen),len(original['retrievals']))
                for item in original['retrievals']:
                    expected={**item,'path':f'runs/run-{number}/'+item['path']}
                    self.assertIn(expected,chosen)
                    self.assertEqual((destination/expected['path']).read_bytes(),(root/item['path']).read_bytes())
                self.assertEqual((destination/f'runs/run-{number}/acquisition-report.json').read_bytes(),(root/'acquisition-report.json').read_bytes())
            self.assertEqual(before,{str(path):path.read_bytes() for root in roots for path in root.rglob('*') if path.is_file()})
            manifest=json.loads((destination/'evidence-manifest.json').read_text())
            self.assertTrue(manifest['managers'][0]['submissionsPath'].startswith('runs/run-1/'))

    def test_merge_missing_manager_tamper_and_overlap_fail_before_writes(self):
        with tempfile.TemporaryDirectory() as parent:
            request,roots=self.merge_fixture(parent);destination=Path(parent)/'merged'
            original=request.read_bytes();data=json.loads(original);data['managers'].append({'cik':'2'})
            request.write_text(json.dumps(data))
            with self.assertRaisesRegex(AcquisitionError,'omit requested'):merge_runs(request,roots,destination)
            self.assertFalse(destination.exists());request.write_bytes(original)
            with self.assertRaisesRegex(AcquisitionError,'overlaps'):merge_runs(request,roots,roots[0]/'nested')
            source=roots[0]/CIK/'submissions.json';source.write_bytes(source.read_bytes()+b' ')
            with self.assertRaisesRegex(AcquisitionError,'provenance differs'):merge_runs(request,roots,destination)
            self.assertFalse(destination.exists())

    def test_existing_destination_and_duplicate_cik_no_writes(self):
        with tempfile.TemporaryDirectory() as path:
            marker=Path(path)/'keep';marker.write_text('original')
            with self.assertRaises(FileExistsError):acquire({'managers':[{'cik':CIK}]},path,client=Client('Fixture'))
            self.assertEqual(marker.read_text(),'original')
            with self.assertRaisesRegex(AcquisitionError,'Duplicate CIK'):
                acquire({'managers':[{'cik':CIK},{'cik':'1'}]},Path(path)/'new',client=Client('Fixture'))
            self.assertFalse((Path(path)/'new').exists())


if __name__=='__main__':unittest.main()
