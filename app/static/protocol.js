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

  // True for the radio's acknowledgment of an offline-message frame
  // (text/voice/image start or chunk) -- mirrors
  // app/protocol/messages.py::is_message_ack(). Used to send each frame
  // of a multi-frame message and wait for this ack before sending the
  // next one (with retry), instead of the old fixed-delay
  // fire-and-forget approach that never noticed a dropped frame.
  function isMessageAck(pkt) {
    return pkt.family === 0x82 && pkt.command === 0x04
      && pkt.body.length >= 2 && pkt.body[0] === 0x01 && pkt.body[1] === 0x00;
  }

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

  // -- incoming offline messages: decode + reassembly ------------------------
  //
  // Full JS port of app/protocol/messages.py's decode()/MessageAssembler --
  // see that module for the detailed rationale of every quirk/fix here
  // (the offset-8-vs-9 chunk divergence from the reference decoder, the
  // declared-length unit correction for fragmented text, trimming to the
  // declared length, and orphan-chunk recovery). Needed so local BLE mode
  // can decode incoming text/voice/image messages at all -- previously
  // only server mode (Python) did this; local BLE just logged the raw
  // family/command of every incoming packet and threw the rest away.

  const MSG_TYPE_TEXT_START = 0x01;
  const MSG_TYPE_TEXT_CHUNK = 0x02;
  const MSG_TYPE_VOICE_START = 0x03;
  const MSG_TYPE_VOICE_CHUNK = 0x04;
  const MSG_TYPE_IMAGE_START = 0x05;
  const MSG_TYPE_IMAGE_CHUNK = 0x06;
  const MSG_DEFAULT_USERNAME = "AT2Bridge";
  const MSG_FRAGMENT_TEXT_CHUNK_BYTES = 131;
  const MSG_VOICE_CHUNK_BYTES = 132;
  const MSG_IMAGE_CHUNK_BYTES = 132;

  function decodeSender(bytes) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (e) {
      text = "";
    }
    text = text.replace(/^[\s\x00]+/, "").replace(/[\s\x00]+$/, "");
    return text || MSG_DEFAULT_USERNAME;
  }

  function readMsgId(p, start) {
    return ((p[start] << 24) | (p[start + 1] << 16) | (p[start + 2] << 8) | p[start + 3]) >>> 0;
  }
  function readBe16(p, start) { return (p[start] << 8) | p[start + 1]; }
  function readLe16(p, start) { return p[start] | (p[start + 1] << 8); }

  function decodeChunkFrame(msgType, p) {
    if (p.length < 9) return null;
    return { kind: "chunk", type: msgType, msgId: readMsgId(p, 2), seq: readBe16(p, 6), data: p.slice(9) };
  }

  function decodeTextOrVoiceStart(msgType, p) {
    if (p.length < 26) return null;
    const inlineData = p.length > 26 ? p.slice(26) : new Uint8Array(0);
    return {
      kind: "start", type: msgType, msgId: readMsgId(p, 2), sender: decodeSender(p.slice(7, 23)),
      declaredLength: readLe16(p, 23), totalParts: p[25], inlineData, durationMs: null,
    };
  }

  function decodeVoiceStart(p) {
    if (p.length < 29) return null;
    const durationSeconds = Math.max(1, readLe16(p, 27));
    return {
      kind: "start", type: MSG_TYPE_VOICE_START, msgId: readMsgId(p, 2), sender: decodeSender(p.slice(7, 23)),
      declaredLength: readLe16(p, 23), totalParts: readLe16(p, 25), inlineData: new Uint8Array(0),
      durationMs: durationSeconds * 1000,
    };
  }

  function decodeImageStart(p) {
    if (p.length < 31) return null;
    return {
      kind: "start", type: MSG_TYPE_IMAGE_START, msgId: readMsgId(p, 2), sender: decodeSender(p.slice(7, 23)),
      declaredLength: readLe16(p, 23), totalParts: p[25], inlineData: p.slice(27), durationMs: null,
    };
  }

  function decodeMessage(pkt) {
    if (pkt.family !== 0x02 || pkt.command !== 0x04) return null;
    const p = pkt.body;
    if (p.length < 2 || p[0] !== 0x01) return null;
    const msgType = p[1];
    if (msgType === MSG_TYPE_IMAGE_START) return decodeImageStart(p);
    if (msgType === MSG_TYPE_VOICE_START) return decodeVoiceStart(p);
    if (msgType === MSG_TYPE_TEXT_START) return decodeTextOrVoiceStart(msgType, p);
    if (msgType === MSG_TYPE_TEXT_CHUNK || msgType === MSG_TYPE_VOICE_CHUNK || msgType === MSG_TYPE_IMAGE_CHUNK) {
      return decodeChunkFrame(msgType, p);
    }
    return null;
  }

  const MSG_FULL_CHUNK_BYTES = {
    [MSG_TYPE_TEXT_CHUNK]: MSG_FRAGMENT_TEXT_CHUNK_BYTES,
    [MSG_TYPE_VOICE_CHUNK]: MSG_VOICE_CHUNK_BYTES,
    [MSG_TYPE_IMAGE_CHUNK]: MSG_IMAGE_CHUNK_BYTES,
  };
  const MSG_CHUNK_KIND = {
    [MSG_TYPE_TEXT_CHUNK]: "text",
    [MSG_TYPE_VOICE_CHUNK]: "voice",
    [MSG_TYPE_IMAGE_CHUNK]: "image",
  };

  function concatUint8(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  function trimToDeclared(data, declaredLength) {
    if (!declaredLength || declaredLength <= 0 || data.length === 0) return data;
    return data.slice(0, declaredLength);
  }

  class MessageAssembler {
    constructor() {
      this._pending = new Map(); // msgId -> entry
    }

    /** `pkt`: {family, command, body} as produced by decodeFrame(). Returns
     * a completed {kind, sender, msgId, text?|data?, durationMs?, width?,
     * height?} once every part of a message has arrived, else null. */
    feed(pkt) {
      const parsed = decodeMessage(pkt);
      if (parsed === null) return null;
      return parsed.kind === "start" ? this._onStart(parsed) : this._onChunk(parsed);
    }

    _onStart(f) {
      if (f.type === MSG_TYPE_TEXT_START) {
        if (f.totalParts <= 1) {
          const data = (f.inlineData.length > 0 && f.inlineData[0] === 0x00) ? f.inlineData.slice(1) : f.inlineData;
          const text = new TextDecoder("utf-8", { fatal: false }).decode(trimToDeclared(data, f.declaredLength));
          return { kind: "text", sender: f.sender, msgId: f.msgId, text };
        }
        // See app/protocol/messages.py::_on_start for why total_parts is
        // subtracted here (declared_length bakes in one pad byte per chunk
        // that this decoder's chunk offset -- offset 9, not 8 -- excludes).
        const declaredLength = f.declaredLength ? f.declaredLength - f.totalParts : f.declaredLength;
        this._pending.set(f.msgId, { kind: "text", sender: f.sender, total: f.totalParts, declaredLength, chunks: new Map() });
        return null;
      }
      if (f.type === MSG_TYPE_VOICE_START) {
        this._pending.set(f.msgId, {
          kind: "voice", sender: f.sender, total: f.totalParts, declaredLength: f.declaredLength,
          chunks: new Map(), durationMs: f.durationMs,
        });
        return null;
      }
      if (f.type === MSG_TYPE_IMAGE_START) {
        const width = f.inlineData.length >= 2 ? readLe16(f.inlineData, 0) : null;
        const height = f.inlineData.length >= 4 ? readLe16(f.inlineData, 2) : null;
        this._pending.set(f.msgId, {
          kind: "image", sender: f.sender, total: f.totalParts, declaredLength: f.declaredLength,
          chunks: new Map(), width, height,
        });
        return null;
      }
      return null;
    }

    _onChunk(c) {
      let entry = this._pending.get(c.msgId);
      if (!entry) {
        // Chunk for a start frame we never saw -- track it under a
        // synthetic entry and fall back to a "contiguous from 0, last one
        // shorter than a full chunk" heuristic below, instead of losing
        // it forever.
        const kind = MSG_CHUNK_KIND[c.type];
        if (!kind) return null;
        entry = { kind, sender: null, total: null, declaredLength: null, chunks: new Map() };
        this._pending.set(c.msgId, entry);
      }
      entry.chunks.set(c.seq, c.data);

      const keys = Array.from(entry.chunks.keys()).sort((a, b) => a - b);
      if (entry.total !== null) {
        // Strict: exactly the expected contiguous set 0..total-1, not
        // just "enough chunks" -- guards against a duplicate/out-of-range
        // seq silently reassembling the wrong bytes.
        if (keys.length !== entry.total || !keys.every((k, i) => k === i)) return null;
      } else {
        if (!keys.every((k, i) => k === i)) return null; // not contiguous from 0 yet
        const fullSize = MSG_FULL_CHUNK_BYTES[c.type];
        const lastSize = entry.chunks.get(keys[keys.length - 1]).length;
        if (!fullSize || !(lastSize > 0 && lastSize < fullSize)) return null;
      }

      const ordered = trimToDeclared(concatUint8(keys.map((k) => entry.chunks.get(k))), entry.declaredLength);
      this._pending.delete(c.msgId);
      const sender = entry.sender || MSG_DEFAULT_USERNAME;

      if (entry.kind === "text") {
        return { kind: "text", sender, msgId: c.msgId, text: new TextDecoder("utf-8", { fatal: false }).decode(ordered) };
      }
      if (entry.kind === "voice") {
        return { kind: "voice", sender, msgId: c.msgId, data: ordered, durationMs: entry.durationMs || null };
      }
      if (entry.kind === "image") {
        return { kind: "image", sender, msgId: c.msgId, data: ordered, width: entry.width || null, height: entry.height || null };
      }
      return null;
    }
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
    isMessageAck, MessageAssembler, encodeCpsFrame, decodeCpsFrame, buildChannelReadRequest, buildChannelWriteRequest, decodeChannelReadResponse,
    buildPttKeyPayload, buildOfflineSessionPayload, buildPttVoicePayload, isPttVoicePacket, extractAmrFrames,
    PTT_FRAMES_PER_PACKET, PTT_TAIL_MIN_FRAMES, PTT_PACKET_PACING_MS };
})();
