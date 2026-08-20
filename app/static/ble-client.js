/* Direct browser<->radio connection via the Web Bluetooth API.
 * Only available on Chrome/Edge (desktop + Android). NOT available on
 * ANY iOS browser (Apple disables Web Bluetooth in WebKit, and every
 * iOS browser is required to use WebKit) -- detect and disable
 * gracefully rather than failing confusingly.
 *
 * Scope: connect, read/notify, channel select, volume, text
 * messaging. Full codeplug read/write and live PTT voice stay
 * server-mode-only for now (see README) -- this is a lighter-weight
 * "quick control from your own phone" path, not a full replacement.
 */
const AT2BleClient = (() => {
  const SERVICE_UUID = "0000ae60-0000-1000-8000-00805f9b34fb";
  const TX_CHAR_UUID = "0000ae10-0000-1000-8000-00805f9b34fb";
  const RX_CHAR_UUID = "0000ae05-0000-1000-8000-00805f9b34fb";

  let device = null;
  let txChar = null;
  let rxChar = null;
  let packetListeners = [];
  let nextMsgId = 1;

  function isSupported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  function onPacket(cb) {
    packetListeners.push(cb);
  }

  function handleNotify(event) {
    const value = event.target.value; // DataView
    const bytes = new Uint8Array(value.buffer);
    const pkt = AT2Protocol.decodeFrame(bytes);
    if (pkt) packetListeners.forEach((cb) => cb(pkt));
  }

  async function connect() {
    if (!isSupported()) throw new Error("Web Bluetooth non disponible sur ce navigateur/appareil.");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    txChar = await service.getCharacteristic(TX_CHAR_UUID);
    rxChar = await service.getCharacteristic(RX_CHAR_UUID);
    await rxChar.startNotifications();
    rxChar.addEventListener("characteristicvaluechanged", handleNotify);
    return { name: device.name || "(sans nom)", id: device.id };
  }

  async function disconnect() {
    if (rxChar) {
      try {
        rxChar.removeEventListener("characteristicvaluechanged", handleNotify);
        await rxChar.stopNotifications();
      } catch (_) { /* ignore */ }
    }
    if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    }
    device = null;
    txChar = null;
    rxChar = null;
  }

  function connected() {
    return !!(device && device.gatt && device.gatt.connected);
  }

  async function sendFrame(frame) {
    if (!txChar) throw new Error("not connected");
    await txChar.writeValueWithResponse(frame);
  }

  async function selectChannel(channel) {
    await sendFrame(AT2Protocol.encodeFrame(AT2Protocol.selectChannel(channel)));
  }

  async function setVolume(level) {
    await sendFrame(AT2Protocol.encodeFrame(AT2Protocol.setVolume(level)));
  }

  async function sendText(username, text) {
    const frames = AT2Protocol.buildTextMessageFrames(username, text, nextMsgId++);
    for (const f of frames) {
      await sendFrame(f);
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  return { isSupported, connect, disconnect, connected, selectChannel, setVolume, sendText, onPacket };
})();
