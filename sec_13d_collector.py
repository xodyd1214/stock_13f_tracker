import requests
import json
import time
import os
import sys

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except:
        pass

print("=" * 80)
print("🚀 [SEC Schedule 13D / 13G 행동주의 및 5% 지분 공시 수집기]")
print("=" * 80)

SEC_HEADERS = {
    "User-Agent": "Alpha13DTracker user@alpha13f.com",
    "Accept-Encoding": "gzip, deflate"
}

# 주요 행동주의 투자자 및 대형 펀드 CIK
ACTIVIST_FUNDS = [
    {"name": "Carl Icahn", "fund": "Icahn Enterprises", "cik": "0000921669"},
    {"name": "Bill Ackman", "fund": "Pershing Square", "cik": "0001336528"},
    {"name": "Nelson Peltz", "fund": "Trian Fund Management", "cik": "0001345471"},
    {"name": "Paul Singer", "fund": "Elliott Investment Management", "cik": "0001048445"},
    {"name": "Dan Loeb", "fund": "Third Point LLC", "cik": "0001040273"},
    {"name": "Starboard Value", "fund": "Starboard Value LP", "cik": "0001515971"},
    {"name": "JANA Partners", "fund": "JANA Partners LLC", "cik": "0001159159"},
    {"name": "Engine No. 1", "fund": "Engine No. 1 LLC", "cik": "0001837424"},
    {"name": "Warren Buffett", "fund": "Berkshire Hathaway", "cik": "0001067983"}
]

filing_13d_records = []

for fund in ACTIVIST_FUNDS:
    cik_str = fund["cik"].zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik_str}.json"
    print(f"📡 수집 중: {fund['name']} ({fund['fund']})...")
    
    try:
        res = requests.get(url, headers=SEC_HEADERS, timeout=10)
        if res.status_code == 200:
            sec_data = res.json()
            recent = sec_data.get("filings", {}).get("recent", {})
            forms = recent.get("form", [])
            
            for i, form in enumerate(forms):
                if form in ["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A", "SCHEDULE 13D"]:
                    filing_date = recent["filingDate"][i]
                    acc_num = recent["accessionNumber"][i]
                    primary_doc = recent["primaryDocument"][i]
                    doc_desc = recent.get("primaryDocDescription", [""])[i]
                    
                    is_activist_13d = "13D" in form
                    type_label = "Schedule 13D (행동주의/경영참여)" if is_activist_13d else "Schedule 13G (단순 대량보유)"
                    
                    filing_13d_records.append({
                        "filingDate": filing_date,
                        "formType": form,
                        "typeLabel": type_label,
                        "isActivist": is_activist_13d,
                        "investorName": fund["name"],
                        "fundName": fund["fund"],
                        "cik": fund["cik"],
                        "targetCompany": doc_desc or "공시 대상 상장 기업",
                        "accessionNumber": acc_num,
                        "docUrl": f"https://www.sec.gov/Archives/edgar/data/{int(fund['cik'])}/{acc_num.replace('-', '')}/{primary_doc}"
                    })
                    
                    if len(filing_13d_records) >= 50:
                        break
        time.sleep(0.15)
    except Exception as e:
        print(f"  ❌ 에러: {e}")

print(f"\n✅ 총 수집된 13D/13G 공시 건수: {len(filing_13d_records)}건")

# 최신 날짜순 정렬
filing_13d_records.sort(key=lambda x: x["filingDate"], reverse=True)

with open("latest_13d_filings.json", "w", encoding="utf-8") as f:
    json.dump(filing_13d_records, f, indent=2, ensure_ascii=False)

print("💾 latest_13d_filings.json 저장 완료!")
