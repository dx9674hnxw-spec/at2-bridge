"""AT2 off-grid messaging codec (text, voice, image), ported from
`At2OfflineMessageCodec.kt` (Apache-2.0) -- see NOTICE.

Wire format: payload = 0x00 0x02 0x04 0x01 <type> <msgId:4 be> <0x00>
<type-specific header> <data...>, where <type> is:

  0x01 = text start   (single-frame short text, or fragmented long text)
  0x02 = text chunk    (continuation of a fragmented text message)
  0x03 = voice start
  0x04 = voice chunk   (132-byte slice of AMR-NB encoded audio = 11 frames)
  0x05 = image start
  0x06 = image chunk   (132-byte slice of JPEG bytes)

All three message types share one "start frame + N chunk frames"
shape; `decode()` below and `MessageAssembler` reassemble whichever
type arrives.

NOTE on a decoder quirk carried over verbatim from the reference app:
for the short (single-frame, non-fragmented) text case, the decoded
`inline_data` includes one leading byte that overlaps with the `seq`
field position (see `_decode_text_or_voice_start`). This is not a bug
introduced here -- it's present in the source `decodeTextOrVoiceStartFrame`
too. `MessageAssembler` strips that leading byte for the single-frame
case to recover the actual text, but this hasn't been checked against
a real radio's actual output, only against this project's own encoder.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .frame import At2Packet, build_payload, encode_frame

SENDER_FIELD_BYTES = 16
SHORT_TEXT_INLINE_MAX_BYTES = 180
FRAGMENT_TEXT_CHUNK_BYTES = 131
VOICE_CHUNK_BYTES = 132
IMAGE_CHUNK_BYTES = 132
IMAGE_LONG_EDGE_PX = 300
IMAGE_JPEG_QUALITY = 75
DEFAULT_USERNAME = "AT2Bridge"

# NOTE: matches the reference decoder's check `family == 0x02 && command == 0x04`
# (SET-domain family, "messaging" command) -- not to be confused with the
# FAMILY_EXT (0x04) used for smart-link in commands.py, which is unrelated.
FAMILY_MSG = 0x02
CMD_MSG = 0x04

TYPE_TEXT_START = 0x01
TYPE_TEXT_CHUNK = 0x02
TYPE_VOICE_START = 0x03
TYPE_VOICE_CHUNK = 0x04
TYPE_IMAGE_START = 0x05
TYPE_IMAGE_CHUNK = 0x06


def _encode_sender(username: str) -> bytes:
    name = (username or "").strip() or DEFAULT_USERNAME
    out = bytearray(b" " * SENDER_FIELD_BYTES)
    data = name.encode("utf-8")
    out[: min(len(data), SENDER_FIELD_BYTES)] = data[:SENDER_FIELD_BYTES]
    return bytes(out)


def _decode_sender(b: bytes) -> str:
    text = b.decode("utf-8", errors="replace").strip(" \x00")
    return text or DEFAULT_USERNAME


def _le16(v: int) -> bytes:
    if not (0 <= v <= 0xFFFF):
        raise ValueError(f"value out of range for le16: {v}")
    return v.to_bytes(2, "little")


def _be16(v: int) -> bytes:
    if not (0 <= v <= 0xFFFF):
        raise ValueError(f"value out of range for be16: {v}")
    return v.to_bytes(2, "big")


def _msg_id_bytes(msg_id: int) -> bytes:
    return (msg_id & 0xFFFFFFFF).to_bytes(4, "big")


# ---------------------------------------------------------------------------
# Encoding (build_*_message_frames): each returns fully-encoded frames
# (AA55..77EE), ready to send over the wire one at a time.
# ---------------------------------------------------------------------------

def build_text_message_frames(username: str, text: str, msg_id: int) -> list[bytes]:
    """`msg_id` should be a caller-managed monotonically increasing uint32."""
    text_bytes = text.encode("utf-8")
    sender = _encode_sender(username)
    mid = _msg_id_bytes(msg_id)

    if len(text_bytes) <= SHORT_TEXT_INLINE_MAX_BYTES:
        body = (
            bytes([0x01, TYPE_TEXT_START]) + mid + bytes([0x00]) + sender
            + _le16(len(text_bytes)) + bytes([0x01, 0x00]) + text_bytes
        )
        payloads = [build_payload(FAMILY_MSG, CMD_MSG, body)]
    else:
        parts = [text_bytes[i:i + FRAGMENT_TEXT_CHUNK_BYTES] for i in range(0, len(text_bytes), FRAGMENT_TEXT_CHUNK_BYTES)]
        if len(parts) > 0xFF:
            raise ValueError("message too large to fragment")
        stream_len = sum(len(p) + 1 for p in parts)
        start_body = (
            bytes([0x01, TYPE_TEXT_START]) + mid + bytes([0x00]) + sender
            + _le16(stream_len) + bytes([len(parts), 0x00])
        )
        payloads = [build_payload(FAMILY_MSG, CMD_MSG, start_body)]
        for index, part in enumerate(parts):
            chunk_body = bytes([0x01, TYPE_TEXT_CHUNK]) + mid + _be16(index) + bytes([0x00]) + part
            payloads.append(build_payload(FAMILY_MSG, CMD_MSG, chunk_body))

    return [encode_frame(p) for p in payloads]


def build_voice_message_frames(username: str, encoded_voice: bytes, duration_ms: int, msg_id: int) -> list[bytes]:
    """`encoded_voice`: concatenated 12-byte AMR-NB MR475 frames (see
    app/protocol/amr_codec.py). This is the *store-and-forward* voice
    message format -- distinct from the live PTT protocol in ptt.py."""
    if not encoded_voice:
        raise ValueError("voice data empty")
    if duration_ms <= 0:
        raise ValueError("voice duration invalid")

    sender = _encode_sender(username)
    mid = _msg_id_bytes(msg_id)
    packet_count = max(1, -(-len(encoded_voice) // VOICE_CHUNK_BYTES))
    duration_seconds = max(1, -(-duration_ms // 1000))

    start_body = (
        bytes([0x01, TYPE_VOICE_START]) + mid + bytes([0x00]) + sender
        + _le16(len(encoded_voice)) + _le16(packet_count) + _le16(duration_seconds)
    )
    payloads = [build_payload(FAMILY_MSG, CMD_MSG, start_body)]
    for index in range(packet_count):
        chunk = encoded_voice[index * VOICE_CHUNK_BYTES:(index + 1) * VOICE_CHUNK_BYTES]
        chunk_body = bytes([0x01, TYPE_VOICE_CHUNK]) + mid + _be16(index) + bytes([0x00]) + chunk
        payloads.append(build_payload(FAMILY_MSG, CMD_MSG, chunk_body))

    return [encode_frame(p) for p in payloads]


def build_image_message_frames(username: str, jpeg_bytes: bytes, width: int, height: int, msg_id: int) -> list[bytes]:
    """`jpeg_bytes` should already be resized/compressed by the caller
    (see app/device.py::send_image_message, which targets
    IMAGE_LONG_EDGE_PX / IMAGE_JPEG_QUALITY to match the reference app)."""
    if not jpeg_bytes:
        raise ValueError("image data empty")
    if width <= 0 or height <= 0:
        raise ValueError("image size invalid")

    sender = _encode_sender(username)
    mid = _msg_id_bytes(msg_id)
    parts = [jpeg_bytes[i:i + IMAGE_CHUNK_BYTES] for i in range(0, len(jpeg_bytes), IMAGE_CHUNK_BYTES)]
    part_count = max(1, len(parts))
    if part_count > 0xFF:
        raise ValueError("image too large to fragment (>255 chunks)")

    start_body = (
        bytes([0x01, TYPE_IMAGE_START]) + mid + bytes([0x00]) + sender
        + _le16(len(jpeg_bytes)) + bytes([part_count, 0x00])
        + _le16(width) + _le16(height)
    )
    payloads = [build_payload(FAMILY_MSG, CMD_MSG, start_body)]
    for index, part in enumerate(parts):
        chunk_body = bytes([0x01, TYPE_IMAGE_CHUNK]) + mid + _be16(index) + bytes([0x00]) + part
        payloads.append(build_payload(FAMILY_MSG, CMD_MSG, chunk_body))

    return [encode_frame(p) for p in payloads]


# ---------------------------------------------------------------------------
# Decoding: turn an incoming At2Packet (already frame-decoded) into a
# start/chunk record, and reassemble complete messages across packets.
# ---------------------------------------------------------------------------

@dataclass
class OfflineStartFrame:
    type: int
    msg_id: int
    sender: str
    declared_length: int
    total_parts: int
    seq: int
    inline_data: bytes
    duration_ms: int | None = None


@dataclass
class OfflineChunk:
    type: int
    msg_id: int
    seq: int
    data: bytes


def decode(packet: At2Packet) -> OfflineStartFrame | OfflineChunk | None:
    if packet.family != FAMILY_MSG or packet.command != CMD_MSG:
        return None
    p = packet.body
    if len(p) < 2 or p[0] != 0x01:
        return None
    msg_type = p[1]
    if msg_type in (TYPE_TEXT_START, TYPE_VOICE_START, TYPE_IMAGE_START):
        return _decode_start_frame(msg_type, p)
    if msg_type in (TYPE_TEXT_CHUNK, TYPE_VOICE_CHUNK, TYPE_IMAGE_CHUNK):
        return _decode_chunk_frame(msg_type, p)
    return None


def _read_msg_id(b: bytes, start: int) -> int:
    return int.from_bytes(b[start:start + 4], "big")


def _decode_chunk_frame(msg_type: int, p: bytes) -> OfflineChunk | None:
    if len(p) < 9:
        return None
    msg_id = _read_msg_id(p, 2)
    seq = int.from_bytes(p[6:8], "big")
    # Byte 8 is a fixed 0x00 padding byte in every chunk frame (see the
    # `+ bytes([0x00]) +` in each build_*_frames chunk builder above);
    # actual chunk data starts right after it, at offset 9. (The
    # reference Kotlin decoder reads from offset 8 here, which appears
    # to be an off-by-one in that decoder -- caught by round-trip
    # testing our own encoder/decoder pair, see module docstring.)
    data = p[9:]
    return OfflineChunk(type=msg_type, msg_id=msg_id, seq=seq, data=data)


def _decode_start_frame(msg_type: int, p: bytes) -> OfflineStartFrame | None:
    if msg_type == TYPE_IMAGE_START:
        return _decode_image_start(p)
    if msg_type == TYPE_VOICE_START:
        return _decode_voice_start(p)
    return _decode_text_or_voice_start(msg_type, p)


def _decode_text_or_voice_start(msg_type: int, p: bytes) -> OfflineStartFrame | None:
    if len(p) < 26:
        return None
    msg_id = _read_msg_id(p, 2)
    sender = _decode_sender(p[7:23])
    declared_length = int.from_bytes(p[23:25], "little")
    total_parts = p[25]
    seq = p[26] if len(p) > 26 else 0
    # Reproduces the reference decoder's overlap between `seq` and the
    # start of `inline_data` verbatim -- see module docstring.
    inline_data = p[26:] if len(p) > 26 else b""
    return OfflineStartFrame(msg_type, msg_id, sender, declared_length, total_parts, seq, inline_data)


def _decode_voice_start(p: bytes) -> OfflineStartFrame | None:
    if len(p) < 29:
        return None
    msg_id = _read_msg_id(p, 2)
    sender = _decode_sender(p[7:23])
    declared_length = int.from_bytes(p[23:25], "little")
    total_parts = int.from_bytes(p[25:27], "little")
    duration_seconds = max(1, int.from_bytes(p[27:29], "little"))
    return OfflineStartFrame(
        TYPE_VOICE_START, msg_id, sender, declared_length, total_parts, 0, b"",
        duration_ms=duration_seconds * 1000,
    )


def _decode_image_start(p: bytes) -> OfflineStartFrame | None:
    if len(p) < 31:
        return None
    msg_id = _read_msg_id(p, 2)
    sender = _decode_sender(p[7:23])
    declared_length = int.from_bytes(p[23:25], "little")
    total_parts = p[25]
    # Byte 26 is a fixed 0x00 padding byte (second byte of the
    # `[part_count, 0x00]` pair in build_image_message_frames); width
    # and height start right after it, at offset 27.
    inline_data = p[27:]  # width(2 LE) + height(2 LE)
    return OfflineStartFrame(TYPE_IMAGE_START, msg_id, sender, declared_length, total_parts, 0, inline_data)


@dataclass
class CompletedMessage:
    kind: str  # "text" | "voice" | "image"
    sender: str
    msg_id: int
    text: str | None = None
    data: bytes | None = None          # raw AMR bytes (voice) or JPEG bytes (image)
    duration_ms: int | None = None
    width: int | None = None
    height: int | None = None


class MessageAssembler:
    """Buffers start + chunk frames per msg_id and yields a
    `CompletedMessage` once every declared part has arrived.

    One instance should be reused per connection (it has no timeout /
    cleanup logic for abandoned partial messages yet -- fine for now
    given messages are small and connections are short-lived in
    practice, but worth revisiting if this sees heavy use).
    """

    def __init__(self) -> None:
        self._pending: dict[int, dict] = {}

    def feed(self, packet: At2Packet) -> CompletedMessage | None:
        parsed = decode(packet)
        if parsed is None:
            return None
        if isinstance(parsed, OfflineStartFrame):
            return self._on_start(parsed)
        return self._on_chunk(parsed)

    def _on_start(self, f: OfflineStartFrame) -> CompletedMessage | None:
        if f.type == TYPE_TEXT_START:
            if f.total_parts <= 1:
                # Single-frame short text: inline_data[0] is the redundant
                # seq byte (see module docstring), actual text follows.
                text = f.inline_data[1:].decode("utf-8", errors="replace") if f.inline_data else ""
                return CompletedMessage(kind="text", sender=f.sender, msg_id=f.msg_id, text=text)
            self._pending[f.msg_id] = {"kind": "text", "sender": f.sender, "total": f.total_parts, "chunks": {}}
            return None

        if f.type == TYPE_VOICE_START:
            self._pending[f.msg_id] = {
                "kind": "voice", "sender": f.sender, "total": f.total_parts,
                "chunks": {}, "duration_ms": f.duration_ms,
            }
            return None

        if f.type == TYPE_IMAGE_START:
            width = int.from_bytes(f.inline_data[0:2], "little") if len(f.inline_data) >= 2 else None
            height = int.from_bytes(f.inline_data[2:4], "little") if len(f.inline_data) >= 4 else None
            self._pending[f.msg_id] = {
                "kind": "image", "sender": f.sender, "total": f.total_parts,
                "chunks": {}, "width": width, "height": height,
            }
            return None
        return None

    def _on_chunk(self, c: OfflineChunk) -> CompletedMessage | None:
        entry = self._pending.get(c.msg_id)
        if entry is None:
            return None  # chunk for a start frame we never saw (e.g. joined mid-stream)
        entry["chunks"][c.seq] = c.data
        if len(entry["chunks"]) < entry["total"]:
            return None

        ordered = b"".join(entry["chunks"][i] for i in sorted(entry["chunks"]))
        del self._pending[c.msg_id]

        if entry["kind"] == "text":
            return CompletedMessage(kind="text", sender=entry["sender"], msg_id=c.msg_id,
                                     text=ordered.decode("utf-8", errors="replace"))
        if entry["kind"] == "voice":
            return CompletedMessage(kind="voice", sender=entry["sender"], msg_id=c.msg_id,
                                     data=ordered, duration_ms=entry.get("duration_ms"))
        if entry["kind"] == "image":
            return CompletedMessage(kind="image", sender=entry["sender"], msg_id=c.msg_id,
                                     data=ordered, width=entry.get("width"), height=entry.get("height"))
        return None
