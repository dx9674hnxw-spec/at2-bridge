"""AT2 frame codec: AA55 [LEN] [PAYLOAD] [CRC16-LE] 77EE.

Ported from the Kotlin reference implementation in
`Baofeng-ALERVITES-AT2-Android` (Apache License 2.0), which documents
the exact same framing over both BLE and the USB-C serial link:

    AA 55 <len:1> <payload: 0x00 + family + command + body> <crc16 le:2> 77 EE

The CRC is CRC-16/CCITT (non-reflected), polynomial 0x1021, init 0x1234,
computed over the payload *without* the leading 0x00 byte.

See /THIRD_PARTY_NOTICES.md for full attribution.
"""
from __future__ import annotations

from dataclasses import dataclass

HEAD = b"\xaa\x55"
TAIL = b"\x77\xee"

CRC16_POLY = 0x1021
CRC16_INIT = 0x1234


def crc16_ccitt(data: bytes) -> int:
    """CRC-16/CCITT (non-reflected), poly 0x1021, init 0x1234."""
    crc = CRC16_INIT
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ CRC16_POLY) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc & 0xFFFF


class FrameError(ValueError):
    """Raised when a frame cannot be encoded or decoded."""


def encode_frame(payload: bytes) -> bytes:
    """Wrap a payload (must start with 0x00) into a full AT2 frame."""
    if not payload:
        raise FrameError("payload must not be empty")
    if payload[0] != 0x00:
        raise FrameError("AT2 payload must start with 0x00")
    body_len = len(payload) - 1
    if body_len > 0xFF:
        raise FrameError(f"payload too long: {len(payload)}")

    crc = crc16_ccitt(payload[1:])
    out = bytearray()
    out += HEAD
    out.append(body_len)
    out += payload
    out.append(crc & 0xFF)
    out.append((crc >> 8) & 0xFF)
    out += TAIL
    return bytes(out)


def try_decode_frame(buf: bytes) -> tuple[bytes | None, int]:
    """Try to find and decode one complete frame inside `buf`.

    Returns (payload_or_None, bytes_consumed). If a frame is found,
    bytes_consumed is the index right after its tail (safe to slice
    the buffer with `buf[bytes_consumed:]`). If nothing usable is
    found yet, returns (None, 0) and the caller should wait for more
    data.
    """
    start = buf.find(HEAD)
    if start == -1:
        return None, 0
    if start + 7 > len(buf):
        return None, 0
    length = buf[start + 2]

    # Variant A: length excludes leading 0x00 (payload = 0x00 + len bytes)
    end_a = start + 3 + (length + 1) + 2 + 2
    if end_a <= len(buf) and buf[end_a - 2:end_a] == TAIL:
        payload_start = start + 3
        payload_end = payload_start + length + 1
        payload = buf[payload_start:payload_end]
        if payload and payload[0] == 0x00:
            got_crc = buf[payload_end] | (buf[payload_end + 1] << 8)
            if crc16_ccitt(payload[1:]) == got_crc:
                return payload, end_a

    # Variant B: length is the raw body length, no leading 0x00 stored
    end_b = start + 3 + length + 2 + 2
    if end_b <= len(buf) and buf[end_b - 2:end_b] == TAIL:
        payload_start = start + 3
        payload_end = payload_start + length
        body = buf[payload_start:payload_end]
        got_crc = buf[payload_end] | (buf[payload_end + 1] << 8)
        if crc16_ccitt(body) == got_crc:
            return b"\x00" + body, end_b

    # Header found but frame incomplete/garbled: drop just the header
    # so the caller can resync on the next AA55 occurrence.
    return None, start + 2


@dataclass(frozen=True)
class At2Packet:
    family: int
    command: int
    body: bytes

    @property
    def hex_preview(self) -> str:
        return self.body[:24].hex()


def decode_packet(payload: bytes) -> At2Packet | None:
    """Turn a decoded frame payload (0x00 + family + command + body) into a packet."""
    if len(payload) < 4 or payload[0] != 0x00:
        return None
    return At2Packet(family=payload[1], command=payload[2], body=payload[3:])


def build_payload(family: int, command: int, body: bytes = b"") -> bytes:
    return bytes([0x00, family & 0xFF, command & 0xFF]) + body


# ---------------------------------------------------------------------------
# "CPS-style" frame envelope -- a SECOND, DISTINCT dialect confirmed on real
# hardware on 27-28/08/2026 for per-channel read/write (opcode=0x11 read /
# 0x12 write, group=0x02, param=0x02 for the channel list). Reverse-engineered
# from the decompiled official Windows CPS's own JS source
# (generateCompleteFrame/generateChannelListWriteFrequency).
#
# Differs from the "legacy" dialect above (used for messaging/PTT/device
# name, all independently confirmed working) in two ways:
#   - the length field is 2 bytes, little-endian (not 1 byte)
#   - there is NO leading 0x00 byte before the payload's first real byte
#     (confirmed by direct hardware round-trip: a 1-byte-length request
#     for reading a channel got zero response; the 2-byte-length version
#     of the exact same logical request worked and returned real channel
#     data -- see CONSIGNES_PROJET.md, 27/08/2026 test log)
#
# Both dialects share the same head/tail markers and the same CRC16
# algorithm (poly 0x1021, init 0x1234), computed over the payload only
# (excluding the length field).
# ---------------------------------------------------------------------------

def encode_cps_frame(payload: bytes) -> bytes:
    """Wrap a payload (e.g. b'\\x11\\x02\\x02\\x00...') into a full CPS-style
    frame: AA55 + LEN(2 bytes LE) + payload + CRC16(2 bytes LE) + 77EE."""
    if not payload:
        raise FrameError("payload must not be empty")
    if len(payload) > 0xFFFF:
        raise FrameError(f"payload too long: {len(payload)}")
    crc = crc16_ccitt(payload)
    out = bytearray()
    out += HEAD
    out += len(payload).to_bytes(2, "little")
    out += payload
    out += crc.to_bytes(2, "little")
    out += TAIL
    return bytes(out)


def try_decode_cps_frame(buf: bytes) -> tuple[bytes | None, int]:
    """CPS-style counterpart to try_decode_frame(): same head/tail markers
    and CRC algorithm, but a 2-byte little-endian length field and no
    leading 0x00. Returns (payload_or_None, bytes_consumed), same
    contract as try_decode_frame()."""
    start = buf.find(HEAD)
    if start == -1:
        return None, 0
    if start + 8 > len(buf):
        return None, 0
    length = int.from_bytes(buf[start + 2:start + 4], "little")
    end = start + 4 + length + 2 + 2
    if end <= len(buf) and buf[end - 2:end] == TAIL:
        payload_start = start + 4
        payload_end = payload_start + length
        payload = buf[payload_start:payload_end]
        got_crc = int.from_bytes(buf[payload_end:payload_end + 2], "little")
        if crc16_ccitt(payload) == got_crc:
            return payload, end
    # Header found but frame incomplete/garbled: drop just the header so
    # the caller can resync on the next AA55 occurrence.
    return None, start + 2


@dataclass(frozen=True)
class CpsPacket:
    """Decoded CPS-style response: opcode (e.g. 0x91 = 0x11|0x80 for a
    read reply), group, param, and whatever body bytes follow."""
    opcode: int
    group: int
    param: int
    body: bytes


def decode_cps_packet(payload: bytes) -> CpsPacket | None:
    if len(payload) < 3:
        return None
    return CpsPacket(opcode=payload[0], group=payload[1], param=payload[2], body=payload[3:])

