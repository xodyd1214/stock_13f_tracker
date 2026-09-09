import urllib.request
import json
import ssl
from datetime import datetime, date
import os
import sys

# Windows 콘솔 UTF-8 설정
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

def log(msg):
    try:
        print(msg, flush=True)
    except:
        pass

log("=" * 80)
log("[Alpha13F 실시간 거시경제(Macro) & FOMC 캘린더 수집기]")
log("=" * 80)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

macro_data = {
    "lastUpdated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "fedRate": {
        "targetRange": "3.50% ~ 3.75%",
        "effr": "3.63%",
        "sofr": "3.66%",
        "effectiveDate": "2026-09-03"
    },
    "labor": {
        "unemploymentRate": "4.1%",
        "period": "August 2026",
        "prevRate": "4.1%"
    },
    "inflation": {
        "cpiIndex": 333.918,
        "cpiYoY": "+3.4%",
        "period": "July 2026"
    },
    "treasury": {
        "yield10Y": {"val": 4.78, "change": 0.0, "label": "10년물 국채 금리"},
        "yield13W": {"val": 3.76, "change": 0.0, "label": "3개월물 국채 (현금/기준금리 벤치마크)"},
        "yield5Y": {"val": 4.55, "change": 0.0, "label": "5년물 국채 금리"},
        "spread10Y_13W": {
            "spread": 1.03,
            "inverted": False,
            "desc": "정상 우상향 (연착륙/경제성장 기대)"
        }
    },
    "commoditiesAndFx": {
        "dxy": {"val": 98.95, "change": -0.23, "label": "달러 인덱스 (DXY)"},
        "wtiOil": {"val": 93.67, "change": 2.39, "label": "WTI 국제유가 ($)"},
        "gold": {"val": 4446.7, "change": -0.67, "label": "국제 금 시세 ($)"}
    },
    "calendar": []
}

# 1. 뉴욕 연방준비은행 공식 금리 API 수집
try:
    log("[1/3] 뉴욕 연방준비은행(New York Fed) 공식 금리 수집 중...")
    ny_url = 'https://markets.newyorkfed.org/api/rates/all/latest.json'
    req = urllib.request.Request(ny_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
        ny_data = json.loads(resp.read().decode('utf-8'))
        effr = next((r for r in ny_data.get('refRates', []) if r.get('type') == 'EFFR'), {})
        sofr = next((r for r in ny_data.get('refRates', []) if r.get('type') == 'SOFR'), {})
        if effr:
            t_from = effr.get('targetRateFrom', 3.50)
            t_to = effr.get('targetRateTo', 3.75)
            macro_data["fedRate"] = {
                "targetRange": f"{t_from:.2f}% ~ {t_to:.2f}%",
                "effr": f"{effr.get('percentRate', 3.63):.2f}%",
                "sofr": f"{sofr.get('percentRate', 3.66):.2f}%",
                "effectiveDate": effr.get('effectiveDate', '2026-09-03')
            }
            log(f"  연준 기준금리: {macro_data['fedRate']['targetRange']} (EFFR: {macro_data['fedRate']['effr']})")
except Exception as e:
    log(f"  NY Fed 수집 실패 (기본값 유지): {e}")

# 2. 미국 노동통계국(BLS) 공식 v1 API 수집 (고용 & 물가)
try:
    log("[2/3] 미국 노동통계국(BLS) 고용 및 CPI 물가 수집 중...")
    bls_url = 'https://api.bls.gov/publicAPI/v1/timeseries/data/'
    payload = json.dumps({
        'seriesid': ['CUUR0000SA0', 'LNS14000000'],
        'startyear': '2025',
        'endyear': '2026'
    }).encode('utf-8')
    req = urllib.request.Request(bls_url, data=payload, headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
        bls_res = json.loads(resp.read().decode('utf-8'))
        for s in bls_res.get('Results', {}).get('series', []):
            sid = s.get('seriesID')
            rows = s.get('data', [])
            if sid == 'LNS14000000' and rows:
                macro_data["labor"] = {
                    "unemploymentRate": f"{rows[0]['value']}%",
                    "period": f"{rows[0]['periodName']} {rows[0]['year']}",
                    "prevRate": f"{rows[1]['value']}%" if len(rows) > 1 else None
                }
                log(f"  실업률: {macro_data['labor']['unemploymentRate']} ({macro_data['labor']['period']})")
            elif sid == 'CUUR0000SA0' and len(rows) >= 13:
                cur_cpi = float(rows[0]['value'])
                prev_yr_cpi = float(rows[12]['value'])
                yoy = ((cur_cpi - prev_yr_cpi) / prev_yr_cpi) * 100
                macro_data["inflation"] = {
                    "cpiIndex": cur_cpi,
                    "cpiYoY": f"{yoy:+.1f}%",
                    "period": f"{rows[0]['periodName']} {rows[0]['year']}"
                }
                log(f"  CPI 소비자물가지수: {cur_cpi} (전년 대비 {macro_data['inflation']['cpiYoY']})")
except Exception as e:
    log(f"  BLS 수집 실패 (기본값 유지): {e}")

# 3. 국채 금리 및 매크로 자산 수집
tickers = [
    ('^TNX', 'yield10Y', '10년물 국채 금리'),
    ('^IRX', 'yield13W', '3개월물 국채 (현금/기준금리 벤치마크)'),
    ('^FVX', 'yield5Y', '5년물 국채 금리'),
    ('DX-Y.NYB', 'dxy', '달러 인덱스 (DXY)'),
    ('CL=F', 'wtiOil', 'WTI 국제유가 ($)'),
    ('GC=F', 'gold', '국제 금 시세 ($)')
]

log("[3/3] 미국 국채 금리, 달러 인덱스, 유가, 금값 수집 중...")
for sym, key, label in tickers:
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
            meta = json.loads(resp.read().decode('utf-8'))['chart']['result'][0]['meta']
            p = meta.get('regularMarketPrice')
            prev = meta.get('chartPreviousClose')
            chg = ((p - prev) / prev * 100) if p and prev else 0.0
            if 'yield' in key:
                macro_data["treasury"][key] = {"val": round(p, 2), "change": round(chg, 2), "label": label}
            else:
                macro_data["commoditiesAndFx"][key] = {"val": round(p, 2), "change": round(chg, 2), "label": label}
    except Exception as e:
        log(f"  {label} 수집 실패: {e}")

# 장단기 금리차 (10년물 - 3개월물) 계산
y10 = macro_data["treasury"].get("yield10Y", {}).get("val", 4.78)
y13w = macro_data["treasury"].get("yield13W", {}).get("val", 3.76)
spread = round(y10 - y13w, 2)
macro_data["treasury"]["spread10Y_13W"] = {
    "spread": spread,
    "inverted": spread < 0,
    "desc": "장단기 금리 역전 (경기침체 강력 경고)" if spread < 0 else "정상 우상향 (연착륙/성장 궤도)"
}

# 4. 공식 정책/경제학 기준선 (Ground Truth Benchmarks)
effr_val = float(macro_data["fedRate"].get("effr", "3.63%").replace("%", ""))
cpi_yoy_val = float(macro_data["inflation"].get("cpiYoY", "+3.4%").replace("%", "").replace("+", ""))
real_rate_val = round(effr_val - cpi_yoy_val, 2)

macro_data["benchmarks"] = {
    "fedRate": {
        "current": macro_data["fedRate"]["targetRange"],
        "currentMid": 3.625,
        "effr": macro_data["fedRate"]["effr"],
        "sofr": macro_data["fedRate"]["sofr"],
        "neutralRate": "2.90%",  # 연준 FOMC 점도표상 장기 중립금리 중간값
        "neutralVal": 2.90,
        "gapToNeutral": "+0.73%p",
        "realRate": f"{real_rate_val:+.2f}%p",
        "zone": "중립선 상회 (제약적 긴축 영역)"
    },
    "inflation": {
        "current": macro_data["inflation"]["cpiYoY"],
        "currentVal": cpi_yoy_val,
        "fedTarget": "2.0%",     # 미 연방준비법 법정 물가목표
        "targetVal": 2.0,
        "gapToTarget": f"+{cpi_yoy_val - 2.0:.2f}%p",
        "prevRate": "+3.4%",
        "forecast": "+3.2%",
        "zone": "법정 목표 2.0% 상회"
    },
    "yieldCurve": {
        "currentSpread": spread,
        "yield10Y": y10,
        "yield13W": y13w,
        "recessionThreshold": 0.00, # 뉴욕 연준 침체 역전선 (0%p 이하)
        "status": "정상 우상향 (역전선 0%p 상회)"
    },
    "cashRiskFree": {
        "rate": y13w,
        "sp500Dividend": 1.30,
        "spreadToEquity": round(y13w - 1.30, 2),
        "desc": f"단기국채 무위험 확정 수익률 (연 {y13w}%)"
    }
}

# 5. 주요 매크로 일정 및 이전치/예상치/D-Day 캘린더 생성
today = date(2026, 9, 8) # 현재 기준일

raw_events = [
    {
        "name": "미국 8월 PPI 생산자물가지수",
        "date": "2026-09-10",
        "category": "INFLATION",
        "impact": "MEDIUM",
        "previous": "+2.2% (7월)",
        "forecast": "+2.3%",
        "actual": "발표 대기",
        "description": "미 노동통계국(BLS) 공식 발표 생산자물가지수 (도매 물가 측정)."
    },
    {
        "name": "미국 8월 CPI 소비자물가지수",
        "date": "2026-09-11",
        "category": "INFLATION",
        "impact": "HIGH",
        "previous": "+3.4% (7월)",
        "forecast": "+3.2%",
        "actual": "발표 대기",
        "description": "미 노동통계국(BLS) 공식 발표 소비자물가지수 (연방준비법 법정 물가목표: 2.00%)."
    },
    {
        "name": "미국 8월 소매판매 지수",
        "date": "2026-09-15",
        "category": "CONSUMER",
        "impact": "MEDIUM",
        "previous": "+1.0% (7월)",
        "forecast": "+0.3%",
        "actual": "발표 대기",
        "description": "미 인구조사국(Census Bureau) 공식 발표 소매판매 지수 (가계 소비 지출 측정)."
    },
    {
        "name": "FOMC 정례회의 (9월 15일~16일)",
        "date": "2026-09-15",
        "releaseDate": "2026-09-16",
        "category": "FED",
        "impact": "CRITICAL",
        "previous": "3.50% ~ 3.75% (7월)",
        "forecast": "기준금리 및 SEP 점도표",
        "actual": "발표 대기",
        "description": "연방공개시장위원회(FOMC) 정례회의. 기준금리 목표 범위 및 분기 경제전망(SEP 점도표) 공식 발표."
    },
    {
        "name": "미국 9월 비농업 고용보고서 (NFP)",
        "date": "2026-10-02",
        "category": "LABOR",
        "impact": "CRITICAL",
        "previous": "14.2만 건 (8월)",
        "forecast": "15.5만 건 (실업률 4.1%)",
        "actual": "발표 대기",
        "description": "미 노동통계국(BLS) 공식 발표 비농업 부문 신규 일자리 수 및 실업률."
    }
]

calendar = []
for ev in raw_events:
    ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
    days_diff = (ev_date - today).days
    d_day_str = f"D-{days_diff}" if days_diff > 0 else ("D-DAY" if days_diff == 0 else f"D+{abs(days_diff)}")
    calendar.append({
        **ev,
        "daysDiff": days_diff,
        "dDay": d_day_str
    })

calendar.sort(key=lambda x: x["daysDiff"])
macro_data["calendar"] = calendar

# 6. 파일 저장
output_path = "latest_macro_indicators.json"
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(macro_data, f, ensure_ascii=False, indent=2)

log(f"\n[Alpha13F] 최신 매크로 지표 및 캘린더가 '{output_path}'에 완벽 저장되었습니다!")
log(f"   * 연준 기준금리: {macro_data['fedRate']['targetRange']} (EFFR: {macro_data['fedRate']['effr']})")
log(f"   * 물가/고용: CPI {macro_data['inflation']['cpiYoY']} | 실업률 {macro_data['labor']['unemploymentRate']}")
log(f"   * 국채/환율: 10Y {macro_data['treasury']['yield10Y']['val']}% | DXY {macro_data['commoditiesAndFx']['dxy']['val']}")
log(f"   * 다음 FOMC: {calendar[3]['dDay']} ({calendar[3]['date']})")
log("=" * 80)
