"""Offline regression tests for the local API. No collectors or upstream calls run."""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def reset_sync_state():
    with server.SYNC_LOCK:
        server.SYNC_STATE.update(
            isSyncing=False, status="idle", operation=None, stage=None,
            startedAt=None, finishedAt=None, lastError=None, errors=[], stageResults=[],
        )


class QuietHandler(server.Alpha13FHandler):
    def log_message(self, *_args):
        pass


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.httpd.daemon_threads = True
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.host = f"127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join(timeout=3)

    def setUp(self):
        reset_sync_state()
        self.run_patch = patch("server.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.run = self.run_patch.start()
        self.get_patch = patch("server.requests.get", side_effect=AssertionError("Unexpected upstream request"))
        self.get = self.get_patch.start()
        self.addCleanup(self.get_patch.stop)
        self.addCleanup(self.run_patch.stop)

    def request(self, method, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        try:
            request_headers = {"Host": self.host, **(headers or {})}
            conn.request(method, path, headers=request_headers)
            response = conn.getresponse()
            body = response.read()
            return response.status, dict(response.getheaders()), json.loads(body)
        finally:
            conn.close()

    def wait_for_idle(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = server._sync_snapshot()
            if not state["isSyncing"]:
                return state
            time.sleep(0.005)
        self.fail("Mocked refresh did not finish")

    def test_sync_sends_accepted_response_and_runs_all_stages(self):
        status, headers, body = self.request("POST", "/api/sync", {"Origin": f"http://{self.host}"})
        self.assertEqual(status, 202)
        self.assertEqual(body["status"], "started")
        self.assertEqual(body["operation"], "sync")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertGreater(int(headers["Content-Length"]), 0)
        state = self.wait_for_idle()
        self.assertEqual(state["status"], "succeeded")
        self.assertIsNone(state["lastError"])
        self.assertIsNotNone(state["finishedAt"])
        scripts = [os.path.basename(call.args[0][1]) for call in self.run.call_args_list]
        self.assertEqual(scripts, list(server.SYNC_SCRIPTS))
        for call in self.run.call_args_list:
            self.assertEqual(call.kwargs["cwd"], server.BASE_DIR)
            self.assertTrue(call.kwargs["check"])
            self.assertGreater(call.kwargs["timeout"], 0)

    def test_simultaneous_sync_and_macro_requests_launch_only_one_job(self):
        started, release = threading.Event(), threading.Event()

        def blocked_run(*_args, **_kwargs):
            started.set()
            release.wait(3)
            return subprocess.CompletedProcess([], 0, "", "")

        self.run.side_effect = blocked_run
        self.addCleanup(release.set)
        try:
            status, _, _ = self.request("POST", "/api/sync")
            self.assertEqual(status, 202)
            self.assertTrue(started.wait(1))
            with ThreadPoolExecutor(max_workers=12) as executor:
                responses = list(executor.map(
                    lambda i: self.request("POST", "/api/sync" if i % 2 else "/api/macro/refresh"),
                    range(12),
                ))
            self.assertTrue(all(response[0] == 200 for response in responses))
            self.assertTrue(all(response[2]["isSyncing"] for response in responses))
            self.assertTrue(all(response[2]["operation"] == "sync" for response in responses))
            self.assertEqual(self.run.call_count, 1)
        finally:
            release.set()
            self.wait_for_idle()
        self.assertEqual(self.run.call_count, len(server.SYNC_SCRIPTS))

    def test_failure_is_exposed_with_stage_and_next_job_can_retry(self):
        self.run.side_effect = subprocess.CalledProcessError(1, ["collector"], stderr="Invalid SEC data")
        status, _, _ = self.request("POST", "/api/sync")
        self.assertEqual(status, 202)
        self.wait_for_idle()
        status, headers, body = self.request("GET", "/api/sync/status")
        self.assertEqual(status, 200)
        self.assertFalse(body["isSyncing"])
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["stage"], "collector_1year.py")
        self.assertIn("Invalid SEC data", body["lastError"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.run.call_count, len(server.SYNC_SCRIPTS))
        self.assertEqual([error["stage"] for error in body["errors"]], list(server.SYNC_SCRIPTS))
        self.assertEqual([result["status"] for result in body["stageResults"]], ["failed"] * len(server.SYNC_SCRIPTS))
        self.run.side_effect = None
        self.assertEqual(self.request("POST", "/api/sync")[0], 202)
        self.assertEqual(self.wait_for_idle()["status"], "succeeded")
        self.assertIsNone(server._sync_snapshot()["lastError"])
        self.assertEqual(server._sync_snapshot()["errors"], [])

    def test_partial_collector_failure_does_not_skip_prices_or_macro(self):
        self.run.side_effect = [
            subprocess.CalledProcessError(1, ["collector"], stderr="One fund failed; previous data retained"),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        self.assertEqual(self.request("POST", "/api/sync")[0], 202)
        self.wait_for_idle()
        status, _, body = self.request("GET", "/api/sync/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "failed")
        self.assertFalse(body["isSyncing"])
        self.assertEqual(body["stage"], "collector_1year.py")
        self.assertEqual(len(body["errors"]), 1)
        self.assertIn("previous data retained", body["lastError"])
        self.assertEqual([result["stage"] for result in body["stageResults"]], list(server.SYNC_SCRIPTS))
        self.assertEqual([result["status"] for result in body["stageResults"]], ["failed", "succeeded", "succeeded", "succeeded"])
        self.assertTrue(all(result["finishedAt"] for result in body["stageResults"]))
        self.assertEqual(self.run.call_count, len(server.SYNC_SCRIPTS))

    def test_macro_failure_is_not_reported_as_success(self):
        self.run.side_effect = subprocess.CalledProcessError(2, ["macro"], stderr="Feed unavailable")
        status, _, body = self.request("POST", "/api/macro/refresh")
        self.assertEqual(status, 202)
        self.assertEqual(body["operation"], "macro")
        state = self.wait_for_idle()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["stage"], "macro_collector.py")
        self.assertIn("Feed unavailable", state["lastError"])
        self.assertEqual(self.run.call_count, 1)

    def test_timeout_releases_lock_and_reports_failure(self):
        self.run.side_effect = subprocess.TimeoutExpired(["collector"], 3600)
        self.assertEqual(self.request("POST", "/api/sync")[0], 202)
        state = self.wait_for_idle()
        self.assertEqual(state["status"], "failed")
        self.assertIn("timed out", state["lastError"])

    def test_get_mutations_are_rejected_without_running_collectors(self):
        for path in ("/api/sync", "/api/macro/refresh", "/api/macro/refresh?test=1"):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 405)
                self.assertEqual(headers["Allow"], "POST")
                self.assertEqual(body["status"], "method_not_allowed")
        self.run.assert_not_called()

    def test_unknown_post_and_api_paths_return_json_not_a_hanging_connection(self):
        self.assertEqual(self.request("POST", "/unknown")[0], 404)
        self.assertEqual(self.request("GET", "/api/prices-unrelated")[0], 404)
        self.run.assert_not_called()
        self.get.assert_not_called()

    def test_mutations_reject_untrusted_host_origin_and_fetch_site(self):
        cases = [
            {"Host": f"attacker.example:{self.httpd.server_port}"},
            {"Host": "127.0.0.1:1"},
            {"Host": f"user@{self.host}"},
            {"Origin": "https://attacker.example"},
            {"Origin": "null"},
            {"Origin": f"http://localhost:{self.httpd.server_port}"},
            {"Origin": f"http://{self.host}/not-an-origin"},
            {"Origin": f"https://{self.host}"},
            {"Sec-Fetch-Site": "cross-site"},
            {"Sec-Fetch-Site": "same-site"},
        ]
        for headers in cases:
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/sync", headers)[0], 403)
                self.assertEqual(self.request("POST", "/api/macro/refresh", headers)[0], 403)
        self.run.assert_not_called()

    def test_head_rejects_dns_rebinding_host_without_a_body(self):
        conn = HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        try:
            conn.request("HEAD", "/index.html", headers={"Host": "attacker.example"})
            response = conn.getresponse()
            self.assertEqual(response.status, 403)
            self.assertEqual(response.read(), b"")
        finally:
            conn.close()
        self.run.assert_not_called()
        self.get.assert_not_called()

    def test_status_and_prices_reject_dns_rebinding_host(self):
        headers = {"Host": f"attacker.example:{self.httpd.server_port}"}
        self.assertEqual(self.request("GET", "/api/sync/status", headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/prices?tickers=AAPL", headers)[0], 403)
        self.get.assert_not_called()

    def test_localhost_same_origin_is_accepted(self):
        host = f"localhost:{self.httpd.server_port}"
        status, _, _ = self.request("POST", "/api/macro/refresh", {"Host": host, "Origin": f"http://{host}", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(status, 202)
        self.assertEqual(self.wait_for_idle()["status"], "succeeded")

    def quote_response(self, **overrides):
        meta = {"regularMarketPrice": 110, "chartPreviousClose": 100, "regularMarketTime": 1700000000, "currency": "USD", **overrides}
        response = Mock()
        response.json.return_value = {"chart": {"result": [{"meta": meta}]}}
        self.get.side_effect = None
        self.get.return_value = response
        return response

    def test_prices_preserve_mapping_shape_validate_tickers_and_report_quote_time(self):
        self.quote_response()
        with patch("server.time.time", return_value=1700000060):
            status, headers, body = self.request("GET", "/api/prices?tickers=aapl,AAPL,BRK.B,%5ETNX,CL%3DF,DX-Y.NYB")
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"AAPL", "BRK.B", "^TNX", "CL=F", "DX-Y.NYB"})
        self.assertEqual(self.get.call_count, 5)

        self.assertEqual(body["AAPL"]["price"], 110)
        self.assertEqual(body["AAPL"]["changePct"], 10)
        self.assertEqual(body["AAPL"]["marketTime"], 1700000000)
        self.assertEqual(body["AAPL"]["fetchedAt"], 1700000060)
        self.assertFalse(body["AAPL"]["stale"])
        self.assertEqual(body["AAPL"]["source"], "Yahoo Finance")
        urls = [call.args[0] for call in self.get.call_args_list]
        self.assertTrue(any("/BRK-B?" in url for url in urls))
        self.assertTrue(any("/%5ETNX?" in url for url in urls))
        self.assertTrue(any("/CL%3DF?" in url for url in urls))
        self.assertTrue(any("/DX-Y.NYB?" in url for url in urls))
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_prices_skip_jhg_and_deduplicate_renamed_block(self):
        self.quote_response()
        status, _, body = self.request('GET', '/api/prices?tickers=JHG,SQ,XYZ,HRB,BGIN')
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {'XYZ', 'HRB', 'BGIN'})
        self.assertEqual(self.get.call_count, 3)
        self.assertTrue(all('/JHG?' not in call.args[0] and '/SQ?' not in call.args[0] for call in self.get.call_args_list))

    def test_inactive_price_request_does_not_contact_yahoo(self):
        status, _, body = self.request('GET', '/api/prices?tickers=JHG')
        self.assertEqual((status, body), (200, {}))
        self.get.assert_not_called()

    def test_invalid_tickers_are_rejected_before_network(self):
        for query in ("AAPL%2F..%2Fevil", "AAPL%3Fsecret%3Dx", "AAPL&tickers=MSFT", ",".join(f"T{i}" for i in range(51))):
            with self.subTest(query=query):
                self.assertEqual(self.request("GET", "/api/prices?tickers=" + query)[0], 400)
        self.get.assert_not_called()

    def test_empty_ticker_request_returns_empty_mapping(self):
        self.assertEqual(self.request("GET", "/api/prices")[2], {})
        self.get.assert_not_called()

    def test_missing_change_or_time_remains_unknown_and_stale(self):
        self.quote_response(chartPreviousClose=None, regularMarketTime=None)
        status, _, body = self.request("GET", "/api/prices?tickers=AAPL")
        self.assertEqual(status, 200)
        self.assertIsNone(body["AAPL"]["changePct"])
        self.assertIsNone(body["AAPL"]["marketTime"])
        self.assertTrue(body["AAPL"]["stale"])

    def test_old_and_future_market_times_are_marked_stale(self):
        for market_time in (1600000000, 1800000000):
            with self.subTest(market_time=market_time):
                self.quote_response(regularMarketTime=market_time)
                with patch("server.time.time", return_value=1700000000):
                    self.assertTrue(self.request("GET", "/api/prices?tickers=AAPL")[2]["AAPL"]["stale"])

    def test_invalid_numeric_quotes_are_omitted(self):
        for price in (float("nan"), float("inf"), "100", True, -1, 0, None):
            with self.subTest(price=price):
                self.quote_response(regularMarketPrice=price)
                self.assertEqual(self.request("GET", "/api/prices?tickers=AAPL")[2], {})

    def test_upstream_error_or_missing_result_does_not_invent_a_quote(self):
        response = self.quote_response()
        response.raise_for_status.side_effect = server.requests.HTTPError("429")
        self.assertEqual(self.request("GET", "/api/prices?tickers=AAPL")[2], {})
        response.raise_for_status.side_effect = None
        response.json.return_value = {"chart": {"result": None}}
        self.assertEqual(self.request("GET", "/api/prices?tickers=AAPL")[2], {})


class ControllerTests(unittest.TestCase):
    def setUp(self):
        reset_sync_state()

    def test_thread_start_failure_returns_error_and_releases_lock(self):
        with patch("server.threading.Thread") as thread:
            thread.return_value.start.side_effect = RuntimeError("Cannot start worker")
            status, payload = server._start_sync("sync", server.SYNC_SCRIPTS)
        self.assertEqual(status, 500)
        self.assertEqual(payload["status"], "failed")
        self.assertFalse(payload["isSyncing"])
        self.assertIn("Cannot start worker", payload["lastError"])

    def test_simultaneous_initial_requests_reserve_one_worker(self):
        barrier, release = threading.Barrier(12), threading.Event()

        def start_job(_index):
            barrier.wait(3)
            return server._start_sync("macro", ("macro_collector.py",))

        def blocked_run(*_args, **_kwargs):
            release.wait(10)
            return subprocess.CompletedProcess([], 0, "", "")

        with patch("server.subprocess.run", side_effect=blocked_run) as run:
            try:
                with ThreadPoolExecutor(max_workers=12) as pool:
                    results = list(pool.map(start_job, range(12)))
                self.assertEqual(sum(code == 202 for code, _ in results), 1)
                self.assertEqual(sum(code == 200 for code, _ in results), 11)
                self.assertEqual(run.call_count, 1)
            finally:
                release.set()
                deadline = time.monotonic() + 3
                while server._sync_snapshot()["isSyncing"] and time.monotonic() < deadline:
                    time.sleep(0.005)
            self.assertFalse(server._sync_snapshot()["isSyncing"])

    def test_run_server_binds_only_loopback_and_closes(self):
        with patch("server.ThreadingHTTPServer") as factory:
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            server.run_server()
        factory.assert_called_once_with(("127.0.0.1", server.PORT), server.Alpha13FHandler)
        factory.return_value.server_close.assert_called_once()


if __name__ == "__main__":
    unittest.main()

