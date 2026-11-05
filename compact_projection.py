"""Lossless deterministic row grouping for a small, dated SEC web projection.

This codec does not decide source validity or modify financial values. Only the
raw-replayed partial-stage builder may authorize a public candidate projection.
"""
from copy import deepcopy
import json

FORMAT = 'lossless_grouped_rows_v1'
FORBIDDEN = {'__proto__', 'constructor', 'prototype'}

class ProjectionError(ValueError):
    pass

def require(condition, reason):
    if not condition:
        raise ProjectionError(reason)

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def valid_path(path):
    return isinstance(path, list) and 1 <= len(path) <= 8 and all(
        isinstance(key, str) and key and key not in FORBIDDEN and len(key) <= 80 for key in path)

def flatten(row):
    require(isinstance(row, dict) and row, 'Each row must be a nonempty object')
    result = {}
    def visit(value, path):
        require(len(path) <= 8, 'Row nesting exceeds codec limit')
        if isinstance(value, dict) and value:
            for key, child in value.items():
                require(isinstance(key, str) and key and key not in FORBIDDEN and len(key) <= 80, 'Unsafe object key')
                visit(child, path + (key,))
        else:
            require(path, 'Empty root object')
            result[path] = deepcopy(value)
    visit(row, ())
    require(len(result) <= 128, 'Too many flattened row fields')
    for value in result.values():
        canonical(value)  # Reject non-JSON values and nonfinite numbers.
    return result

def encode_rows(rows):
    require(isinstance(rows, list), 'Rows must be a list')
    groups, run, signature = [], [], None
    def finish():
        if not run:
            return
        paths = sorted(run[0])
        common = [path for path in paths if all(canonical(item[path]) == canonical(run[0][path]) for item in run)]
        common_set = set(common)
        columns = [path for path in paths if path not in common_set]
        groups.append({'common': [[list(path), deepcopy(run[0][path])] for path in common],
                       'columns': [list(path) for path in columns],
                       'rows': [[deepcopy(item[path]) for path in columns] for item in run]})
    for row in rows:
        flat = flatten(row)
        key = (row.get('cik'), row.get('accessionNumber', row.get('accession')), tuple(sorted(flat)))
        if run and key != signature:
            finish(); run = []
        run.append(flat); signature = key
    finish()
    result = {'schemaVersion': 1, 'format': FORMAT, 'rowCount': len(rows), 'groups': groups}
    require(canonical(decode_rows(result)) == canonical(rows), 'Codec did not preserve source rows')
    return result

def decode_rows(projection):
    require(isinstance(projection, dict) and set(projection) == {'schemaVersion','format','rowCount','groups'}, 'Unexpected projection contract')
    require(type(projection['schemaVersion']) is int and projection['schemaVersion'] == 1 and projection['format'] == FORMAT, 'Unsupported projection')
    require(type(projection['rowCount']) is int and 0 <= projection['rowCount'] <= 500000, 'Invalid row count')
    require(isinstance(projection['groups'], list) and len(projection['groups']) <= 2000, 'Invalid group count')
    result = []
    for group in projection['groups']:
        require(isinstance(group, dict) and set(group) == {'common','columns','rows'}, 'Invalid group contract')
        common, columns, entries = group['common'], group['columns'], group['rows']
        require(isinstance(common, list) and isinstance(columns, list) and isinstance(entries, list) and entries, 'Malformed group arrays')
        require(all(isinstance(pair,list) and len(pair)==2 and valid_path(pair[0]) for pair in common), 'Malformed common field')
        require(all(valid_path(path) for path in columns), 'Malformed column path')
        paths = [tuple(pair[0]) for pair in common] + [tuple(path) for path in columns]
        require(0 < len(paths) <= 128 and len(paths) == len(set(paths)), 'Duplicate or excessive paths')
        require(not any(a != b and len(a) < len(b) and b[:len(a)] == a for a in paths for b in paths), 'Prefix-conflicting paths')
        for entry in entries:
            require(isinstance(entry,list) and len(entry)==len(columns), 'Row column count mismatch')
            row = {}
            for path, value in common + [[path,value] for path,value in zip(columns,entry)]:
                parent = row
                for key in path[:-1]:
                    parent = parent.setdefault(key,{})
                parent[path[-1]] = deepcopy(value)
            result.append(row)
            require(len(result) <= projection['rowCount'], 'Projection exceeds declared row count')
    require(len(result)==projection['rowCount'], 'Projection row count mismatch')
    return result
