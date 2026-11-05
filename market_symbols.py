"""Reviewed security identities and quote lifecycle metadata.

A 13F issuer name or an inherited ticker is not evidence of security identity.
Only an exact, provenance-backed CUSIP may select a live quote. Unreviewed
positions remain in SEC history and dashboard totals without a current price.
"""
import json
import re
from pathlib import Path

with (Path(__file__).resolve().parent / 'market_symbols.json').open(encoding='utf-8') as handle:
    MARKET_SYMBOLS = json.load(handle)


def canonical_symbol(ticker):
    ticker = str(ticker or '').upper().strip()
    return MARKET_SYMBOLS['aliases'].get(ticker, ticker)


def quote_eligible(ticker):
    symbol = canonical_symbol(ticker)
    return bool(symbol) and not symbol.startswith(('CUSIP:', 'UNMAPPED:')) and symbol not in MARKET_SYMBOLS['inactive']


def is_non_equity(cusip):
    return str(cusip or '').upper().strip() in MARKET_SYMBOLS['nonEquityCusips']


def is_quarantined(cusip):
    return str(cusip or '').upper().strip() in MARKET_SYMBOLS['quarantinedCusips']


def reviewed_symbol(cusip):
    identity = str(cusip or '').upper().strip()
    if is_non_equity(identity) or is_quarantined(identity):
        return None
    record = MARKET_SYMBOLS['reviewedCusips'].get(identity)
    if not record or not record.get('sourceUrl') or record.get('quoteEligible') is False:
        return None
    symbol = canonical_symbol(record.get('ticker'))
    return symbol if re.fullmatch(r'[A-Z]{1,5}(?:[.-][A-Z])?', symbol) else None


def resolve_security_symbol(cusip, share_type='SH', put_call=None):
    """Return the reviewed quote symbol, never a name or raw-ticker guess.

    Inactive identities may resolve for historical labels; quote_eligible
    separately forbids a current quote. Principal and options cannot inherit
    the ordinary share price even if they refer to the same issuer/CUSIP.
    """
    if str(share_type or 'SH').upper() != 'SH' or put_call:
        return None
    return reviewed_symbol(cusip)
