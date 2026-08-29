"""AT2 channel record codec (24 bytes per channel, 30 channels).

Ported from `At2ChannelCodec.kt` and `At2Commands.kt` (Apache-2.0),
see /THIRD_PARTY_NOTICES.md.

Record layout (offsets are byte indices into the 24-byte record):
  0     : 0x01 marker (write) / channel status
  1     : channel number (1..30)
  3..6  : RX frequency, uint32 little-endian, value = round(mhz * 100000)
  7..10 : TX frequency, same encoding
  11    : rxTone value/index
  12    : rxTone type (0x00 CTCSS, 0x01 DCS)
  13    : txTone value/index
  14    : txTone type
  15    : rxTone polarity (DCS normal/inverted)
  16    : txTone polarity
  17    : busyLock  (0x00 = on,  0x01 = off  -- inverted, see encode below)
  18    : bandwidth (0x01 = narrow, 0x00 = wide)
  19    : power     (0x01 = high, 0x00 = low)
  20    : scanAdd   (0x00 = added to scan, 0x01 = excluded -- inverted)
  21    : frequency hopping (0x01 = on)
  22    : mode      (0x01 = digital, 0x00 = analog)
  23    : encrypt key index (0 = off, 1..31)
"""
from __future__ import annotations

from dataclasses import dataclass, field

CHANNEL_RECORD_LEN = 24
CHANNEL_COUNT = 30

CTCSS_VALUES = [
    "67.0", "69.3", "71.9", "74.4", "77.0", "79.7", "82.5", "85.4", "88.5", "91.5",
    "94.8", "97.4", "100.0", "103.5", "107.2", "110.9", "114.8", "118.8", "123.0", "127.3",
    "131.8", "136.5", "141.3", "146.2", "150.0", "151.4", "156.7", "159.8", "162.2", "165.5",
    "167.9", "171.3", "173.8", "177.3", "179.9", "183.5", "186.2", "189.9", "192.8", "196.6",
    "199.5", "203.5", "206.5", "210.7", "218.1", "225.7", "229.1", "233.6", "241.8", "250.3",
    "254.1",
]

DCS_VALUES = [
    "D023", "D025", "D026", "D031", "D032", "D036", "D043", "D047", "D051", "D053",
    "D054", "D065", "D071", "D072", "D073", "D074", "D114", "D115", "D116", "D122",
    "D125", "D131", "D132", "D134", "D143", "D145", "D152", "D155", "D156", "D162",
    "D165", "D172", "D174", "D205", "D212", "D223", "D225", "D226", "D243", "D244",
    "D245", "D246", "D251", "D252", "D255", "D261", "D263", "D265", "D266", "D271",
    "D274", "D306", "D311", "D315", "D325", "D331", "D332", "D343", "D346", "D351",
    "D356", "D364", "D365", "D371", "D411", "D412", "D413", "D423", "D431", "D432",
    "D445", "D446", "D452", "D454", "D455", "D462", "D464", "D465", "D466", "D503",
    "D506", "D516", "D523", "D526", "D532", "D546", "D565", "D606", "D612", "D624",
    "D627", "D631", "D632", "D645", "D654", "D662", "D664", "D703", "D712", "D723",
    "D731", "D732", "D734", "D743", "D754",
]


def tone_options() -> list[str]:
    return ["OFF"] + [f"{v}Hz" for v in CTCSS_VALUES] + [f"{v}N" for v in DCS_VALUES] + [f"{v}I" for v in DCS_VALUES]


def tone_label(value: int, type_: int, polarity: int) -> str:
    if value == 0x7F and type_ == 0x00:
        return "OFF"
    if type_ == 0x00:
        return f"{CTCSS_VALUES[value]}Hz" if value < len(CTCSS_VALUES) else "OFF"
    if type_ == 0x01:
        if value < len(DCS_VALUES):
            return DCS_VALUES[value] + ("I" if polarity == 0x01 else "N")
        return "OFF"
    return "OFF"


def parse_tone_label(label: str) -> tuple[int, int, int]:
    """Returns (value, type, polarity)."""
    text = label.strip().upper()
    if text == "OFF":
        return 0x7F, 0x00, 0x00
    if text.endswith("N") or text.endswith("I"):
        base = text[:-1]
        if base in DCS_VALUES:
            return DCS_VALUES.index(base), 0x01, (0x01 if text.endswith("I") else 0x00)
    normalized = text.removesuffix("HZ")
    if normalized in CTCSS_VALUES:
        return CTCSS_VALUES.index(normalized), 0x00, 0x00
    raise ValueError(f"unrecognized tone label: {label!r}")


@dataclass
class ChannelConfig:
    channel: int
    rx_mhz: float | None = None
    tx_mhz: float | None = None
    rx_tone: str = "OFF"
    tx_tone: str = "OFF"
    busy_lock: bool = False
    bandwidth_narrow: bool = True
    high_power: bool = True
    scan_add: bool = True
    hop_on: bool = False
    mode_digital: bool = False
    encrypt_key: int = 0
    name: str | None = None  # local-only label, not sent to the radio


def _encode_freq(mhz: float | None) -> bytes:
    if mhz is None:
        return b"\x00\x00\x00\x00"
    raw = round(mhz * 100000)
    if not (0 <= raw <= 0xFFFFFFFF):
        raise ValueError(f"frequency out of range: {mhz}")
    return raw.to_bytes(4, "little")


def _decode_freq(b: bytes) -> float | None:
    raw = int.from_bytes(b, "little")
    if raw == 0:
        return None
    return round(raw / 100000, 5)


def empty_channel_record(channel: int) -> bytearray:
    if not (1 <= channel <= 30):
        raise ValueError(f"channel out of range: {channel}")
    rec = bytearray(CHANNEL_RECORD_LEN)
    rec[0] = 0x01
    rec[1] = channel
    rec[11] = 0x7F  # rx tone = OFF
    rec[13] = 0x7F  # tx tone = OFF
    return rec


def encode_channel_record(config: ChannelConfig) -> bytes:
    rec = empty_channel_record(config.channel)
    rec[3:7] = _encode_freq(config.rx_mhz)
    rec[7:11] = _encode_freq(config.tx_mhz)

    rx_val, rx_type, rx_pol = parse_tone_label(config.rx_tone)
    tx_val, tx_type, tx_pol = parse_tone_label(config.tx_tone)
    rec[11] = rx_val & 0xFF
    rec[12] = rx_type & 0xFF
    rec[13] = tx_val & 0xFF
    rec[14] = tx_type & 0xFF
    rec[15] = rx_pol & 0xFF
    rec[16] = tx_pol & 0xFF

    rec[17] = 0x00 if config.busy_lock else 0x01
    rec[18] = 0x01 if config.bandwidth_narrow else 0x00
    rec[19] = 0x01 if config.high_power else 0x00
    rec[20] = 0x00 if config.scan_add else 0x01
    rec[21] = 0x01 if config.hop_on else 0x00
    rec[22] = 0x01 if config.mode_digital else 0x00
    rec[23] = config.encrypt_key & 0xFF
    return bytes(rec)


def decode_channel_record(rec: bytes) -> ChannelConfig:
    if len(rec) != CHANNEL_RECORD_LEN:
        raise ValueError(f"channel record must be {CHANNEL_RECORD_LEN} bytes, got {len(rec)}")
    channel = rec[1]
    rx_mhz = _decode_freq(rec[3:7])
    tx_mhz = _decode_freq(rec[7:11])
    rx_tone = tone_label(rec[11], rec[12], rec[15])
    tx_tone = tone_label(rec[13], rec[14], rec[16])
    return ChannelConfig(
        channel=channel,
        rx_mhz=rx_mhz,
        tx_mhz=tx_mhz,
        rx_tone=rx_tone,
        tx_tone=tx_tone,
        busy_lock=(rec[17] == 0x00),
        bandwidth_narrow=(rec[18] == 0x01),
        high_power=(rec[19] == 0x01),
        scan_add=(rec[20] == 0x00),
        hop_on=(rec[21] == 0x01),
        mode_digital=(rec[22] == 0x01),
        encrypt_key=rec[23],
    )


def build_codeplug_write_chunks(configs: list[ChannelConfig]) -> list[bytes]:
    """Build the family=0x02 command=0x02 chunk bodies for a full 30-channel write.

    Channels are concatenated (30 x 24 = 720 bytes) then split into
    168-byte chunks (7 channels each), matching the reference app.
    """
    if len(configs) != CHANNEL_COUNT:
        raise ValueError("need exactly 30 channel configs")
    raw = b"".join(encode_channel_record(c) for c in configs)
    chunk_size = 168
    return [raw[i:i + chunk_size] for i in range(0, len(raw), chunk_size)]


def parse_codeplug_read_chunks(chunks: list[bytes]) -> list[ChannelConfig]:
    """Inverse of build_codeplug_write_chunks: reassemble channel records
    from the raw bodies received while reading the codeplug back."""
    raw = b"".join(chunks)
    if len(raw) % CHANNEL_RECORD_LEN != 0:
        raise ValueError(f"unexpected codeplug read length: {len(raw)} bytes")
    return [decode_channel_record(raw[i:i + CHANNEL_RECORD_LEN]) for i in range(0, len(raw), CHANNEL_RECORD_LEN)]


# ---------------------------------------------------------------------------
# Import from a CPS-format XML export (the human-readable config file saved
# by the official Windows CPS -- NOT a protocol capture, just a config
# snapshot). Field-by-field mapping cross-validated on 27-28/08/2026 against
# real hardware reads for channels 1, 11, 12 (frequencies, tones, mode,
# encrypt key all matched exactly) -- see CONSIGNES_PROJET.md.
#
# This only produces ChannelConfig objects for the UI to review/edit; it
# never writes to the radio directly -- the person still has to click
# "Write" afterwards, same as after a live "Read" from the radio.
# ---------------------------------------------------------------------------

_CPS_XML_CHANNEL_TAG = "信道数据"

_CPS_XML_ATTR = {
    "channel": "信道号",
    "rx_freq": "接收频率",
    "tx_freq": "发射频率",
    "rx_tone_value": "接收CTCSS",
    "rx_tone_type": "接收CTCSS类型",
    "tx_tone_value": "发射CTCSS",
    "tx_tone_type": "发射CTCSS类型",
    "rx_tone_polarity": "接收CTCSS数字编码",
    "tx_tone_polarity": "发射CTCSS数字编码",
    "busy_lock": "繁忙锁定",
    "bandwidth": "宽窄带",
    "power": "发射功率",
    "scan_add": "扫描添加",
    "hop": "跳频",
    "mode": "对讲模式",
    "encrypt_key": "加密密钥",
}


def _cps_xml_tone_to_label(value: str, type_: str, polarity: str) -> str:
    """Converts the CPS XML's tone representation (separate value/type/
    polarity attributes, e.g. value="67.0" type="CTCSS") into our own
    tone label format (e.g. "67.0Hz", "D023N", "OFF") -- see
    tone_options()/parse_tone_label() above.

    NOTE: the exact string used by the CPS XML for *reversed* DCS
    polarity has not been observed yet (every DCS/CTCSS example seen so
    far uses polarity="normal") -- this assumes "reverse" by elimination
    by symmetry with "normal", not confirmed. Any other/unrecognized
    polarity string is treated as normal rather than raising, since a
    wrong polarity on import is a minor, easily-corrected-by-eye mistake
    in the channel table, not worth failing the whole import over.
    """
    value = (value or "").strip()
    if not value:
        return "OFF"
    if type_ == "DCS":
        return f"{value}{'I' if polarity == 'reverse' else 'N'}"
    return f"{value}Hz"


def parse_cps_xml(xml_bytes: bytes) -> list[ChannelConfig]:
    """Parses a CPS XML export (as produced by the official Windows CPS's
    own save/export feature) into a list of ChannelConfig, one per
    channel found (usually 30, but this doesn't assume/require exactly
    30 -- it returns whatever channel entries are present).

    Channels with no frequency set (blank/unconfigured slots) are
    skipped entirely rather than turned into a bogus all-zero
    ChannelConfig, since a channel wholly absent from the XML is not the
    same thing as a channel deliberately cleared to 0.0 MHz.
    """
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise ValueError(f"XML illisible: {e}") from e

    configs: list[ChannelConfig] = []
    for elem in root.iter(_CPS_XML_CHANNEL_TAG):
        attrs = {k: elem.get(v, "") for k, v in _CPS_XML_ATTR.items()}

        channel_str = attrs["channel"].strip()
        if not channel_str:
            continue
        channel = int(channel_str)

        rx_str = attrs["rx_freq"].strip()
        tx_str = attrs["tx_freq"].strip()
        if not rx_str and not tx_str:
            continue  # blank/unconfigured channel slot -- skip, not a 0.0 MHz channel

        rx_tone = _cps_xml_tone_to_label(attrs["rx_tone_value"], attrs["rx_tone_type"], attrs["rx_tone_polarity"])
        tx_tone = _cps_xml_tone_to_label(attrs["tx_tone_value"], attrs["tx_tone_type"], attrs["tx_tone_polarity"])
        encrypt_key_str = attrs["encrypt_key"].strip()

        configs.append(ChannelConfig(
            channel=channel,
            rx_mhz=float(rx_str) if rx_str else None,
            tx_mhz=float(tx_str) if tx_str else None,
            rx_tone=rx_tone,
            tx_tone=tx_tone,
            busy_lock=(attrs["busy_lock"].strip().upper() == "ON"),
            bandwidth_narrow=(attrs["bandwidth"].strip().upper() == "NARROW"),
            high_power=(attrs["power"].strip().upper() == "HIGH"),
            scan_add=(attrs["scan_add"].strip().upper() == "ON"),
            hop_on=(attrs["hop"].strip().upper() == "OPEN"),
            mode_digital=(attrs["mode"].strip().upper() == "DIGITAL"),
            encrypt_key=int(encrypt_key_str) if encrypt_key_str else 0,
        ))

    return configs

