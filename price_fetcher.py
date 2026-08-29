# -*- coding: utf-8 -*-
"""
==============================================================================
Yahoo Finance Batch Real-time Price Fetcher (With Standard Ticker Mapping)
==============================================================================
"""

import os
import sys
import json
import time
import requests

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

def get_standard_ticker(name, ticker, ticker_map):
    name_clean = (name or "").upper().strip()
    for k, v in ticker_map.items():
        if k in name_clean:
            return v
    if ticker and len(ticker) <= 5 and not " " in ticker and ticker.isalpha():
        return ticker.upper()
    return None

def fetch_yahoo_price(ticker):
    try:
        clean_ticker = ticker.replace(".", "-")
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{clean_ticker}?interval=1d&range=1d"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        res = requests.get(url, headers=headers, timeout=5)
        if res.status_code == 200:
            data = res.json()
            result = data.get("chart", {}).get("result", [])
            if result:
                meta = result[0].get("meta", {})
                cur_price = meta.get("regularMarketPrice")
                prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
                if cur_price is not None:
                    change_pct = 0.0
                    if prev_close and prev_close > 0:
                        change_pct = round(((cur_price - prev_close) / prev_close) * 100, 2)
                    return {
                        "price": round(cur_price, 2),
                        "changePct": change_pct,
                        "currency": meta.get("currency", "USD"),
                        "marketTime": meta.get("regularMarketTime", int(time.time()))
                    }
    except Exception as e:
        pass
    return None

def main():
    ticker_map = {}
    if os.path.exists("ticker_map.json"):
        with open("ticker_map.json", "r", encoding="utf-8") as f:
            ticker_map = json.load(f)

    # 13F에서 종목 수집
    target_tickers = set(ticker_map.values())
    if os.path.exists("latest_13f_holdings.json"):
        with open("latest_13f_holdings.json", "r", encoding="utf-8") as f:
            holdings = json.load(f)
            for h in holdings[:500]:
                mapped = get_standard_ticker(h.get("name"), h.get("ticker"), ticker_map)
                if mapped:
                    target_tickers.add(mapped)

    # 기존 시세 캐시 유지
    prices = {}
    if os.path.exists("realtime_prices.json"):
        try:
            with open("realtime_prices.json", "r", encoding="utf-8") as f:
                prices = json.load(f)
        except Exception:
            prices = {}

    print(f"📡 총 {len(target_tickers)}개 종목의 야후 파이낸스 실시간 시세 수집을 시작합니다...")
    for i, t in enumerate(target_tickers):
        info = fetch_yahoo_price(t)
        if info:
            prices[t] = info
            print(f"[{i+1}/{len(target_tickers)}] {t}: ${info['price']} ({info['changePct']}%)")
        time.sleep(0.05)

    with open("realtime_prices.json", "w", encoding="utf-8") as f:
        json.dump(prices, f, ensure_ascii=False, indent=2)
    print("✅ realtime_prices.json 갱신 완료!")

if __name__ == "__main__":
    main()
