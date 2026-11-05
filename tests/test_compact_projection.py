from copy import deepcopy
import unittest
from compact_projection import ProjectionError,encode_rows,decode_rows

class CompactProjectionTests(unittest.TestCase):
    def rows(self):
        return [{'cik':'0000000001','accessionNumber':'0000000001-26-000001','value':100+i,'shares':10,
                 'name':'Synthetic issuer '+str(i),'sourceValue':str(100+i),'option':None,
                 'rawSource':{'shareType':'SH','sourceValue':str(100+i),'voting':{'Sole':'010','Shared':'0','None':'0'}},
                 'components':[{'accession':'0000000001-26-000001','hash':'a'*64}],'empty':{},'present':False}
                for i in range(3)]
    def test_lossless_nested_rows_and_input_immutability(self):
        rows=self.rows(); before=deepcopy(rows); projection=encode_rows(rows)
        self.assertEqual(decode_rows(projection),rows);self.assertEqual(rows,before)
        self.assertEqual(encode_rows(rows),projection)
        self.assertEqual(len(projection['groups']),1)
    def test_missing_and_null_and_types_are_not_collapsed(self):
        rows=self.rows();del rows[1]['option'];rows[2]['present']=0
        self.assertEqual(decode_rows(encode_rows(rows)),rows)
        self.assertNotIn('option',decode_rows(encode_rows(rows))[1])
    def test_order_preserved_across_interleaved_sources(self):
        rows=self.rows();rows[1]['cik']='0000000002'
        self.assertEqual(decode_rows(encode_rows(rows)),rows)
        self.assertEqual(len(encode_rows(rows)['groups']),3)
    def test_unsafe_keys_and_paths_rejected(self):
        for key in ['__proto__','constructor','prototype']:
            with self.subTest(key=key),self.assertRaises(ProjectionError):encode_rows([{key:1}])
    def test_duplicate_prefix_and_wrong_counts_rejected(self):
        original=encode_rows(self.rows())
        for kind in ['duplicate','prefix','columns','count']:
            p=deepcopy(original);g=p['groups'][0]
            if kind=='duplicate':g['common'].append(deepcopy(g['common'][0]))
            if kind=='prefix':g['common'].append([['rawSource'],{}])
            if kind=='columns':g['rows'][0].append('extra')
            if kind=='count':p['rowCount']+=1
            with self.subTest(kind=kind),self.assertRaises(ProjectionError):decode_rows(p)
    def test_empty_projection_is_explicit_not_missing(self):
        self.assertEqual(decode_rows(encode_rows([])),[])

if __name__=='__main__':unittest.main()
