/* Minimal JS port of the AT2 frame protocol (app/protocol/frame.py +
 * commands.py), used only by the client-side Web Bluetooth mode
 * (ble-client.js). Kept intentionally small: channel select + text
 * messaging, enough for direct browser<->radio control without a
 * server round-trip. The full protocol (codeplug read/write, PTT
 * voice) stays server-side for now -- see README.
 */
const AT2Protocol = (() => {
  const HEAD = [0xaa, 0x55];
  const TAIL = [0x77, 0xee];

  function crc16Ccitt(bytes) {
    let crc = 0x1234;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc & 0xffff;
  }

  function buildPayload(family, command, body = []) {
    return [0x00, family & 0xff, command & 0xff, ...body];
  }

  function encodeFrame(payload) {
    if (!payload.length || payload[0] !== 0x00) throw new Error("payload must start with 0x00");
    const bodyLen = payload.length - 1;
    const crc = crc16Ccitt(payload.slice(1));
    return new Uint8Array([
      ...HEAD,
      bodyLen,
      ...payload,
      crc & 0xff,
      (crc >> 8) & 0xff,
      ...TAIL,
    ]);
  }

  function decodeFrame(bytes) {
    // Expects exactly one frame's worth of bytes (BLE notify already
    // delivers discrete packets in practice for this radio).
    if (bytes.length < 7) return null;
    if (bytes[0] !== HEAD[0] || bytes[1] !== HEAD[1]) return null;
    const len = bytes[2];
    const payloadStart = 3;
    const payloadEnd = payloadStart + len + 1;
    if (bytes[payloadEnd] === undefined) return null;
    const payload = bytes.slice(payloadStart, payloadEnd);
    const gotCrc = bytes[payloadEnd] | (bytes[payloadEnd + 1] << 8);
    const expectCrc = crc16Ccitt(payload.slice(1));
    if (gotCrc !== expectCrc) return null;
    return { family: payload[1], command: payload[2], body: payload.slice(3) };
  }

  function selectChannel(channel) {
    if (channel < 1 || channel > 30) throw new Error("channel out of range");
    return buildPayload(0x02, 0x02, [0x0e, 0x01, channel, 0x00]);
  }

  function setVolume(level) {
    return buildPayload(0x02, 0x01, [0x01, level]);
  }

  // -- text messaging (mirrors app/protocol/messages.py) --------------------

  function encodeSender(username) {
    const out = new Array(16).fill(0x20); // ASCII space padding
    const bytes = new TextEncoder().encode((username || "AT2Bridge").slice(0, 16));
    bytes.forEach((b, i) => (out[i] = b));
    return out;
  }

  function buildTextMessageFrames(username, text, msgId) {
    const textBytes = Array.from(new TextEncoder().encode(text));
    const sender = encodeSender(username);
    const msgIdBytes = [
      (msgId >>> 24) & 0xff,
      (msgId >>> 16) & 0xff,
      (msgId >>> 8) & 0xff,
      msgId & 0xff,
    ];

    if (textBytes.length <= 180) {
      const body = [
        0x01, 0x01,
        ...msgIdBytes,
        0x00,
        ...sender,
        textBytes.length & 0xff, (textBytes.length >> 8) & 0xff,
        0x01, 0x00,
        ...textBytes,
      ];
      return [encodeFrame(buildPayload(0x02, 0x04, body))];
    }

    const chunkSize = 131;
    const parts = [];
    for (let i = 0; i < textBytes.length; i += chunkSize) parts.push(textBytes.slice(i, i + chunkSize));
    const streamLen = parts.reduce((acc, p) => acc + p.length + 1, 0);
    const startBody = [
      0x01, 0x01,
      ...msgIdBytes,
      0x00,
      ...sender,
      streamLen & 0xff, (streamLen >> 8) & 0xff,
      parts.length & 0xff, 0x00,
    ];
    const frames = [encodeFrame(buildPayload(0x02, 0x04, startBody))];
    parts.forEach((part, index) => {
      const chunkBody = [0x01, 0x02, ...msgIdBytes, (index >> 8) & 0xff, index & 0xff, 0x00, ...part];
      frames.push(encodeFrame(buildPayload(0x02, 0x04, chunkBody)));
    });
    return frames;
  }

  // ---------------------------------------------------------------------
  // "CPS-style" frame dialect -- confirmed on real hardware 27-28/08/2026
  // for per-channel read/write (opcode 0x11 read / 0x12 write). See
  // app/protocol/frame.py::encode_cps_frame for the authoritative Python
  // implementation and the hardware test log this was derived from.
  // Differs from the frame above: 2-byte little-endian length field, and
  // NO leading 0x00 byte before the payload's first real byte.
  // ---------------------------------------------------------------------

  function encodeCpsFrame(payload) {
    if (!payload.length) throw new Error("payload must not be empty");
    const crc = crc16Ccitt(payload);
    const len = payload.length;
    return new Uint8Array([
      ...HEAD,
      len & 0xff, (len >> 8) & 0xff,
      ...payload,
      crc & 0xff, (crc >> 8) & 0xff,
      ...TAIL,
    ]);
  }

  function decodeCpsFrame(bytes) {
    if (bytes.length < 8) return null;
    if (bytes[0] !== HEAD[0] || bytes[1] !== HEAD[1]) return null;
    const len = bytes[2] | (bytes[3] << 8);
    const payloadStart = 4;
    const payloadEnd = payloadStart + len;
    if (bytes[payloadEnd + 1] === undefined) return null;
    const payload = bytes.slice(payloadStart, payloadEnd);
    const gotCrc = bytes[payloadEnd] | (bytes[payloadEnd + 1] << 8);
    if (crc16Ccitt(payload) !== gotCrc) return null;
    return { opcode: payload[0], group: payload[1], param: payload[2], body: payload.slice(3) };
  }

  // -- channel read/write (mirrors app/protocol/channel.py) -----------------

  const CTCSS_VALUES = [
    "67.0", "69.3", "71.9", "74.4", "77.0", "79.7", "82.5", "85.4", "88.5", "91.5",
    "94.8", "97.4", "100.0", "103.5", "107.2", "110.9", "114.8", "118.8", "123.0", "127.3",
    "131.8", "136.5", "141.3", "146.2", "150.0", "151.4", "156.7", "159.8", "162.2", "165.5",
    "167.9", "171.3", "173.8", "177.3", "179.9", "183.5", "186.2", "189.9", "192.8", "196.6",
    "199.5", "203.5", "206.5", "210.7", "218.1", "225.7", "229.1", "233.6", "241.8", "250.3",
    "254.1",
  ];

  const DCS_VALUES = [
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
  ];

  function toneLabel(value, type, polarity) {
    if (value === 0x7f && type === 0x00) return "OFF";
    if (type === 0x00) return value < CTCSS_VALUES.length ? `${CTCSS_VALUES[value]}Hz` : "OFF";
    if (type === 0x01) return value < DCS_VALUES.length ? DCS_VALUES[value] + (polarity === 0x01 ? "I" : "N") : "OFF";
    return "OFF";
  }

  function parseToneLabel(label) {
    const text = (label || "").trim().toUpperCase();
    if (text === "OFF") return [0x7f, 0x00, 0x00];
    if (text.endsWith("N") || text.endsWith("I")) {
      const base = text.slice(0, -1);
      const idx = DCS_VALUES.indexOf(base);
      if (idx !== -1) return [idx, 0x01, text.endsWith("I") ? 0x01 : 0x00];
    }
    const normalized = text.endsWith("HZ") ? text.slice(0, -2) : text;
    const idx = CTCSS_VALUES.indexOf(normalized);
    if (idx !== -1) return [idx, 0x00, 0x00];
    throw new Error(`unrecognized tone label: ${label}`);
  }

  function encodeFreq(mhz) {
    if (mhz === null || mhz === undefined) return [0, 0, 0, 0];
    const raw = Math.round(mhz * 100000);
    return [raw & 0xff, (raw >> 8) & 0xff, (raw >> 16) & 0xff, (raw >>> 24) & 0xff];
  }

  function decodeFreq(bytes) {
    const raw = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    if (raw === 0) return null;
    return Math.round((raw / 100000) * 1e5) / 1e5;
  }

  function buildChannelReadRequest(channel) {
    if (channel < 1 || channel > 30) throw new Error("channel out of range");
    return [0x11, 0x02, 0x02, 0x00, channel & 0xff, (channel >> 8) & 0xff];
  }

  function buildChannelWriteFields(config) {
    const [rxVal, rxType, rxPol] = parseToneLabel(config.rx_tone);
    const [txVal, txType, txPol] = parseToneLabel(config.tx_tone);
    return [
      config.channel & 0xff, (config.channel >> 8) & 0xff,
      ...encodeFreq(config.rx_mhz),
      ...encodeFreq(config.tx_mhz),
      rxVal & 0xff, rxType & 0xff, txVal & 0xff, txType & 0xff, rxPol & 0xff, txPol & 0xff,
      config.busy_lock ? 0x00 : 0x01,
      config.bandwidth_narrow ? 0x01 : 0x00,
      config.high_power ? 0x01 : 0x00,
      config.scan_add ? 0x00 : 0x01,
      config.hop_on ? 0x01 : 0x00,
      config.mode_digital ? 0x01 : 0x00,
      config.encrypt_key & 0xff,
    ];
  }

  function buildChannelWriteRequest(config) {
    return [0x12, 0x02, 0x02, 0x00, ...buildChannelWriteFields(config)];
  }

  function decodeChannelReadResponse(body) {
    if (body.length !== 25) throw new Error(`expected a 25-byte channel read body, got ${body.length}`);
    const channel = body[2] | (body[3] << 8);
    return {
      channel,
      rx_mhz: decodeFreq(body.slice(4, 8)),
      tx_mhz: decodeFreq(body.slice(8, 12)),
      rx_tone: toneLabel(body[12], body[13], body[16]),
      tx_tone: toneLabel(body[14], body[15], body[17]),
      busy_lock: body[18] === 0x00,
      bandwidth_narrow: body[19] === 0x01,
      high_power: body[20] === 0x01,
      scan_add: body[21] === 0x00,
      hop_on: body[22] === 0x01,
      mode_digital: body[23] === 0x01,
      encrypt_key: body[24],
    };
  }

  // -- live PTT voice packets (mirrors app/protocol/ptt.py) -----------------

  const PTT_FAMILY = 0x02;
  const PTT_CMD = 0x04;
  const PTT_VOICE_SUBTYPE = [0x03, 0x00, 0x00];
  const PTT_KEY_SUBTYPE = 0x02;
  const OFFLINE_SESSION_SUBTYPE = 0x07;
  const PTT_FRAMES_PER_PACKET = 5;
  const PTT_TAIL_MIN_FRAMES = 4;
  const PTT_PACKET_PACING_MS = 100;

  // Key the radio's transmitter on/off, ported from
  // At2ProtocolExecutor.kt::setOfflineMode(ptt=...) (reference Android
  // app). MUST be sent before the first voice packet of a transmission
  // and again after the last one -- without it the radio's receiver is
  // never told to enter PTT/offline-comm mode and silently discards
  // voice packets, even though they're correctly built/paced/sent.
  function buildPttKeyPayload(pttOn) {
    return buildPayload(PTT_FAMILY, PTT_CMD, [PTT_KEY_SUBTYPE, pttOn ? 0x01 : 0x00]);
  }

  // Enable/disable the radio's offline comm (chat/PTT) session, ported
  // from At2ProtocolExecutor.kt::setOfflineSession() / enterPttPreflight().
  function buildOfflineSessionPayload(enabled) {
    return buildPayload(PTT_FAMILY, PTT_CMD, [OFFLINE_SESSION_SUBTYPE, enabled ? 0x01 : 0x00]);
  }

  function buildPttVoicePayload(amrFrames) {
    if (amrFrames.length < PTT_TAIL_MIN_FRAMES || amrFrames.length > PTT_FRAMES_PER_PACKET) {
      throw new Error(`expected ${PTT_TAIL_MIN_FRAMES}-${PTT_FRAMES_PER_PACKET} AMR frames, got ${amrFrames.length}`);
    }
    const data = [];
    for (const f of amrFrames) {
      if (f.length !== 12) throw new Error("each AMR frame must be 12 bytes");
      data.push(...f);
    }
    return buildPayload(PTT_FAMILY, PTT_CMD, [...PTT_VOICE_SUBTYPE, ...data]);
  }

  function isPttVoicePacket(pkt) {
    return pkt.family === PTT_FAMILY && pkt.command === PTT_CMD
      && pkt.body[0] === PTT_VOICE_SUBTYPE[0] && pkt.body[1] === PTT_VOICE_SUBTYPE[1] && pkt.body[2] === PTT_VOICE_SUBTYPE[2];
  }

  function extractAmrFrames(body) {
    const data = body.slice(3);
    const frames = [];
    for (let i = 0; i + 12 <= data.length; i += 12) frames.push(data.slice(i, i + 12));
    return frames;
  }

  return { crc16Ccitt, buildPayload, encodeFrame, decodeFrame, selectChannel, setVolume, buildTextMessageFrames,
    encodeCpsFrame, decodeCpsFrame, buildChannelReadRequest, buildChannelWriteRequest, decodeChannelReadResponse,
    buildPttVoicePayload, isPttVoicePacket, extractAmrFrames,
    PTT_FRAMES_PER_PACKET, PTT_TAIL_MIN_FRAMES, PTT_PACKET_PACING_MS };
})();
