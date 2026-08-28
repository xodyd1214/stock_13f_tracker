import requests
import json
import re
import time
import sys
import csv

# Windows 콘솔 UTF-8 인코딩 설정
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# SEC 공식 규정 준수 헤더 (403 차단 완벽 통과)
HEADERS = {
    "User-Agent": "Alpha13FTracker xodyd1214@gmail.com",
    "Accept-Encoding": "gzip, deflate",
    "Host": "data.sec.gov"
}

# 100인 슈퍼인베스터 데이터 로드
with open("gurus_100.json", "r", encoding="utf-8") as f:
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
    "166764100": {"ticker": "CVX", "name": "Chevron Corp.", "sector": "Energy"}
}

def fetch_guru_13f(guru):
    cik_padded = str(guru["cik"]).zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    
    print(f"🔍 [{guru['name']} ({guru['fund']})] 최신 공시 확인 중...")
    res = requests.get(url, headers=HEADERS, timeout=10)
    
    if res.status_code != 200:
        print(f"❌ SEC 응답 실패 ({res.status_code}): {guru['name']}")
        return None
    
    data = res.json()
    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    
    # 최신 13F-HR 찾기
    target_idx = -1
    for i, form in enumerate(forms):
        if form in ["13F-HR", "13F-HR/A"]:
            target_idx = i
            break
            
    if target_idx == -1:
        print(f"⚠️ {guru['name']}의 13F 공시 없음")
        return None
    
    acc_num = recent["accessionNumber"][target_idx]
    filing_date = recent["filingDate"][target_idx]
    report_date = recent.get("reportDate", [filing_date])[target_idx]
    raw_acc = acc_num.replace("-", "")
    
    print(f"  📄 발견: 접수번호 {acc_num} | 기준분기: {report_date}")
    
    # XML 다운로드
    sec_doc_headers = {
        "User-Agent": "Alpha13FTracker xodyd1214@gmail.com",
        "Host": "www.sec.gov"
    }
    
    folder_url = f"https://www.sec.gov/Archives/edgar/data/{int(guru['cik'])}/{raw_acc}/"
    xml_url = f"{folder_url}informationTable.xml"
    
    xml_res = requests.get(xml_url, headers=sec_doc_headers, timeout=10)
    if xml_res.status_code != 200:
        xml_url = f"{folder_url}infotable.xml"
        xml_res = requests.get(xml_url, headers=sec_doc_headers, timeout=10)
        
    if xml_res.status_code != 200:
        xml_url = f"{folder_url}{acc_num}.txt"
        xml_res = requests.get(xml_url, headers=sec_doc_headers, timeout=10)
        
    if xml_res.status_code == 200:
        return parse_13f_xml(guru, report_date, filing_date, xml_res.text)
    else:
        print(f"  ⚠️ XML 다운로드 실패 ({xml_res.status_code})")
        return None

def parse_13f_xml(guru, report_date, filing_date, xml_text):
    info_table_blocks = re.findall(r'<(?:\w+:)?infoTable[^>]*>([\s\S]*?)<\/(?:\w+:)?infoTable>', xml_text, re.IGNORECASE)
    
    holdings = []
    total_val = 0
    
    for block in info_table_blocks:
        name_m = re.search(r'<(?:\w+:)?nameOfIssuer>([^<]+)', block, re.IGNORECASE)
        cusip_m = re.search(r'<(?:\w+:)?cusip>([^<]+)', block, re.IGNORECASE)
        val_m = re.search(r'<(?:\w+:)?value>([^<]+)', block, re.IGNORECASE)
        shrs_m = re.search(r'<(?:\w+:)?sshPrnamt>([^<]+)', block, re.IGNORECASE)
        
        name = name_m.group(1).strip() if name_m else "Unknown"
        cusip = cusip_m.group(1).strip() if cusip_m else ""
        val = float(val_m.group(1).replace(",", "")) if val_m else 0.0
        shrs = float(shrs_m.group(1).replace(",", "")) if shrs_m else 0.0
        
        total_val += val
        ticker = KNOWN_CUSIPS.get(cusip, {}).get("ticker", cusip)
        sector = KNOWN_CUSIPS.get(cusip, {}).get("sector", "Other")
        
        holdings.append({
            "guru": guru["name"],
            "fund": guru["fund"],
            "period": report_date,
            "filingDate": filing_date,
            "ticker": ticker,
            "name": name,
            "cusip": cusip,
            "shares": shrs,
            "value": val,
            "sector": sector
        })
        
    for h in holdings:
        h["weight"] = round((h["value"] / total_val * 100), 2) if total_val > 0 else 0.0
        
    print(f"  ✅ {len(holdings)}개 종목 파싱 완료 (총 운용자산: ${total_val/1000:,.1f}M)")
    return holdings

def main():
    print(f"🚀 [Alpha13F] 슈퍼인베스터 {len(GURUS)}인 전체의 최신 13F 공식 데이터 일괄 수집을 시작합니다...\n")
    all_results = []
    success_count = 0
    
    for idx, guru in enumerate(GURUS, 1):
        print(f"[{idx}/{len(GURUS)}] {guru['name']} ({guru['fund']}) 처리 중...")
        try:
            h = fetch_guru_13f(guru)
            if h:
                all_results.extend(h)
                success_count += 1
        except Exception as e:
            print(f"  ❌ 에러 발생 ({guru['name']}): {e}")
            
        time.sleep(0.15) # SEC Rate Limit (초당 10회 미만) 철저 준수
        
    if all_results:
        # JSON 저장
        with open("latest_13f_holdings.json", "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)
            
        # CSV 저장
        keys = all_results[0].keys()
        with open("latest_13f_holdings.csv", "w", newline="", encoding="utf-8-sig") as f:
            dict_writer = csv.DictWriter(f, fieldnames=keys)
            dict_writer.writeheader()
            dict_writer.writerows(all_results)
            
        print(f"\n🎉 전체 수집 완료! {success_count}개 펀드에서 총 {len(all_results)}건의 최신 보유종목이 'latest_13f_holdings.csv' 및 'latest_13f_holdings.json'에 완벽 저장되었습니다.")

if __name__ == "__main__":
    main()
