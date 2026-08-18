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


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
