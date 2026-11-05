import unittest

from sec_insider_collector import parse_form4_xml


class Form4Tests(unittest.TestCase):
    def test_issuer_owners_and_security_come_from_distinct_source_fields(self):
        xml = b"""<ownershipDocument><documentType>4</documentType>
          <issuer><issuerCik>1170311</issuerCik><issuerName>PIMCO Fund</issuerName>
          <issuerTradingSymbol>PNI</issuerTradingSymbol></issuer>
          <reportingOwner><reportingOwnerId><rptOwnerName>Bank of America</rptOwnerName></reportingOwnerId>
          <reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
          <reportingOwner><reportingOwnerId><rptOwnerName>Merrill Lynch</rptOwnerName></reportingOwnerId>
          <reportingOwnerRelationship><isTenPercentOwner>true</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
          <nonDerivativeTable>
            <nonDerivativeTransaction>
              <securityTitle><value>Common Stock</value></securityTitle>
              <transactionDate><value>2026-10-21</value></transactionDate>
              <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
              <transactionAmounts><transactionShares><value>12170</value></transactionShares>
              <transactionPricePerShare><value>6.334</value></transactionPricePerShare></transactionAmounts>
              <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership></ownershipNature>
            </nonDerivativeTransaction>
            <nonDerivativeTransaction>
              <transactionAmounts><transactionShares><value>1</value></transactionShares>
              <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare></transactionAmounts>
            </nonDerivativeTransaction>
          </nonDerivativeTable>
          <footnotes><footnote id="F1">Between $5 and $10</footnote></footnotes>
        </ownershipDocument>"""
        rows = parse_form4_xml(xml, "0000070858-26-000508", "2026-10-23", "https://www.sec.gov/example")
        self.assertEqual(len(rows), 2)
        first, second = rows
        self.assertEqual((first["ticker"], first["issuerCik"], first["securityTitle"]),
                         ("PNI", "0001170311", "Common Stock"))
        self.assertEqual(first["insiderName"], "Bank of America · Merrill Lynch")
        self.assertFalse(first["directInsiderPurchase"])
        self.assertEqual((first["transDate"], first["filingDate"]), ("2026-10-21", "2026-10-23"))
        self.assertEqual((first["price"], first["totalValue"], first["ownership"]), (6.334, 77084.78, "I"))
        self.assertIsNone(second["price"])
        self.assertIsNone(second["totalValue"])
        self.assertIsNone(second["transDate"])

    def test_direct_company_purchase_and_weighted_average_exclude_plan(self):
        xml = b"""<ownershipDocument><documentType>4</documentType>
          <issuer><issuerCik>12927</issuerCik><issuerName>Boeing</issuerName>
          <issuerTradingSymbol>BA</issuerTradingSymbol></issuer>
          <reportingOwner><reportingOwnerId><rptOwnerName>Test Director</rptOwnerName></reportingOwnerId>
          <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>
          <nonDerivativeTable><nonDerivativeTransaction>
            <securityTitle><value>Common Stock</value></securityTitle>
            <transactionDate><value>2026-10-30</value></transactionDate>
            <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
            <transactionAmounts><transactionShares><value>2950</value></transactionShares>
            <transactionPricePerShare><value>173.026</value><footnoteId id="F1"/></transactionPricePerShare>
            <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
            <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
          </nonDerivativeTransaction></nonDerivativeTable>
          <footnotes><footnote id="F1">Weighted average purchase price</footnote></footnotes>
        </ownershipDocument>"""
        def parse(raw):
            return parse_form4_xml(raw, "0001225208-26-008641", "2026-11-02", "https://www.sec.gov/example")[0]

        self.assertTrue(parse(xml)["directInsiderPurchase"])
        self.assertEqual(parse(xml)["priceBasis"], "weightedAverage")
        self.assertFalse(parse(xml.replace(b"<value>D</value>", b"<value>I</value>"))["directInsiderPurchase"])
        self.assertFalse(parse(xml.replace(b"Weighted average purchase price", b"Purchased under the ESPP"))["directInsiderPurchase"])

    def test_missing_issuer_does_not_fall_back_to_the_reporter(self):
        with self.assertRaisesRegex(ValueError, "issuer identity"):
            parse_form4_xml(b"<ownershipDocument><documentType>4</documentType></ownershipDocument>",
                            "0000070858-26-000508", "2026-10-23", "https://www.sec.gov/example")
