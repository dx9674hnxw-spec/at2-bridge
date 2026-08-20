"""AMR-NB (MR475, 4.75 kbps) codec binding via the system `libopencore-amrnb`.

Mirrors the exact framing used by the reference app's JNI wrapper
(`talkie_jni.cpp`, Apache-2.0): the wire format is the *raw* 12-byte
MR475 core frame with its leading TOC byte (0x04) stripped on encode
and re-added on decode -- see `NOTICE`.

Requires the `libopencore-amrnb0` runtime library on the host/container
(installed via apt in the Dockerfile). This is the well-known open
source AMR-NB reference codec (Apache 2.0), not a vendored copy.
"""
from __future__ import annotations

import ctypes
import ctypes.util
from ctypes import c_int, c_short, c_ubyte, c_void_p, POINTER

FRAME_SAMPLES = 160          # 20ms @ 8kHz
FRAME_BYTES_PCM = 320        # 160 samples * 2 bytes (16-bit)
ENCODED_FRAME_BYTES = 12     # MR475 core frame, TOC stripped
MR475_MODE = 0               # enum Mode { MR475 = 0, ... }
MR475_TOC = 0x04
SAMPLE_RATE = 8000
FRAME_DURATION_MS = 20


class AmrCodecUnavailable(RuntimeError):
    pass


def _load_lib() -> ctypes.CDLL:
    for candidate in ("libopencore-amrnb.so.0", "libopencore-amrnb.so", ctypes.util.find_library("opencore-amrnb")):
        if not candidate:
            continue
        try:
            return ctypes.CDLL(candidate)
        except OSError:
            continue
    raise AmrCodecUnavailable(
        "libopencore-amrnb not found. Install it with: "
        "apt-get install libopencore-amrnb0 (already in this project's Dockerfile)."
    )


class AmrNbCodec:
    """One encoder + one decoder state, matching TalkieCodec.kt's lifecycle."""

    def __init__(self) -> None:
        self._lib = _load_lib()
        self._lib.Encoder_Interface_init.restype = c_void_p
        self._lib.Encoder_Interface_init.argtypes = [c_int]
        self._lib.Encoder_Interface_Encode.restype = c_int
        self._lib.Encoder_Interface_Encode.argtypes = [
            c_void_p, c_int, POINTER(c_short), POINTER(c_ubyte), c_int
        ]
        self._lib.Encoder_Interface_exit.argtypes = [c_void_p]

        self._lib.Decoder_Interface_init.restype = c_void_p
        self._lib.Decoder_Interface_Decode.argtypes = [
            c_void_p, POINTER(c_ubyte), POINTER(c_short), c_int
        ]
        self._lib.Decoder_Interface_exit.argtypes = [c_void_p]

        self._enc_state = self._lib.Encoder_Interface_init(0)
        self._dec_state = self._lib.Decoder_Interface_init()

    def encode(self, pcm: bytes) -> bytes | None:
        """pcm: 320 bytes (160 int16 samples, little-endian, mono @8kHz) -> 12-byte MR475 frame."""
        if len(pcm) != FRAME_BYTES_PCM:
            raise ValueError(f"expected {FRAME_BYTES_PCM} bytes of PCM, got {len(pcm)}")
        samples = (c_short * FRAME_SAMPLES).from_buffer_copy(pcm)
        out_buf = (c_ubyte * 32)()
        produced = self._lib.Encoder_Interface_Encode(
            self._enc_state, MR475_MODE, samples, out_buf, 0
        )
        if produced != ENCODED_FRAME_BYTES + 1:
            return None
        # out_buf[0] is the TOC byte; strip it to match the over-the-air format.
        return bytes(out_buf[1:ENCODED_FRAME_BYTES + 1])

    def decode(self, frame: bytes) -> bytes:
        """frame: 12-byte MR475 core frame (no TOC) -> 320 bytes of PCM."""
        if len(frame) != ENCODED_FRAME_BYTES:
            raise ValueError(f"expected {ENCODED_FRAME_BYTES}-byte frame, got {len(frame)}")
        in_buf = (c_ubyte * (ENCODED_FRAME_BYTES + 1))()
        in_buf[0] = MR475_TOC
        in_buf[1:] = frame
        out_samples = (c_short * FRAME_SAMPLES)()
        self._lib.Decoder_Interface_Decode(self._dec_state, in_buf, out_samples, 0)
        return bytes(out_samples)

    def close(self) -> None:
        if self._enc_state:
            self._lib.Encoder_Interface_exit(self._enc_state)
            self._enc_state = None
        if self._dec_state:
            self._lib.Decoder_Interface_exit(self._dec_state)
            self._dec_state = None

    def __enter__(self) -> "AmrNbCodec":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
