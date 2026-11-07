"""Macro regressions use fixtures only. No test invokes a live source."""
from datetime import datetime, timezone
import importlib
import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch

import macro_collector as macro


NOW = datetime(2028, 4, 8, 16, tzinfo=timezone.utc)


def failed_fetch(*args, **kwargs):
    raise OSError("offline fixture")


def ny_fed(day="2028-04-07"):
    return {"refRates": [{"type": "EFFR", "percentRate": 4.25, "targetRateFrom": 4.0,
                          "targetRateTo": 4.5, "effectiveDate": day},
                         {"type": "SOFR", "percentRate": 4.31, "effectiveDate": day}]}


def bls_fixture():
    return {"status": "REQUEST_SUCCEEDED", "Results": {"series": [
        {"seriesID": "CUUR0000SA0", "data": [
            {"year": "2028", "period": "M03", "value": "110"},
            {"year": "2028", "period": "M02", "value": "106"},
            {"year": "2027", "period": "M03", "value": "100"},
            {"year": "2027", "period": "M02", "value": "100"},
            {"year": "2028", "period": "M13", "value": "999"},
            {"year": "2030", "period": "M01", "value": "999"}]},
        {"seriesID": "LNS14000000", "data": [
            {"year": "2028", "period": "M03", "value": "4.2"},
            {"year": "2028", "period": "M02", "value": "4.1"}]},
        {"seriesID": "UNREQUESTED", "data": [
            {"year": "2028", "period": "M04", "value": "99"}]},
    ]}}


def chart(value=4.5, day="2028-04-07", previous=4.0, history=False):
    timestamp = int(datetime.fromisoformat(day).replace(hour=15, tzinfo=timezone.utc).timestamp())
    result = {"meta": {"regularMarketPrice": value, "regularMarketTime": timestamp,
                       "chartPreviousClose": previous}}
    if history:
        result.update({"timestamp": [timestamp], "indicators": {"quote": [{"close": [value]}]}})
    return {"chart": {"result": [result], "error": None}}


def all_sources(url, payload=None):
    if url == macro.NY_FED_URL:
        return ny_fed()
    if url == macro.BLS_URL:
        return bls_fixture()
    if "query1.finance.yahoo.com" in url:
        return chart(3.0 if "%5EIRX" in url else 4.5, history="range=1y" in url)
    if url == macro.FOMC_URL:
        return ('<h4><a id="year">2028 FOMC Meetings</a></h4>'
                '<div class="fomc-meeting__month"><strong>April</strong></div>'
                '<div class="fomc-meeting__date">25-26</div>')
    if url.startswith(macro.FRED_CALENDAR):
        year = url.rsplit("=", 1)[-1]
        release_id = "10" if "rid=10" in url else "50"
        return ("All times are US Central Time."
                f"<tr><td><span>Wednesday April 12, {year}</span></td></tr>"
                f'<tr><td>7:30 am</td><td><a href="/release?rid={release_id}">Release</a></td></tr>')
    raise AssertionError(f"Unexpected fixture URL: {url}")


class MacroTests(unittest.TestCase):
    def test_import_never_fetches_or_writes(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("network during import")) as fetch:
            with patch("data_io.atomic_write_json", side_effect=AssertionError("write during import")) as write:
                importlib.reload(macro)
        fetch.assert_not_called()
        write.assert_not_called()
        # Restore the normal imported helper after the patch is removed.
        importlib.reload(macro)

    def test_http_uses_verified_tls(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok": true}'
        with patch("urllib.request.urlopen", return_value=response) as opener:
            self.assertEqual(macro.fetch_json("https://example.invalid/data", {"a": 1}), {"ok": True})
        context = opener.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(opener.call_args.kwargs["timeout"], 10)

    def test_all_failed_sources_are_unknown_not_fabricated(self):
        data = macro.collect_macro(now=NOW, fetcher=failed_fetch)
        self.assertIsNone(data["fedRate"]["effr"])
        self.assertIsNone(data["inflation"]["cpiYoY"])
        self.assertIsNone(data["treasury"]["yield10Y"]["val"])
        self.assertIsNone(data["treasury"]["spread10Y_13W"]["spread"])
        self.assertIsNone(data["benchmarks"]["fedRate"]["neutralVal"])
        self.assertIsNone(data["benchmarks"]["inflation"]["forecast"])
        self.assertEqual(data["calendar"], [])
        self.assertEqual(data["timeSeries"]["treasuryDaily"], [])
        self.assertEqual(data["status"], "unavailable")
        self.assertIsNone(data["lastUpdated"])
        self.assertEqual(data["sources"]["nyFed"]["status"], "error")

    def test_official_release_times_and_retained_calendar(self):
        events, sources = macro.collect_release_calendar({}, NOW, all_sources)
        times = {(event["source"], event["date"]): event["releaseAt"] for event in events}
        self.assertEqual(times[("calendarFomc", "2028-04-25")], "2028-04-26T18:00:00Z")
        self.assertEqual(times[("calendarCpi", "2028-04-12")], "2028-04-12T12:30:00Z")
        self.assertEqual(times[("calendarLabor", "2029-04-12")], "2029-04-12T12:30:00Z")
        retained, status = macro.collect_release_calendar(
            {"schemaVersion": 2, "calendar": events, "sources": sources}, NOW, failed_fetch)
        self.assertEqual(retained, events)
        self.assertEqual(status["calendarCpi"]["status"], "stale")

    def test_failed_collection_preserves_existing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "macro.json"
            original = b'{"lastUpdated":"prior","preserve":42}\n'
            path.write_bytes(original)
            with self.assertRaisesRegex(RuntimeError, "not replaced"):
                macro.run(path, now=NOW, fetcher=failed_fetch)
            self.assertEqual(path.read_bytes(), original)

    def test_failed_first_collection_does_not_create_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.json"
            with self.assertRaises(RuntimeError):
                macro.run(path, now=NOW, fetcher=failed_fetch)
            self.assertFalse(path.exists())

    def test_malformed_cache_is_not_discarded_or_fetched_over(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.json"
            original = b'{"partial":'
            path.write_bytes(original)
            with patch.object(macro, "fetch_json", side_effect=AssertionError("unexpected fetch")) as fetch:
                with self.assertRaises(json.JSONDecodeError):
                    macro.run(path, now=NOW)
            fetch.assert_not_called()
            self.assertEqual(path.read_bytes(), original)

    def test_partial_publication_preserves_verified_sections_as_stale(self):
        previous = macro.collect_macro(now=NOW, fetcher=all_sources)
        old_success = previous["sources"]["yield10Y"]["lastSuccessAt"]

        def fed_only(url, payload=None):
            return ny_fed("2028-04-08") if url == macro.NY_FED_URL else failed_fetch()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "macro.json"
            path.write_text(json.dumps(previous), encoding="utf-8")
            data = macro.run(path, now=NOW, fetcher=fed_only)
            self.assertEqual(data["treasury"]["yield10Y"], previous["treasury"]["yield10Y"])
            self.assertEqual(data["sources"]["yield10Y"]["status"], "stale")
            self.assertEqual(data["sources"]["yield10Y"]["lastSuccessAt"], old_success)
            self.assertEqual(data["status"], "partial")
            self.assertEqual(json.loads(path.read_text()), data)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_legacy_sample_values_are_not_reused(self):
        legacy = {"fedRate": {"effr": "99%"}, "labor": {"unemploymentRate": "99%"},
                  "treasury": {"yield10Y": {"val": 99}}, "calendar": [{"date": "2026-09-15"}]}

        def fed_only(url, payload=None):
            return ny_fed() if url == macro.NY_FED_URL else failed_fetch()

        data = macro.collect_macro(legacy, now=NOW, fetcher=fed_only)
        self.assertEqual(data["fedRate"]["effr"], "4.25%")
        self.assertIsNone(data["labor"]["unemploymentRate"])
        self.assertIsNone(data["treasury"]["yield10Y"]["val"])
        self.assertEqual(data["calendar"], [])

    def test_partial_bls_response_preserves_missing_series_and_history(self):
        previous = macro.collect_macro(now=NOW, fetcher=all_sources)

        def partial_bls(url, payload=None):
            if url == macro.BLS_URL:
                result = bls_fixture()
                result["Results"]["series"] = result["Results"]["series"][:1]
                return result
            return all_sources(url, payload)

        data = macro.collect_macro(previous, now=NOW, fetcher=partial_bls)
        self.assertEqual(data["labor"], previous["labor"])
        self.assertEqual(data["timeSeries"]["policyMonthly"], previous["timeSeries"]["policyMonthly"])
        self.assertEqual(data["sources"]["blsLabor"]["status"], "stale")
        self.assertEqual(data["sources"]["policyMonthly"]["status"], "stale")

    def test_bls_request_and_dates_follow_clock(self):
        calls = []

        def capture(url, payload=None):
            calls.append((url, payload))
            return all_sources(url, payload)

        data = macro.collect_macro(now=NOW, fetcher=capture)
        payload = next(payload for url, payload in calls if url == macro.BLS_URL)
        self.assertEqual(payload["startyear"], "2026")
        self.assertEqual(payload["endyear"], "2028")
        self.assertEqual(data["lastUpdated"], "2028-04-08T16:00:00Z")
        self.assertEqual(data["inflation"]["cpiYoY"], "+10.0%")
        self.assertEqual(data["inflation"]["prevRate"], "+6.0%")
        self.assertEqual(data["labor"]["period"], "2028-03")
        self.assertEqual(data["labor"]["unemploymentRate"], "4.2%")
        self.assertEqual(data["status"], "success")
        self.assertTrue(all(row["realRate"] is None for row in data["timeSeries"]["policyMonthly"]))
        self.assertIsNone(data["benchmarks"]["fedRate"]["realRate"])
        self.assertIsNone(data["benchmarks"]["inflation"]["fedTarget"])
        self.assertAlmostEqual(data["benchmarks"]["fedRate"]["currentMid"], 4.25)

    def test_bls_missing_prior_year_leaves_yoy_unknown(self):
        values = {"2028-03": 110.0}
        data = macro._inflation(values)
        self.assertEqual(data["cpiIndex"], 110)
        self.assertIsNone(data["cpiYoY"])
        self.assertIsNone(data["prevRate"])
        self.assertIsNone(macro._labor({"2028-03": 4.1, "2028-01": 4.0})["prevRate"])

    def test_bls_rejects_bad_status_nonfinite_and_annual_rows(self):
        with self.assertRaises(ValueError):
            macro.parse_bls({"status": "REQUEST_NOT_PROCESSED"}, NOW)
        fixture = bls_fixture()
        fixture["Results"]["series"][0]["data"].append({"year": "2028", "period": "M04", "value": "NaN"})
        cpi, unemployment = macro.parse_bls(fixture, NOW)
        self.assertNotIn("2028-04", cpi)
        self.assertNotIn("2028-13", cpi)
        self.assertNotIn("2030-01", cpi)
        self.assertNotIn("2028-04", unemployment)

    def test_ny_fed_missing_fields_are_null_and_future_rows_rejected(self):
        fixture = ny_fed()
        fixture["refRates"] = [fixture["refRates"][0]]
        del fixture["refRates"][0]["targetRateFrom"]
        data = macro.parse_ny_fed(fixture, NOW)
        self.assertIsNone(data["targetRange"])
        self.assertIsNone(data["sofr"])
        with self.assertRaises(ValueError):
            macro.parse_ny_fed(ny_fed("2030-01-01"), NOW)
        fixture["refRates"][0]["percentRate"] = "NaN"
        with self.assertRaises(ValueError):
            macro.parse_ny_fed(fixture, NOW)

    def test_missing_price_timestamp_and_change_are_not_invented(self):
        self.assertIsNone(macro.parse_quote(chart(previous=None), NOW, "fixture")["change"])
        self.assertEqual(macro.parse_quote(chart(value=0), NOW, "fixture")["val"], 0)
        for invalid in (None, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                macro.parse_quote(chart(value=invalid), NOW, "fixture")
        fixture = chart()
        del fixture["chart"]["result"][0]["meta"]["regularMarketTime"]
        with self.assertRaises(ValueError):
            macro.parse_quote(fixture, NOW, "fixture")
        with self.assertRaises(ValueError):
            macro.parse_quote(chart(day="2030-01-01"), NOW, "fixture")

    def test_empty_or_disjoint_treasury_history_does_not_crash(self):
        fixture = chart(history=True)
        fixture["chart"]["result"][0]["indicators"]["quote"][0]["close"] = [None]
        with self.assertRaises(ValueError):
            macro.parse_treasury_history(fixture, NOW)

        def disjoint(url, payload=None):
            if "range=1y" in url:
                return chart(day="2028-04-06" if "%5EIRX" in url else "2028-04-07", history=True)
            return all_sources(url, payload)

        data = macro.collect_macro(now=NOW, fetcher=disjoint)
        self.assertEqual(data["timeSeries"]["treasuryDaily"], [])
        self.assertEqual(data["sources"]["treasuryDaily"]["status"], "error")

    def test_different_dates_do_not_generate_spread_signal(self):
        def mixed_dates(url, payload=None):
            if "%5EIRX" in url and "range=1d" in url:
                return chart(day="2028-04-06")
            return all_sources(url, payload)

        data = macro.collect_macro(now=NOW, fetcher=mixed_dates)
        self.assertIsNone(data["treasury"]["spread10Y_13W"]["spread"])
        self.assertIsNone(data["treasury"]["spread10Y_13W"]["inverted"])
        self.assertIsNone(data["benchmarks"]["yieldCurve"]["status"])

    def test_source_age_is_not_reset_by_new_fetch_time(self):
        def old_fed(url, payload=None):
            return ny_fed("2028-03-01") if url == macro.NY_FED_URL else all_sources(url, payload)

        data = macro.collect_macro(now=NOW, fetcher=old_fed)
        source = data["sources"]["nyFed"]
        self.assertEqual(source["asOf"], "2028-03-01")
        self.assertEqual(source["ageDays"], 38)
        self.assertEqual(source["status"], "stale")
        self.assertEqual(data["status"], "stale")

    def test_older_response_cannot_replace_newer_verified_observation(self):
        previous = macro.collect_macro(now=NOW, fetcher=all_sources)

        def regressed(url, payload=None):
            return ny_fed("2028-03-01") if url == macro.NY_FED_URL else all_sources(url, payload)

        data = macro.collect_macro(previous, now=NOW, fetcher=regressed)
        self.assertEqual(data["fedRate"], previous["fedRate"])
        self.assertEqual(data["sources"]["nyFed"]["status"], "stale")
        self.assertIn("older", data["sources"]["nyFed"]["error"])

    def test_atomic_write_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "macro.json"
            original = b'{"valid":"prior"}\n'
            path.write_bytes(original)
            with patch("data_io.os.replace", side_effect=OSError("simulated disk error")):
                with self.assertRaises(OSError):
                    macro.run(path, now=NOW, fetcher=all_sources)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_main_reports_partial_failure(self):
        data = macro.collect_macro(now=NOW, fetcher=all_sources)
        data["collection"]["failedSources"] = ["blsLabor"]
        data["status"] = "partial"
        with patch.object(macro, "run", return_value=data), patch("builtins.print"):
            self.assertEqual(macro.main(), 1)

    def test_main_does_not_claim_success_for_stale_sources(self):
        data = macro.collect_macro(now=NOW, fetcher=all_sources)
        data["status"] = "stale"
        with patch.object(macro, "run", return_value=data), patch("builtins.print"):
            self.assertEqual(macro.main(), 1)


if __name__ == "__main__":
    unittest.main()
