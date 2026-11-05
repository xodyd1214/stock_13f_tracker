"""Build a new local audit+Pages release candidate. Does not contact any service.

Live acquisition is deliberately separate. The source manifest, identity ledger
and request must already exist and satisfy the fixed reviewed display policy.
"""
import argparse
import json
from pathlib import Path
import shutil
import tempfile

import sec_partial_stage as stage
from build_pages_bundle import build_bundle

def prepare(evidence_manifest, identity_ledger, request, source_tree, new_destination, *, now=None):
    output = Path(new_destination).absolute()
    if output != output.resolve() or output.exists() or not output.parent.is_dir():
        raise ValueError('New local non-symlink destination required')
    if output.is_relative_to(Path(evidence_manifest).resolve().parent):
        raise ValueError('Output must not be inside retained evidence')
    temporary = Path(tempfile.mkdtemp(prefix='.'+output.name+'-',dir=output.parent))
    try:
        stage.stage_candidate(evidence_manifest,identity_ledger,request,temporary/'audit',now=now)
        receipt = build_bundle(temporary/'audit',source_tree,temporary/'public',now=now)
        (temporary/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        if output.exists():
            raise ValueError('Destination appeared during preparation')
        temporary.rename(output)
        return receipt
    except BaseException:
        shutil.rmtree(temporary,ignore_errors=True)
        raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence_manifest');parser.add_argument('identity_ledger')
    parser.add_argument('request');parser.add_argument('source_tree');parser.add_argument('new_destination')
    args=parser.parse_args()
    receipt=prepare(args.evidence_manifest,args.identity_ledger,args.request,args.source_tree,args.new_destination)
    print(json.dumps({key:value for key,value in receipt.items() if key!='files'},indent=2))

if __name__=='__main__':main()
