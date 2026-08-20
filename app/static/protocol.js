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
    return buildPayload(0x02, 0x0e, [0x01, channel, 0x00]);
  }

  function setVolume(level) {
    return buildPayload(0x02, 0x01, [level]);
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

  return { crc16Ccitt, buildPayload, encodeFrame, decodeFrame, selectChannel, setVolume, buildTextMessageFrames };
})();
