"""AT2 command payload builders, ported from `At2Commands.kt` (Apache-2.0).

Every function here returns a *payload* (starts with 0x00) ready to
pass to `frame.encode_frame()`. Family byte convention observed in the
reference app: 0x01 = query/read, 0x02 = set/write (instant apply or
codeplug), 0x04 = messaging / smart-link / PTT domain.

IMPORTANT: the exact "read all 30 channels" request was not captured
in the reference app (it only shows single-channel edit + bulk write).
`query_channel_config()` mirrors the write command's family/command
bytes with the query family (0x01) by symmetry with every other
query/set pair in this file. This is a well-grounded inference, not
a captured trace -- validate against a real radio and adjust
`app/protocol/channel.py:parse_codeplug_read_chunks` if the returned
chunk size differs.
"""
from __future__ import annotations

from .frame import build_payload

FAMILY_QUERY = 0x01
FAMILY_SET = 0x02
FAMILY_DEVICE = 0x03
FAMILY_EXT = 0x04


def select_channel(channel: int) -> bytes:
    if not (1 <= channel <= 30):
        raise ValueError(f"channel out of range: {channel}")
    return build_payload(FAMILY_SET, 0x0E, bytes([0x01, channel, 0x00]))


def set_volume(level: int) -> bytes:
    if not (1 <= level <= 8):
        raise ValueError("volume out of range (1..8)")
    return build_payload(FAMILY_SET, 0x01, bytes([level]))


def query_volume() -> bytes:
    return build_payload(FAMILY_QUERY, 0x01)


def set_prompt_tone(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x04, bytes([0x01 if enabled else 0x00]))


def query_prompt_tone() -> bytes:
    return build_payload(FAMILY_QUERY, 0x04)


def set_squelch(level: int) -> bytes:
    if not (0 <= level <= 9):
        raise ValueError("squelch out of range (0..9)")
    return build_payload(FAMILY_SET, 0x02, bytes([0x04, level]))


def query_squelch() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x04]))


def set_tot_seconds(seconds: int) -> bytes:
    if not (0 <= seconds <= 240):
        raise ValueError("TOT out of range (0..240)")
    return build_payload(FAMILY_SET, 0x02, bytes([0x05]) + seconds.to_bytes(2, "little"))


def set_vox(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x02, bytes([0x06, 0x01 if enabled else 0x00]))


def query_vox() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x06]))


def set_vox_sensitivity(level: int) -> bytes:
    if not (1 <= level <= 5):
        raise ValueError("VOX sensitivity out of range (1..5)")
    return build_payload(FAMILY_SET, 0x02, bytes([0x07, level]))


def set_tx_inhibit(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x02, bytes([0x09, 0x01 if enabled else 0x00]))


def set_noise_reduction(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x02, bytes([0x11, 0x01 if enabled else 0x00]))


def query_noise_reduction() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x11]))


def query_current_channel_info() -> bytes:
    return build_payload(FAMILY_QUERY, 0x0E)


def query_channel_config() -> bytes:
    """Request the full codeplug (30 channels). See module docstring: inferred."""
    return build_payload(FAMILY_QUERY, 0x02)


def write_channel_chunk(chunk: bytes) -> bytes:
    """Wrap one 168-byte codeplug chunk (from channel.build_codeplug_write_chunks)."""
    return build_payload(FAMILY_SET, 0x02, chunk)


def clear_channel(channel: int) -> bytes:
    from .channel import empty_channel_record
    return build_payload(FAMILY_SET, 0x02, bytes(empty_channel_record(channel)))


def set_device_name(name: str) -> bytes:
    return build_payload(FAMILY_DEVICE, 0x01, name.encode("utf-8"))


def set_smart_link(enabled: bool) -> bytes:
    return build_payload(FAMILY_EXT, 0x09, bytes([0x01 if enabled else 0x00]))


def query_smart_link() -> bytes:
    return build_payload(FAMILY_EXT, 0x09)
