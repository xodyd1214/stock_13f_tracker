"""Collect sourced macro observations without manufacturing missing values.

Importing this module never fetches data or writes files. Collection is deliberately
separate from publication so callers can test every failure path offline.
"""

import copy
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import ssl
import sys
import urllib.parse
import urllib.request

from data_io import atomic_write_json, load_json

NY_FED_URL = "https://markets.newyorkfed.org/api/rates/all/latest.json"
BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
OUTPUT_PATH = Path(__file__).resolve().parent / "latest_macro_indicators.json"
TICKERS = (
    ("^TNX", "yield10Y", "10년물 국채 금리", "treasury"),
    ("^IRX", "yield13W", "3개월물 국채 수익률 지표", "treasury"),
    ("^FVX", "yield5Y", "5년물 국채 금리", "treasury"),
    ("DX-Y.NYB", "dxy", "달러 인덱스 (DXY)", "commoditiesAndFx"),
    ("CL=F", "wtiOil", "WTI 원유 선물 ($)", "commoditiesAndFx"),
    ("GC=F", "gold", "금 선물 ($)", "commoditiesAndFx"),
)


def _utc(now=None):
    now = now or datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def _stamp(now):
    return now.isoformat(timespec="seconds").replace("+00:00", "Z")


def _number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _date(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m" if len(value) == 7 else "%Y-%m-%d").date()
    except ValueError:
        return None


def _percent(value, digits=2):
    return f"{value:.{digits}f}%" if value is not None else None


def fetch_json(url, payload=None):
    """Use certificate/hostname verification and bounded HTTP timeouts."""
    headers = {"User-Agent": "Alpha13F macro collector", "Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
        return json.loads(response.read().decode("utf-8"))


def _chart_url(symbol, period):
    symbol = urllib.parse.quote(symbol, safe="")
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={period}&interval=1d"


def _chart_result(payload):
    chart = payload.get("chart", {}) if isinstance(payload, dict) else {}
    results = chart.get("result")
    if chart.get("error") or not isinstance(results, list) or not results or not isinstance(results[0], dict):
        raise ValueError("Market source returned no valid chart")
    return results[0]


def _observation_date(timestamp, now):
    timestamp = _number(timestamp)
    if timestamp is None:
        raise ValueError("Market source omitted observation time")
    try:
        observed = datetime.fromtimestamp(timestamp, timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError("Invalid market observation time") from exc
    if observed > now + timedelta(minutes=5):
        raise ValueError("Market source returned a future observation")
    return observed.date().isoformat()


def parse_ny_fed(payload, now):
    rates = payload.get("refRates", []) if isinstance(payload, dict) else []
    valid = {}
    for row in rates:
        if not isinstance(row, dict) or row.get("type") not in ("EFFR", "SOFR"):
            continue
        observed = _date(row.get("effectiveDate"))
        rate = _number(row.get("percentRate"))
        if observed and observed <= now.date() and rate is not None:
            if row["type"] not in valid or observed > _date(valid[row["type"]]["effectiveDate"]):
                valid[row["type"]] = row
    effr = valid.get("EFFR")
    if not effr:
        raise ValueError("NY Fed returned no dated EFFR observation")
    lower, upper = _number(effr.get("targetRateFrom")), _number(effr.get("targetRateTo"))
    if lower is None or upper is None or lower > upper:
        lower = upper = None
    sofr = valid.get("SOFR", {})
    return {
        "targetRange": f"{lower:.2f}% ~ {upper:.2f}%" if lower is not None else None,
        "targetLower": lower,
        "targetUpper": upper,
        "effr": _percent(_number(effr.get("percentRate"))),
        "sofr": _percent(_number(sofr.get("percentRate"))),
        "effectiveDate": effr["effectiveDate"],
        "sofrEffectiveDate": sofr.get("effectiveDate"),
    }


def parse_bls(payload, now):
    if not isinstance(payload, dict) or payload.get("status") != "REQUEST_SUCCEEDED":
        raise ValueError("BLS did not report a successful request")
    maps = {"CUUR0000SA0": {}, "LNS14000000": {}}
    for series in payload.get("Results", {}).get("series", []):
        values = maps.get(series.get("seriesID"))
        if values is None:
            continue
        for row in series.get("data", []):
            period = row.get("period", "")
            month = f"{row.get('year')}-{period[1:]}"
            observed = _date(month)
            value = _number(row.get("value"))
            if len(period) != 3 or not period.startswith("M") or not observed or observed > now.date() or value is None:
                continue
            if (series["seriesID"] == "CUUR0000SA0" and value <= 0) or (series["seriesID"] == "LNS14000000" and not 0 <= value <= 100):
                continue
            values[month] = value
    return maps["CUUR0000SA0"], maps["LNS14000000"]


def _previous_month(month):
    return (_date(month).replace(day=1) - timedelta(days=1)).strftime("%Y-%m")


def _cpi_yoy(values, month):
    previous = f"{int(month[:4]) - 1}{month[4:]}"
    if month not in values or not values.get(previous):
        return None
    return (values[month] / values[previous] - 1) * 100


def _inflation(values):
    if not values:
        raise ValueError("BLS returned no CPI observations")
    month = max(values)
    yoy, previous = _cpi_yoy(values, month), _cpi_yoy(values, _previous_month(month))
    return {
        "cpiIndex": values[month], "cpiYoY": f"{yoy:+.1f}%" if yoy is not None else None,
        "cpiYoYValue": round(yoy, 4) if yoy is not None else None,
        "period": month, "prevRate": f"{previous:+.1f}%" if previous is not None else None,
    }


def _labor(values):
    if not values:
        raise ValueError("BLS returned no unemployment observations")
    month = max(values)
    return {"unemploymentRate": _percent(values[month], 1), "period": month,
            "prevRate": _percent(values.get(_previous_month(month)), 1)}


def parse_quote(payload, now, label):
    meta = _chart_result(payload).get("meta", {})
    price, previous = _number(meta.get("regularMarketPrice")), _number(meta.get("chartPreviousClose"))
    if price is None:
        raise ValueError("Market source omitted a finite price")
    as_of = _observation_date(meta.get("regularMarketTime"), now)
    change = ((price - previous) / previous * 100) if previous not in (None, 0) else None
    return {"val": round(price, 2), "change": round(change, 2) if change is not None else None,
            "label": label, "asOf": as_of}


def parse_treasury_history(payload, now):
    result = _chart_result(payload)
    timestamps = result.get("timestamp", [])
    quotes = result.get("indicators", {}).get("quote", [])
    closes = quotes[0].get("close", []) if quotes else []
    if len(timestamps) != len(closes):
        raise ValueError("Market history has mismatched timestamps and values")
    values = {}
    for timestamp, close in zip(timestamps, closes):
        value = _number(close)
        if value is not None:
            values[_observation_date(timestamp, now)] = round(value, 2)
    if not values:
        raise ValueError("Market source returned empty treasury history")
    return values


def empty_macro():
    """A missing observation is null, never a sample or a guessed zero."""
    result = {
        "schemaVersion": 2, "lastUpdated": None, "collectedAt": None, "status": "unavailable",
        "fedRate": {"targetRange": None, "targetLower": None, "targetUpper": None,
                    "effr": None, "sofr": None, "effectiveDate": None, "sofrEffectiveDate": None},
        "labor": {"unemploymentRate": None, "period": None, "prevRate": None},
        "inflation": {"cpiIndex": None, "cpiYoY": None, "cpiYoYValue": None, "period": None, "prevRate": None},
        "treasury": {}, "commoditiesAndFx": {}, "calendar": [],
        "timeSeries": {"treasuryDaily": [], "policyMonthly": []}, "sources": {},
    }
    for _, key, label, section in TICKERS:
        result[section][key] = {"val": None, "change": None, "label": label, "asOf": None}
    return result


def _source_meta(url, now, as_of=None, max_age=7, error=None, previous=None):
    observed = _date(as_of)
    age = (now.date() - observed).days if observed else None
    status = "success" if observed else "unavailable"
    if observed and (error or age > max_age):
        status = "stale"
    elif error:
        status = "error"
    return {"url": url, "status": status, "fetchStatus": "error" if error else "success",
            "asOf": as_of, "ageDays": age, "maxAgeDays": max_age, "checkedAt": _stamp(now),
            "lastSuccessAt": previous.get("lastSuccessAt") if error and previous else (_stamp(now) if not error else None),
            "error": str(error) if error else None}


def _trusted_previous(previous, key, url):
    """The old bundled dataset lacks provenance and includes invented values."""
    if not isinstance(previous, dict) or previous.get("schemaVersion") != 2:
        return None
    meta = previous.get("sources", {}).get(key, {})
    if (isinstance(meta, dict) and meta.get("url") == url and _date(meta.get("asOf"))
            and meta.get("lastSuccessAt") and meta.get("status") in ("success", "stale")):
        return meta
    return None


def _get_path(data, path):
    for key in path:
        data = data[key]
    return data


def _set_path(data, path, value):
    for key in path[:-1]:
        data = data[key]
    data[path[-1]] = copy.deepcopy(value)


def _derive(data):
    y10, y3 = data["treasury"]["yield10Y"], data["treasury"]["yield13W"]
    # Do not combine an old cached point with a different observation date.
    comparable = y10["val"] is not None and y3["val"] is not None and y10.get("asOf") == y3.get("asOf")
    spread = round(y10["val"] - y3["val"], 2) if comparable else None
    description = None if spread is None else ("10년물 수익률이 3개월물보다 낮음" if spread < 0 else "10년물 수익률이 3개월물 이상")
    data["treasury"]["spread10Y_13W"] = {
        "spread": spread, "inverted": spread < 0 if spread is not None else None,
        "desc": description, "asOf": y10.get("asOf") if comparable else None,
    }
    fed, inflation = data["fedRate"], data["inflation"]
    lower, upper = fed.get("targetLower"), fed.get("targetUpper")
    data["benchmarks"] = {
        "fedRate": {"current": fed["targetRange"], "currentMid": (lower + upper) / 2 if lower is not None and upper is not None else None,
                    "effr": fed["effr"], "sofr": fed["sofr"], "neutralRate": None, "neutralVal": None,
                    "gapToNeutral": None, "realRate": None, "zone": None},
        "inflation": {"current": inflation["cpiYoY"], "currentVal": inflation["cpiYoYValue"],
                      "fedTarget": None, "targetVal": None, "gapToTarget": None,
                      "prevRate": inflation["prevRate"], "forecast": None, "zone": None},
        "yieldCurve": {"currentSpread": spread, "yield10Y": y10["val"], "yield13W": y3["val"],
                       "recessionThreshold": None, "status": description},
        "cashRiskFree": {"rate": y3["val"], "sp500Dividend": None, "spreadToEquity": None,
                         "desc": "3개월물 국채 수익률 지표 (확정 투자수익률 아님)" if y3["val"] is not None else None},
    }


def collect_macro(previous=None, *, now=None, fetcher=None):
    """Return a snapshot plus per-source freshness; never write as a side effect."""
    now, fetcher = _utc(now), fetcher or fetch_json
    previous = previous or {}
    data = empty_macro()
    data["collectedAt"] = _stamp(now)
    successful = []

    def collect(key, url, path, producer, as_of, max_age=7):
        prior_meta = _trusted_previous(previous, key, url)
        try:
            value = producer()
            observed = as_of(value)
            if not _date(observed) or _date(observed) > now.date():
                raise ValueError("Source omitted a valid observation date")
            if prior_meta and _date(observed) < _date(prior_meta["asOf"]):
                raise ValueError("Source is older than the preserved observation")
            _set_path(data, path, value)
            data["sources"][key] = _source_meta(url, now, observed, max_age)
            successful.append(key)
        except Exception as exc:
            if prior_meta:
                try:
                    _set_path(data, path, _get_path(previous, path))
                except (KeyError, TypeError):
                    prior_meta = None
            data["sources"][key] = _source_meta(url, now, prior_meta.get("asOf") if prior_meta else None,
                                                 max_age, exc, prior_meta)

    collect("nyFed", NY_FED_URL, ("fedRate",), lambda: parse_ny_fed(fetcher(NY_FED_URL), now),
            lambda value: min(d for d in (value["effectiveDate"], value["sofrEffectiveDate"]) if d))
    # Ask for enough history to calculate year-on-year inflation, including January.
    try:
        cpi, unemployment = parse_bls(fetcher(BLS_URL, {"seriesid": ["CUUR0000SA0", "LNS14000000"],
                                                    "startyear": str(now.year - 2), "endyear": str(now.year)}), now)
        bls_error = None
    except Exception as exc:
        cpi, unemployment, bls_error = {}, {}, exc

    def bls_value(builder, values):
        if bls_error:
            raise bls_error
        return builder(values)

    collect("blsInflation", BLS_URL, ("inflation",), lambda: bls_value(_inflation, cpi), lambda value: value["period"], 75)
    collect("blsLabor", BLS_URL, ("labor",), lambda: bls_value(_labor, unemployment), lambda value: value["period"], 75)

    def monthly_policy():
        if bls_error:
            raise bls_error
        if not cpi or not unemployment:
            # A partial BLS reply must not erase the other series' saved history.
            raise ValueError("BLS omitted a series needed for monthly history")
        months = sorted(month for month in set(cpi) | set(unemployment) if month >= f"{now.year - 1}-01")
        if not months:
            raise ValueError("BLS returned no monthly history")
        return [{"month": month, "cpiYoY": round(_cpi_yoy(cpi, month), 2) if _cpi_yoy(cpi, month) is not None else None,
                 "unemployment": unemployment.get(month), "realRate": None} for month in months]

    collect("policyMonthly", BLS_URL, ("timeSeries", "policyMonthly"), monthly_policy, lambda value: value[-1]["month"], 75)
    for symbol, key, label, section in TICKERS:
        url = _chart_url(symbol, "1d")
        collect(key, url, (section, key), lambda url=url, label=label: parse_quote(fetcher(url), now, label), lambda value: value["asOf"])

    def treasury_history():
        series = {key: parse_treasury_history(fetcher(_chart_url(symbol, "1y")), now)
                  for symbol, key in (("^IRX", "y3m"), ("^FVX", "y5y"), ("^TNX", "y10y"))}
        dates = sorted(set.intersection(*(set(values) for values in series.values())))
        if not dates:
            raise ValueError("Treasury histories have no common observation dates")
        return [{"date": day, "y3m": series["y3m"][day], "y5y": series["y5y"][day],
                 "y10y": series["y10y"][day], "spread": round(series["y10y"][day] - series["y3m"][day], 2)} for day in dates]

    collect("treasuryDaily", "https://query1.finance.yahoo.com/v8/finance/chart/", ("timeSeries", "treasuryDaily"),
            treasury_history, lambda value: value[-1]["date"])
    data["sources"]["calendar"] = {"status": "unavailable", "fetchStatus": "not_configured", "asOf": None,
                                     "error": "No verified event-calendar source is configured"}
    data["collection"] = {"successfulSources": successful,
                          "failedSources": [key for key, source in data["sources"].items() if source["fetchStatus"] == "error"]}
    data["lastUpdated"] = _stamp(now) if successful else (previous.get("lastUpdated") if previous.get("schemaVersion") == 2 else None)
    data["status"] = "success" if successful and not data["collection"]["failedSources"] else ("partial" if successful else "unavailable")
    if data["status"] == "success" and any(source["status"] == "stale" for source in data["sources"].values()):
        data["status"] = "stale"
    _derive(data)
    return data


def run(output_path=OUTPUT_PATH, *, now=None, fetcher=None):
    """Publish only a validated, at-least-partly successful snapshot atomically.

    Total fetch failure and malformed existing JSON leave the original bytes intact.
    Failed source sections are retained only when their provenance was recorded by
    this collector; old bundled samples are not treated as verified observations.
    """
    previous = load_json(output_path, {})
    if not isinstance(previous, dict):
        raise ValueError("Existing macro dataset must be a JSON object")
    data = collect_macro(previous, now=now, fetcher=fetcher)
    if not data["collection"]["successfulSources"]:
        raise RuntimeError("All macro sources failed; existing data was not replaced")
    atomic_write_json(output_path, data)
    return data


def main():
    try:
        data = run()
    except Exception as exc:
        print(f"Macro collection failed: {exc}", file=sys.stderr)
        return 1
    print(f"Macro collection {data['status']}: {len(data['collection']['successfulSources'])} sources saved to {OUTPUT_PATH}")
    # Expose partial failures to the sync controller rather than claiming success.
    return 0 if data["status"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
