"""
Alpha13F - Yahoo Finance 무료 실시간 주가 일괄 수집 모듈
회원가입/API 키 없이 전 종목의 실제 미국 시장 실시간 현재가를 초고속으로 수집합니다.
"""
import json
import time
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def get_realtime_price(ticker):
    """야후 파이낸스에서 단일 티커의 실시간 주가 및 변동률 조회"""
    # 점(.)을 하이픈(-)으로 변환 (예: BRK.B -> BRK-B)
    clean_ticker = ticker.replace(".", "-").upper()
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{clean_ticker}?interval=1d&range=1d"
    
    try:
        res = requests.get(url, headers=HEADERS, timeout=4)
        if res.status_code == 200:
            data = res.json()
            meta = data["chart"]["result"][0]["meta"]
            current_price = meta.get("regularMarketPrice")
            previous_close = meta.get("chartPreviousClose") or meta.get("previousClose")
            
            change_pct = 0.0
            if previous_close and current_price:
                change_pct = ((current_price - previous_close) / previous_close) * 100
                
            return {
                "price": round(current_price, 2) if current_price else None,
                "changePct": round(change_pct, 2),
                "currency": meta.get("currency", "USD"),
                "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
            }
    except Exception:
        pass
    return None

def fetch_all_portfolio_prices(holdings_json_path="latest_13f_holdings.json", output_path="realtime_prices.json"):
    """13F 보유 종목 목록에서 유효한 티커들을 추출하여 실시간 주가 일괄 수집"""
    try:
        with open(holdings_json_path, "r", encoding="utf-8") as f:
            holdings = json.load(f)
    except Exception as e:
        print(f"❌ 보유 종목 파일 로드 실패: {e}")
        return {}

    # 유효한 티커 추출 (중복 제거 및 CUSIP 제외)
    tickers = set()
    for h in holdings:
        t = h.get("ticker", "").strip()
        if t and len(t) <= 5 and t.isalnum() and not t.isdigit():
            tickers.add(t)

    print(f"🚀 [Yahoo Finance] 총 {len(tickers)}개 주요 종목의 실시간 시장 주가 수집 시작...")
    
    price_map = {}
    success_count = 0
    
    # 상위/인기 티커 우선 일괄 수집
    ticker_list = sorted(list(tickers))
    for idx, ticker in enumerate(ticker_list, 1):
        p_info = get_realtime_price(ticker)
        if p_info and p_info.get("price"):
            price_map[ticker] = p_info
            success_count += 1
            if idx % 10 == 0 or idx == len(ticker_list):
                print(f"  [{idx}/{len(ticker_list)}] {ticker}: ${p_info['price']} (수집 진행 중...)")
        time.sleep(0.05) # 야후 파이낸스 매너 딜레이

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(price_map, f, ensure_ascii=False, indent=2)

    print(f"✅ 야후 파이낸스 실시간 주가 {success_count}개 종목 연동 완료! -> {output_path}\n")
    return price_map

if __name__ == "__main__":
    fetch_all_portfolio_prices()
