"""In-memory + optional disk-persistent cache backed by cachetools.TTLCache."""
from __future__ import annotations

import json
import os
import threading
from typing import Any

from cachetools import TTLCache

_CACHE_DIR: str = os.environ.get("CINEDIRECT_CACHE_DIR", "")
_TTL: int = 3600 * 6  # 6 hours
_MAX: int = 2048

_lock = threading.Lock()
_store: TTLCache[str, Any] = TTLCache(maxsize=_MAX, ttl=_TTL)

# ── optional disk persistence ────────────────────────────────────────────────
_DISK_PATH: str = ""
if _CACHE_DIR:
    _DISK_PATH = os.path.join(_CACHE_DIR, "resolve_cache.json")

def _load_disk() -> None:
    if not _DISK_PATH:
        return
    try:
        with open(_DISK_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        with _lock:
            _store.update(data)
    except (OSError, json.JSONDecodeError):
        pass


def _flush_disk() -> None:
    if not _DISK_PATH:
        return
    try:
        os.makedirs(os.path.dirname(_DISK_PATH), exist_ok=True)
        with _lock:
            snapshot = dict(_store)
        with open(_DISK_PATH, "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False)
    except OSError:
        pass


# load once at import time
_load_disk()


# ── public API ──────────────────────────────────────────────────────────────
def get(key: str) -> Any | None:
    with _lock:
        return _store.get(key)


def put(key: str, value: Any) -> None:
    with _lock:
        _store[key] = value
    _flush_disk()


def has(key: str) -> bool:
    with _lock:
        return key in _store


def invalidate(key: str) -> None:
    with _lock:
        _store.pop(key, None)
    _flush_disk()


def clear() -> None:
    with _lock:
        _store.clear()
    _flush_disk()
