import requests
import json
import time
import os
import sys
import re

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except:
        pass

print("=" * 80)
print("🚀 [SEC Schedule 13D / 13G 행동주의 및 5% 지분 공시 정밀 수집기]")
print("=" * 80)

SEC_HEADERS = {
    "User-Agent": "Alpha13DTracker user@alpha13f.com",
    "Accept-Encoding": "gzip, deflate"
}

# 1. 미국 전체 상장사 티커 및 CIK 매핑 캐시 로드/다운로드
TICKERS_CACHE_FILE = "company_tickers.json"
tickers_map = {}

if os.path.exists(TICKERS_CACHE_FILE):
    try:
        with open(TICKERS_CACHE_FILE, "r", encoding="utf-8") as f:
            raw_tickers = json.load(f)
            for v in raw_tickers.values():
                tickers_map[str(v["cik_str"])] = {"ticker": v["ticker"], "title": v["title"]}
        print(f"📦 상장사 티커 맵 로드 완료: {len(tickers_map):,}개 기업")
    except Exception as e:
        print(f"⚠️ 티커 캐시 로드 오류: {e}")

if not tickers_map:
    try:
        print("🌐 SEC 상장사 티커 데이터베이스 다운로드 중...")
        r = requests.get("https://www.sec.gov/files/company_tickers.json", headers=SEC_HEADERS, timeout=15)
        if r.status_code == 200:
            raw_tickers = r.json()
            with open(TICKERS_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(raw_tickers, f, indent=2, ensure_ascii=False)
            for v in raw_tickers.values():
                tickers_map[str(v["cik_str"])] = {"ticker": v["ticker"], "title": v["title"]}
            print(f"✅ 상장사 티커 매핑 완료: {len(tickers_map):,}개 기업")
    except Exception as e:
        print(f"❌ 상장사 티커 다운로드 실패: {e}")

# 2. 주요 행동주의 투자자 및 대형 펀드 CIK
ACTIVIST_FUNDS = [
    {"name": "Carl Icahn", "fund": "Icahn Enterprises", "cik": "0000921669"},
    {"name": "Bill Ackman", "fund": "Pershing Square", "cik": "0001336528"},
    {"name": "Nelson Peltz", "fund": "Trian Fund Management", "cik": "0001345471"},
    {"name": "Paul Singer", "fund": "Elliott Investment Management", "cik": "0001048445"},
    {"name": "Dan Loeb", "fund": "Third Point LLC", "cik": "0001040273"},
    {"name": "Starboard Value", "fund": "Starboard Value LP", "cik": "0001515971"},
    {"name": "JANA Partners", "fund": "JANA Partners LLC", "cik": "0001159159"},
    {"name": "Engine No. 1", "fund": "Engine No. 1 LLC", "cik": "0001837424"},
    {"name": "Ryan Cohen", "fund": "RC Ventures LLC", "cik": "0001767470"},
    {"name": "David Einhorn", "fund": "Greenlight Capital", "cik": "0001079114"},
    {"name": "ValueAct Capital", "fund": "ValueAct Holdings", "cik": "0001418814"},
    {"name": "Warren Buffett", "fund": "Berkshire Hathaway", "cik": "0001067983"}
]

filing_13d_records = []

for fund in ACTIVIST_FUNDS:
    fund_cik_int = int(fund["cik"])
    cik_str = fund["cik"].zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik_str}.json"
    print(f"\n📡 수집 중: {fund['name']} ({fund['fund']})...")
    
    try:
        res = requests.get(url, headers=SEC_HEADERS, timeout=10)
        if res.status_code == 200:
            sec_data = res.json()
            recent = sec_data.get("filings", {}).get("recent", {})
            forms = recent.get("form", [])
            
            fund_collected = 0
            for i, form in enumerate(forms):
                # SC 13D, SC 13D/A, SCHEDULE 13D, SC 13G, SC 13G/A
                is_13d = "13D" in form
                is_13g = "13G" in form
                
                if is_13d or is_13g:
                    filing_date = recent["filingDate"][i]
                    acc_num = recent["accessionNumber"][i]
                    primary_doc = recent["primaryDocument"][i]
                    doc_desc = recent.get("primaryDocDescription", [""])[i]
                    
                    acc_no_dash = acc_num.replace("-", "")
                    actual_doc = "primary_doc.xml" if "primary_doc.xml" in primary_doc else primary_doc.split("/")[-1]
                    raw_xml_url = f"https://www.sec.gov/Archives/edgar/data/{fund_cik_int}/{acc_no_dash}/{actual_doc}"
                    viewer_doc_url = f"https://www.sec.gov/Archives/edgar/data/{fund_cik_int}/{acc_no_dash}/{primary_doc}"
                    
                    # 상세 파싱
                    target_company = doc_desc.strip() if doc_desc else ""
                    target_ticker = ""
                    percent_owned = None
                    cusip = ""
                    
                    try:
                        doc_res = requests.get(raw_xml_url, headers=SEC_HEADERS, timeout=7)
                        if doc_res.status_code == 200:
                            doc_text = doc_res.text
                            
                            # 1) XML 태그 기반 파싱
                            cik_m = re.search(r"<issuerCIK>(\d+)</issuerCIK>", doc_text)
                            name_m = re.search(r"<issuerName>(.*?)</issuerName>", doc_text)
                            cusip_m = re.search(r"<issuerCusipNumber>(.*?)</issuerCusipNumber>", doc_text)
                            pct_m = re.findall(r"<percentOfClass>([\d\.]+)</percentOfClass>", doc_text)
                            
                            # 2) 텍스트/HTML 백업 정규식
                            if not cik_m:
                                cik_m = re.search(r"SUBJECT COMPANY:.*?CENTRAL INDEX KEY:\s*(\d+)", doc_text, re.DOTALL | re.IGNORECASE)
                            if not name_m:
                                name_m = re.search(r"SUBJECT COMPANY:.*?COMPANY CONFORMED NAME:\s*([^\n\r<]+)", doc_text, re.DOTALL | re.IGNORECASE)
                            if not cusip_m:
                                cusip_m = re.search(r"(?:CUSIP|Cusip)(?:\s+Number|\s+NO\.?)?[:\s]+([0-9A-Za-z]{9})", doc_text)
                            if not pct_m:
                                pct_m = re.findall(r"PERCENT OF CLASS.*?([\d\.]+)%", doc_text, re.IGNORECASE)

                            # 지분율 계산 (복수 보고 주체 중 최대값)
                            if pct_m:
                                valid_pcts = [float(p) for p in pct_m if float(p) >= 0]
                                if valid_pcts:
                                    percent_owned = max(valid_pcts)

                            issuer_cik = str(int(cik_m.group(1))) if cik_m else ""
                            issuer_name = name_m.group(1).strip() if name_m else ""
                            if cusip_m:
                                cusip = cusip_m.group(1).strip()

                            # 티커 및 공식 기업명 매핑
                            if issuer_cik and issuer_cik in tickers_map:
                                mapped = tickers_map[issuer_cik]
                                target_ticker = mapped["ticker"]
                                if target_ticker.endswith("-WT"):
                                    target_ticker = target_ticker[:-3]
                                target_company = mapped["title"]
                            elif issuer_name:
                                target_company = issuer_name

                    except Exception as parse_err:
                        # 파싱 실패 시 fallback
                        pass

                    if not target_company:
                        target_company = "공시 대상 상장 기업"

                    type_label = "Schedule 13D (행동주의/경영참여)" if is_13d else "Schedule 13G (단순 대량보유)"
                    
                    filing_13d_records.append({
                        "filingDate": filing_date,
                        "formType": form,
                        "typeLabel": type_label,
                        "isActivist": is_13d,
                        "investorName": fund["name"],
                        "fundName": fund["fund"],
                        "cik": fund["cik"],
                        "targetCompany": target_company,
                        "targetTicker": target_ticker,
                        "percentOwned": percent_owned,
                        "cusip": cusip,
                        "accessionNumber": acc_num,
                        "docUrl": viewer_doc_url
                    })
                    
                    ticker_str = f" [{target_ticker}]" if target_ticker else ""
                    pct_str = f" ({percent_owned}%)" if percent_owned is not None else ""
                    print(f"  ✓ [{filing_date}] {form}: {target_company}{ticker_str}{pct_str}")
                    
                    fund_collected += 1
                    time.sleep(0.12)
                    
                    # 펀드당 최대 최신 5건 수집
                    if fund_collected >= 5:
                        break

        time.sleep(0.15)
    except Exception as e:
        print(f"  ❌ 에러: {e}")

print(f"\n✅ 총 수집된 13D/13G 공시 건수: {len(filing_13d_records)}건")

# 최신 날짜순 정렬
filing_13d_records.sort(key=lambda x: x["filingDate"], reverse=True)

with open("latest_13d_filings.json", "w", encoding="utf-8") as f:
    json.dump(filing_13d_records, f, indent=2, ensure_ascii=False)

file_size_kb = os.path.getsize("latest_13d_filings.json") / 1024
print(f"💾 latest_13d_filings.json 저장 완료! (크기: {file_size_kb:.1f} KB - 초경량 무부하)")
