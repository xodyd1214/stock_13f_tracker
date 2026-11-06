"""Publish a scoped, source-linked snapshot of U.S. House financial disclosures."""

import csv
from datetime import date, datetime, timedelta
from io import BytesIO, TextIOWrapper
import json
from pathlib import Path
import re
import time
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import requests

from data_io import atomic_write_json

HOUSE = "https://disclosures-clerk.house.gov/public_disc"
OUTPUT = Path(__file__).with_name("latest_congress_house.json")
KINDS = {"P": "ptr", "O": "annual"}
ASSETS = {"ST", "EF", "OP"}
OWNERS = {"", "SP", "JT", "DC", "SELF"}
ACTIONS = {"P", "S", "S (partial)", "E"}
DOLLARS = r"\$\d{1,3}(?:,\d{3})*"
RANGE = rf"{DOLLARS} - {DOLLARS}"
VALUE = rf"(?:{RANGE}|Over {DOLLARS}|None|N/A)"
HEADERS = {
    "ptr": "ID Owner Asset Transaction Date Notification Amount Cap.",
    "annual": "Asset Owner Value of Asset Income Type(s) Income Tx. >",
}


def source_url(filing):
    folder = "ptr-pdfs" if filing["kind"] == "ptr" else "financial-pdfs"
    return f'{HOUSE}/{folder}/{filing["year"]}/{filing["id"]}.pdf'


def filing_date(text):
    return datetime.strptime(text, "%m/%d/%Y").date().isoformat()


def read_index(content, year):
    with ZipFile(BytesIO(content)) as archive, archive.open(f"{year}FD.txt") as source:
        reader = csv.DictReader(TextIOWrapper(source, encoding="utf-8-sig"), delimiter="\t")
        if not {"FilingType", "Prefix", "StateDst", "DocID", "Year", "First", "Last", "Suffix",
                "FilingDate"}.issubset(reader.fieldnames or ()):
            raise ValueError(f"Unexpected House index columns for {year}")
        for row in reader:
            kind = KINDS.get(row["FilingType"])
            if not kind or row["Prefix"] != "Hon." or not re.fullmatch(r"[A-Z]{2}\d{2}", row["StateDst"] or ""):
                continue
            if row["Year"] != str(year) or not re.fullmatch(r"[0-9]{4,10}", row["DocID"] or ""):
                raise ValueError(f"Invalid House document identity for {year}")
            if not row["FilingDate"]:
                continue
            yield {
                "id": row["DocID"], "kind": kind, "year": year, "filed": filing_date(row["FilingDate"]),
                "name": " ".join(" ".join(row[field] for field in ("First", "Last", "Suffix")).split()),
                "district": row["StateDst"],
            }


def extract_rows(pdf_bytes, filing):
    import pdfplumber
    from pdfplumber.utils import cluster_objects

    kind = filing["kind"]
    rows = []
    columns = None
    record = None
    identity_confirmed = False
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            lines = [sorted(line, key=lambda word: word["x0"])
                     for line in cluster_objects(page.extract_words(), "top", 2)]
            for line in lines:
                words = [word["text"] for word in line]
                line_text = " ".join(words)
                if line_text == f'Filing ID #{filing["id"]}':
                    identity_confirmed = True
                if kind == "annual" and (re.match(r"^S\x00+ [B-Z](?:\b|:)", line_text) or
                                         line_text.startswith("Asset Owner Date Tx.")):
                    if record:
                        add_row(rows, record, filing)
                    return (rows, columns is not None) if identity_confirmed else ([], False)
                if kind == "ptr" and line_text.startswith("* For the complete list"):
                    return (rows, columns is not None) if identity_confirmed else ([], False)

                if line_text == HEADERS[kind]:
                    offsets = range(8) if kind == "ptr" else (0, 1, 2, 5, 7, 8)
                    columns = [line[index]["x0"] - 1.5 for index in offsets]
                    continue
                if columns is None or line_text.startswith("Filing ID #"):
                    continue

                cells = [[] for _ in columns]
                for word in line:
                    index = next((i for i in reversed(range(len(columns))) if word["x0"] >= columns[i]), 0)
                    cells[index].append(word["text"])
                cells = [" ".join(cell) for cell in cells]
                if kind == "ptr":
                    _, owner, asset, action, traded, _, amount, _ = cells
                    if action in ACTIONS and traded and owner in OWNERS:
                        record = {"owner": owner, "asset": asset, "value": amount,
                                  "action": action, "traded": traded, "status": ""}
                    elif record and re.match(r"^F\x00+ S\x00+:", line_text):
                        record["status"] = line_text.split(":", 1)[1].strip()
                        add_row(rows, record, filing)
                        record = None
                    elif record and "\x00" not in line_text:
                        record["asset"] += " " + asset
                        record["value"] += " " + amount
                else:
                    asset, owner, amount, _, _, _ = cells
                    if "\x00" in line_text or line_text.startswith("*"):
                        if record:
                            add_row(rows, record, filing)
                        record = None
                    elif record and record["value"].endswith("-") and re.fullmatch(DOLLARS, amount):
                        record["value"] += " " + amount
                        if not re.search(r"\[[A-Z0-9]{2}\]$", record["asset"]):
                            record["asset"] += " " + asset
                    elif asset and owner in OWNERS and re.match(r"^(?:\$|Over |None$|N/A$)", amount):
                        if record:
                            add_row(rows, record, filing)
                        record = {"owner": owner, "asset": asset, "value": amount}
                    elif record and not re.search(r"\[[A-Z0-9]{2}\]$", record["asset"]):
                        record["asset"] = (record["asset"] + " " + asset).strip()
            page.close()
    if kind == "annual" and record:
        add_row(rows, record, filing)
    return (rows, columns is not None) if identity_confirmed else ([], False)


def add_row(rows, record, filing):
    asset = " ".join(record["asset"].split()).rsplit("⇒", 1)[-1].strip()
    match = re.fullmatch(r"(.+?) \[([A-Z0-9]{2})\]", asset)
    value = " ".join(record["value"].split())
    if not match or match[2] not in ASSETS or not re.fullmatch(VALUE, value):
        return
    name, code = match.groups()
    symbol = re.search(r" \(([A-Z][A-Z0-9.\-]{0,11})\)$", name)
    row = {"asset": name[:symbol.start()] if symbol else name, "ticker": symbol[1] if symbol else "",
           "assetType": code, "owner": record["owner"], "value": value}
    if filing["kind"] == "ptr":
        if not re.fullmatch(rf"(?:{RANGE}|Over {DOLLARS})", value):
            return
        try:
            traded = filing_date(record["traded"])
        except ValueError:
            return
        if traded > filing["filed"] or not record["status"]:
            return
        row.update(traded=traded, action=record["action"], status=record["status"])
    rows.append(row)


def validate_snapshot(snapshot):
    if (snapshot.get("schemaVersion") != 1 or not isinstance(snapshot.get("filings"), list) or
            type(snapshot.get("annualYear")) is not int or
            not isinstance(snapshot.get("asOf"), str) or not isinstance(snapshot.get("ptrFrom"), str)):
        raise ValueError("Unexpected House snapshot version")
    generated = date.fromisoformat(snapshot["asOf"])
    start = date.fromisoformat(snapshot["ptrFrom"])
    if generated - start != timedelta(days=89):
        raise ValueError("Unexpected House PTR window")
    seen = set()
    kinds = set()
    for filing in snapshot["filings"]:
        kind = filing["kind"]
        filed = date.fromisoformat(filing["filed"])
        if (kind not in KINDS.values() or filed > generated or
                not re.fullmatch(r"[0-9]{4,10}", filing["id"]) or filing["id"] in seen or
                not re.fullmatch(r"[A-Z]{2}\d{2}", filing["district"]) or not filing["name"].strip() or
                filing["year"] not in (generated.year, generated.year - 1, generated.year - 2) or
                (kind == "ptr" and filed < start) or
                (kind == "annual" and filing["year"] != snapshot["annualYear"]) or
                type(filing["parsed"]) is not bool or not isinstance(filing["rows"], list) or
                (not filing["parsed"] and filing["rows"])):
            raise ValueError(f"Invalid House filing {filing['id']}")
        seen.add(filing["id"])
        kinds.add(kind)
        for row in filing["rows"]:
            if (not row["asset"].strip() or not isinstance(row["ticker"], str) or
                    row["assetType"] not in ASSETS or row["owner"] not in OWNERS or
                    not re.fullmatch(VALUE, row["value"]) or
                    (kind == "ptr" and (row["action"] not in ACTIONS or not row["status"] or
                                        not re.fullmatch(rf"(?:{RANGE}|Over {DOLLARS})", row["value"]) or
                                        date.fromisoformat(row["traded"]) > filed))):
                raise ValueError(f"Invalid House disclosure row in {filing['id']}")
    if kinds != set(KINDS.values()):
        raise ValueError("Both House disclosure types are required")
    return snapshot


def refresh(*, reparse=False):
    today = datetime.now(ZoneInfo("America/New_York")).date()
    start = today - timedelta(days=89)
    old = validate_snapshot(json.loads(OUTPUT.read_text())) if OUTPUT.exists() else None
    if old and old["asOf"] > today.isoformat():
        raise ValueError("House snapshot date would go backward")
    cached = {filing["id"]: filing for filing in old["filings"]} if old else {}
    with requests.Session() as session:
        session.headers["User-Agent"] = "Alpha13F public disclosures (github.com/xodyd1214/stock_13f_tracker)"

        def download(url):
            for attempt in range(3):
                try:
                    response = session.get(url, timeout=20)
                    response.raise_for_status()
                    return response.content
                except requests.RequestException:
                    if attempt == 2:
                        raise
                    time.sleep(1 + attempt)

        filings = [filing for year in range(today.year - 2, today.year + 1)
                   for filing in read_index(download(f"{HOUSE}/financial-pdfs/{year}FD.zip"), year)
                   if filing["filed"] <= today.isoformat()]
        annual_year = max(filing["year"] for filing in filings if filing["kind"] == "annual")
        selected = {filing["id"]: filing for filing in filings
                    if (filing["filed"] >= start.isoformat() if filing["kind"] == "ptr"
                        else filing["year"] == annual_year)}
        if old and any(filing["id"] not in selected for filing in old["filings"]
                       if (filing["filed"] >= start.isoformat() if filing["kind"] == "ptr"
                           else filing["year"] == annual_year)):
            raise ValueError("House index is missing previously indexed filings")

        for index, filing in enumerate(sorted(selected.values(), key=lambda item: item["filed"], reverse=True), 1):
            previous = cached.get(filing["id"], {})
            if not reparse and all(previous.get(key) == value for key, value in filing.items()):
                filing.update(parsed=previous["parsed"], rows=previous["rows"])
                continue
            try:
                rows, parsed = extract_rows(download(source_url(filing)), filing)
            except requests.HTTPError as exc:
                if exc.response.status_code != 404:
                    raise
                rows, parsed = [], False
            filing.update(parsed=parsed, rows=rows)
            if index % 50 == 0:
                print(f"Inspected {index}/{len(selected)} documents", flush=True)
            time.sleep(0.12)
    snapshot = validate_snapshot({
        "schemaVersion": 1, "asOf": today.isoformat(), "ptrFrom": start.isoformat(),
        "annualYear": annual_year,
        "filings": sorted(selected.values(), key=lambda item: (item["filed"], item["id"]), reverse=True),
    })
    if snapshot != old:
        atomic_write_json(OUTPUT, snapshot)
    print(f"House disclosures through {today}: {len(snapshot['filings'])} documents, "
          f"{sum(len(filing['rows']) for filing in snapshot['filings'])} rows")


if __name__ == "__main__":
    refresh()
