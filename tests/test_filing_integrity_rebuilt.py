"""New synthetic unit fixtures, not captured filings or production evidence."""
import copy
import hashlib
import unittest
from sec_filing_integrity import IntegrityError, reconcile_filing, resolve_period_snapshot, equity_rows, is_reported_equity, validate_share_class_policy


def synthetic(number=0, kind=None, value='00100', shares='00010', security='COM', share_type='SH', option=None, filing='2026-02-02', period='12-31-2025', voting='00010', cusip='000000001'):
    accession = f'0000000001-26-{number+1:06d}'
    amendment = f'<amendmentNo>{number}</amendmentNo><amendmentInfo><amendmentType>{kind}</amendmentType></amendmentInfo>' if kind else ''
    form = '13F-HR/A' if kind else '13F-HR'
    primary = f'''<edgarSubmission><headerData><submissionType>{form}</submissionType><filerInfo><filer><credentials><cik>1</cik></credentials></filer><periodOfReport>{period}</periodOfReport></filerInfo></headerData><formData><coverPage><reportCalendarOrQuarter>{period}</reportCalendarOrQuarter><filingManager><name>SYNTHETIC FIXTURE ONLY</name></filingManager><isAmendment>{str(bool(kind)).lower()}</isAmendment>{amendment}<reportType>13F HOLDINGS REPORT</reportType></coverPage><summaryPage><tableEntryTotal>1</tableEntryTotal><tableValueTotal>{value}</tableValueTotal><isConfidentialOmitted>true</isConfidentialOmitted></summaryPage></formData></edgarSubmission>'''.encode()
    table = f'''<informationTable><infoTable><nameOfIssuer>SYNTHETIC ONLY</nameOfIssuer><titleOfClass>{security}</titleOfClass><cusip>{cusip}</cusip><value>{value}</value><shrsOrPrnAmt><sshPrnamt>{shares}</sshPrnamt><sshPrnamtType>{share_type}</sshPrnamtType></shrsOrPrnAmt><putCall>{option}</putCall><investmentDiscretion>SOLE</investmentDiscretion><votingAuthority><Sole>{voting}</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable></informationTable>'''.encode()
    if option is None:
        table = table.replace(b'<putCall>None</putCall>', b'')
    from datetime import datetime
    metadata = {'cik': '0000000001', 'accessionNumber': accession, 'form': form,
                'reportDate': datetime.strptime(period, '%m-%d-%Y').date().isoformat(), 'filingDate': filing,
                'acceptanceDateTime': filing + f'T12:00:{number:02d}Z'}
    prefix = f'https://www.sec.gov/Archives/edgar/data/1/{accession.replace("-", "")}/'
    return [primary, table, metadata, prefix + 'primary.xml', prefix + 'table.xml']


def filing(**kwargs):
    return reconcile_filing(*synthetic(**kwargs))


class RebuiltIntegrityTests(unittest.TestCase):
    def fund_policy(self):
        return [{'cusip':'25459Y207','issuer':'DIREXION SHARES ETF TRUST','titleOfClass':'NASDAQ 100 EQ WT','classification':'fund_share','evidence':[{'url':'https://example.test/SYNTHETIC-fixture.pdf','sha256':'a'*64,'title':'SYNTHETIC test-only identity proof','checkedAt':'2026-01-01T00:00:00Z'}]}]

    def fund_filing(self, **kwargs):
        args=synthetic(cusip='25459Y207',security='NASDAQ 100 EQ WT',**kwargs)
        args[1]=args[1].replace(b'<nameOfIssuer>SYNTHETIC ONLY</nameOfIssuer>',b'<nameOfIssuer>DIREXION SHARES ETF TRUST</nameOfIssuer>')
        return reconcile_filing(*args)

    def test_exact_fund_policy_does_not_override_source_option_or_principal(self):
        policy=self.fund_policy();f=self.fund_filing();row=f['rows'][0]
        self.assertFalse(is_reported_equity(row));self.assertTrue(is_reported_equity(row,policy))
        for kwargs in ({'option':'Call'},{'option':'Put'},{'share_type':'PRN'}):
            self.assertFalse(is_reported_equity(self.fund_filing(**kwargs)['rows'][0],policy))
        for key,value in (('issuer','WRONG'),('name','WRONG'),('titleOfClass','OTHER WT'),('cusip','999999999'),('isOption',True),('optionType','PUT')):
            altered=copy.deepcopy(row);altered[key]=value
            self.assertFalse(is_reported_equity(altered,policy),(key,value))
        for raw in ({}, {'putCall':''}, {'putCall':' '}):
            altered=copy.deepcopy(row);altered['rawSource']=raw;self.assertFalse(is_reported_equity(altered,policy))
        wrong=copy.deepcopy(policy);wrong[0]['titleOfClass']='WARRANT'
        altered=copy.deepcopy(row);altered['titleOfClass']='WARRANT'
        self.assertFalse(is_reported_equity(altered,wrong))

    def test_position_partition_exact_and_ambiguous_not_silently_equity(self):
        f=self.fund_filing();before=copy.deepcopy(f)
        unresolved=resolve_period_snapshot([f],[f['accession']])
        self.assertEqual(unresolved['classificationSummary']['unresolved_share_class']['rowCount'],1)
        resolved=resolve_period_snapshot([f],[f['accession']],self.fund_policy())
        self.assertEqual(resolved['classificationSummary']['equity_verified_fund_share'],{'rowCount':1,'reportedValueUsd':100})
        self.assertEqual(sum(v['rowCount'] for v in resolved['classificationSummary'].values()),len(resolved['rows']))
        self.assertEqual(sum(v['reportedValueUsd'] for v in resolved['classificationSummary'].values()),resolved['reportedValueUSD'])
        self.assertEqual(f,before)

    def test_classification_evidence_required(self):
        for transform in (lambda p:p[0].update(evidence=[]),lambda p:p[0]['evidence'][0].update(sha256='bad'),lambda p:p.append(copy.deepcopy(p[0]))):
            policy=self.fund_policy();transform(policy)
            with self.assertRaises(IntegrityError):validate_share_class_policy(policy)

    def test_exact_raw_preserved(self):
        args = synthetic(value=' 00100 ', shares='00010')
        before = copy.deepcopy(args)
        result = reconcile_filing(*args)
        self.assertEqual(args, before)
        self.assertEqual(result['rows'][0]['sourceValue'], ' 00100 ')
        self.assertEqual(result['rows'][0]['sourceShares'], '00010')
        self.assertEqual(result['reportedValueUSD'], 100)
        self.assertEqual(result['tableSha256'], hashlib.sha256(args[1]).hexdigest())
        self.assertTrue(result['confidentialDisclosures'])
        self.assertEqual(result['rows'][0]['sourceUrl'], args[4])

    def test_units_by_filing_date(self):
        self.assertEqual(filing(filing='2023-01-02', period='12-31-2022')['reportedValueUSD'], 100000)
        self.assertEqual(filing(filing='2023-01-03', period='12-31-2022')['reportedValueUSD'], 100)

    def test_wrong_cik_not_other_manager(self):
        args = synthetic()
        args[0] = args[0].replace(b'<cik>1</cik>', b'<cik>2</cik>').replace(b'</coverPage>', b'<otherManager><cik>1</cik></otherManager></coverPage>')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_summary_count_and_total(self):
        for old, new in [(b'<tableEntryTotal>1', b'<tableEntryTotal>2'), (b'<tableValueTotal>00100', b'<tableValueTotal>99')]:
            args = synthetic(); args[0] = args[0].replace(old, new)
            with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_missing_or_invalid_share_type(self):
        for share_type in ('', 'UNKNOWN', 'SHARE'):
            with self.assertRaises(IntegrityError): filing(share_type=share_type)
        args = synthetic(); args[1] = args[1].replace(b'<sshPrnamtType>SH</sshPrnamtType>', b'')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_options_and_classes(self):
        for kwargs in ({'option':'PUT'}, {'option':'CALL'}, {'share_type':'PRN'}, {'security':'WARRANTS'}, {'security':'COM OPTION'}):
            self.assertEqual(equity_rows(filing(**kwargs)), [])
        self.assertEqual(len(equity_rows(filing(security='BOND FUND'))), 1)
        args = synthetic(); args[1] = args[1].replace(b'<putCall></putCall>', b'')
        self.assertEqual(len(equity_rows(reconcile_filing(*args))), 1)
        with self.assertRaises(IntegrityError): filing(option='UNKNOWN')

    def test_optional_amendment_flag_on_original_only(self):
        args = synthetic()
        args[0] = args[0].replace(b'<isAmendment>false</isAmendment>', b'')
        result = reconcile_filing(*args)
        self.assertFalse(result['isAmendment'])
        self.assertIsNone(result['sourceIsAmendment'])
        args[0] = args[0].replace(b'</coverPage>', b'<amendmentNo>1</amendmentNo></coverPage>')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)
        args = synthetic(number=1, kind='RESTATEMENT')
        args[0] = args[0].replace(b'<isAmendment>true</isAmendment>', b'')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_sec_option_enum_spelling_preserved(self):
        for source, canonical in [('Put', 'PUT'), ('Call', 'CALL')]:
            result = filing(option=source)
            row = result['rows'][0]
            self.assertEqual(row['putCall'], canonical)
            self.assertEqual(row['rawSource']['putCall'], source)
            self.assertTrue(row['isOption'])
            self.assertEqual(equity_rows(result), [])
        with self.assertRaises(IntegrityError): filing(option='put or call')

    def test_explicit_empty_option_declaration_rejected(self):
        for source in ('', ' ', '\t\n'):
            with self.subTest(source=source), self.assertRaises(IntegrityError):
                filing(option=source)
        args = synthetic()
        args[1] = args[1].replace(b'<investmentDiscretion>', b'<putCall/><investmentDiscretion>')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)
        self.assertIsNone(filing()['rows'][0]['rawSource']['putCall'])

    def test_integer_grammar(self):
        for value in ('1.0', '-1', '+1', '1,000', '1e2', 'NaN'):
            with self.subTest(value=value), self.assertRaises(IntegrityError): filing(value=value)

    def test_unsafe_and_ambiguous_xml(self):
        for transform in (lambda b: b + b'<extra/>', lambda b: b'<!DOCTYPE informationTable [<!ENTITY x "1">]>' + b,
                          lambda b: b.replace(b'<value>00100</value>', b'<value>00100</value><value>00100</value>')):
            args = synthetic(); args[1] = transform(args[1])
            with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_metadata_and_chronology(self):
        for key, value in [('form', '13F-NT'), ('reportDate', '2025-09-30'), ('filingDate', '2025-12-30')]:
            args = synthetic(); args[2][key] = value
            with self.assertRaises(IntegrityError): reconcile_filing(*args)
        with self.assertRaises(IntegrityError): filing(period='12-30-2025')

    def test_bad_source_urls(self):
        for transform in (lambda s:s.replace('www.sec.gov', 'www.sec.gov.evil.test'),lambda s:s.replace('/data/1/', '/data/2/'),lambda s:s+'?x=1',lambda s:s.replace('https:', 'http:')):
            args = synthetic(); args[4] = transform(args[4])
            with self.assertRaises(IntegrityError): reconcile_filing(*args)

    def test_latest_restatement(self):
        entries = [filing(), filing(number=1, kind='RESTATEMENT', value='200'), filing(number=2, kind='RESTATEMENT', value='300')]
        result = resolve_period_snapshot(entries, [f['accession'] for f in entries])
        self.assertEqual(result['reportedValueUSD'], 300)
        self.assertEqual(len(result['components']), 1)
        self.assertEqual(result['componentAccessions'], [entries[-1]['accession']])

    def test_addition_chain_and_immutable(self):
        entries = [filing(), filing(number=1, kind='NEW HOLDINGS', cusip='000000002')]
        before = copy.deepcopy(entries)
        result = resolve_period_snapshot(entries, [f['accession'] for f in entries])
        self.assertEqual(result['reportedValueUSD'], 200)
        self.assertEqual(result['equityRowCount'], 2)
        result['rows'][0]['shares'] = 999
        self.assertEqual(entries, before)

    def test_same_cusip_different_financial_row_not_deduped(self):
        entries = [filing(), filing(number=1, kind='NEW HOLDINGS', value='200')]
        self.assertEqual(len(resolve_period_snapshot(entries, [f['accession'] for f in entries])['rows']), 2)

    def test_duplicate_financial_rows_normalized(self):
        entries = [filing(), filing(number=1, kind='NEW HOLDINGS', voting='10', security=' com ')]
        with self.assertRaises(IntegrityError): resolve_period_snapshot(entries, [f['accession'] for f in entries])

    def test_gap_missing_duplicate_mixed_period(self):
        base = filing(); addition = filing(number=2, kind='NEW HOLDINGS', cusip='000000002')
        for entries, required in [([base, addition], [base['accession'], addition['accession']]), ([base], [base['accession'], addition['accession']]), ([base,base], [base['accession']]), ([base, filing(number=1, kind='RESTATEMENT', period='09-30-2025')], [base['accession'], filing(number=1, kind='RESTATEMENT')['accession']])]:
            with self.assertRaises(IntegrityError): resolve_period_snapshot(entries, required)

    def test_qualified_acceptance_adjacent_utc_date(self):
        args = synthetic()
        args[2]['acceptanceDateTime'] = '2026-02-03T01:00:00Z'
        base = reconcile_filing(*args)
        self.assertEqual(base['filingDate'], '2026-02-02')
        args = synthetic(number=1, kind='NEW HOLDINGS', cusip='000000002')
        args[2]['acceptanceDateTime'] = '2026-02-02T21:00:00-05:00'
        addition = reconcile_filing(*args)
        result = resolve_period_snapshot([addition, base], [base['accession'], addition['accession']])
        self.assertEqual(result['componentAccessions'], [base['accession'], addition['accession']])
        self.assertEqual(result['acceptanceDateTime'], '2026-02-02T21:00:00-05:00')

    def test_naive_acceptance_rejected(self):
        args = synthetic()
        args[2]['acceptanceDateTime'] = '2026-02-02T12:00:00'
        with self.assertRaises(IntegrityError): reconcile_filing(*args)
        base = filing()
        base['acceptanceDateTime'] = '2026-02-02T12:00:00'
        with self.assertRaises(IntegrityError): resolve_period_snapshot([base], [base['accession']])
        restatement = filing(number=1, kind='RESTATEMENT', filing='2026-02-03')
        restatement['acceptanceDateTime'] = None
        with self.assertRaises(IntegrityError): resolve_period_snapshot([base, restatement], [base['accession'], restatement['accession']])

    def test_unknown_acceptance_additions(self):
        entries = [filing(), filing(number=1, kind='NEW HOLDINGS', cusip='000000002')]
        entries[0]['acceptanceDateTime'] = None
        with self.assertRaises(IntegrityError): resolve_period_snapshot(entries, [f['accession'] for f in entries])

    def test_original_without_acceptance_and_distinct_date_restatement(self):
        entries = [filing(), filing(number=1, kind='RESTATEMENT', filing='2026-02-03')]
        for f in entries: f['acceptanceDateTime'] = None
        self.assertEqual(len(resolve_period_snapshot(entries, [f['accession'] for f in entries])['rows']), 1)
        entries[1]['filingDate'] = entries[0]['filingDate']
        with self.assertRaises(IntegrityError): resolve_period_snapshot(entries, [f['accession'] for f in entries])

    def test_addition_before_restatement_blocks(self):
        entries = [filing(), filing(number=1, kind='NEW HOLDINGS', cusip='000000002'), filing(number=2, kind='RESTATEMENT')]
        with self.assertRaises(IntegrityError): resolve_period_snapshot(entries, [f['accession'] for f in entries])

    def test_combination_preserved_and_notice_blocked(self):
        args = synthetic(); args[0] = args[0].replace(b'13F HOLDINGS REPORT', b'13F COMBINATION REPORT')
        self.assertEqual(reconcile_filing(*args)['reportType'], '13F COMBINATION REPORT')
        args[0] = args[0].replace(b'13F COMBINATION REPORT', b'13F NOTICE')
        with self.assertRaises(IntegrityError): reconcile_filing(*args)

if __name__ == '__main__': unittest.main()
