"""Offline local orchestration tests using explicitly synthetic data."""
import json
from unittest.mock import patch
import unittest
from pathlib import Path
import tempfile
import prepare_partial_release as release

class ReleasePreparationTests(unittest.TestCase):
    def test_failure_does_not_expose_partial_directory(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'new'
            def create_stage(*args,**kwargs):Path(args[3]).mkdir()
            with patch.object(release.stage,'stage_candidate',side_effect=create_stage),patch.object(release,'build_bundle',side_effect=ValueError('SYNTHETIC gate failed')):
                with self.assertRaises(ValueError):release.prepare('e','l','r','source',output)
            self.assertFalse(output.exists());self.assertEqual(list(Path(d).iterdir()),[])
    def test_local_complete_directory_exposed_only_after_success(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'new'
            def create_stage(*args,**kwargs):Path(args[3]).mkdir()
            def create_site(*args,**kwargs):Path(args[2]).mkdir();return {'deployed':False,'fixture':'SYNTHETIC'}
            with patch.object(release.stage,'stage_candidate',side_effect=create_stage),patch.object(release,'build_bundle',side_effect=create_site):
                result=release.prepare('e','l','r','source',output)
            self.assertFalse(result['deployed']);self.assertTrue((output/'audit').is_dir());self.assertTrue((output/'public').is_dir())
            self.assertEqual(json.loads((output/'build-receipt.json').read_text()),result)
    def test_existing_output_never_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):release.prepare('e','l','r','source',d)
