"""AT2 off-grid text messaging codec, ported from
`At2OfflineMessageCodec.kt` (Apache-2.0). Voice and image framing
exist in the reference app too but are not ported yet (see README
roadmap) -- text is the highest-value, lowest-risk starting point.
"""
from __future__ import annotations

from .frame import build_payload

SENDER_FIELD_BYTES = 16
SHORT_TEXT_INLINE_MAX_BYTES = 180
FRAGMENT_TEXT_CHUNK_BYTES = 131
DEFAULT_USERNAME = "AT2Bridge"

# NOTE: matches the reference decoder's check `family == 0x02 && command == 0x04`
# (SET-domain family, "messaging" command) -- not to be confused with the
# FAMILY_EXT (0x04) used for smart-link in commands.py, which is unrelated.
FAMILY_MSG = 0x02
CMD_MSG = 0x04


def _encode_sender(username: str) -> bytes:
    name = (username or "").strip() or DEFAULT_USERNAME
    out = bytearray(b" " * SENDER_FIELD_BYTES)
    data = name.encode("utf-8")
    out[: min(len(data), SENDER_FIELD_BYTES)] = data[:SENDER_FIELD_BYTES]
    return bytes(out)


def _le16(v: int) -> bytes:
    return v.to_bytes(2, "little")


def _be16(v: int) -> bytes:
    return v.to_bytes(2, "big")


def build_text_message_frames(username: str, text: str, msg_id: int) -> list[bytes]:
    """Build the full-frame (AA55..77EE) sequence to send one text message.

    `msg_id` should be a caller-managed monotonically increasing
    uint32 (wrap at 2**32).
    """
    text_bytes = text.encode("utf-8")
    sender = _encode_sender(username)
    msg_id_bytes = (msg_id & 0xFFFFFFFF).to_bytes(4, "big")

    if len(text_bytes) <= SHORT_TEXT_INLINE_MAX_BYTES:
        body = (
            bytes([0x01, 0x01])
            + msg_id_bytes
            + bytes([0x00])
            + sender
            + _le16(len(text_bytes))
            + bytes([0x01, 0x00])
            + text_bytes
        )
        payloads = [build_payload(FAMILY_MSG, CMD_MSG, body)]
    else:
        parts = [text_bytes[i:i + FRAGMENT_TEXT_CHUNK_BYTES] for i in range(0, len(text_bytes), FRAGMENT_TEXT_CHUNK_BYTES)]
        if len(parts) > 0xFF:
            raise ValueError("message too large to fragment")
        stream_len = sum(len(p) + 1 for p in parts)
        start_body = (
            bytes([0x01, 0x01])
            + msg_id_bytes
            + bytes([0x00])
            + sender
            + _le16(stream_len)
            + bytes([len(parts), 0x00])
        )
        payloads = [build_payload(FAMILY_MSG, CMD_MSG, start_body)]
        for index, part in enumerate(parts):
            chunk_body = bytes([0x01, 0x02]) + msg_id_bytes + _be16(index) + bytes([0x00]) + part
            payloads.append(build_payload(FAMILY_MSG, CMD_MSG, chunk_body))

    from .frame import encode_frame
    return [encode_frame(p) for p in payloads]
