import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except:
        pass

import requests
import re
import xml.etree.ElementTree as ET
import json
import time
import os

def log(msg):
    try:
        print(msg, flush=True)
    except:
        pass

log("=" * 80)
log("🛡️ [SEC Form 4 공식 원문 XML 100% 실데이터 대량 수집 파이프라인]")
log("=" * 80)

headers = {
    "User-Agent": "AlphaInsiderTracker xodyd1214@gmail.com",
    "Accept-Encoding": "gzip, deflate"
}

with open("sec_cik_master.json", "r", encoding="utf-8") as f:
    ticker_to_cik = json.load(f)

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

def parse_form4_xml(xml_content, comp_ticker, comp_name, comp_cik, acc_num, filing_date):
    records = []
    try:
        root = ET.fromstring(xml_content)
    except Exception as e:
        return records

    # 1) 보고자 정보 추출
    owner_name = "내부자 (미기재)"
    for tag in [".//rptOwnerName", ".//reportingOwnerId/rptOwnerName", ".//reportingOwner/reportingOwnerId/rptOwnerName", ".//rptOwner/rptOwnerName"]:
        elem = root.find(tag)
        if elem is not None and elem.text and elem.text.strip():
            owner_name = elem.text.strip()
            break

    officer_title = "임원 / 이사"
    is_director = False
    is_officer = False
    is_ten_pct = False
    is_other = False

    rel = root.find(".//reportingOwnerRelationship")
    if rel is None:
        rel = root.find(".//reportingOwner/reportingOwnerRelationship")

    if rel is not None:
        dir_e = rel.find("isDirector")
        off_e = rel.find("isOfficer")
        ten_e = rel.find("isTenPercentOwner")
        oth_e = rel.find("isOther")
        title_e = rel.find("officerTitle")

        is_director = (dir_e is not None and dir_e.text in ["1", "true", "True"])
        is_officer = (off_e is not None and off_e.text in ["1", "true", "True"])
        is_ten_pct = (ten_e is not None and ten_e.text in ["1", "true", "True"])
        is_other = (oth_e is not None and oth_e.text in ["1", "true", "True"])

        if title_e is not None and title_e.text and title_e.text.strip():
            officer_title = title_e.text.strip()
        elif is_director and is_officer:
            officer_title = "대표이사 / 사내이사 (Director & Officer)"
        elif is_director:
            officer_title = "사내/사외이사 (Director)"
        elif is_ten_pct:
            officer_title = "10% 이상 주요주주 (10% Owner)"
        elif is_other:
            officer_title = "주요 관계자 (Other)"

    # 2) Table I 거래 파싱
    non_deriv_txs = root.findall(".//nonDerivativeTransaction")
    if not non_deriv_txs:
        return records

    for tx in non_deriv_txs:
        tx_date_elem = tx.find(".//transactionDate/value")
        tx_date = tx_date_elem.text.strip() if tx_date_elem is not None and tx_date_elem.text else filing_date

        tx_code_elem = tx.find(".//transactionCoding/transactionCode")
        tx_code = tx_code_elem.text.strip() if tx_code_elem is not None and tx_code_elem.text else "ETC"

        acq_disp_elem = tx.find(".//transactionAmounts/transactionAcquiredDisposedCode/value")
        acq_disp = acq_disp_elem.text.strip() if acq_disp_elem is not None and acq_disp_elem.text else ""

        shares_elem = tx.find(".//transactionAmounts/transactionShares/value")
        shares = float(shares_elem.text.strip()) if shares_elem is not None and shares_elem.text else 0.0

        price_elem = tx.find(".//transactionAmounts/transactionPricePerShare/value")
        price = float(price_elem.text.strip()) if price_elem is not None and price_elem.text else 0.0

        post_shares_elem = tx.find(".//postTransactionAmounts/sharesOwnedFollowingTransaction/value")
        post_shares = float(post_shares_elem.text.strip()) if post_shares_elem is not None and post_shares_elem.text else 0.0

        if tx_code == "P" or (acq_disp == "A" and price > 0 and tx_code in ["P", "I"]):
            tx_type = "장내 매수 (P)"
            tx_type_code = "P"
        elif tx_code == "S" or acq_disp == "D":
            tx_type = "장내 매도 (S)"
            tx_type_code = "S"
        elif tx_code in ["M", "C"]:
            tx_type = f"옵션/전환 행사 ({tx_code})"
            tx_type_code = tx_code
        elif tx_code == "A":
            tx_type = "주식 보상 부여 (A)"
            tx_type_code = "A"
        elif tx_code == "G":
            tx_type = "증여/기부 (G)"
            tx_type_code = "G"
        else:
            tx_type = f"기타 거래 ({tx_code})"
            tx_type_code = tx_code

        total_value = shares * price
        acc_clean = acc_num.replace("-", "")
        sec_url = f"https://www.sec.gov/Archives/edgar/data/{int(comp_cik)}/{acc_clean}/{acc_num}-index.htm"

        records.append({
            "filingDate": filing_date,
            "transDate": tx_date,
            "ticker": comp_ticker,
            "companyName": comp_name,
            "insiderName": owner_name,
            "officerTitle": officer_title,
            "isOfficer": is_officer,
            "isDirector": is_director,
            "isTenPercent": is_ten_pct,
            "txType": tx_type,
            "txTypeCode": tx_type_code,
            "shares": shares,
            "price": price,
            "totalValue": total_value,
            "postShares": post_shares,
            "accessionNumber": acc_num,
            "secUrl": sec_url
        })

    return records

all_real_records = []

for idx, ticker in enumerate(KEY_TICKERS):
    if ticker not in ticker_to_cik:
        continue
    comp = ticker_to_cik[ticker]
    cik = comp["cik"]
    comp_name = comp["name"]

    log(f"📡 [{idx+1}/{len(KEY_TICKERS)}] {ticker:<6} ({comp_name}) 수집 중...")

    try:
        sub_url = f"https://data.sec.gov/submissions/CIK{cik}.json"
        res = requests.get(sub_url, headers=headers, timeout=10)
        if res.status_code != 200:
            time.sleep(0.2)
            continue
        sec_data = res.json()
        recent = sec_data.get("filings", {}).get("recent", {})
        forms = recent.get("form", [])

        f4_indices = [i for i, f in enumerate(forms) if f == "4"]
        
        # 최신 15개 공시 대상 파싱
        for f_idx in f4_indices[:15]:
            filing_date = recent["filingDate"][f_idx]
            acc = recent["accessionNumber"][f_idx]
            acc_clean = acc.replace("-", "")
            
            # Submission 폴더 인덱스 검색
            dir_url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_clean}/"
            r_dir = requests.get(dir_url, headers=headers, timeout=8)
            if r_dir.status_code == 200:
                xml_links = re.findall(r'href="([^"]+\.xml)"', r_dir.text)
                for x in xml_links:
                    full_x = f"https://www.sec.gov{x}" if x.startswith("/") else f"{dir_url}{x}"
                    rx = requests.get(full_x, headers=headers, timeout=8)
                    if "<ownershipDocument" in rx.text or "<rptOwner" in rx.text:
                        parsed = parse_form4_xml(rx.text, ticker, comp_name, cik, acc, filing_date)
                        if parsed:
                            all_real_records.extend(parsed)
                            log(f"   -> {filing_date} | {parsed[0]['insiderName']} ({parsed[0]['officerTitle']}) | {parsed[0]['txType']} {parsed[0]['shares']:,}주 (${parsed[0]['price']})")
                            break
                    time.sleep(0.06)

            time.sleep(0.08)
    except Exception as e:
        log(f"  ❌ {ticker} 에러: {e}")
        time.sleep(0.3)

log(f"\n🎉 100% 실제 SEC 공식 원문 파싱 완료! 총 {len(all_real_records)}건")

# 최신 날짜순 정렬
all_real_records.sort(key=lambda x: x["filingDate"], reverse=True)

with open("latest_form4_insiders.json", "w", encoding="utf-8") as f:
    json.dump(all_real_records, f, indent=2, ensure_ascii=False)

log("💾 latest_form4_insiders.json 실제 사실 100% 데이터셋 저장 완료!")
