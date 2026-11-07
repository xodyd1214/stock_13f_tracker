"""Reconcile recent exchange-listed issuers' direct purchases against EDGAR."""
from collections import defaultdict
from datetime import date, datetime, timedelta
import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

import requests

from data_io import atomic_write_json, load_json
from sec_insider_collector import COMMON_SHARE_TITLE, field, ownership_date, ownership_xml, parse_form4_xml

SEC = "https://www.sec.gov"
OUTPUT = "latest_form4_recent.json"
MARKETS = ("NYSE", "Nasdaq", "CBOE", "TXSE")
WINDOW_DAYS = 30
INITIAL_WINDOW_DAYS = 14
RULESET_VERSION = 1
MAX_RESPONSE_BYTES = 8_000_000
ACCESSION = r"[0-9]{10}-[0-9]{2}-[0-9]{6}"
INDEX_PATH = re.compile(rf"edgar/data/([0-9]+)/({ACCESSION})\.txt")
INDEX_HEADER = "CIK|Company Name|Form Type|Date Filed|File Name"
FUND_FILE_NUMBER = re.compile(rb"(?m)^\s*SEC FILE NUMBER:\s*(?:811|814)-")


def edgar_date(value):
    if not re.fullmatch(r"[0-9]{8}", value):
        raise ValueError("Invalid EDGAR date")
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def index_dates(get, start, cutoff):
    dates = set()
    quarters = {(d.year, (d.month - 1) // 3 + 1) for d in (start, cutoff)}
    for year, quarter in sorted(quarters):
        path = f"/Archives/edgar/daily-index/{year}/QTR{quarter}/index.json"
        items = json.loads(get(path))["directory"]["item"]
        for item in items:
            match = re.fullmatch(r"master\.([0-9]{8})\.idx", item["name"])
            if match:
                day = edgar_date(match[1])
                if start <= day <= cutoff:
                    dates.add(day)
    if not dates:
        raise ValueError("No recent EDGAR daily indexes were available")
    return sorted(dates)


def listed_issuers(get):
    data = json.loads(get("/files/company_tickers_exchange.json"))
    if data["fields"] != ["cik", "name", "ticker", "exchange"]:
        raise ValueError("Unexpected SEC exchange listing schema")
    issuers = {str(int(cik)) for cik, _, _, exchange in data["data"] if exchange in MARKETS}
    if len(issuers) < 1000:
        raise ValueError("Incomplete SEC exchange listing")
    return issuers


def indexed_filings(raw, issuers):
    lines = raw.decode("latin-1").splitlines()
    try:
        offset = lines.index(INDEX_HEADER)
    except ValueError as error:
        raise ValueError("EDGAR master index header missing") from error
    candidates = {}
    for line in lines[offset + 1:]:
        if not line.strip() or not line.strip("-"):
            continue
        cik, _, form, filed, filename = line.split("|")
        if form not in ("4", "4/A") or cik not in issuers:
            continue
        match = INDEX_PATH.fullmatch(filename)
        if not match or match[1] != cik:
            raise ValueError(f"Invalid SEC filing path {filename!r}")
        accession = match[2]
        filed_date = edgar_date(filed).isoformat()
        filing = candidates.setdefault(accession, (form, filed_date, set()))
        if filing[:2] != (form, filed_date):
            raise ValueError(f"Conflicting index entries for {accession}")
        filing[2].add(cik)
    return {key: (form, filed, sorted(ciks)) for key, (form, filed, ciks) in sorted(candidates.items())}


def filing_path(cik, accession):
    return f"/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{accession}"


def header_field(header, label):
    match = re.search(rb"(?m)^\s*" + label + rb":\s*([^\r\n]+)", header)
    return match[1].decode("ascii").strip() if match else ""


def filing_findings(get, accession, candidate, issuers):
    form, filed, ciks = candidate
    for cik in ciks:
        path = filing_path(cik, accession)
        try:
            raw = get(path + ".txt")
            break
        except FileNotFoundError:
            continue
    else:
        raise FileNotFoundError(f"Original SEC filing unavailable: {accession}")

    header = raw.split(b"<DOCUMENT>", 1)[0]
    if (header_field(header, b"ACCESSION NUMBER") != accession
            or header_field(header, b"CONFORMED SUBMISSION TYPE") != form
            or edgar_date(header_field(header, b"FILED AS OF DATE")).isoformat() != filed):
        raise ValueError(f"SEC submission does not match its index: {accession}")
    xml = ownership_xml(raw, form)
    root = ET.fromstring(xml)
    if root.tag != "ownershipDocument" or field(root, "documentType") != form:
        raise ValueError(f"Unexpected ownership document type: {accession}")
    issuer = str(int(field(root, "issuer/issuerCik")))
    if issuer not in issuers or FUND_FILE_NUMBER.search(header):
        return [], []
    if form == "4/A":
        original_date = field(root, "dateOfOriginalSubmission")
        if original_date:
            original_date = ownership_date(original_date)
        names = [field(owner, "reportingOwnerId/rptOwnerName") for owner in root.findall("reportingOwner")]
        if not names or not all(names):
            raise ValueError(f"Amended report lacks owner identity: {accession}")
        # When the original date is absent, withhold matches for that reporter
        # throughout this bounded snapshot instead of guessing the original.
        return [], [[issuer.zfill(10), name.casefold(), original_date] for name in names]

    rows = parse_form4_xml(xml, accession, filed, SEC + path + "-index.htm")
    return [row for row in rows if row["directInsiderPurchase"]], []


def compile_transactions(days):
    amendments = {tuple(key) for day in days for key in day["amendments"]}
    seen_accessions = set()
    rows = []
    for day in reversed(days):
        by_accession = defaultdict(list)
        for row in day["purchases"]:
            by_accession[row["accessionNumber"]].append(row)
        for accession, trades in by_accession.items():
            if accession in seen_accessions:
                continue
            seen_accessions.add(accession)
            for row in trades:
                key = (row["issuerCik"], row["insiderName"].casefold())
                if (*key, row["filingDate"]) not in amendments and (*key, "") not in amendments:
                    rows.append(row)
    return sorted(rows, key=lambda row: (row["filingDate"], row["transDate"], row["accessionNumber"]), reverse=True)


def collect(get, cutoff, previous=None):
    window_start = cutoff - timedelta(days=WINDOW_DAYS - 1)
    if previous:
        validate_recent_snapshot(previous)
        # Expand the published window as daily indexes arrive, without re-fetching
        # filings before the earliest reconciled date on each scheduled run.
        start = max(window_start, date.fromisoformat(previous["coverage"]["from"]))
    else:
        start = cutoff - timedelta(days=INITIAL_WINDOW_DAYS - 1)
    issuers = listed_issuers(get)
    dates = index_dates(get, start, cutoff)
    old_days = {}
    if previous:
        if dates[-1].isoformat() < previous["coverage"]["through"]:
            raise ValueError("EDGAR index coverage regressed")
        old_days = {day["date"]: day for day in previous["days"]}
        retained_dates = {date.fromisoformat(value) for value in old_days if value >= start.isoformat()}
        if not retained_dates.issubset(dates):
            raise ValueError("A previously confirmed EDGAR index is missing")
    days = []
    for day in dates:
        date_key = day.isoformat()
        path = f"/Archives/edgar/daily-index/{day.year}/QTR{(day.month - 1) // 3 + 1}/master.{day:%Y%m%d}.idx"
        filings = indexed_filings(get(path), issuers)
        digest = hashlib.sha256(json.dumps([RULESET_VERSION, filings], sort_keys=True).encode()).hexdigest()
        cached = old_days.get(date_key)
        if cached and cached["indexSha256"] == digest:
            days.append(cached)
            continue
        purchases, amendments = [], []
        for accession, candidate in filings.items():
            rows, corrections = filing_findings(get, accession, candidate, issuers)
            purchases.extend(rows)
            amendments.extend(corrections)
        print(f"EDGAR {date_key}: checked {len(filings)} filings, found {len(purchases)} direct purchase rows", flush=True)
        days.append({"date": date_key, "indexSha256": digest, "filings": len(filings),
                     "purchases": purchases, "amendments": amendments})
    count = sum(day["filings"] for day in days)
    result = {
        "schemaVersion": 1,
        "sourceFilings": count,
        "verifiedFilings": count,
        "coverage": {"from": start.isoformat(), "through": dates[-1].isoformat(),
                     "listedIssuers": len(issuers), "markets": list(MARKETS)},
        "days": days,
        "transactions": compile_transactions(days),
    }
    validate_recent_snapshot(result)
    return result


def validate_recent_snapshot(snapshot):
    def require(condition):
        if not condition:
            raise ValueError("Invalid reconciled Form 4 snapshot")

    def iso_day(value):
        return date.fromisoformat(value).isoformat() == value

    require(isinstance(snapshot, dict) and snapshot.get("schemaVersion") == 1)
    coverage = snapshot.get("coverage", {})
    require(coverage.get("markets") == list(MARKETS) and type(coverage.get("listedIssuers")) is int
            and coverage["listedIssuers"] >= 1000 and iso_day(coverage["from"]) and iso_day(coverage["through"]))
    days = snapshot.get("days")
    require(isinstance(days, list) and 0 < len(days) <= WINDOW_DAYS)
    require([day["date"] for day in days] == sorted({day["date"] for day in days})
            and days[-1]["date"] == coverage["through"]
            and 0 <= (date.fromisoformat(coverage["through"]) - date.fromisoformat(coverage["from"])).days < WINDOW_DAYS)
    require(all(coverage["from"] <= day["date"] <= coverage["through"] and iso_day(day["date"])
                and type(day["filings"]) is int and day["filings"] >= 0
                and re.fullmatch(r"[0-9a-f]{64}", day["indexSha256"]) for day in days))
    count = sum(day["filings"] for day in days)
    require(count > 0 and snapshot.get("sourceFilings") == snapshot.get("verifiedFilings") == count)
    for day in days:
        require(isinstance(day["purchases"], list) and isinstance(day["amendments"], list))
        for key in day["amendments"]:
            require(isinstance(key, list) and len(key) == 3 and re.fullmatch(r"[0-9]{10}", key[0])
                    and isinstance(key[1], str) and key[1] and (key[2] == "" or iso_day(key[2])))
        for row in day["purchases"]:
            accession = row.get("accessionNumber", "")
            require(row.get("directInsiderPurchase") is True and row.get("txTypeCode") == "P"
                    and row.get("ownership") == "D" and iso_day(row["transDate"]) and iso_day(row["filingDate"])
                    and row["filingDate"] <= day["date"] and row["transDate"] <= row["filingDate"]
                    and re.fullmatch(r"[0-9]{10}", row["issuerCik"])
                    and bool(row["insiderName"] and row["officerTitle"] and row["companyName"])
                    and COMMON_SHARE_TITLE.fullmatch(row["securityTitle"])
                    and type(row["shares"]) in (float, int) and row["shares"] > 0
                    and type(row["price"]) in (float, int) and row["price"] > 0
                    and re.fullmatch(ACCESSION, accession)
                    and re.fullmatch(rf"https://www\.sec\.gov/Archives/edgar/data/[0-9]+/"
                                     rf"{accession.replace('-', '')}/{re.escape(accession)}-index\.htm", row["secUrl"]))
    require(snapshot.get("transactions") == compile_transactions(days))


def main():
    with requests.Session() as session:
        session.headers["User-Agent"] = "AlphaInsiderTracker xodyd1214@gmail.com"

        def get(path):
            for attempt in range(3):
                time.sleep(.2)
                with session.get(SEC + path, timeout=(8, 35), stream=True) as response:
                    if response.status_code == 404:
                        raise FileNotFoundError(path)
                    if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                        time.sleep(15 * (attempt + 1))
                        continue
                    response.raise_for_status()
                    payload = bytearray()
                    for chunk in response.iter_content(65536):
                        payload.extend(chunk)
                        if len(payload) > MAX_RESPONSE_BYTES:
                            raise ValueError(f"Oversized EDGAR response: {path}")
                    return bytes(payload)

        cutoff = datetime.now(ZoneInfo("America/New_York")).date() - timedelta(days=1)
        previous = load_json(OUTPUT)
        result = collect(get, cutoff, previous)
    if result != previous:
        atomic_write_json(OUTPUT, result)
    print(f"Verified {result['verifiedFilings']} Form 4 filings through {result['coverage']['through']}; "
          f"{len(result['transactions'])} direct purchases.")


if __name__ == "__main__":
    main()
