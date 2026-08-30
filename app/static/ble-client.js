/* Direct browser <-> radio connection via the Web Bluetooth API.
 * Compatible Chrome/Edge desktop + Android only.
 * Web Bluetooth is not supported by iOS browsers.
 *
 * Local mode scope:
 * - Connection + notifications
 * - Channel selection
 * - Volume
 * - Offline text messaging
 *
 * Full codeplug operations and live PTT remain server mode only.
 */
const AT2BleClient = (() => {
  const SERVICE_UUID = "0000ae60-0000-1000-8000-00805f9b34fb";
  const TX_CHAR_UUID = "0000ae10-0000-1000-8000-00805f9b34fb";
  const RX_CHAR_UUID = "0000ae05-0000-1000-8000-00805f9b34fb";

  const DEVICE_NAME_PREFIX = "AT2_";

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

    return () => {
      packetListeners = packetListeners.filter((listener) => listener !== cb);
    };
  }

  function handleNotify(event) {
    const value = event.target.value;

    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );

    const pkt = AT2Protocol.decodeFrame(bytes);

    if (pkt) {
      packetListeners.forEach((cb) => cb(pkt));
    }
  }

  function handleDisconnected() {
    device = null;
    txChar = null;
    rxChar = null;
  }

  async function connect() {
    if (!isSupported()) {
      throw new Error(
        "Web Bluetooth non disponible sur ce navigateur/appareil. " +
        "Utilise Chrome ou Edge sur Windows, Linux ou Android."
      );
    }

    device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: DEVICE_NAME_PREFIX }
      ],
      optionalServices: [
        SERVICE_UUID
      ]
    });

    device.addEventListener("gattserverdisconnected", handleDisconnected);

    const server = await device.gatt.connect();

    const service = await server.getPrimaryService(SERVICE_UUID);

    txChar = await service.getCharacteristic(TX_CHAR_UUID);
    rxChar = await service.getCharacteristic(RX_CHAR_UUID);

    await rxChar.startNotifications();
    rxChar.addEventListener(
      "characteristicvaluechanged",
      handleNotify
    );

    return {
      name: device.name || "(sans nom)",
      id: device.id
    };
  }

  async function disconnect() {
    if (rxChar) {
      try {
        rxChar.removeEventListener(
          "characteristicvaluechanged",
          handleNotify
        );

        await rxChar.stopNotifications();
      } catch (_) {
        // Une déconnexion radio peut survenir avant l'arrêt des notifications.
      }
    }

    if (device) {
      device.removeEventListener(
        "gattserverdisconnected",
        handleDisconnected
      );

      if (device.gatt && device.gatt.connected) {
        device.gatt.disconnect();
      }
    }

    device = null;
    txChar = null;
    rxChar = null;
  }

  function connected() {
    return !!(
      device &&
      device.gatt &&
      device.gatt.connected &&
      txChar &&
      rxChar
    );
  }

  async function sendFrame(frame) {
    if (!txChar || !connected()) {
      throw new Error("Radio AT2 non connectée.");
    }

    const data = frame instanceof Uint8Array ? frame : new Uint8Array(frame);

    if (typeof txChar.writeValueWithResponse === "function") {
      await txChar.writeValueWithResponse(data);
    } else {
      await txChar.writeValue(data);
    }
  }

  async function selectChannel(channel) {
    const payload = AT2Protocol.selectChannel(channel);
    const frame = AT2Protocol.encodeFrame(payload);

    await sendFrame(frame);
  }

  async function setVolume(level) {
    const payload = AT2Protocol.setVolume(level);
    const frame = AT2Protocol.encodeFrame(payload);

    await sendFrame(frame);
  }

  async function sendText(username, text) {
    const frames = AT2Protocol.buildTextMessageFrames(
      username,
      text,
      nextMsgId++
    );

    for (const frame of frames) {
      await sendFrame(frame);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return {
    isSupported,
    connect,
    disconnect,
    connected,
    selectChannel,
    setVolume,
    sendText,
    onPacket
  };
})();
