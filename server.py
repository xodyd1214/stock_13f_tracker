"""
==============================================================================
🚀 Alpha13F - Local Backend Web Server & Sync Controller
==============================================================================
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
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
                print("🔄 [API] 사용자의 요청으로 13F 데이터 수집을 시작합니다...")
                try:
                    subprocess.run([sys.executable, "collector_1year.py"], check=True)
                    print("✅ [API] 13F 데이터 수집 및 시계열 분석 완료!")
                except Exception as e:
                    print(f"❌ [API] 수집 중 에러: {e}")
                finally:
                    IS_SYNCING = False

            thread = threading.Thread(target=run_sync_task)
            thread.daemon = True
            thread.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "started",
                "message": "SEC 공식 13F 데이터 수집이 시작되었습니다. (약 30초 소요)"
            }).encode("utf-8"))
            return

        self.send_error(404, "Not Found")

    def do_GET(self):
        global IS_SYNCING
        if self.path == "/api/sync/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"isSyncing": IS_SYNCING}).encode("utf-8"))
            return
            
        return super().do_GET()

def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server_address = ("", PORT)
    httpd = HTTPServer(server_address, Alpha13FHandler)
    print(f"🌐 [Alpha13F] 서버가 실행되었습니다: http://localhost:{PORT}")
    httpd.serve_forever()

if __name__ == "__main__":
    run_server()
