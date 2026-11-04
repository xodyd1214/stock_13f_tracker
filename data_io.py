"""Crash-safe JSON persistence. Malformed existing data is never silently discarded."""
import json
import os
from pathlib import Path
import tempfile


def load_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def atomic_write_json(path, data):
    path = Path(path)
    # Serialize before touching disk, rejecting NaN and infinity.
    payload = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
