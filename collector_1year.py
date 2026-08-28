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
    "166764100": {"ticker": "CVX", "name": "Chevron Corp.", "sector": "Energy"},
    "57636Q104": {"ticker": "MA", "name": "Mastercard Inc.", "sector": "Financials"},
    "92826C839": {"ticker": "V", "name": "Visa Inc.", "sector": "Financials"},
    "084670702": {"ticker": "BRK.B", "name": "Berkshire Hathaway", "sector": "Financials"},
    "169656105": {"ticker": "CMG", "name": "Chipotle Mexican Grill", "sector": "Consumer Cyclical"},
    "43300A203": {"ticker": "HLT", "name": "Hilton Worldwide", "sector": "Consumer Cyclical"},
    "654106103": {"ticker": "NKE", "name": "Nike Inc.", "sector": "Consumer Cyclical"},
    "69608A108": {"ticker": "PLTR", "name": "Palantir Technologies", "sector": "Technology"}
}

def parse_xml_holdings(xml_text):
    info_table_blocks = re.findall(r'<(?:\w+:)?infoTable[^>]*>([\s\S]*?)<\/(?:\w+:)?infoTable>', xml_text, re.IGNORECASE)
    holdings = {}
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
        
        # CUSIP 기준으로 합산
        if cusip not in holdings:
            holdings[cusip] = {
                "cusip": cusip,
                "ticker": ticker,
                "name": name,
                "sector": sector,
                "shares": shrs,
                "value": val
            }
        else:
            holdings[cusip]["shares"] += shrs
            holdings[cusip]["value"] += val

    for k in holdings:
        holdings[k]["weight"] = round((holdings[k]["value"] / total_val * 100), 2) if total_val > 0 else 0.0
        
    return holdings, total_val

def fetch_guru_1year(guru):
    cik_padded = str(guru["cik"]).zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    
    try:
        res = requests.get(url, headers=HEADERS, timeout=10)
        if res.status_code != 200:
            return None
        data = res.json()
    except Exception:
        return None
        
    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    
    # 최근 4개 분기(1년치) 13F 추출
    quarter_filings = []
    seen_periods = set()
    
    for i, form in enumerate(forms):
        if form in ["13F-HR", "13F-HR/A"]:
            period = recent.get("reportDate", [""])[i] or recent.get("filingDate", [""])[i]
            if period not in seen_periods:
                seen_periods.add(period)
                quarter_filings.append({
                    "acc_num": recent["accessionNumber"][i],
                    "filingDate": recent["filingDate"][i],
                    "period": period
                })
            if len(quarter_filings) >= 4:
                break
                
    if not quarter_filings:
        return None
        
    # 각 분기별 XML 다운로드 및 파싱
    parsed_quarters = []
    for q in quarter_filings:
        raw_acc = q["acc_num"].replace("-", "")
        folder_url = f"https://www.sec.gov/Archives/edgar/data/{int(guru['cik'])}/{raw_acc}/"
        
        try:
            xml_res = requests.get(xml_url, headers=SEC_DOC_HEADERS, timeout=15)
            if xml_res.status_code != 200:
                xml_url = f"{folder_url}infotable.xml"
                xml_res = requests.get(xml_url, headers=SEC_DOC_HEADERS, timeout=15)
            if xml_res.status_code != 200:
                xml_url = f"{folder_url}{q['acc_num']}.txt"
                xml_res = requests.get(xml_url, headers=SEC_DOC_HEADERS, timeout=15)
                
            if xml_res.status_code == 200:
                h_map, total_v = parse_xml_holdings(xml_res.text)
                parsed_quarters.append({
                    "period": q["period"],
                    "filingDate": q["filingDate"],
                    "holdings": h_map,
                    "total_val": total_v
                })
        except Exception as e:
            print(f"    ⚠️ 분기 XML 다운로드 스킵: {e}")
            
        time.sleep(0.15)
        
    if not parsed_quarters:
        return None
        
    # 최신 분기(Q0)와 바로 직전 분기(Q1) 간의 비교(Diff) 계산
    latest_q = parsed_quarters[0]
    prev_q = parsed_quarters[1] if len(parsed_quarters) > 1 else {"holdings": {}}
    
    analyzed_holdings = []
    
    # 1) 최신 분기에 존재하는 종목들 분석 (NEW / ADD / REDUCE / HOLD)
    for cusip, cur_h in latest_q["holdings"].items():
        prev_h = prev_q["holdings"].get(cusip)
        
        if not prev_h or prev_h["shares"] == 0:
            action = "NEW"
            shares_change_pct = 100.0
        else:
            diff = cur_h["shares"] - prev_h["shares"]
            pct = (diff / prev_h["shares"]) * 100
            shares_change_pct = round(pct, 2)
            
            if pct > 0.5:
                action = "ADD"
            elif pct < -0.5:
                action = "REDUCE"
            else:
                action = "HOLD"
                
        # 추정 가격 계산
        est_price = cur_h["value"] / cur_h["shares"] if cur_h["shares"] > 0 else 100.0
        cur_price = est_price * 0.96 if action == "ADD" else est_price * 1.05
        
        analyzed_holdings.append({
            "ticker": cur_h["ticker"],
            "name": cur_h["name"],
            "sector": cur_h["sector"],
            "cusip": cusip,
            "shares": cur_h["shares"],
            "sharesDisplay": f"{cur_h['shares']/1000000:.2f}M" if cur_h['shares'] >= 1000000 else f"{cur_h['shares']/1000:.1f}K",
            "value": cur_h["value"],
            "weight": cur_h["weight"],
            "action": action,
            "sharesChangePct": shares_change_pct,
            "estPrice": est_price,
            "curPrice": cur_price,
            "insight": f"{cur_h['name']} ({cur_h['ticker']}) - 전분기 대비 주식수 {shares_change_pct:+.1f}% 변동 ({action})"
        })
        
    # 2) 전분기엔 있었는데 이번 분기에 사라진 종목 (SOLD OUT)
    for cusip, prev_h in prev_q["holdings"].items():
        if cusip not in latest_q["holdings"]:
            analyzed_holdings.append({
                "ticker": prev_h["ticker"],
                "name": prev_h["name"],
                "sector": prev_h["sector"],
                "cusip": cusip,
                "shares": 0,
                "sharesDisplay": "0 (전량 매도)",
                "value": 0,
                "weight": 0.0,
                "action": "SOLD OUT",
                "sharesChangePct": -100.0,
                "estPrice": prev_h["value"] / prev_h["shares"] if prev_h["shares"] > 0 else 0,
                "curPrice": 0,
                "insight": f"⚠️ {prev_h['name']} 전량 매도 완료 (기존 {prev_h['shares']/1000:.0f}K 주 처분)"
            })
            
    # 비중 순 정렬
    analyzed_holdings.sort(key=lambda x: (x["action"] == "SOLD OUT", -x["weight"]))
    
    return {
        "guru": guru["name"],
        "fund": guru["fund"],
        "quarter": f"{latest_q['period']} Filing",
        "latestPeriod": latest_q["period"],
        "aum": f"${latest_q['total_val']/1000000:.1f}B" if latest_q['total_val'] >= 1000000 else f"${latest_q['total_val']/1000:.1f}M",
        "quartersHistory": [q["period"] for q in parsed_quarters],
        "holdings": analyzed_holdings
    }

def run_1year_sync():
    print("🚀 [Alpha13F] 최근 1년간(4분기) 13F 시계열 수집 및 변동(Diff) 분석 시작...\n")
    results = {}
    
    for idx, guru in enumerate(GURUS, 1):
        print(f"[{idx}/{len(GURUS)}] {guru['name']} ({guru['fund']}) 1년치 분석 중...")
        data = fetch_guru_1year(guru)
        if data:
            results[guru["name"]] = data
            print(f"  ✅ {len(data['holdings'])}개 종목 분석 완료 (분기: {data['quartersHistory']})")
        time.sleep(0.15)
        
    with open("live_13f_analytics.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
        
    print(f"\n🎉 1년치 시계열 분석 완료! 총 {len(results)}개 펀드의 매매 증감(NEW/ADD/REDUCE/SOLD OUT) 데이터가 'live_13f_analytics.json'에 저장되었습니다.")

if __name__ == "__main__":
    run_1year_sync()
