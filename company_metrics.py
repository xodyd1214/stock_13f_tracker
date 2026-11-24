"""Publish end-of-session company metrics for a bounded set of reviewed quote symbols."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import math
from pathlib import Path
import re
import sys
import time
from zoneinfo import ZoneInfo

import requests

from data_io import atomic_write_json, load_json

BASE = Path(__file__).resolve().parent
OUTPUT = 'latest_company_metrics.json'
EASTERN = ZoneInfo('America/New_York')
COMPANIES = {
    'AAPL': '0000320193', 'AMZN': '0001018724', 'AVGO': '0001730168', 'GOOGL': '0001652044',
    'JPM': '0000019617', 'META': '0001326801', 'MSFT': '0000789019', 'NVDA': '0001045810',
    'TSLA': '0001318605', 'WMT': '0000104169',
}
CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/'
CONCEPT = 'https://data.sec.gov/api/xbrl/companyconcept/'
SEC_AGENT = 'AlphaInsiderTracker xodyd1214@gmail.com'
DAY = timedelta(days=1)
EPS_METHODS = {'annual', 'quarter_sum', 'annual_ytd'}
PER_REASONS = {'eps_unavailable', 'non_positive_eps', 'split'}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def iso_date(value):
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError('Invalid ISO date')
    return parsed


def eastern_date(timestamp):
    if not finite(timestamp) or timestamp <= 0:
        raise ValueError('Invalid observation timestamp')
    return datetime.fromtimestamp(timestamp, EASTERN).date()


def rsi14(closes):
    if len(closes) < 15:
        return None
    changes = [later - earlier for earlier, later in zip(closes, closes[1:])]
    gain = sum(max(change, 0) for change in changes[:14]) / 14
    loss = sum(max(-change, 0) for change in changes[:14]) / 14
    for change in changes[14:]:
        gain = (gain * 13 + max(change, 0)) / 14
        loss = (loss * 13 + max(-change, 0)) / 14
    return 50.0 if gain + loss == 0 else round(100 * gain / (gain + loss), 2)


def quote_metrics(payload, symbol, now):
    result, = payload['chart']['result']
    meta = result['meta']
    if (meta.get('symbol'), meta.get('instrumentType'), meta.get('currency'), meta.get('exchangeTimezoneName')) != (
        symbol, 'EQUITY', 'USD', 'America/New_York'
    ):
        raise ValueError('Unexpected quote identity or currency')
    timestamps = result['timestamp']
    closes = result['indicators']['quote'][0]['close']
    adjusted = result['indicators']['adjclose'][0]['adjclose']
    if len(timestamps) != len(closes) or len(closes) != len(adjusted):
        raise ValueError('Inconsistent daily price columns')
    if not timestamps or not all(finite(ts) for ts in timestamps) or any(a >= b for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError('Unordered daily price series')
    today = now.astimezone(EASTERN).date()
    regular_end = meta.get('currentTradingPeriod', {}).get('regular', {}).get('end')
    last_trade = meta.get('regularMarketTime')
    today_complete = finite(regular_end) and eastern_date(regular_end) == today and (
        finite(last_trade) and eastern_date(last_trade) == today and
        regular_end - 60 <= last_trade <= now.timestamp() + 60 and regular_end <= now.timestamp()
    )
    dates = [eastern_date(ts) for ts in timestamps]
    if len(set(dates)) != len(dates):
        raise ValueError('Duplicate daily observation')
    rows = [(day, close, adj) for day, close, adj in zip(dates, closes, adjusted)
            if day.weekday() < 5 and (day < today or (day == today and today_complete))]
    if not rows or not finite(rows[-1][1]) or rows[-1][1] <= 0:
        raise ValueError('No verified completed session close')
    day, close, _ = rows[-1]
    series = []
    for _, _, adj in reversed(rows):
        if not finite(adj) or adj <= 0:
            break
        series.append(adj)
    split_dates = [eastern_date(item['date']) for item in result.get('events', {}).get('splits', {}).values()]
    return day, round(close, 4), rsi14(series[::-1]), split_dates


def eps_facts(payload, cik, now):
    if (str(payload['cik']).zfill(10), payload.get('taxonomy'), payload.get('tag')) != (
        cik, 'us-gaap', 'EarningsPerShareDiluted'
    ):
        raise ValueError('Unexpected EPS source identity')
    facts = {}
    for item in payload.get('units', {}).get('USD/shares', []):
        if item.get('form') not in {'10-K', '10-K/A', '10-Q', '10-Q/A'} or not finite(item.get('val')):
            continue
        start, end, filed = (iso_date(item[k]) for k in ('start', 'end', 'filed'))
        if not start <= end <= filed <= now or end < now - timedelta(days=760):
            continue
        fact = (filed, item['accn'], Decimal(str(item['val'])))
        key = (start, end)
        if key in facts and fact[:2] == facts[key][:2] and fact[2] != facts[key][2]:
            raise ValueError('Conflicting EPS facts for the same reporting period')
        if key not in facts or fact[:2] >= facts[key][:2]:
            facts[key] = fact
    return facts


def trailing_eps(facts):
    if not facts:
        return None
    end = max(last for _, last in facts)
    annual = sorted((period for period in facts if 349 <= (period[1] - period[0]).days <= 377),
                    key=lambda period: period[1], reverse=True)

    def metric(periods, start, method, eps):
        return {'eps': float(eps), 'start': start.isoformat(), 'end': end.isoformat(),
                'filed': max(facts[period][0] for period in periods).isoformat(), 'method': method}

    if annual and annual[0][1] == end:
        period = annual[0]
        return metric([period], period[0], 'annual', facts[period][2])

    # The periods must be adjacent. Multiple candidates at the same quarter end
    # are treated as ambiguous rather than selecting a duration by guesswork.
    quarter_ends = {}
    for start, last in facts:
        if 76 <= (last - start).days <= 104:
            quarter_ends.setdefault(last, []).append((start, last))
    chain, next_end = [], end
    for _ in range(4):
        candidates = quarter_ends.get(next_end, [])
        if len(candidates) != 1:
            break
        chain.append(candidates[0])
        next_end = candidates[0][0] - DAY
    if len(chain) == 4 and 349 <= (end - chain[-1][0]).days <= 377:
        return metric(chain, chain[-1][0], 'quarter_sum', sum(facts[p][2] for p in chain))

    # When standalone fiscal Q4 EPS is missing, use filed fiscal-year
    # and comparable year-to-date EPS. Per-share weighting makes it an estimate.
    for year_start, year_end in annual:
        current = year_end + DAY, end
        if current not in facts or not 76 <= (end - current[0]).days <= 290:
            continue
        comparable = [p for p in facts if p[0] == year_start and p[1] < year_end and
                      abs((p[1] - p[0]).days - (end - current[0]).days) <= 7 and
                      349 <= (end - p[1] - DAY).days <= 377]
        if len(comparable) == 1:
            old = comparable[0]
            annual_period = (year_start, year_end)
            return metric([annual_period, current, old], old[1] + DAY, 'annual_ytd',
                          facts[annual_period][2] + facts[current][2] - facts[old][2])
    return None


def assemble(cik, market, earnings, eps_status):
    day, close, rsi, split_dates = market
    reason, per = None, None
    if not earnings:
        reason = 'eps_unavailable'
    elif earnings['eps'] <= 0:
        reason = 'non_positive_eps'
    elif any(iso_date(earnings['start']) <= split <= day for split in split_dates):
        reason = 'split'
    else:
        per = round(close / earnings['eps'], 2)
    return {'cik': cik, 'closeDate': day.isoformat(), 'close': close, 'rsi14': rsi,
            'perTtm': per, 'perReason': reason, 'earnings': earnings, 'epsStatus': eps_status}


def validate_snapshot(snapshot):
    if snapshot.get('schemaVersion') != 1 or set(snapshot.get('symbols', {})) != set(COMPANIES):
        raise ValueError('Invalid company metrics scope')
    for symbol, row in snapshot['symbols'].items():
        if row is None:
            continue
        if row['cik'] != COMPANIES[symbol] or not finite(row['close']) or row['close'] <= 0:
            raise ValueError('Invalid company metrics identity or close')
        close_date = iso_date(row['closeDate'])
        rsi = row['rsi14']
        if rsi is not None and (not finite(rsi) or not 0 <= rsi <= 100):
            raise ValueError('Invalid RSI')
        if row['epsStatus'] not in {'success', 'preserved', 'error'}:
            raise ValueError('Invalid EPS source status')
        earnings = row['earnings']
        if earnings is not None:
            start, end, filed = (iso_date(earnings[field]) for field in ('start', 'end', 'filed'))
            if (not 349 <= (end - start).days <= 377 or end > close_date or end > filed
                    or not finite(earnings['eps']) or earnings['method'] not in EPS_METHODS):
                raise ValueError('Invalid trailing EPS')
        per = row['perTtm']
        reason = row['perReason']
        if per is None:
            expected = 'eps_unavailable' if earnings is None else 'non_positive_eps' if earnings['eps'] <= 0 else 'split'
            if reason not in PER_REASONS or reason != expected:
                raise ValueError('Missing PER needs a matching reason')
        elif reason is not None or not earnings or earnings['eps'] <= 0 or not finite(per) or per <= 0 or per != round(row['close'] / earnings['eps'], 2):
            raise ValueError('Invalid PER')
    return snapshot


def fetch_json(session, url, headers, params=None):
    response = session.get(url, headers=headers, params=params, timeout=8)
    response.raise_for_status()
    return response.json()


def collect(previous, now, session):
    symbols = dict(previous['symbols'])
    failed = []
    for symbol, cik in COMPANIES.items():
        old = symbols.get(symbol)
        try:
            market = quote_metrics(fetch_json(
                session, CHART + symbol, {'User-Agent': 'Mozilla/5.0'},
                {'interval': '1d', 'range': '2y', 'events': 'splits'}
            ), symbol, now)
            day = market[0]
            if old and day < iso_date(old['closeDate']):
                raise ValueError('Daily close regressed')
        except (ValueError, OSError, KeyError, TypeError, IndexError, requests.RequestException) as error:
            failed.append(symbol)
            print(f'{symbol}: daily close: {error}', file=sys.stderr)
            continue
        status = 'success'
        try:
            source = f'{CONCEPT}CIK{cik}/us-gaap/EarningsPerShareDiluted.json'
            facts = eps_facts(fetch_json(session, source, {'User-Agent': SEC_AGENT}), cik, day)
            earnings = trailing_eps(facts)
            if old and old['earnings'] and (not earnings or earnings['end'] < old['earnings']['end']):
                raise ValueError('EPS period regressed')
        except (ValueError, OSError, KeyError, TypeError, IndexError, requests.RequestException) as error:
            earnings = old['earnings'] if old else None
            status = 'preserved' if earnings else 'error'
            failed.append(symbol)
            print(f'{symbol}: EPS: {error}', file=sys.stderr)
        symbols[symbol] = assemble(cik, market, earnings, status)
        time.sleep(.16)
    return validate_snapshot({'schemaVersion': 1, 'symbols': symbols}), failed


def main():
    path = BASE / OUTPUT
    cache = load_json(BASE / 'realtime_prices.json', {})
    if not set(COMPANIES) <= cache.keys():
        raise ValueError('Metrics scope must have existing price coverage')
    previous = validate_snapshot(load_json(path, {'schemaVersion': 1, 'symbols': dict.fromkeys(COMPANIES)}))
    with requests.Session() as session:
        snapshot, failed = collect(previous, datetime.now(timezone.utc), session)
    if snapshot != previous:
        atomic_write_json(path, snapshot)
    rows = [row for row in snapshot['symbols'].values() if row is not None]
    print(f'{len(rows)}/{len(COMPANIES)} closing prices, '
          f'{sum(row["perTtm"] is not None for row in rows)} PER, '
          f'{sum(row["rsi14"] is not None for row in rows)} RSI; {len(failed)} source checks failed.')
    return bool(failed)


if __name__ == '__main__':
    raise SystemExit(main())
