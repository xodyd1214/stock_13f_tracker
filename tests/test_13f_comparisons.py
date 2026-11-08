import unittest

from build_13f_comparisons import compare, previous_quarter


def position(cusip, shares, title='COM', put_call=''):
    return {'cusip': cusip, 'shares': shares, 'titleOfClass': title, 'shareType': 'SH', 'putCall': put_call}


def report(rows, *, report_type='13F HOLDINGS REPORT', omitted=False):
    return {'rows': rows, 'components': [{'reportType': report_type,
        'confidentialDisclosures': [{'text': str(omitted)}]}]}


class HoldingsComparisonTests(unittest.TestCase):
    def test_exact_share_class_and_prior_report_absence(self):
        current = report([position('000000001', 130), position('000000002', 70),
                          position('000000003', 5, 'CL A'), position('000000004', 4)])
        previous = report([position('000000001', 60), position('000000001', 40),
                           position('000000003', 5, 'CL B'), position('000000004', 1, put_call='CALL')])
        self.assertEqual(compare(current, previous, []), [['000000001', 100], ['000000002', None]])

    def test_omissions_and_combination_reports_prevent_new_disclosure_claims(self):
        current = report([position('000000001', 130), position('000000002', 70)])
        for earlier in (report([position('000000001', 100)], omitted=True),
                        report([position('000000001', 100)], report_type='13F COMBINATION REPORT')):
            self.assertEqual(compare(current, earlier, []), [['000000001', 100]])
        self.assertEqual(previous_quarter('2026-03-31'), '2025-12-31')
        self.assertEqual(previous_quarter('2026-09-30'), '2026-06-30')
