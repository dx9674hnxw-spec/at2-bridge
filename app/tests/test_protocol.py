"""Unit tests for the AT2 protocol codec.

Run with: python -m pytest app/tests -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.protocol import frame, channel, commands, messages


def test_crc16_matches_known_vector():
    # CRC-16/CCITT-FALSE style, init 0x1234, poly 0x1021 over an empty
    # buffer must return the init value unchanged.
    assert frame.crc16_ccitt(b"") == 0x1234


def test_frame_round_trip():
    payload = commands.query_volume()
    encoded = frame.encode_frame(payload)
    assert encoded.startswith(frame.HEAD)
    assert encoded.endswith(frame.TAIL)

    decoded_payload, consumed = frame.try_decode_frame(encoded)
    assert decoded_payload == payload
    assert consumed == len(encoded)


def test_frame_decode_with_garbage_prefix():
    payload = commands.set_volume(5)
    encoded = frame.encode_frame(payload)
    noisy = b"\x00\x11\x22" + encoded + b"\x33\x44"
    decoded_payload, consumed = frame.try_decode_frame(noisy)
    assert decoded_payload == payload


def test_decode_packet_roundtrip():
    payload = commands.select_channel(5)
    pkt = frame.decode_packet(payload)
    assert pkt is not None
    assert pkt.family == 0x02
    assert pkt.command == 0x0E


def test_channel_encode_decode_round_trip():
    cfg = channel.ChannelConfig(
        channel=3,
        rx_mhz=446.00625,
        tx_mhz=446.00625,
        rx_tone="88.5Hz",
        tx_tone="D023N",
        busy_lock=False,
        bandwidth_narrow=True,
        high_power=True,
        scan_add=True,
        hop_on=False,
        mode_digital=False,
        encrypt_key=0,
    )
    record = channel.encode_channel_record(cfg)
    assert len(record) == channel.CHANNEL_RECORD_LEN

    decoded = channel.decode_channel_record(record)
    assert decoded.channel == 3
    assert decoded.rx_mhz == cfg.rx_mhz
    assert decoded.tx_mhz == cfg.tx_mhz
    assert decoded.rx_tone == "88.5Hz"
    assert decoded.tx_tone == "D023N"


def test_channel_off_tone_round_trip():
    cfg = channel.ChannelConfig(channel=1, rx_mhz=440.0, tx_mhz=440.0)
    record = channel.encode_channel_record(cfg)
    decoded = channel.decode_channel_record(record)
    assert decoded.rx_tone == "OFF"
    assert decoded.tx_tone == "OFF"


def test_codeplug_write_chunking():
    configs = [channel.ChannelConfig(channel=i + 1) for i in range(30)]
    chunks = channel.build_codeplug_write_chunks(configs)
    assert len(chunks) == 5  # 720 bytes / 168-byte chunks = 4 full + 1 partial (48 bytes)
    total_bytes = sum(len(c) for c in chunks)
    assert total_bytes == 30 * 24


def test_codeplug_read_parse_round_trip():
    configs = [
        channel.ChannelConfig(channel=i + 1, rx_mhz=440.0 + i * 0.0125, tx_mhz=440.0 + i * 0.0125)
        for i in range(30)
    ]
    chunks = channel.build_codeplug_write_chunks(configs)
    parsed = channel.parse_codeplug_read_chunks(chunks)
    assert len(parsed) == 30
    assert parsed[0].rx_mhz == 440.0
    assert parsed[29].rx_mhz == round(440.0 + 29 * 0.0125, 5)


def test_tone_label_parse_all_ctcss():
    for value in channel.CTCSS_VALUES:
        v, t, p = channel.parse_tone_label(f"{value}Hz")
        assert t == 0x00
        assert channel.tone_label(v, t, p) == f"{value}Hz"


def test_message_short_text_single_frame():
    frames = messages.build_text_message_frames("elyha", "Salut !", msg_id=1)
    assert len(frames) == 1
    assert frames[0].startswith(frame.HEAD)


def test_message_long_text_fragments():
    long_text = "A" * 500
    frames = messages.build_text_message_frames("elyha", long_text, msg_id=2)
    assert len(frames) > 1  # start frame + chunk frames


def test_amr_codec_round_trip_shapes():
    from app.protocol.amr_codec import AmrNbCodec, FRAME_BYTES_PCM, ENCODED_FRAME_BYTES
    import math
    import struct

    samples = [int(3000 * math.sin(2 * math.pi * 440 * i / 8000)) for i in range(160)]
    pcm = struct.pack("<160h", *samples)
    assert len(pcm) == FRAME_BYTES_PCM

    with AmrNbCodec() as codec:
        encoded = codec.encode(pcm)
        assert encoded is not None
        assert len(encoded) == ENCODED_FRAME_BYTES

        decoded = codec.decode(encoded)
        assert len(decoded) == FRAME_BYTES_PCM


def test_ptt_voice_payload_build_and_parse():
    from app.protocol import ptt

    frames = [bytes([i]) * 12 for i in range(5)]
    payload = ptt.build_ptt_voice_payload(frames)
    pkt = frame.decode_packet(payload)
    assert pkt.family == ptt.FAMILY_PTT
    assert pkt.command == ptt.CMD_PTT
    assert ptt.is_ptt_voice_packet(pkt.family, pkt.command, pkt.body)

    parsed = ptt.extract_amr_frames(pkt.body)
    assert parsed == frames


def test_ptt_voice_payload_tail_of_four():
    from app.protocol import ptt

    frames = [bytes([i]) * 12 for i in range(4)]
    payload = ptt.build_ptt_voice_payload(frames)
    pkt = frame.decode_packet(payload)
    assert ptt.extract_amr_frames(pkt.body) == frames


def test_ptt_voice_payload_rejects_bad_frame_count():
    from app.protocol import ptt
    import pytest

    with pytest.raises(ValueError):
        ptt.build_ptt_voice_payload([b"\x00" * 12] * 2)


# ---------------------------------------------------------------------------
# Offline messaging: voice, image, generic decode(), MessageAssembler
# (previously validated manually, not yet locked in by automated tests)
# ---------------------------------------------------------------------------

def _round_trip(frames_list):
    """Feed a list of already-encoded frames through decode + assembler,
    return the last completed message produced (or None)."""
    assembler = messages.MessageAssembler()
    result = None
    for f in frames_list:
        payload, consumed = frame.try_decode_frame(f)
        assert consumed == len(f)
        pkt = frame.decode_packet(payload)
        r = assembler.feed(pkt)
        if r is not None:
            result = r
    return result


def test_message_decode_rejects_wrong_family_command():
    # A channel-select packet (family=0x02, command=0x0e) must not be
    # mistaken for a messaging packet (family=0x02, command=0x04).
    payload = commands.select_channel(5)
    pkt = frame.decode_packet(payload)
    assert messages.decode(pkt) is None


def test_message_short_text_round_trip_via_assembler():
    frames = messages.build_text_message_frames("elyha", "Salut !", msg_id=10)
    result = _round_trip(frames)
    assert result is not None
    assert result.kind == "text"
    assert result.sender == "elyha"
    assert result.text == "Salut !"


def test_message_long_text_round_trip_via_assembler():
    long_text = "C" * 400
    frames = messages.build_text_message_frames("elyha", long_text, msg_id=11)
    result = _round_trip(frames)
    assert result.kind == "text"
    assert result.text == long_text


def test_message_voice_round_trip():
    # 20 fake 12-byte AMR frames concatenated (240 bytes); doesn't need
    # to be real AMR data to exercise the chunking/reassembly path.
    voice_bytes = bytes(range(12)) * 20
    frames = messages.build_voice_message_frames("elyha", voice_bytes, duration_ms=2500, msg_id=12)
    result = _round_trip(frames)
    assert result.kind == "voice"
    assert result.sender == "elyha"
    assert result.data == voice_bytes
    assert result.duration_ms == 3000  # ceil(2500ms) -> 3s -> 3000ms


def test_message_voice_rejects_empty_data():
    import pytest
    with pytest.raises(ValueError):
        messages.build_voice_message_frames("elyha", b"", duration_ms=1000, msg_id=13)


def test_message_image_round_trip():
    jpeg_fake = bytes([0xFF, 0xD8]) + bytes(range(256)) * 3  # 770 bytes
    frames = messages.build_image_message_frames("elyha", jpeg_fake, width=300, height=225, msg_id=14)
    result = _round_trip(frames)
    assert result.kind == "image"
    assert result.sender == "elyha"
    assert result.data == jpeg_fake
    assert result.width == 300
    assert result.height == 225


def test_message_image_rejects_invalid_dimensions():
    import pytest
    with pytest.raises(ValueError):
        messages.build_image_message_frames("elyha", b"\xff\xd8\x00", width=0, height=100, msg_id=15)


def test_message_image_single_chunk():
    # Image small enough to fit in exactly one 132-byte chunk.
    small_jpeg = bytes([0xFF, 0xD8]) + bytes(range(50))
    frames = messages.build_image_message_frames("elyha", small_jpeg, width=64, height=48, msg_id=16)
    assert len(frames) == 2  # start frame + exactly one chunk
    result = _round_trip(frames)
    assert result.data == small_jpeg


def test_message_assembler_ignores_unrelated_packets():
    # Feeding a non-messaging packet (e.g. a channel write) must not
    # raise and must not produce a spurious completed message.
    assembler = messages.MessageAssembler()
    payload = commands.set_volume(5)
    pkt = frame.decode_packet(payload)
    assert assembler.feed(pkt) is None


def test_message_assembler_handles_orphan_chunk_gracefully():
    # A chunk frame arriving without its start frame (e.g. joined
    # mid-transmission) must be ignored, not crash.
    assembler = messages.MessageAssembler()
    frames = messages.build_text_message_frames("elyha", "D" * 400, msg_id=17)
    orphan_chunk_frame = frames[2]  # skip the start frame
    payload, _ = frame.try_decode_frame(orphan_chunk_frame)
    pkt = frame.decode_packet(payload)
    assert assembler.feed(pkt) is None


def test_message_assembler_handles_concurrent_messages():
    # Two messages interleaved (different msg_ids) must reassemble
    # independently without cross-contamination.
    assembler = messages.MessageAssembler()
    frames_a = messages.build_text_message_frames("alice", "A" * 300, msg_id=20)
    frames_b = messages.build_text_message_frames("bob", "B" * 300, msg_id=21)

    results = {}
    for fa, fb in zip(frames_a, frames_b):
        for f, sender in ((fa, "alice"), (fb, "bob")):
            payload, _ = frame.try_decode_frame(f)
            pkt = frame.decode_packet(payload)
            r = assembler.feed(pkt)
            if r is not None:
                results[r.sender] = r.text

    assert results.get("alice") == "A" * 300
    assert results.get("bob") == "B" * 300


# ---------------------------------------------------------------------------
# Auth (app/auth.py) -- token issuance/verification, password check
# ---------------------------------------------------------------------------

def test_auth_disabled_when_no_password_set(monkeypatch):
    from app import auth
    monkeypatch.delenv("AT2_BRIDGE_PASSWORD", raising=False)
    assert auth.auth_enabled() is False
    assert auth.verify_token(None) is True
    assert auth.verify_token("garbage") is True


def test_auth_enabled_rejects_wrong_password(monkeypatch):
    from app import auth
    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    assert auth.auth_enabled() is True
    assert auth.check_password("secret123") is True
    assert auth.check_password("wrong") is False
    assert auth.check_password("") is False


def test_auth_token_round_trip(monkeypatch):
    from app import auth
    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    token = auth.issue_token()
    assert auth.verify_token(token) is True
    assert auth.verify_token("garbage") is False
    assert auth.verify_token(None) is False


def test_auth_token_rejects_tampered_signature(monkeypatch):
    from app import auth
    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    token = auth.issue_token()
    expires_at, _, _sig = token.partition(".")
    tampered = f"{expires_at}.0000000000000000000000000000000000000000000000000000000000000000"
    assert auth.verify_token(tampered) is False


def test_auth_token_rejects_expired(monkeypatch):
    from app import auth
    import time
    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    monkeypatch.setattr(auth, "TOKEN_TTL_SECONDS", -1)  # force immediate expiry
    token = auth.issue_token()
    assert auth.verify_token(token) is False


def test_auth_require_auth_dependency(monkeypatch):
    from app import auth
    from fastapi import HTTPException
    import pytest

    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    token = auth.issue_token()

    auth.require_auth(authorization=f"Bearer {token}")  # must not raise

    with pytest.raises(HTTPException):
        auth.require_auth(authorization=None)

    with pytest.raises(HTTPException):
        auth.require_auth(authorization="Bearer garbage")


def test_auth_require_auth_ws_helper(monkeypatch):
    from app import auth
    monkeypatch.setenv("AT2_BRIDGE_PASSWORD", "secret123")
    token = auth.issue_token()
    assert auth.require_auth_ws(token=token) is True
    assert auth.require_auth_ws(token=None) is False
    assert auth.require_auth_ws(token="garbage") is False


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
