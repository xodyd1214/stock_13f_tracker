"""
==============================================================================
🚀 Alpha13F - 최근 1년(4개 분기) 시계열 데이터 수집 & 분기별 변동(Diff) 분석 엔진
==============================================================================
"""

import requests
import json
import re
import time
import sys
import os
import math
from pathlib import Path
from datetime import date, datetime, timezone
import xml.etree.ElementTree as ET
from data_io import atomic_write_json, load_json

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

HEADERS = {
    "User-Agent": "Alpha13FTracker xodyd1214@gmail.com",
    "Accept-Encoding": "gzip, deflate",
    "Host": "data.sec.gov"
}

SEC_DOC_HEADERS = {
    "User-Agent": "Alpha13FTracker xodyd1214@gmail.com",
    "Host": "www.sec.gov"
}

# 100인 구루 로드
BASE_DIR = Path(__file__).resolve().parent
with (BASE_DIR / "gurus_100.json").open("r", encoding="utf-8") as f:
    GURUS = json.load(f)

# CUSIP -> Ticker 사전
KNOWN_CUSIPS = {
    "037833100": {"ticker": "AAPL", "name": "Apple Inc.", "sector": "Technology"},
    "02079K305": {"ticker": "GOOGL", "name": "Alphabet Inc. Class A", "sector": "Technology"},
    "02079K107": {"ticker": "GOOG", "name": "Alphabet Inc. Class C", "sector": "Technology"},
    "594918104": {"ticker": "MSFT", "name": "Microsoft Corp.", "sector": "Technology"},
    "023135106": {"ticker": "AMZN", "name": "Amazon.com Inc.", "sector": "Technology"},
    "67066G104": {"ticker": "NVDA", "name": "NVIDIA Corp.", "sector": "Technology"},
    "674599105": {"ticker": "OXY", "name": "Occidental Petroleum", "sector": "Energy"},
    "191216100": {"ticker": "KO", "name": "Coca-Cola Co.", "sector": "Consumer Defensive"},
    "060505104": {"ticker": "BAC", "name": "Bank of America Corp.", "sector": "Financials"},
    "025816109": {"ticker": "AXP", "name": "American Express Co.", "sector": "Financials"},
    "166764100": {"ticker": "CVX", "name": "Chevron Corp.", "sector": "Energy"},
    "57636Q104": {"ticker": "MA", "name": "Mastercard Inc.", "sector": "Financials"},
    "92826C839": {"ticker": "V", "name": "Visa Inc.", "sector": "Financials"},
    "084670702": {"ticker": "BRK.B", "name": "Berkshire Hathaway", "sector": "Financials"},
    "169656105": {"ticker": "CMG", "name": "Chipotle Mexican Grill", "sector": "Consumer Cyclical"},
    "43300A203": {"ticker": "HLT", "name": "Hilton Worldwide", "sector": "Consumer Cyclical"},
    "654106103": {"ticker": "NKE", "name": "Nike Inc.", "sector": "Consumer Cyclical"},
    "69608A108": {"ticker": "PLTR", "name": "Palantir Technologies", "sector": "Technology"}
}

def parse_xml_holdings(xml_text, filing_date):
    """Normalize reported values to USD, keeping options and principal separate.

    SEC changed from thousands to dollars on Jan 3, 2023 (filing date,
    not report period). These values are not cost basis or live quotes.
    """
    multiplier = 1000 if date.fromisoformat(filing_date) < date(2023, 1, 3) else 1
    documents = re.findall(r'<XML>\s*([\s\S]*?)\s*</XML>', xml_text, re.I) or [xml_text]
    entries = []
    for document in documents:
        try:
            root = ET.fromstring(document.strip())
        except ET.ParseError:
            continue
        entries.extend(node for node in root.iter() if node.tag.split('}')[-1] == 'infoTable')
    if not entries:
        raise ValueError('No valid information-table entries; refusing empty update')
    holdings = {}
    for node in entries:
        fields = {e.tag.split('}')[-1]: (e.text or '').strip() for e in node.iter()}
        cusip = fields.get('cusip', '')
        if not cusip or not fields.get('nameOfIssuer'):
            raise ValueError('Incomplete information-table entry')
        value = float(fields['value'].replace(',', '')) * multiplier
        shares = float(fields['sshPrnamt'].replace(',', ''))
        if not all(math.isfinite(v) and v >= 0 for v in (value, shares)):
            raise ValueError('Invalid value or share count')
        option = fields.get('putCall', '').upper()
        share_type = fields.get('sshPrnamtType', '').upper()
        security_class = fields.get('titleOfClass', '')
        if option not in ('', 'PUT', 'CALL') or share_type not in ('SH', 'PRN'):
            raise ValueError('Unknown security/share type')
        key = '|'.join((cusip, security_class, share_type, option or 'EQUITY'))
        if key not in holdings:
            holdings[key] = {'cusip': cusip, 'positionId': key,
                'ticker': KNOWN_CUSIPS.get(cusip, {}).get('ticker', cusip),
                'name': fields['nameOfIssuer'], 'sector': KNOWN_CUSIPS.get(cusip, {}).get('sector', 'Other'),
                'putCall': option or None, 'shareType': share_type, 'securityClass': security_class,
                'shares': 0, 'value': 0, 'valueUnit': 'USD'}
        holdings[key]['shares'] += shares
        holdings[key]['value'] += value
    total = sum(h['value'] for h in holdings.values())
    for holding in holdings.values():
        holding['weight'] = round(holding['value'] / total * 100, 2) if total else 0.0
    return holdings, total


def select_filings(recent):
    periods = {}
    for i, form in enumerate(recent.get('form', [])):
        if form not in ('13F-HR', '13F-HR/A'):
            continue
        row = {key: recent[key][i] for key in ('reportDate', 'filingDate', 'accessionNumber')}
        date.fromisoformat(row['reportDate'])  # No fallback from filing date to quarter.
        existing = periods.setdefault(row['reportDate'], {'original': None, 'amended': False})
        if form.endswith('/A'):
            existing['amended'] = True
        elif existing['original'] is None:
            existing['original'] = row
    selected = []
    for period in sorted(periods, reverse=True)[:4]:
        item = periods[period]
        # Add-holdings amendments cannot safely replace or be added blindly to originals.
        if item['amended'] or not item['original']:
            raise ValueError(f'Amendment reconciliation required for {period}')
        selected.append(item['original'])
    return selected


def fetch_information_table(folder_url, accession, filing_date):
    candidates = ['informationTable.xml', 'infotable.xml']
    try:
        listing = requests.get(folder_url + 'index.json', headers=SEC_DOC_HEADERS, timeout=15)
        listing.raise_for_status()
        for item in listing.json().get('directory', {}).get('item', []):
            name = item.get('name', '')
            if re.fullmatch(r'[A-Za-z0-9_.-]+\.xml', name, re.I) and name not in candidates:
                candidates.append(name)
    except (requests.RequestException, ValueError, KeyError):
        pass
    candidates.append(accession + '.txt')
    for name in candidates:
        time.sleep(0.15)
        response = requests.get(folder_url + name, headers=SEC_DOC_HEADERS, timeout=15)
        if response.status_code != 200:
            continue
        try:
            holdings, total = parse_xml_holdings(response.text, filing_date)
            return holdings, total, folder_url + name
        except (ValueError, KeyError):
            continue
    raise ValueError('No valid information table found')


def consecutive_quarters(latest, previous):
    current, prior = date.fromisoformat(latest), date.fromisoformat(previous)
    ends = {(3, 31), (6, 30), (9, 30), (12, 31)}
    return ((current.month, current.day) in ends and (prior.month, prior.day) in ends
            and (current.year * 4 + (current.month - 1) // 3) -
            (prior.year * 4 + (prior.month - 1) // 3) == 1)


def analyze_quarters(guru, quarters):
    latest = quarters[0]
    prior = quarters[1] if len(quarters) > 1 and consecutive_quarters(latest['period'], quarters[1]['period']) else None
    holdings = []
    for key, current in latest['holdings'].items():
        previous = prior['holdings'].get(key) if prior else None
        change = None
        if prior is None:
            action = 'UNKNOWN'
        elif previous is None or previous['shares'] == 0:
            action = 'NEW'
        else:
            change = round((current['shares'] / previous['shares'] - 1) * 100, 2)
            action = 'ADD' if change > .5 else 'REDUCE' if change < -.5 else 'HOLD'
        reported_price = (current['value'] / current['shares']
                          if current['shares'] > 0 and current['shareType'] == 'SH' and not current['putCall'] else None)
        holdings.append({**current, 'sharesDisplay': f"{current['shares']:,.0f}",
            'action': action, 'sharesChangePct': change, 'estPrice': None, 'curPrice': None,
            'reportedPrice': reported_price, 'priceBasis': 'reported quarter-end value per share',
            'insight': '분기말 공시 보유수량 비교. 매입단가 및 실시간 가격 아님.'})
    if prior:
        for key, previous in prior['holdings'].items():
            if key not in latest['holdings']:
                holdings.append({**previous, 'shares': 0, 'sharesDisplay': '0', 'value': 0,
                    'weight': 0, 'action': 'SOLD OUT', 'sharesChangePct': -100,
                    'estPrice': None, 'curPrice': None, 'reportedPrice': None,
                    'insight': '이전 분기 대비 해당 공시에서 보유 내역 없음.'})
    holdings.sort(key=lambda h: (h['action'] == 'SOLD OUT', -h['weight']))
    total = latest['total_val']
    return {'guru': guru['name'], 'fund': guru['fund'], 'quarter': latest['period'] + ' Filing',
        'latestPeriod': latest['period'], 'filingDate': latest['filingDate'],
        'aum': f'${total / 1e9:.1f}B' if total >= 1e9 else f'${total / 1e6:.1f}M',
        'reportedValueUSD': total, 'valueUnit': 'USD', 'schemaVersion': 2,
        'comparisonAvailable': prior is not None, 'comparisonPeriod': prior['period'] if prior else None,
        'quartersHistory': [q['period'] for q in quarters], 'sourceUrl': latest['sourceUrl'],
        'fetchedAt': datetime.now(timezone.utc).isoformat(), 'holdings': holdings}


def fetch_guru_1year(guru):
    try:
        response = requests.get(f"https://data.sec.gov/submissions/CIK{str(guru['cik']).zfill(10)}.json",
                                headers=HEADERS, timeout=10)
        response.raise_for_status()
        filings = select_filings(response.json().get('filings', {}).get('recent', {}))
        quarters = []
        for i, filing in enumerate(filings):
            folder = f"https://www.sec.gov/Archives/edgar/data/{int(guru['cik'])}/{filing['accessionNumber'].replace('-', '')}/"
            try:
                holdings, total, source = fetch_information_table(folder, filing['accessionNumber'], filing['filingDate'])
                quarters.append({'period': filing['reportDate'], 'filingDate': filing['filingDate'],
                                 'holdings': holdings, 'total_val': total, 'sourceUrl': source})
            except (requests.RequestException, ValueError, KeyError) as error:
                if i == 0:
                    raise ValueError('Latest quarter unavailable; preserving previous data') from error
                print(f"Quarter unavailable: {filing['reportDate']}: {error}")
        return analyze_quarters(guru, quarters) if quarters else None
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as error:
        print(f"Unable to update {guru['name']}: {error}")
        return None


def run_1year_sync(output_path=None, gurus=None):
    output_path = Path(output_path) if output_path else BASE_DIR / 'live_13f_analytics.json'
    results = load_json(output_path, {})
    if not isinstance(results, dict):
        raise ValueError('Existing analytics must be an object')
    updated, failed = [], []
    for guru in GURUS if gurus is None else gurus:
        data = fetch_guru_1year(guru)
        if data:
            results[guru['name']] = data
            updated.append(guru['name'])
        else:
            failed.append(guru['name'])
        time.sleep(.15)
    if updated:
        atomic_write_json(output_path, results)
    summary = {'updated': updated, 'failed': failed, 'preservedOnFailure': True}
    print(json.dumps(summary, ensure_ascii=False))
    return summary


if __name__ == '__main__':
    result = run_1year_sync()
    sys.exit(1 if result['failed'] or not result['updated'] else 0)
