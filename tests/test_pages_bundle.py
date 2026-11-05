"""Entirely SYNTHETIC source fixtures for local-only Pages preparation."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import test_partial_stage as fixture
from test_partial_stage import NOW
import sec_partial_stage as stage
import build_pages_bundle as bundle
from compact_projection import decode_rows

class PagesBundleTests(unittest.TestCase):
    def setUp(self):
        self.fx=fixture.PartialStageTests();self.fx.setUp();self.root=self.fx.root
        scope=json.loads(self.fx.scope.read_bytes());scope.update(schemaVersion=1,contract=bundle.CONTRACT)
        self.fx.write(self.fx.scope,scope)
        # The generic stage fixture shares an accession across synthetic CIKs.
        # Real SEC accession identifiers are globally unique; model that here.
        for manager in self.fx.manifest['managers']:
            cik=manager['cik'];old=next(iter(manager['filings']));new=cik+'-26-000001'
            oldflat,newflat=old.replace('-',''),new.replace('-','')
            filing=manager['filings'].pop(old);manager['filings'][new]=filing
            for key in ('primarySourceUrl','tableSourceUrl'):filing[key]=filing[key].replace(oldflat,newflat)
            for record in self.fx.report['retrievals']:
                if record['path'].startswith(cik+'/'):
                    record['sourceUrl']=record['sourceUrl'].replace(oldflat,newflat)
                    if record['path'].endswith(('/submissions.json','/final.json')):
                        path=self.fx.ev/record['path'];obj=json.loads(path.read_bytes())
                        obj['filings']['recent']['accessionNumber']=[new]
                        raw=stage.encoded(obj);path.write_bytes(raw);record.update(sha256=stage.sha(raw),bytes=len(raw))
        self.fx.flush()
        self.saved=self.root/'stage'
        stage.stage_candidate(self.fx.ev/'manifest.json',self.fx.ledger,self.fx.request,self.saved,now=NOW)
        self.source=self.root/'site-source';self.source.mkdir()
        for name in bundle.ASSETS:(self.source/name).write_text('SYNTHETIC TEST ASSET: '+name+'\n')
        (self.source/'latest_13f_holdings.json').write_text('UNTRUSTED LEGACY DATA')
        (self.source/'private-history.json').write_text('PRIVATE EVIDENCE')
        self.output=self.root/'public'
    def tearDown(self):self.fx.tearDown()
    def build(self):return bundle.build_bundle(self.saved,self.source,self.output,now=NOW)
    def test_lossless_hashed_public_tree_with_exact_scope(self):
        result=self.build();self.assertFalse(result['deployed']);self.assertEqual(result['availableLabels'],43)
        pointer=json.loads((self.output/'sec-data/current.json').read_bytes())
        directory=self.output/'sec-data/generations'/pointer['generationId']
        raw=(directory/'generation.json').read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),pointer['generationId'])
        for name,ref in json.loads(raw)['files'].items():
            data=(directory/name).read_bytes();self.assertEqual(len(data),ref['bytes']);self.assertEqual(hashlib.sha256(data).hexdigest(),ref['sha256'])
        rows=decode_rows(json.loads((directory/'projection.json').read_bytes()))
        self.assertEqual(rows,json.loads((self.saved/'holdings.json').read_bytes()))
        manifest=json.loads((directory/'manifest.json').read_bytes());self.assertNotIn('inputs',manifest)
        self.assertEqual(len(manifest['sources']),42);self.assertFalse(manifest['releaseEligible']);self.assertFalse(manifest['migrationReady'])
        self.assertEqual(manifest['totalEquityValueUsd'],4200)
        coverage=json.loads((directory/'coverage.json').read_bytes());self.assertEqual(len(coverage['labels']),50)
        self.assertEqual(sum(x['status']=='verification-pending' for x in coverage['labels']),7)
        self.assertFalse((self.output/'latest_13f_holdings.json').exists());self.assertFalse((self.output/'private-history.json').exists())
        for path in self.output.rglob('*'):
            if path.is_file():self.assertNotIn(str(self.root).encode(),path.read_bytes())
    def test_existing_output_not_modified(self):
        self.output.mkdir();(self.output/'keep').write_text('unchanged')
        with self.assertRaises(ValueError):self.build()
        self.assertEqual((self.output/'keep').read_text(),'unchanged')
    def test_output_cannot_pollute_retained_stage(self):
        self.output=self.saved/'public'
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists());self.assertTrue(stage.verify_candidate(self.saved,now=NOW)['activationEligible'])
    def test_output_cannot_pollute_retained_evidence(self):
        self.output=self.fx.ev/'public'
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists());self.assertTrue(stage.verify_candidate(self.saved,now=NOW)['activationEligible'])
    def test_expiry_during_write_rejects_and_cleans(self):
        real=bundle.os.fsync
        clock_patch=None
        def expire(fd):
            nonlocal clock_patch
            if clock_patch is None:
                clock_patch=patch.object(stage,'clock',return_value=stage.timestamp('2026-11-07T11:00:00Z'))
                clock_patch.start()
            return real(fd)
        try:
            with patch.object(bundle.os,'fsync',side_effect=expire),self.assertRaises(ValueError):self.build()
        finally:
            if clock_patch is not None:clock_patch.stop()
        self.assertFalse(self.output.exists());self.assertEqual(list(self.root.glob('.public-*')),[])
    def test_tampered_stage_fails_without_output(self):
        (self.saved/'holdings.json').write_bytes(b'[]')
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())
    def test_stale_activation_fails_without_output(self):
        with self.assertRaises(ValueError):bundle.build_bundle(self.saved,self.source,self.output,now='2026-11-07T11:00:00Z')
        self.assertFalse(self.output.exists())
    def test_missing_asset_fails_without_output(self):
        (self.source/'latest_form4_insiders.json').unlink()
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())
    def test_symlink_asset_fails_without_output(self):
        target=self.source/'app.js';target.unlink();target.symlink_to(self.source/'style.css')
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())
    def test_projection_budget_fails_without_output(self):
        with patch.object(bundle,'MAX_PROJECTION',1),self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())
    def test_same_inputs_make_same_generation(self):
        first=self.build();self.output=self.root/'second';second=self.build()
        self.assertEqual(first['generationId'],second['generationId'])
    def test_write_failure_cleans_temporary_tree(self):
        with patch.object(bundle.os,'fsync',side_effect=OSError('SYNTHETIC disk failure')),self.assertRaises(OSError):self.build()
        self.assertFalse(self.output.exists());self.assertEqual(list(self.root.glob('.public-*')),[])
    def test_post_verification_mutation_never_changes_export(self):
        original=stage.verify_candidate
        def change_after_replay(*args,**kwargs):
            verified=original(*args,**kwargs)
            rows=json.loads((self.saved/'holdings.json').read_bytes())
            rows[0]['value']*=2;rows[0]['valueUsd']*=2;rows[0]['sourceReportedValue']*=2
            (self.saved/'holdings.json').write_bytes(stage.encoded(rows))
            saved=json.loads((self.saved/'manifest.json').read_bytes());saved['totalEquityValueUsd']+=100
            (self.saved/'manifest.json').write_bytes(stage.encoded(saved))
            return verified
        with patch.object(stage,'verify_candidate',side_effect=change_after_replay):result=self.build()
        self.assertEqual(result['totalEquityValueUsd'],4200)
        directory=self.output/'sec-data/generations'/result['generationId']
        rows=decode_rows(json.loads((directory/'projection.json').read_bytes()))
        self.assertEqual(rows[0]['value'],100)
    def test_policy_change_during_write_rejects_and_cleans(self):
        real=bundle.os.fsync;changed=False
        def alter_policy(fd):
            nonlocal changed
            if not changed:self.fx.scope.write_bytes(self.fx.scope.read_bytes()+b' ');changed=True
            return real(fd)
        with patch.object(bundle.os,'fsync',side_effect=alter_policy),self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists());self.assertEqual(list(self.root.glob('.public-*')),[])
    def test_incomplete_partial_cannot_be_exported(self):
        self.fx.manifest['managers'][0]['acquisitionError']='SYNTHETIC failed';self.fx.flush()
        other=self.root/'failed-stage';stage.stage_candidate(self.fx.ev/'manifest.json',self.fx.ledger,self.fx.request,other,now=NOW)
        with self.assertRaises(ValueError):bundle.build_bundle(other,self.source,self.output,now=NOW)
        self.assertFalse(self.output.exists())

if __name__=='__main__':unittest.main()
