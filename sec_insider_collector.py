"""Collect SEC Form 4 Table I transactions with issuer and reporter separated."""
from datetime import date
from decimal import Decimal, InvalidOperation
import math
import re
import time
import xml.etree.ElementTree as ET

import requests

from data_io import atomic_write_json, load_json


KEY_TICKERS = [
    # 빅테크 & 메가캡
    "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "BRK-B", "AVGO",
    # 반도체 & AI & 하드웨어
    "AMD", "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "ADI", "ARM", "SMCI", "DELL", "HPQ", "ASML", "TSM",
    # 소프트웨어 & 클라우드 & 사이버보안
    "PLTR", "CRM", "ORCL", "NOW", "PANW", "SNOW", "CRWD", "DDOG", "ADBE", "INTU", "WDAY", "ZS", "FTNT", "NET",
    # 금융 & 결제
    "JPM", "BAC", "WFC", "C", "GS", "MS", "V", "MA", "AXP", "PYPL", "COIN", "SCHW", "BLK", "PNC",
    # 헬스케어 & 제약 & 바이오
    "LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "ISRG", "AMGN", "BMY", "GILD", "VRTX",
    # 소비재 & 유통 & 이커머스
    "WMT", "COST", "HD", "PG", "KO", "PEP", "MCD", "NKE", "SBUX", "TGT", "LOW", "PM", "MO", "EL",
    # 산업 & 항공 & 물류 & 에너지
    "CAT", "GE", "BA", "HON", "UPS", "FDX", "UNP", "DE", "RTX", "LMT", "XOM", "CVX", "COP", "SLB",
    # 미디어 & 통신 & 모빌리티
    "NFLX", "DIS", "CMCSA", "TMUS", "VZ", "T", "UBER", "ABNB", "DASH", "BKNG", "SPOT"
]


def ownership_xml(submission):
    for document in submission.split(b"<DOCUMENT>")[1:]:
        if re.match(rb"\s*<TYPE>4\s", document):
            match = re.search(rb"<ownershipDocument(?:\s[^>]*)?>.*?</ownershipDocument>", document, re.S)
            if match:
                return match.group()
    raise ValueError("Form 4 ownership document missing")


def field(node, path):
    return (node.findtext(path) or "").strip()


def number(node, path):
    value = field(node, path)
    if not value:
        return None
    try:
        parsed = Decimal(value)
        if parsed.is_finite() and math.isfinite(float(parsed)):
            return parsed
    except InvalidOperation:
        pass
    raise ValueError(f"Invalid Form 4 number at {path}")


COMMON_SHARE_TITLE = re.compile(
    r"^(?:class [a-z0-9]+ )?(?:common stock|common shares?|ordinary shares?)"
    r"(?:,\s*(?:\$[0-9.]+\s*)?par value.*|\s*\([a-z0-9.]+\))?$",
    re.IGNORECASE,
)
PLAN_PURCHASE = re.compile(
    r"employee stock purchase plan|dividend reinvestment plan|\bESPP\b|\bDRIP\b",
    re.IGNORECASE,
)


def tracked_issuer_ciks(tickers):
    return {str(tickers[ticker]["cik"]).zfill(10) for ticker in KEY_TICKERS if ticker in tickers}


def linked_notes(node, notes):
    if node is None:
        return ""
    return " ".join(notes.get(ref.get("id"), "") for ref in node.findall(".//footnoteId"))


def parse_form4_xml(xml_content, accession, filing_date, source_url):
    root = ET.fromstring(xml_content)
    if root.tag != "ownershipDocument" or field(root, "documentType") != "4":
        raise ValueError("Expected an original Form 4")
    date.fromisoformat(filing_date)
    cik = field(root, "issuer/issuerCik")
    company = field(root, "issuer/issuerName")
    if not re.fullmatch(r"[0-9]{1,10}", cik) or int(cik) == 0 or not company:
        raise ValueError("Form 4 issuer identity missing")
    ticker = field(root, "issuer/issuerTradingSymbol").upper()
    if ticker in {"N/A", "NA", "NONE", "NOT APPLICABLE", "-"}:
        ticker = ""

    owner_nodes = root.findall("reportingOwner")
    owners = []
    for owner in owner_nodes:
        name = field(owner, "reportingOwnerId/rptOwnerName")
        if not name:
            continue
        relationship = owner.find("reportingOwnerRelationship")
        roles = []
        officer = director = False
        if relationship is not None:
            officer = field(relationship, "isOfficer").lower() in ("1", "true")
            director = field(relationship, "isDirector").lower() in ("1", "true")
            if officer:
                roles.append(field(relationship, "officerTitle") or "임원")
            if director:
                roles.append("이사")
            if field(relationship, "isTenPercentOwner").lower() in ("1", "true"):
                roles.append("10% 초과 보유자로 신고")
            if field(relationship, "isOther").lower() in ("1", "true"):
                roles.append(field(relationship, "otherText") or "기타 관계")
        owners.append((name, " / ".join(dict.fromkeys(roles)) or "관계 미기재", officer, director))
    if not owners:
        raise ValueError("Form 4 reporting owner missing")

    names = " · ".join(dict.fromkeys(name for name, _, _, _ in owners))
    roles = {role for _, role, _, _ in owners}
    relation = owners[0][1] if len(roles) == 1 else " · ".join(f"{name} ({role})" for name, role, _, _ in owners)
    sole_officer_or_director = len(owner_nodes) == 1 and (owners[0][2] or owners[0][3])
    notes = {note.get("id"): "".join(note.itertext()) for note in root.findall("footnotes/footnote")}
    plan_mentioned = PLAN_PURCHASE.search(" ".join([field(root, "remarks"), *notes.values()]))
    rows = []
    for transaction in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        title = field(transaction, "securityTitle/value")
        code = field(transaction, "transactionCoding/transactionCode")
        traded = field(transaction, "transactionDate/value") or None
        if traded:
            date.fromisoformat(traded)
        shares = number(transaction, "transactionAmounts/transactionShares/value")
        price = number(transaction, "transactionAmounts/transactionPricePerShare/value")
        post = number(transaction, "postTransactionAmounts/sharesOwnedFollowingTransaction/value")
        ownership = field(transaction, "ownershipNature/directOrIndirectOwnership/value")
        acquired = field(transaction, "transactionAmounts/transactionAcquiredDisposedCode/value")
        price_notes = linked_notes(transaction.find("transactionAmounts/transactionPricePerShare"), notes)
        if re.search(r"\bweighted[- ]average\b", price_notes, re.IGNORECASE):
            price_basis = "weightedAverage"
        elif re.search(r"multiple (?:trades|transactions|executions)", price_notes, re.IGNORECASE):
            price_basis = "multipleExecutions"
        else:
            price_basis = None
        direct_purchase = (
            sole_officer_or_director and code == "P" and acquired == "A" and ownership == "D"
            and bool(traded and COMMON_SHARE_TITLE.fullmatch(title))
            and shares is not None and shares > 0 and price is not None and price > 0
            and not plan_mentioned
        )
        rows.append({
            "filingDate": filing_date,
            "transDate": traded,
            "issuerCik": cik.zfill(10),
            "ticker": ticker,
            "companyName": company,
            "securityTitle": title or None,
            "insiderName": names,
            "officerTitle": relation,
            "isOfficer": any(officer for _, _, officer, _ in owners),
            "txTypeCode": code,
            "ownership": ownership,
            "directInsiderPurchase": direct_purchase,
            "priceBasis": price_basis,
            "shares": float(shares) if shares is not None else None,
            "price": float(price) if price is not None else None,
            "totalValue": float(shares * price) if shares is not None and price is not None else None,
            "postShares": float(post) if post is not None else None,
            "accessionNumber": accession,
            "secUrl": source_url,
        })
    return rows


def snapshot(rows, *, verified_filings, source_filings, issuer_ciks):
    scoped_rows = [
        {**row, "directInsiderPurchase": row["directInsiderPurchase"] and row["issuerCik"] in issuer_ciks}
        for row in rows
    ]
    return {
        "schemaVersion": 1,
        "sourceFilings": source_filings,
        "verifiedFilings": verified_filings,
        "transactions": sorted(scoped_rows, key=lambda row: row["filingDate"], reverse=True),
    }


def collect():
    """Publish atomically only after all requested SEC responses have parsed."""
    tickers = load_json("sec_cik_master.json")
    rows, seen = [], set()
    with requests.Session() as session:
        session.headers["User-Agent"] = "AlphaInsiderTracker xodyd1214@gmail.com"

        def fetch(url):
            time.sleep(.2)
            response = session.get(url, timeout=15)
            response.raise_for_status()
            return response

        for ticker in KEY_TICKERS:
            if ticker not in tickers:
                continue
            cik = tickers[ticker]["cik"]
            recent = fetch(f"https://data.sec.gov/submissions/CIK{cik}.json").json()["filings"]["recent"]
            columns = [recent[key] for key in ("form", "accessionNumber", "filingDate")]
            if len({len(column) for column in columns}) != 1:
                raise ValueError(f"Mismatched SEC submission columns for {cik}")
            filings = [(accession, filed) for form, accession, filed in zip(*columns) if form == "4"]
            for accession, filed in filings[:15]:
                if accession in seen:
                    continue
                if not re.fullmatch(r"[0-9]{10}-[0-9]{2}-[0-9]{6}", accession):
                    raise ValueError("Invalid SEC accession")
                base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}"
                raw = fetch(f"{base}/{accession}.txt").content
                rows.extend(parse_form4_xml(ownership_xml(raw), accession, filed, f"{base}/{accession}-index.htm"))
                seen.add(accession)

    if not rows:
        raise ValueError("No Form 4 transactions returned")
    return snapshot(rows, verified_filings=len(seen), source_filings=len(seen), issuer_ciks=tracked_issuer_ciks(tickers))


if __name__ == "__main__":
    result = collect()
    atomic_write_json("latest_form4_insiders.json", result)
    print(f"Saved {len(result['transactions'])} transactions from {result['verifiedFilings']} SEC filings.")
