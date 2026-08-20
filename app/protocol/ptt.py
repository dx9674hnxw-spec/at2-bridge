"""Real-time PTT voice protocol, ported from `PttVoiceSender.kt` /
`PttVoiceReceiver.kt` (Apache-2.0) -- see NOTICE.

Wire format per voice packet: payload = 0x02 0x04 0x03 0x00 0x00 + data,
where `data` is 5 concatenated 12-byte AMR MR475 frames (60 bytes,
= 100ms of audio), except the final packet of a transmission which may
carry only 4 frames (48 bytes) as a tail. Packets are paced at roughly
one every 100ms to match the reference app's observed timing.
"""
from __future__ import annotations

from .frame import build_payload

FAMILY_PTT = 0x02
CMD_PTT = 0x04
PTT_VOICE_SUBTYPE = bytes([0x03, 0x00, 0x00])

FRAMES_PER_PACKET = 5
TAIL_MIN_FRAMES = 4
PACKET_PACING_SECONDS = 0.10


def build_ptt_voice_payload(amr_frames: list[bytes]) -> bytes:
    """`amr_frames`: 4 or 5 elements of 12-byte AMR MR475 frames."""
    if not (TAIL_MIN_FRAMES <= len(amr_frames) <= FRAMES_PER_PACKET):
        raise ValueError(f"expected {TAIL_MIN_FRAMES}-{FRAMES_PER_PACKET} AMR frames, got {len(amr_frames)}")
    for f in amr_frames:
        if len(f) != 12:
            raise ValueError("each AMR frame must be 12 bytes")
    data = b"".join(amr_frames)
    return build_payload(FAMILY_PTT, CMD_PTT, PTT_VOICE_SUBTYPE + data)


def is_ptt_voice_packet(family: int, command: int, body: bytes) -> bool:
    return family == FAMILY_PTT and command == CMD_PTT and body[:3] == PTT_VOICE_SUBTYPE


def extract_amr_frames(body: bytes) -> list[bytes]:
    """`body` is the packet body *after* family/command, i.e. starts with the subtype bytes."""
    data = body[3:]
    return [data[i:i + 12] for i in range(0, len(data) - len(data) % 12, 12)]
