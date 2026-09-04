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


# Side of a dual-watch pair, ported from `At2Commands.Side` (A=0x01, B=0x02).
SIDE_CODE = {"A": 0x01, "B": 0x02}


def _side_code(side: str) -> int:
    try:
        return SIDE_CODE[side]
    except KeyError:
        raise ValueError(f"side must be 'A' or 'B', got: {side!r}") from None


def select_channel(channel: int) -> bytes:
    """Select the active channel (side A of the dual-watch pair when dual
    watch is off, which is what "the" active channel means in that case).

    FIXED (was byte-incompatible with the reference app -- see
    `At2Commands.kt::selectChannel`/`selectDualWatchChannel`): both are
    the *same* wire command, just with a different side byte, and that
    command's family/command is `0x02/0x02` with the channel opcode
    (`0x0E`) as the *first body byte* -- not `0x02/0x0E` as this used to
    read. The one-byte-short frame this previously produced very likely
    explains the "old channel-selection command... probably writes the
    dual-watch channel, not the currently active channel" note in the
    README: with the opcode byte missing, the radio saw `command=0x0E`
    directly instead of `command=0x02, subtype=0x0E`.
    """
    if not (1 <= channel <= 30):
        raise ValueError(f"channel out of range: {channel}")
    return select_dual_watch_channel("A", channel)


def select_dual_watch_channel(side: str, channel: int) -> bytes:
    """`side`: "A" or "B". Ported from `At2Commands.kt::selectDualWatchChannel`."""
    if not (1 <= channel <= 30):
        raise ValueError(f"channel out of range: {channel}")
    return build_payload(FAMILY_SET, 0x02, bytes([0x0E, _side_code(side), channel, 0x00]))


def select_dual_watch_focus(side: str) -> bytes:
    """Switch which side of the dual-watch pair is currently focused
    (i.e. which one PTT transmits on). Ported from
    `At2Commands.kt::selectDualWatchFocus`."""
    return build_payload(FAMILY_SET, 0x02, bytes([0x0F, _side_code(side)]))


def set_dual_watch(enabled: bool) -> bytes:
    """Ported from `At2Commands.kt::setDualWatch` -- note the enabled
    value is `0x02`, not `0x01` like every other boolean setting here."""
    return build_payload(FAMILY_SET, 0x02, bytes([0x0D, 0x02 if enabled else 0x00]))


def query_dual_watch() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x0D]))


def set_volume(level: int) -> bytes:
    """FIXED: was missing the `0x01` subtype byte the reference app
    always sends before the level (`At2Commands.kt::setVolume` ->
    `00 02 01 01 <level>`, this used to build `00 02 01 <level>`)."""
    if not (1 <= level <= 8):
        raise ValueError("volume out of range (1..8)")
    return build_payload(FAMILY_SET, 0x01, bytes([0x01, level]))


def query_volume() -> bytes:
    return build_payload(FAMILY_QUERY, 0x01, bytes([0x01]))


def set_prompt_language(english: bool) -> bytes:
    """Ported from `At2Commands.kt::setPromptLanguage`
    (`PromptLanguage.Chinese=0x00` / `.English=0x01`)."""
    return build_payload(FAMILY_SET, 0x01, bytes([0x03, 0x01 if english else 0x00]))


def query_prompt_language() -> bytes:
    return build_payload(FAMILY_QUERY, 0x01, bytes([0x03]))


def set_prompt_tone(enabled: bool) -> bytes:
    """FIXED: this used to send `family=0x02, command=0x04, body=[value]`
    -- the *same* family/command pair as text messaging and PTT
    (`FAMILY_MSG`/`CMD_MSG` in `messages.py`), distinguished there only
    by the body's first byte, which a single `0x01` byte collides
    with (the start of a text-message body). The reference app's real
    command is `family=0x02, command=0x01, body=[0x04, value]`
    (`At2Commands.kt::setPromptTone`) -- an entirely different
    family/command pair, with no such collision."""
    return build_payload(FAMILY_SET, 0x01, bytes([0x04, 0x01 if enabled else 0x00]))


def query_prompt_tone() -> bytes:
    return build_payload(FAMILY_QUERY, 0x01, bytes([0x04]))


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


def query_tot_seconds() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x05]))


def query_vox_sensitivity() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x07]))


def set_tx_inhibit(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x02, bytes([0x09, 0x01 if enabled else 0x00]))


def query_tx_inhibit() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x09]))


def set_tx_interval_seconds(seconds: int) -> bytes:
    """AKA "hop interval". Ported from `At2Commands.kt::setTxIntervalSeconds`
    -- distinct from `set_tot_seconds` despite the similar shape (different
    subtype byte, `0x0A` vs `0x05`)."""
    if not (0 <= seconds <= 240):
        raise ValueError("TX interval out of range (0..240)")
    return build_payload(FAMILY_SET, 0x02, bytes([0x0A]) + seconds.to_bytes(2, "little"))


def query_tx_interval_seconds() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x0A]))


def set_noise_reduction(enabled: bool) -> bytes:
    return build_payload(FAMILY_SET, 0x02, bytes([0x11, 0x01 if enabled else 0x00]))


def query_noise_reduction() -> bytes:
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x11]))


def query_current_channel_info() -> bytes:
    """FIXED: was missing the `0x0E` body byte -- the reference app's
    `queryCurrentChannelInfo()` is `family=0x01, command=0x02, body=[0x0E]`,
    not `family=0x01, command=0x0E` with an empty body."""
    return build_payload(FAMILY_QUERY, 0x02, bytes([0x0E]))


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
