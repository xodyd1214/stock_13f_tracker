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
import math
import re
from pathlib import Path
from datetime import datetime, timezone
from data_io import atomic_write_json, load_json

BASE_DIR = Path(__file__).resolve().parent

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

def get_standard_ticker(name, ticker, ticker_map):
    # A provided ticker wins. Substring issuer matching can confuse share classes.
    if ticker and re.fullmatch(r"[A-Za-z]{1,5}(?:[.-][A-Za-z])?", ticker):
        return ticker.upper()
    name_clean = (name or "").upper().strip()
    return next((v for k, v in ticker_map.items() if k.upper().strip() == name_clean), None)

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
                if isinstance(cur_price, (int, float)) and not isinstance(cur_price, bool) and math.isfinite(cur_price) and cur_price > 0:
                    change_pct = None
                    if isinstance(prev_close, (int, float)) and math.isfinite(prev_close) and prev_close > 0:
                        change_pct = round(((cur_price - prev_close) / prev_close) * 100, 2)
                    market_time = meta.get("regularMarketTime")
                    if not isinstance(market_time, (int, float)) or isinstance(market_time, bool) or not math.isfinite(market_time) or market_time <= 0:
                        market_time = None
                    stale = market_time is None or not -300 <= time.time() - market_time <= 86400
                    return {
                        "price": round(cur_price, 2),
                        "changePct": change_pct,
                        "currency": meta.get("currency"),
                        "marketTime": market_time,
                        "stale": stale,
                        "fetchedAt": datetime.now(timezone.utc).isoformat(),
                        "source": "Yahoo Finance"
                    }
    except Exception as e:
        pass
    return None

def main():
    ticker_map = load_json(BASE_DIR / "ticker_map.json", {})
    target_tickers = set(ticker_map.values())
    analytics = load_json(BASE_DIR / "live_13f_analytics.json", {})
    for fund in analytics.values():
        for holding in fund.get("holdings", []):
            if holding.get("putCall") or holding.get("shareType") == "PRN":
                continue
            ticker = get_standard_ticker(holding.get("name"), holding.get("ticker"), ticker_map)
            if ticker:
                target_tickers.add(ticker)
    path = BASE_DIR / "realtime_prices.json"
    prices = load_json(path, {})
    if not isinstance(prices, dict):
        raise ValueError("Existing price cache must be an object")
    updated = 0
    failed = []
    for ticker in sorted(target_tickers):
        info = fetch_yahoo_price(ticker)
        previous = prices.get(ticker, {})
        previous_time = previous.get('marketTime') if isinstance(previous, dict) else None
        if info and isinstance(previous_time, (int, float)) and not isinstance(previous_time, bool) and math.isfinite(previous_time) and previous_time > 0:
            observed = info.get('marketTime')
            if not isinstance(observed, (int, float)) or isinstance(observed, bool) or not math.isfinite(observed) or observed < previous_time:
                info = None
        if info:
            prices[ticker] = info
            updated += 1
        else:
            failed.append(ticker)
        time.sleep(.15)
    if updated:
        atomic_write_json(path, prices)
    print(f"Updated {updated}/{len(target_tickers)} prices; failed quotes retain original timestamps.")
    if failed:
        print("Failed or regressing quotes: " + ", ".join(failed), file=sys.stderr)
    return updated > 0 and not failed

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
