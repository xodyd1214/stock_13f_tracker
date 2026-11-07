"""Fail-closed validation for the atomically written publication datasets."""
import json
import math
from pathlib import Path
import sys

ALLOWED_OUTPUTS = {'live_13f_analytics.json', 'realtime_prices.json', 'latest_macro_indicators.json',
                   'latest_13f_holdings.json', 'latest_form4_recent.json', 'latest_congress_house.json',
                   'listed_companies.json'}


def validate_output(path):
    path = Path(path)
    if path.name not in ALLOWED_OUTPUTS:
        raise ValueError(f'Unreviewed collector output: {path.name}')
    def reject_constant(value):
        raise ValueError(f'Non-finite JSON number: {value}')
    with path.open(encoding='utf-8') as handle:
        value = json.load(handle, parse_constant=reject_constant)
    expected_type = list if path.name == 'latest_13f_holdings.json' else dict
    if not isinstance(value, expected_type) or not value:
        raise ValueError(f'Empty or malformed dataset: {path.name}')
    def validate_numbers(item):
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError('Non-finite numeric value')
        if isinstance(item, dict):
            for nested in item.values(): validate_numbers(nested)
        elif isinstance(item, list):
            for nested in item: validate_numbers(nested)
    validate_numbers(value)
    if path.name == 'latest_13f_holdings.json' and any(not isinstance(row, dict) or not row.get('guru') for row in value):
        raise ValueError('Dashboard rows require fund identity')
    def nonnegative(number):
        return isinstance(number, (int, float)) and not isinstance(number, bool) and number >= 0
    if path.name == 'realtime_prices.json':
        if any(not isinstance(quote, dict) or not nonnegative(quote.get('price')) or quote['price'] == 0 for quote in value.values()):
            raise ValueError('Price entries require positive observed prices')
    if path.name == 'latest_13f_holdings.json':
        if any(not nonnegative(row.get('value')) or not nonnegative(row.get('shares')) for row in value):
            raise ValueError('Holdings require nonnegative values and share counts')
    if path.name == 'live_13f_analytics.json':
        if any(not isinstance(fund, dict) or not isinstance(fund.get('holdings'), list) or not fund['holdings'] for fund in value.values()):
            raise ValueError('Analytics require nonempty fund holdings')
    if path.name == 'latest_macro_indicators.json':
        if value.get('schemaVersion') != 2 or not isinstance(value.get('sources'), dict) or not value['sources']:
            raise ValueError('Macro publication requires source provenance schema 2')
        successful = value.get('collection', {}).get('successfulSources', [])
        if not successful or any(key not in value['sources'] or value['sources'][key].get('fetchStatus') != 'success' for key in successful):
            raise ValueError('Macro publication requires at least one successful source')
        from macro_calendar import validate_calendar
        validate_calendar(value.get('calendar', []))
    if path.name == 'latest_form4_recent.json':
        from sec_form4_recent import validate_recent_snapshot
        validate_recent_snapshot(value)
    if path.name == 'listed_companies.json':
        from sec_form4_recent import validate_listed_companies
        validate_listed_companies(value)
    if path.name == 'latest_congress_house.json':
        from congress_house import validate_snapshot
        validate_snapshot(value)
    return value


if __name__ == '__main__':
    for filename in sys.argv[1:]:
        validate_output(filename)
