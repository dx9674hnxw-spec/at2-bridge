"""Small local JSON store for things the AT2 protocol itself has no
room for: human-readable channel names (the radio only stores numeric
channel slots) and a list of previously-seen devices so the UI can
show them even before a fresh scan.

Not a database -- this is single-writer, low-frequency data, so a
plain JSON file with atomic replace is enough.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

DATA_DIR = Path(os.environ.get("AT2_BRIDGE_DATA_DIR", "/srv/data"))
STORE_PATH = DATA_DIR / "store.json"

_DEFAULT = {
    "channel_names": {},   # {"1": "Base", "5": "Équipe A", ...}
    "known_devices": [],   # [{"id": "...", "name": "...", "transport": "ble"|"serial", "target": "..."}]
}


def _read() -> dict:
    if not STORE_PATH.exists():
        return dict(_DEFAULT)
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return dict(_DEFAULT)
    merged = dict(_DEFAULT)
    merged.update(data)
    return merged


def _write(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=DATA_DIR, prefix=".store-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, STORE_PATH)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def get_channel_names() -> dict[str, str]:
    return _read()["channel_names"]


def set_channel_name(channel: int, name: str) -> None:
    data = _read()
    if name:
        data["channel_names"][str(channel)] = name
    else:
        data["channel_names"].pop(str(channel), None)
    _write(data)


def get_known_devices() -> list[dict]:
    return _read()["known_devices"]


def remember_device(device_id: str, name: str, transport: str, target: str) -> None:
    data = _read()
    devices = [d for d in data["known_devices"] if d["id"] != device_id]
    devices.append({"id": device_id, "name": name, "transport": transport, "target": target})
    data["known_devices"] = devices[-20:]  # keep it small
    _write(data)


def forget_device(device_id: str) -> None:
    data = _read()
    data["known_devices"] = [d for d in data["known_devices"] if d["id"] != device_id]
    _write(data)
