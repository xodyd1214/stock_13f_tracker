"""
==============================================================================
🚀 Alpha13F - Local Backend Web Server & Sync Controller
==============================================================================
"""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import threading
import subprocess
import os
import sys

# Windows 콘솔 UTF-8 인코딩 설정
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

PORT = 8080
IS_SYNCING = False

class Alpha13FHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        global IS_SYNCING
        if self.path == "/api/sync":
            if IS_SYNCING:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "syncing", "message": "현재 데이터 수집이 이미 진행 중입니다..."}).encode("utf-8"))
                return

            IS_SYNCING = True
            
            def run_sync_task():
                global IS_SYNCING
                print("🔄 [API] 사용자의 요청으로 13F 데이터, 야후 실시간 주가 및 거시경제 지표 수집을 시작합니다...")
                try:
                    subprocess.run([sys.executable, "collector_1year.py"], check=True)
                    subprocess.run([sys.executable, "price_fetcher.py"], check=True)
                    subprocess.run([sys.executable, "macro_collector.py"], check=False)
                    print("✅ [API] 13F 데이터, 야후 파이낸스 실시간 주가 및 거시경제 지표 수집 완료!")
                except Exception as e:
                    print(f"❌ [API] 수집 중 에러: {e}")
                finally:
                    IS_SYNCING = False

            thread = threading.Thread(target=run_sync_task)
            thread.daemon = True
            thread.start()

    def do_GET(self):
        global IS_SYNCING
        
        # 1. 동기화 상태 확인 API
        if self.path == "/api/sync/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"isSyncing": IS_SYNCING}).encode("utf-8"))
            return

        # 2. 거시경제 지표 수동 갱신 API
        if self.path == "/api/macro/refresh":
            def run_macro_refresh():
                print("🌐 [API] 거시경제 지표 즉시 갱신 시작...")
                subprocess.run([sys.executable, "macro_collector.py"], check=False)
                print("✅ [API] 거시경제 지표 갱신 완료!")

            thread = threading.Thread(target=run_macro_refresh)
            thread.daemon = True
            thread.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "refreshing", "message": "거시경제 데이터 갱신을 시작했습니다."}).encode("utf-8"))
            return

        # 3. 🚀 온디맨드 실시간 주가 조회 API (브라우저 요청 시 즉시 야후 파이낸스 조회)
        if self.path.startswith("/api/prices"):
            from urllib.parse import urlparse, parse_qs
            import requests
            from concurrent.futures import ThreadPoolExecutor
            
            query = parse_qs(urlparse(self.path).query)
            tickers_raw = query.get("tickers", [""])[0]
            tickers = [t.strip().upper() for t in tickers_raw.split(",") if t.strip()][:50]
            
            def fetch_single(ticker):
                try:
                    clean_t = ticker if ("=" in ticker or "^" in ticker or "NYB" in ticker) else ticker.replace(".", "-")
                    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{clean_t}?interval=1d&range=1d"
                    res = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
                    if res.status_code == 200:
                        meta = res.json()["chart"]["result"][0]["meta"]
                        cur_p = meta.get("regularMarketPrice")
                        prev_c = meta.get("chartPreviousClose") or meta.get("previousClose")
                        chg_pct = round(((cur_p - prev_c) / prev_c) * 100, 2) if (cur_p and prev_c) else 0.0
                        if cur_p is not None:
                            return ticker, {
                                "price": round(cur_p, 2),
                                "changePct": chg_pct
                            }
                except Exception:
                    pass
                return ticker, None

            results = {}
            if tickers:
                with ThreadPoolExecutor(max_workers=10) as executor:
                    for t, data in executor.map(fetch_single, tickers):
                        if data:
                            results[t] = data

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(results).encode("utf-8"))
            return

        return super().do_GET()

def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server_address = ("", PORT)
    httpd = ThreadingHTTPServer(server_address, Alpha13FHandler)
    httpd.daemon_threads = True
    print(f"[Alpha13F] 서버가 실행되었습니다: http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == "__main__":
    run_server()
