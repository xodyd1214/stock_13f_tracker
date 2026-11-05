"""Transparent offline SYNTHETIC fixtures. None are real SEC financial data."""
import copy
from datetime import datetime, timezone
import json
import shutil
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
from test_filing_integrity_rebuilt import synthetic
import sec_partial_stage as stage

NOW='2026-11-05T11:00:00+00:00'

class PartialStageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.ev=self.root/'evidence';self.ev.mkdir()
        self.ledger=self.root/'ledger.json';self.request=self.root/'request.json';self.scope=self.root/'synthetic_scope.json'
        labels=[];eligible=[];pending=[];specs=[]
        for i in range(50):
            c=i+1 if i<42 else (1 if i==42 else i)
            cik=str(c).zfill(10);label=f'SYNTHETIC LABEL {i}';legal=f'SYNTHETIC LEGAL {c}'
            entry={'original_deployed_label':label,'proposed_reporting_cik':cik,'proposed_sec_legal_name':legal,'fresh_sec_identity_verified':True,'selected_for_45_entity_acquisition':c<=45,'coverage_class':'SYNTHETIC_PENDING'};labels.append(entry)
            if i<43:eligible.append({'label':label,'cik':cik,'legalName':legal})
            else:pending.append({'label':label,'cik':cik,'reason':'SYNTHETIC_PENDING','integrityEvidence':None})
        self.write(self.ledger,{'labels':labels})
        for c in range(1,46):specs.append({'cik':str(c).zfill(10),'label':f'SYNTHETIC LEGAL {c}','latestPeriods':1})
        self.write(self.request,{'managers':specs})
        self.write(self.scope,{'contract':'SYNTHETIC EXACT 43/42/50','ledgerSha256':stage.sha(self.ledger.read_bytes()),'requestSha256':stage.sha(self.request.read_bytes()),'originalLabels':[x['original_deployed_label'] for x in labels],'eligible':eligible,'pending':pending})
        self.patch=patch.object(stage,'SCOPE_PATH',self.scope);self.patch.start()
        self.report={'schemaVersion':1,'retrievals':[]};managers=[]
        for c in range(1,46):
            cik=str(c).zfill(10);args=synthetic(filing='2026-08-14',period='06-30-2026');acc=args[2]['accessionNumber'];args[0]=args[0].replace(b'<cik>1</cik>',f'<cik>{c}</cik>'.encode());base=f'https://www.sec.gov/Archives/edgar/data/{c}/{acc.replace("-", "")}/';url=f'https://data.sec.gov/submissions/CIK{cik}.json'
            sub={'cik':c,'name':f'SYNTHETIC LEGAL {c}','filings':{'recent':{k:[v] for k,v in args[2].items() if k!='cik'},'files':[]}}
            self.add(f'{cik}/submissions.json',url,stage.encoded(sub));self.add(f'{cik}/index.json',base+'index.json',stage.encoded({'directory':{'item':[{'name':'primary.xml'},{'name':'table.xml'}]}}));self.add(f'{cik}/primary.xml',base+'primary.xml',args[0]);self.add(f'{cik}/table.xml',base+'table.xml',args[1]);self.add(f'{cik}/final.json',url,stage.encoded(sub))
            managers.append({'cik':cik,'label':sub['name'],'reportPeriods':['2026-06-30'],'submissionsPath':f'{cik}/submissions.json','submissionsSourceUrl':url,'archives':{},'filings':{acc:{'primaryPath':f'{cik}/primary.xml','primarySourceUrl':base+'primary.xml','tablePath':f'{cik}/table.xml','tableSourceUrl':base+'table.xml'}}})
        self.manifest={'schemaVersion':1,'requireAcquisitionProvenance':True,'acquisitionReportPath':'report.json','managers':managers};self.flush()
    def tearDown(self):self.patch.stop();self.temp.cleanup()
    def write(self,path,value):path.write_bytes(stage.encoded(value))
    def add(self,path,url,raw):
        target=self.ev/path;target.parent.mkdir(exist_ok=True,parents=True);target.write_bytes(raw)
        self.report['retrievals'].append({'path':path,'sourceUrl':url,'sha256':stage.sha(raw),'bytes':len(raw),'retrievedAt':NOW,'httpStatus':200})
    def flush(self):
        failures=[{'cik':m['cik'],'reason':m['acquisitionError']} for m in self.manifest['managers'] if 'acquisitionError' in m]
        self.report.update(failures=failures,requestedManagerCount=45,completedManagerCount=45-len(failures),complete=not failures)
        self.manifest['acquisitionComplete']=not failures
        self.write(self.ev/'manifest.json',self.manifest);self.write(self.ev/'report.json',self.report)
    def rewrite(self,path,raw):
        (self.ev/path).write_bytes(raw)
        for item in self.report['retrievals']:
            if item['path']==path:item.update(sha256=stage.sha(raw),bytes=len(raw))
        self.flush()
    def build(self):return stage.build_candidate(self.ev/'manifest.json',self.ledger,self.request,now=NOW)
    def test_exact_scope_alias_dedup_pending_nulls(self):
        before=copy.deepcopy(self.manifest);result=self.build();m=result['manifest.json']
        self.assertTrue(m['partialDisplayEligible']);self.assertFalse(m['releaseEligible']);self.assertFalse(m['migrationReady'])
        self.assertEqual((m['availableLabelCount'],m['availableEntityCount'],m['pendingLabelCount']),(43,42,7));self.assertEqual(len(result['holdings.json']),42);self.assertEqual(m['totalEquityValueUsd'],4200)
        self.assertEqual(self.manifest,before)
        for row in result['coverage.json'][43:]:self.assertEqual(row['status'],'verification_pending');self.assertIsNone(row['valueUsd']);self.assertIsNone(row['reportDate'])
        self.assertEqual(result['holdings.json'][0]['verificationStatus'],'source_reconciled');self.assertNotIn('rows',result['holdings.json'][0]['snapshotComponents'][0]);self.assertEqual(result['coverage.json'][0]['legalName'],'SYNTHETIC LEGAL 1')
        self.assertEqual(len(result['history.json']),45);self.assertIsNotNone(result['quarantine.json'][0]['currentReplay'])
    def test_extra_failure_blocks_entire_partial(self):
        self.manifest['managers'][0]['acquisitionError']='SYNTHETIC source failed';self.flush();r=self.build()
        self.assertFalse(r['manifest.json']['partialDisplayEligible']);self.assertEqual(r['manifest.json']['availableLabelCount'],41)
    def test_source_mismatch_quarantines(self):
        path='0000000001/primary.xml';self.rewrite(path,(self.ev/path).read_bytes().replace(b'<tableValueTotal>00100',b'<tableValueTotal>99'))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_unknown_share_units_quarantine(self):
        path='0000000001/table.xml';self.rewrite(path,(self.ev/path).read_bytes().replace(b'<sshPrnamtType>SH',b'<sshPrnamtType>UNKNOWN'))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_ambiguous_share_class_blocks_instead_of_silent_omission(self):
        path='0000000001/table.xml';self.rewrite(path,(self.ev/path).read_bytes().replace(b'<titleOfClass>COM</titleOfClass>',b'<titleOfClass>UNREVIEWED OPTION</titleOfClass>'))
        result=self.build();self.assertFalse(result['manifest.json']['partialDisplayEligible'])
        self.assertIn('Unresolved share class',result['quarantine.json'][0]['replayError'])
    def test_reviewed_fund_policy_reconciles_full_position_partition(self):
        path='0000000001/table.xml';self.rewrite(path,(self.ev/path).read_bytes().replace(b'<titleOfClass>COM</titleOfClass>',b'<titleOfClass>FUND OPTION</titleOfClass>'))
        policy=json.loads(self.scope.read_bytes());policy['equityShareClassOverrides']=[{'cusip':'000000001','issuer':'SYNTHETIC ONLY','titleOfClass':'FUND OPTION','classification':'fund_share','evidence':[{'url':'https://example.test/SYNTHETIC.pdf','sha256':'a'*64,'title':'SYNTHETIC proof','checkedAt':NOW}]}]
        self.write(self.scope,policy);result=self.build();self.assertTrue(result['manifest.json']['partialDisplayEligible'])
        partition=result['manifest.json']['positionClassification'];self.assertEqual(partition['equity_verified_fund_share'],{'rowCount':1,'reportedValueUsd':100})
        self.assertEqual(sum(x['rowCount'] for x in partition.values()),42)
        self.assertEqual(sum(x['reportedValueUsd'] for x in partition.values()),4200)
        self.assertEqual(partition['unresolved_share_class']['rowCount'],0)
    def test_missing_amendment_quarantine(self):
        self.change_sub(lambda sub:[v.append(v[0] if k!='accessionNumber' else '0000000001-26-000002') for k,v in sub['filings']['recent'].items()])
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def change_sub(self,fn):
        p='0000000001/submissions.json';sub=json.loads((self.ev/p).read_bytes());fn(sub)
        for p in ('0000000001/submissions.json','0000000001/final.json'):self.rewrite(p,stage.encoded(sub))
    def test_notice_latest_blocks(self):
        self.change_sub(lambda sub:sub['filings']['recent']['form'].__setitem__(0,'13F-NT'))
        self.assertIn('notice',self.build()['quarantine.json'][0]['replayError'])
    def test_archive_omission_blocks(self):
        self.change_sub(lambda sub:sub['filings']['files'].append({'name':'CIK0000000001-submissions-001.json','filingCount':1,'filingFrom':'2026-08-14','filingTo':'2026-08-14'}))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def archive_fixture(self):
        name='CIK0000000001-submissions-001.json';path='0000000001/'+name;url='https://data.sec.gov/submissions/'+name
        sub=json.loads((self.ev/'0000000001/submissions.json').read_bytes());columns=sub['filings']['recent']
        self.change_sub(lambda s:s['filings']['files'].append({'name':name,'filingCount':1,'filingFrom':'2026-08-13','filingTo':'2026-08-16'}))
        self.manifest['managers'][0]['archives'][name]={'path':path,'sourceUrl':url}
        self.add(path,url,stage.encoded(columns));self.add('0000000001/archive-final.json',url,stage.encoded(columns))
        root_final=self.report['retrievals'].pop(4);self.report['retrievals'].append(root_final);self.flush()
        return path,columns
    def test_wider_archive_bounds_valid_and_recorded(self):
        self.archive_fixture();result=self.build();self.assertTrue(result['manifest.json']['partialDisplayEligible'])
        self.assertEqual(result['history.json'][0]['archiveBounds'][0]['observedFilingTo'],'2026-08-14')
        self.assertEqual(result['history.json'][0]['archiveBounds'][0]['descriptorFilingTo'],'2026-08-16')
    def test_archive_out_of_range_blocks(self):
        path,columns=self.archive_fixture();columns['filingDate'][0]='2026-08-17'
        for p in (path,'0000000001/archive-final.json'):self.rewrite(p,stage.encoded(columns))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_archive_truncated_column_blocks(self):
        path,columns=self.archive_fixture();columns['acceptanceDateTime']=[]
        for p in (path,'0000000001/archive-final.json'):self.rewrite(p,stage.encoded(columns))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_archive_duplicate_accession_blocks(self):
        path,columns=self.archive_fixture()
        for values in columns.values():values.append(values[0])
        for p in (path,'0000000001/archive-final.json'):self.rewrite(p,stage.encoded(columns))
        self.change_sub(lambda s:s['filings']['files'][0].update(filingCount=2))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_exact_identity_blocks(self):
        self.change_sub(lambda sub:sub.update(name='Wrong legal name'))
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_path_traversal_rejected_globally(self):
        self.report['retrievals'][0]['path']='../ledger.json';self.flush()
        with self.assertRaises(ValueError):self.build()
    def test_tamper_rejected_globally(self):
        (self.ev/'0000000001/table.xml').write_bytes(b'tampered')
        with self.assertRaises(ValueError):self.build()
    def test_duplicate_keys_rejected(self):
        (self.ev/'manifest.json').write_bytes(b'{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(ValueError):self.build()
    def test_reused_paths_rejected(self):
        self.report['retrievals'].append(copy.deepcopy(self.report['retrievals'][0]));self.flush()
        with self.assertRaises(ValueError):self.build()
    def test_final_copy_missing_blocks(self):
        self.report['retrievals'].pop(4);self.flush();self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_final_copy_order_blocks(self):
        self.report['retrievals'][1],self.report['retrievals'][4]=self.report['retrievals'][4],self.report['retrievals'][1];self.flush()
        self.assertFalse(self.build()['manifest.json']['partialDisplayEligible'])
    def test_missing_manager_not_omitted(self):
        self.manifest['managers'].pop();self.flush()
        with self.assertRaises(ValueError):self.build()
    def test_policy_change_rejected(self):
        self.ledger.write_bytes(self.ledger.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.build()
    def test_old_preparation_blocked(self):
        with self.assertRaises(ValueError):stage.build_candidate(self.ev/'manifest.json',self.ledger,self.request,now='2026-11-07T11:00:00Z')
    def test_safe_aggregate(self):
        with self.assertRaises(ValueError):stage.safe_numbers({'sum':2**53})
    def test_stage_new_destination_and_historical_verification(self):
        output=self.root/'new';args=(self.ev/'manifest.json',self.ledger,self.request,output)
        stage.stage_candidate(*args,now=NOW)
        self.assertTrue(stage.verify_candidate(output,now=NOW)['activationEligible'])
        with self.assertRaises(ValueError):stage.stage_candidate(*args,now=NOW)
        with self.assertRaises(ValueError):stage.verify_candidate(output,now='2026-11-07T11:00:00Z')
        historical=stage.verify_candidate(output,now='2026-11-07T11:00:00Z',require_recent=False)
        self.assertTrue(historical['stale']);self.assertFalse(historical['activationEligible']);self.assertEqual(historical['displayMode'],'dated_historical_partial')
        (output/'coverage.json').write_bytes(b'[]')
        with self.assertRaises(ValueError):stage.verify_candidate(output,now=NOW)
    def merge_fixture(self):
        from datetime import timedelta
        start=stage.timestamp(NOW)-timedelta(minutes=10)
        for i,item in enumerate(self.report['retrievals']):item['retrievedAt']=(start+timedelta(seconds=i)).isoformat()
        self.flush();merged=self.root/'merged';merged.mkdir();sources=[]
        def prefix(value,root):
            if isinstance(value,list):return [prefix(v,root) for v in value]
            if isinstance(value,dict):return {k:(root+'/'+v if (k=='path' or k.endswith('Path')) and isinstance(v,str) else prefix(v,root)) for k,v in value.items()}
            return value
        for run in (0,1):
            root=f'runs/run-{run}';shutil.copytree(self.ev,merged/root)
            sources.append({'runId':run,'prefix':root,'manifestPath':root+'/manifest.json','manifestSha256':stage.sha((merged/root/'manifest.json').read_bytes()),'reportPath':root+'/report.json','reportSha256':stage.sha((merged/root/'report.json').read_bytes())})
        provenance={'description':'SYNTHETIC merge fixture only','requestSha256':stage.sha(self.request.read_bytes()),'sources':sources,'selectedRunByCik':{m['cik']:0 for m in self.manifest['managers']},'unselectedRetrievalsAreNotActiveConsistencyEvidence':True}
        shutil.copyfile(self.request,merged/'request.json')
        order=lambda item:(stage.timestamp(item['retrievedAt']),item['path'])
        self.report['unselectedRetrievals']=sorted(prefix(self.report['retrievals'],'runs/run-1'),key=order)
        self.report['retrievals']=sorted(prefix(self.report['retrievals'],'runs/run-0'),key=order)
        self.report['mergeProvenance']=copy.deepcopy(provenance);self.manifest['mergeProvenance']=provenance
        self.manifest['managers']=prefix(self.manifest['managers'],'runs/run-0');self.ev=merged;self.flush()
    def test_merge_preserves_and_verifies_both_raw_runs(self):
        self.merge_fixture();self.assertTrue(self.build()['manifest.json']['partialDisplayEligible'])
    def test_unselected_raw_tamper_rejected(self):
        self.merge_fixture();(self.ev/'runs/run-1/0000000001/table.xml').write_bytes(b'tampered history')
        with self.assertRaisesRegex(ValueError,'Raw retrieval byte/hash/status mismatch'):self.build()
    def test_omitted_unselected_history_rejected(self):
        self.merge_fixture();self.report['unselectedRetrievals'].pop();self.flush()
        with self.assertRaisesRegex(ValueError,'Merged raw history partition differs'):self.build()
    def test_copied_source_report_tamper_rejected(self):
        self.merge_fixture();p=self.ev/'runs/run-1/report.json';p.write_bytes(p.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'Merge source metadata hash differs'):self.build()
    def test_relocation_replays_without_original_inputs(self):
        output=self.root/'new';stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now=NOW)
        original={name:(output/name).read_bytes() for name in stage.ARTIFACTS}
        with tempfile.TemporaryDirectory() as destination:
            moved=Path(destination)/'copy';shutil.copytree(self.root,moved)
            shutil.rmtree(self.ev);self.ledger.unlink();self.request.unlink()
            overrides={'evidenceManifest':moved/'evidence/manifest.json','ledgerPath':moved/'ledger.json','requestPath':moved/'request.json'}
            result=stage.verify_candidate(moved/'new',inputs_override=overrides,now=NOW)
            self.assertTrue(result['activationEligible'])
            self.assertEqual(original,{name:(moved/'new'/name).read_bytes() for name in stage.ARTIFACTS})
            self.assertEqual(original,{name:(output/name).read_bytes() for name in stage.ARTIFACTS})
    def test_relocation_wrong_input_bytes_rejected(self):
        output=self.root/'new';stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now=NOW)
        with tempfile.TemporaryDirectory() as destination:
            moved=Path(destination)/'copy';shutil.copytree(self.root,moved)
            request=moved/'request.json';request.write_bytes(request.read_bytes()+b' ')
            overrides={'evidenceManifest':moved/'evidence/manifest.json','ledgerPath':moved/'ledger.json','requestPath':request}
            with self.assertRaisesRegex(ValueError,'Saved input hash differs'):stage.verify_candidate(moved/'new',inputs_override=overrides,now=NOW)
    def test_relocation_raw_tamper_rejected(self):
        output=self.root/'new';stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now=NOW)
        with tempfile.TemporaryDirectory() as destination:
            moved=Path(destination)/'copy';shutil.copytree(self.root,moved)
            (moved/'evidence/0000000001/table.xml').write_bytes(b'changed raw')
            overrides={'evidenceManifest':moved/'evidence/manifest.json','ledgerPath':moved/'ledger.json','requestPath':moved/'request.json'}
            with self.assertRaisesRegex(ValueError,'Raw retrieval byte/hash/status mismatch'):stage.verify_candidate(moved/'new',inputs_override=overrides,now=NOW)
    def test_verified_artifacts_are_replay_not_later_reread(self):
        output=self.root/'new';stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now=NOW)
        before=copy.deepcopy(self.manifest)
        result=stage.verify_candidate(output,now=NOW,include_artifacts=True)
        rows=result['replayedArtifacts']['holdings.json'];self.assertEqual(sum(x['value'] for x in rows),4200)
        (output/'holdings.json').write_bytes(b'[]')
        self.assertEqual(sum(x['value'] for x in rows),4200)
        rows[0]['value']=999
        self.assertEqual(self.manifest,before)
        self.assertEqual(result['replayedArtifacts']['history.json'][0]['snapshot']['equityValueUsd'],100)
    def test_scope_change_invalidates_stage(self):
        output=self.root/'new';stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now=NOW)
        self.scope.write_bytes(self.scope.read_bytes()+b' ')
        with self.assertRaises(ValueError):stage.verify_candidate(output,now=NOW)
    def test_new_due_period_marks_recent_acquisition_historical(self):
        for item in self.report['retrievals']:item['retrievedAt']='2026-11-16T23:00:00Z'
        self.flush();output=self.root/'new'
        stage.stage_candidate(self.ev/'manifest.json',self.ledger,self.request,output,now='2026-11-16T23:00:00Z')
        with self.assertRaisesRegex(ValueError,'Current standard 45-day due period'):stage.verify_candidate(output,now='2026-11-17T00:00:00Z')
        result=stage.verify_candidate(output,now='2026-11-17T00:00:00Z',require_recent=False)
        self.assertTrue(result['stale']);self.assertEqual(result['displayMode'],'dated_historical_partial');self.assertFalse(result['activationEligible'])
    def test_due_period(self):
        from datetime import date
        self.assertEqual(stage.due_period(date(2026,11,5)),'2026-06-30');self.assertEqual(stage.due_period(date(2026,11,14)),'2026-06-30')
        self.assertEqual(stage.due_period(date(2026,11,16)),'2026-06-30')
        self.assertEqual(stage.due_period(date(2026,11,17)),'2026-09-30')
        self.assertEqual(stage.due_period(date(2026,2,17)),'2025-09-30')
        self.assertEqual(stage.due_period(date(2026,2,18)),'2025-12-31')
        self.assertEqual(stage.due_period(date(2026,8,14)),'2026-03-31')
        self.assertEqual(stage.due_period(date(2026,8,15)),'2026-06-30')

if __name__=='__main__':unittest.main()
