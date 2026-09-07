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

import time
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
FAMILY_MSG_ACK = FAMILY_MSG | 0x80  # 0x82 -- the radio's response family for a family=0x02 write

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


def is_message_ack(family: int, command: int, body: bytes) -> bool:
    """True for the radio's acknowledgment of an offline-message frame
    (text/voice/image start or chunk) -- ported from
    `BleEventController.kt`'s
    `packet.containsSubsequence(byteArrayOf(0x82, 0x04, 0x01, 0x00))`.

    Used to send each frame of a multi-frame message and wait for this
    ack before sending the next one (with retry), instead of the old
    fixed-delay fire-and-forget approach -- a dropped frame on a lossy
    BLE link used to go completely undetected, silently truncating
    whatever the receiving end could reassemble.
    """
    return family == FAMILY_MSG_ACK and command == CMD_MSG and len(body) >= 2 and body[0] == 0x01 and body[1] == 0x00


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


# Full (unpadded) chunk-data size per chunk type, used both to detect
# whether a start frame's declared total looks sane and, for orphan
# chunks (see below), as the "this one is shorter, so it must be the
# last one" heuristic -- ported from
# `OfflineMessageAssembler.kt::consumeChunk`'s fullTextChunkSize/
# fullVoiceChunkSize/lastChunkSize logic.
_FULL_CHUNK_BYTES = {
    TYPE_TEXT_CHUNK: FRAGMENT_TEXT_CHUNK_BYTES,
    TYPE_VOICE_CHUNK: VOICE_CHUNK_BYTES,
    TYPE_IMAGE_CHUNK: IMAGE_CHUNK_BYTES,
}
_CHUNK_KIND = {TYPE_TEXT_CHUNK: "text", TYPE_VOICE_CHUNK: "voice", TYPE_IMAGE_CHUNK: "image"}

# Bounds on MessageAssembler._pending -- without these, a flood of bogus
# start/chunk frames (anything any RF/BLE transmitter in range can send,
# no auth possible at that layer) grows _pending without limit, since
# nothing here previously expired an entry that never got completed
# (a start frame whose chunks never arrive, or -- since the orphan-chunk
# recovery below was added -- an orphan chunk with a msg_id that never
# gets a matching start frame either). A real connection normally has at
# most ~1 message in flight at a time (see device.py's ack-gated,
# one-frame-at-a-time sender), so both limits are generous headroom
# against a hostile flood, not a normal-usage constraint.
_MAX_PENDING_MESSAGES = 64
_PENDING_MESSAGE_TTL_SECONDS = 120.0


def _trim_to_declared(data: bytes, declared_length: int | None) -> bytes:
    """Ported from `OfflineMessageAssembler.kt::trimToDeclared`. The radio's
    real over-the-air chunks may pad the last one out to the fixed chunk
    size instead of sending only the remaining bytes (neither this
    project's nor the reference app's own encoder does this, but nothing
    guarantees the *radio* doesn't) -- without this, a received message
    whose length isn't an exact multiple of the chunk size could get
    trailing garbage appended by the reassembly. Trimming to the
    start frame's self-declared length is a pure safety net: it only
    ever removes bytes, never legitimate ones, since declared_length is
    always <= the reassembled size in that scenario."""
    if not declared_length or declared_length <= 0 or not data:
        return data
    return data[:declared_length]


class MessageAssembler:
    """Buffers start + chunk frames per msg_id and yields a
    `CompletedMessage` once every declared part has arrived.

    One instance should be reused per connection. Abandoned partial
    messages (a start frame whose chunks never arrive, or an orphan
    chunk that never gets a matching start) are bounded by
    `_MAX_PENDING_MESSAGES` / `_PENDING_MESSAGE_TTL_SECONDS` above --
    see `_evict_stale_and_excess()` -- rather than left to accumulate
    forever.
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

    def _evict_stale_and_excess(self) -> None:
        """Called right before inserting a new pending entry, so the caps
        hold even under a sustained flood rather than only being checked
        once memory has already grown. First drops anything older than
        the TTL (a real multi-chunk message completes in well under
        that); if still at/over the cap, drops the oldest remaining
        entries -- a real device only ever has ~1 message in flight, so
        anything pushing past the cap is far more likely to be junk than
        a legitimate backlog."""
        if not self._pending:
            return
        now = time.monotonic()
        stale_ids = [msg_id for msg_id, entry in self._pending.items()
                     if now - entry["created_at"] > _PENDING_MESSAGE_TTL_SECONDS]
        for msg_id in stale_ids:
            del self._pending[msg_id]
        if len(self._pending) >= _MAX_PENDING_MESSAGES:
            oldest_first = sorted(self._pending.items(), key=lambda kv: kv[1]["created_at"])
            evict_count = len(self._pending) - _MAX_PENDING_MESSAGES + 1
            for msg_id, _entry in oldest_first[:evict_count]:
                del self._pending[msg_id]

    def _on_start(self, f: OfflineStartFrame) -> CompletedMessage | None:
        if f.type == TYPE_TEXT_START:
            if f.total_parts <= 1:
                # Single-frame short text: inline_data[0] is the redundant
                # seq byte (see module docstring) -- but only strip it when
                # it's actually the reference decoder's `0x00` padding
                # convention (`stripLeadingControlByte` in
                # OfflineMessageAssembler.kt is conditional on that byte
                # being zero, not an unconditional drop -- this used to
                # unconditionally drop byte 0, which would have eaten a
                # real leading character on some other value).
                data = f.inline_data[1:] if f.inline_data[:1] == b"\x00" else f.inline_data
                text = _trim_to_declared(data, f.declared_length).decode("utf-8", errors="replace")
                return CompletedMessage(kind="text", sender=f.sender, msg_id=f.msg_id, text=text)
            # `declared_length` here is the *stream* length as computed by
            # build_text_message_frames() -- `sum(len(part) + 1 for part
            # in parts)`, i.e. it bakes in one extra byte per chunk (the
            # leading 0x00 pad byte each chunk carries on the wire).
            # Python's own chunk decoder deliberately extracts chunk data
            # *without* that pad byte (see the module docstring on the
            # offset-8-vs-9 divergence from the reference decoder), so
            # reassembled chunks are `total_parts` bytes shorter than
            # `declared_length` even with no padding at all. Correct for
            # that unit mismatch here so `_trim_to_declared` trims against
            # the right target instead of leaving `total_parts` stray
            # bytes behind.
            declared_length = f.declared_length - f.total_parts if f.declared_length else f.declared_length
            self._evict_stale_and_excess()
            self._pending[f.msg_id] = {
                "kind": "text", "sender": f.sender, "total": f.total_parts,
                "declared_length": declared_length, "chunks": {}, "created_at": time.monotonic(),
            }
            return None

        if f.type == TYPE_VOICE_START:
            self._evict_stale_and_excess()
            self._pending[f.msg_id] = {
                "kind": "voice", "sender": f.sender, "total": f.total_parts,
                "declared_length": f.declared_length, "chunks": {}, "duration_ms": f.duration_ms,
                "created_at": time.monotonic(),
            }
            return None

        if f.type == TYPE_IMAGE_START:
            width = int.from_bytes(f.inline_data[0:2], "little") if len(f.inline_data) >= 2 else None
            height = int.from_bytes(f.inline_data[2:4], "little") if len(f.inline_data) >= 4 else None
            self._evict_stale_and_excess()
            self._pending[f.msg_id] = {
                "kind": "image", "sender": f.sender, "total": f.total_parts,
                "declared_length": f.declared_length, "chunks": {}, "width": width, "height": height,
                "created_at": time.monotonic(),
            }
            return None
        return None

    def _on_chunk(self, c: OfflineChunk) -> CompletedMessage | None:
        entry = self._pending.get(c.msg_id)
        if entry is None:
            # Chunk for a start frame we never saw -- e.g. it was dropped
            # on a lossy BLE link, or we joined mid-transmission. Ported
            # from OfflineMessageAssembler.kt: rather than discarding
            # these forever (the previous behavior here), start tracking
            # them under a synthetic entry so the message can still be
            # recovered once enough chunks arrive. We don't know `total`
            # in this case, so completion instead falls back to a
            # "contiguous from 0, and the last one is shorter than a
            # full chunk" heuristic below -- same limitation the
            # reference app has: a message whose length happens to be an
            # exact multiple of the chunk size can't be detected as
            # complete this way and needs its start frame.
            kind = _CHUNK_KIND.get(c.type)
            if kind is None:
                return None
            self._evict_stale_and_excess()
            entry = self._pending[c.msg_id] = {
                "kind": kind, "sender": None, "total": None, "declared_length": None, "chunks": {},
                "created_at": time.monotonic(),
            }
        entry["chunks"][c.seq] = c.data

        total = entry["total"]
        if total is not None:
            # Strict: not just "enough chunks arrived" (len >= total) but
            # exactly the expected contiguous set 0..total-1 -- guards
            # against a dropped-then-duplicated or out-of-range seq
            # silently reassembling the wrong bytes (sorted(dict) sorts
            # whatever keys actually arrived, not the expected range).
            if sorted(entry["chunks"]) != list(range(total)):
                return None
        else:
            keys = sorted(entry["chunks"])
            if keys != list(range(len(keys))):
                return None  # not contiguous from 0 yet
            full_size = _FULL_CHUNK_BYTES.get(c.type)
            last_size = len(entry["chunks"][keys[-1]])
            if not full_size or not (0 < last_size < full_size):
                return None  # last-seen chunk is still full-size: more likely still coming

        ordered = _trim_to_declared(
            b"".join(entry["chunks"][i] for i in sorted(entry["chunks"])),
            entry["declared_length"],
        )
        del self._pending[c.msg_id]
        sender = entry["sender"] or DEFAULT_USERNAME

        if entry["kind"] == "text":
            return CompletedMessage(kind="text", sender=sender, msg_id=c.msg_id,
                                     text=ordered.decode("utf-8", errors="replace"))
        if entry["kind"] == "voice":
            return CompletedMessage(kind="voice", sender=sender, msg_id=c.msg_id,
                                     data=ordered, duration_ms=entry.get("duration_ms"))
        if entry["kind"] == "image":
            return CompletedMessage(kind="image", sender=sender, msg_id=c.msg_id,
                                     data=ordered, width=entry.get("width"), height=entry.get("height"))
        return None
