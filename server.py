"""Local-only Alpha13F web server and serialized data refresh controller."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, quote, urlsplit

import requests
from market_symbols import canonical_symbol, quote_eligible

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

PORT = 8080
HOST = "127.0.0.1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COLLECTOR_TIMEOUT_SECONDS = 3600
PRICE_MAX_AGE_SECONDS = 24 * 60 * 60
SYNC_LOCK = threading.Lock()
SYNC_STATE = {
    "isSyncing": False,
    "status": "idle",
    "operation": None,
    "stage": None,
    "startedAt": None,
    "finishedAt": None,
    "lastError": None,
    "errors": [],
    "stageResults": [],
}
SYNC_SCRIPTS = ("collector_1year.py", "sec_collector.py", "price_fetcher.py", "macro_collector.py")
TICKER_PATTERN = re.compile(r"\^?[A-Z0-9][A-Z0-9.=-]{0,19}\Z")


def _utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sync_snapshot():
    with SYNC_LOCK:
        return dict(SYNC_STATE)


def _error_message(error):
    message = str(error)
    detail = getattr(error, "stderr", None)
    if detail:
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", errors="replace")
        message += ": " + detail.strip()[-1000:]
    return message[:2000]


def _run_sync_task(scripts):
    errors = []
    stage_results = []
    current_stage = None
    try:
        # Each collector preserves its own last-good data. A partial SEC failure
        # must not prevent the independent quote and macro refreshes from running.
        for script in scripts:
            current_stage = script
            result = {"stage": script, "startedAt": _utc_now(), "lastError": None}
            with SYNC_LOCK:
                SYNC_STATE["stage"] = script
            try:
                completed = subprocess.run(
                    [sys.executable, os.path.join(BASE_DIR, script)],
                    cwd=BASE_DIR,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=COLLECTOR_TIMEOUT_SECONDS,
                )
                if completed.stdout:
                    print(completed.stdout, end="")
                if completed.stderr:
                    print(completed.stderr, end="", file=sys.stderr)
                result["status"] = "succeeded"
            except Exception as error:
                message = _error_message(error)
                print(f"[Alpha13F] {script} failed: {message}", file=sys.stderr)
                errors.append({"stage": script, "message": message})
                result.update(status="failed", lastError=message)
            result["finishedAt"] = _utc_now()
            stage_results.append(result)
            with SYNC_LOCK:
                SYNC_STATE.update(
                    stageResults=list(stage_results), errors=list(errors),
                    lastError="\n".join(f"{item['stage']}: {item['message']}" for item in errors) or None,
                )
    except Exception as error:
        # Unexpected controller errors must also leave a terminal, retryable state.
        errors.append({"stage": current_stage, "message": _error_message(error)})
    finally:
        with SYNC_LOCK:
            SYNC_STATE.update(
                isSyncing=False, status="failed" if errors else "succeeded",
                stage=errors[0]["stage"] if errors else None,
                errors=list(errors), stageResults=list(stage_results),
                lastError="\n".join(f"{item['stage']}: {item['message']}" for item in errors) or None,
                finishedAt=_utc_now(),
            )


def _start_sync(operation, scripts):
    # Reserve the job before starting a worker. Both endpoints share this lock
    # because a full sync also writes the macro data file.
    with SYNC_LOCK:
        if SYNC_STATE["isSyncing"]:
            return 200, {"status": "syncing", "message": "데이터 수집이 이미 진행 중입니다.", **SYNC_STATE}
        SYNC_STATE.update(
            isSyncing=True, status="syncing", operation=operation,
            stage=None, startedAt=_utc_now(), finishedAt=None, lastError=None,
            errors=[], stageResults=[],
        )
    try:
        threading.Thread(target=_run_sync_task, args=(scripts,), daemon=True).start()
    except Exception as error:
        with SYNC_LOCK:
            SYNC_STATE.update(
                isSyncing=False, status="failed", lastError=_error_message(error),
                errors=[{"stage": None, "message": _error_message(error)}],
                finishedAt=_utc_now(),
            )
        return 500, {"status": "failed", "message": "수집 작업을 시작하지 못했습니다.", **_sync_snapshot()}
    return 202, {"status": "started", "operation": operation, "message": "데이터 수집을 시작했습니다."}


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _fetch_price(ticker):
    """Return an observed quote, keeping missing change/time explicitly unknown."""
    ticker = canonical_symbol(ticker)
    if not quote_eligible(ticker):
        return ticker, None
    try:
        clean_ticker = ticker if ("=" in ticker or ticker.startswith("^") or ticker.endswith(".NYB")) else ticker.replace(".", "-")
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(clean_ticker, safe='')}?interval=1d&range=1d"
        response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
        response.raise_for_status()
        meta = response.json()["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice")
        if not _finite_number(price) or price <= 0:
            return ticker, None
        previous = meta.get("chartPreviousClose")
        if not _finite_number(previous) or previous <= 0:
            previous = meta.get("previousClose")
        change = None
        if _finite_number(previous) and previous > 0:
            calculated_change = ((price - previous) / previous) * 100
            if math.isfinite(calculated_change):
                change = round(calculated_change, 2)
        fetched_at = int(time.time())
        market_time = meta.get("regularMarketTime")
        if not _finite_number(market_time) or market_time <= 0:
            market_time = None
        else:
            market_time = int(market_time)
        return ticker, {
            "price": round(price, 2),
            "changePct": change,
            "currency": meta.get("currency"),
            "marketTime": market_time,
            "fetchedAt": fetched_at,
            "stale": market_time is None or not -300 <= fetched_at - market_time <= PRICE_MAX_AGE_SECONDS,
            "source": "Yahoo Finance",
        }
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError, AttributeError, OverflowError):
        return ticker, None


class Alpha13FHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _json(self, status, payload, allow=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if allow:
            self.send_header("Allow", allow)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _trusted_request(self, mutation=False):
        # Loopback binding alone does not prevent DNS rebinding or cross-site POSTs.
        hosts = self.headers.get_all("Host", [])
        try:
            if len(hosts) != 1:
                raise ValueError("A single local Host is required")
            host = urlsplit("http://" + hosts[0])
            port = host.port or 80
            if (
                host.hostname not in {"localhost", "127.0.0.1"}
                or port != self.server.server_port
                or host.username is not None or host.password is not None
                or host.path or host.query or host.fragment
            ):
                raise ValueError("Invalid local Host")
            if mutation:
                origins = self.headers.get_all("Origin", [])
                if len(origins) > 1:
                    raise ValueError("A single Origin is required")
                if origins:
                    origin = urlsplit(origins[0])
                    if (
                        origin.scheme != "http" or origin.hostname != host.hostname
                        or (origin.port or 80) != port
                        or origin.username is not None or origin.password is not None
                        or origin.path or origin.query or origin.fragment
                    ):
                        raise ValueError("Origin must match this local server")
                if self.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}:
                    raise ValueError("Cross-site mutations are not allowed")
        except ValueError:
            self._json(403, {"status": "forbidden", "message": "이 로컬 서버와 같은 출처의 요청만 허용됩니다."})
            return False
        return True

    def do_HEAD(self):
        if self._trusted_request():
            super().do_HEAD()

    def do_POST(self):
        if not self._trusted_request(mutation=True):
            return
        path = urlsplit(self.path).path
        if path == "/api/sync":
            status, payload = _start_sync("sync", SYNC_SCRIPTS)
        elif path == "/api/macro/refresh":
            status, payload = _start_sync("macro", ("macro_collector.py",))
        else:
            self._json(404, {"status": "not_found"})
            return
        self._json(status, payload)

    def do_GET(self):
        if not self._trusted_request():
            return
        path = urlsplit(self.path).path
        if path == "/api/sync/status":
            self._json(200, _sync_snapshot())
            return
        if path in {"/api/sync", "/api/macro/refresh"}:
            self._json(405, {"status": "method_not_allowed", "message": "이 작업에는 POST가 필요합니다."}, allow="POST")
            return
        if path == "/api/prices":
            if len(self.path) > 4096:
                self._json(400, {"status": "invalid_tickers"})
                return
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            ticker_params = query.get("tickers", [""])
            tickers = list(dict.fromkeys(t.strip().upper() for t in ticker_params[0].split(",") if t.strip()))
            if len(ticker_params) != 1 or len(tickers) > 50 or any(not TICKER_PATTERN.fullmatch(t) for t in tickers):
                self._json(400, {"status": "invalid_tickers", "message": "최대 50개의 올바른 티커를 입력하세요."})
                return
            tickers = list(dict.fromkeys(canonical_symbol(t) for t in tickers if quote_eligible(t)))
            results = {}
            if tickers:
                with ThreadPoolExecutor(max_workers=10) as executor:
                    for ticker, data in executor.map(_fetch_price, tickers):
                        if data is not None:
                            results[ticker] = data
            self._json(200, results)
            return
        if path.startswith("/api/"):
            self._json(404, {"status": "not_found"})
            return
        super().do_GET()


def run_server():
    httpd = ThreadingHTTPServer((HOST, PORT), Alpha13FHandler)
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

