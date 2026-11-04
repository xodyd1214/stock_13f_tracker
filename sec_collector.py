"""Export validated 13F history for the equity dashboard without refetching SEC.

Run collector_1year.py first. Options/principal positions stay in the history
file and are not combined with equities in the dashboard's flat dataset.
The legacy latest_13f_holdings.csv is not regenerated or automatically published;
use the dashboard's CSV export for the currently displayed snapshot.
"""
from pathlib import Path
import sys
import math
from datetime import date
from data_io import load_json, atomic_write_json

BASE_DIR = Path(__file__).resolve().parent


def export_latest(analytics_path=None, output_path=None):
    analytics_path = Path(analytics_path) if analytics_path else BASE_DIR / 'live_13f_analytics.json'
    output_path = Path(output_path) if output_path else BASE_DIR / 'latest_13f_holdings.json'
    analytics = load_json(analytics_path, {})
    previous = load_json(output_path, [])
    if not isinstance(analytics, dict) or not isinstance(previous, list):
        raise ValueError('Invalid source or existing dashboard dataset; refusing replacement')
    if any(not isinstance(row, dict) or not row.get('guru') for row in previous):
        raise ValueError('Existing dashboard rows lack fund identity')
    replacements = {}
    skipped = {}
    for name, fund in analytics.items():
        if not isinstance(fund, dict) or fund.get('schemaVersion') != 2:
            continue
        if fund.get('valueUnit') != 'USD' or not fund.get('latestPeriod') or not fund.get('sourceUrl'):
            raise ValueError(f'Incomplete verified history for {name}')
        period = date.fromisoformat(fund['latestPeriod'])
        filed = date.fromisoformat(fund['filingDate'])
        existing = [row for row in previous if row['guru'] == name]
        if existing:
            try:
                periods = [date.fromisoformat(row['period']) for row in existing]
                dates = [date.fromisoformat(row['filingDate']) for row in existing]
            except (KeyError, ValueError, TypeError):
                skipped[name] = 'Existing snapshot dates are unknown; manual reconciliation required'
                continue
            if period < max(periods) or filed < max(dates):
                skipped[name] = 'History predates existing period or filing date'
                continue
        rows = []
        for holding in fund['holdings']:
            for field in ('value', 'shares'):
                number = holding.get(field)
                if not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(number) or number < 0:
                    raise ValueError(f'Invalid {field} in verified history for {name}')
            if holding['action'] == 'SOLD OUT' or holding.get('putCall') or holding.get('shareType') != 'SH':
                continue
            rows.append({**holding, 'guru': name, 'fund': fund['fund'],
                         'period': fund['latestPeriod'], 'filingDate': fund['filingDate'],
                         'titleOfClass': holding['securityClass'], 'isOption': False,
                         'optionType': None, 'schemaVersion': 2, 'valueUnit': 'USD',
                         'sourceUrl': fund['sourceUrl'], 'fetchedAt': fund['fetchedAt']})
        replacements[name] = rows
    if not replacements:
        raise ValueError(f'No non-regressing verified history available; existing dashboard data preserved: {skipped}')
    result = [row for row in previous if row['guru'] not in replacements]
    for rows in replacements.values():
        result.extend(rows)
    if not result:
        raise ValueError('No equity holdings to publish; existing dashboard data preserved')
    atomic_write_json(output_path, result)
    return {'updatedFunds': sorted(replacements), 'skippedFunds': skipped, 'rows': len(result)}


if __name__ == '__main__':
    try:
        result = export_latest()
        print(result)
        if result['skippedFunds']:
            raise SystemExit(1)
    except Exception as error:
        print(f'Dashboard export failed: {error}', file=sys.stderr)
        raise SystemExit(1)
