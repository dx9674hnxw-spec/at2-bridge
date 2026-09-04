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

  // Web Bluetooth allows only ONE GATT operation in flight at a time on
  // a given connection -- calling writeValue again before the previous
  // write's promise resolves throws "GATT operation already in
  // progress". PTT can produce several 20ms frames per audio callback
  // (see ptt-audio.js), so without serializing here, concurrent sends
  // were a real, reproducible failure (confirmed on real hardware
  // 28/08/2026). This queue makes ALL sendFrame() calls -- from any
  // feature, not just PTT -- safely sequential.
  let sendQueue = Promise.resolve();

  function queuedWrite(data) {
    const next = sendQueue.then(async () => {
      if (typeof txChar.writeValueWithResponse === "function") {
        await txChar.writeValueWithResponse(data);
      } else {
        await txChar.writeValue(data);
      }
    });
    // Swallow the error here so one failed write doesn't permanently
    // wedge the queue for subsequent, unrelated sends -- the caller
    // still sees the rejection via the returned promise below.
    sendQueue = next.catch(() => {});
    return next;
  }

  async function sendFrame(frame) {
    if (!txChar || !connected()) {
      throw new Error("Radio AT2 non connectée.");
    }

    const data = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    await queuedWrite(data);
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

  // -- channel read/write (CPS-style dialect, confirmed on real hardware
  // 27-28/08/2026 -- see app/protocol/channel.py and static/protocol.js).
  // Incoming BLE notifications are already decoded by the "legacy" frame
  // decoder in handleNotify()/AT2Protocol.decodeFrame(); for payloads in
  // our size range this coincidentally (but reliably, verified against
  // real hardware) produces a packet whose `body` is exactly the 25-byte
  // shape decodeChannelReadResponse() expects -- no separate CPS-frame
  // receive path is needed, only a distinct SEND encoding.

  function waitForPacket(predicate, timeoutMs = 1000) {
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribe = onPacket((pkt) => {
        if (settled || !predicate(pkt)) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(pkt);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(null);
      }, timeoutMs);
    });
  }

  async function readChannel(channel, timeoutMs = 500) {
    const request = AT2Protocol.buildChannelReadRequest(channel);
    const frame = AT2Protocol.encodeCpsFrame(request);
    const waitPromise = waitForPacket((p) => p.family === 0x91 && p.command === 0x02, timeoutMs);
    await sendFrame(frame);
    const pkt = await waitPromise;
    if (!pkt) return null; // empty/unconfigured channel slot -- not an error
    return AT2Protocol.decodeChannelReadResponse(pkt.body);
  }

  async function readAllChannels() {
    const results = [];
    for (let channel = 1; channel <= 30; channel++) {
      const config = await readChannel(channel);
      if (config) results.push(config);
    }
    return results;
  }

  async function writeChannel(config) {
    // NOTE: write ACKs from the radio do not confirm the write actually
    // persisted -- see CONSIGNES_PROJET.md "accusé de réception ≠
    // confirmation fonctionnelle". Same caveat as the server-mode path.
    const request = AT2Protocol.buildChannelWriteRequest(config);
    const frame = AT2Protocol.encodeCpsFrame(request);
    await sendFrame(frame);
  }

  // -- live PTT (client-side AMR encode/decode, since PTT is confirmed
  // BLE-only -- see CONSIGNES_PROJET.md "Live PTT limité au Bluetooth").
  // Mirrors app/device.py's PttSession exactly (same pacing/chunking
  // constants, from AT2Protocol.PTT_*), except encode/decode both
  // happen in the browser via ptt-amr-codec.js instead of server-side.

  function startPtt(onRxPcm, onLog) {
    const log = onLog || (() => {});
    if (typeof PttAmr === "undefined") {
      throw new Error("ptt-amr-codec.js (and amrnb.js) must be loaded for live PTT");
    }
    const codec = new PttAmr.Codec();
    let pending = [];
    let lastSend = 0;

    // Per-stage counters -- mirrors app/device.py's PttSession instrumentation
    // (28/08/2026), added here too since a silent encode() failure (codec
    // always returning null) would otherwise produce zero TX frames with
    // NO error, NO log line, and NO visible symptom anywhere -- exactly
    // matching a real "PTT does nothing" report. This makes that failure
    // mode impossible to miss on the next test.
    let pcmFramesReceived = 0;
    let encodeFailures = 0;
    let amrFramesEncoded = 0;
    let packetsSent = 0;
    let amrFramesSent = 0;
    let loggedFirstFailure = false;

    log("PTT BLE: session démarrée (attente de frames audio du navigateur)");

    const rxUnsubscribe = onPacket((pkt) => {
      if (!AT2Protocol.isPttVoicePacket(pkt)) return;
      for (const amrFrame of AT2Protocol.extractAmrFrames(pkt.body)) {
        const pcm = codec.decode(amrFrame);
        if (onRxPcm) onRxPcm(pcm);
      }
    });

    async function flush(count) {
      if (pending.length < count) return;
      const chunk = pending.slice(0, count);
      pending = pending.slice(count);
      const now = performance.now();
      const gap = now - lastSend;
      if (lastSend && gap < AT2Protocol.PTT_PACKET_PACING_MS) {
        await new Promise((resolve) => setTimeout(resolve, AT2Protocol.PTT_PACKET_PACING_MS - gap));
      }
      lastSend = performance.now();
      const payload = AT2Protocol.buildPttVoicePayload(chunk);
      const frame = AT2Protocol.encodeFrame(payload);
      await sendFrame(frame);
      packetsSent += 1;
      amrFramesSent += chunk.length;
    }

    return {
      /** pcm: Int16Array of exactly 160 samples (20ms @ 8kHz mono). */
      async feedPcmFrame(pcm) {
        pcmFramesReceived += 1;
        let encoded;
        try {
          encoded = codec.encode(pcm);
        } catch (e) {
          encodeFailures += 1;
          if (!loggedFirstFailure) {
            loggedFirstFailure = true;
            log(`PTT BLE: ⚠️ exception d'encodage AMR sur la frame #${pcmFramesReceived}: ${e.message}`);
          }
          return;
        }
        if (!encoded) {
          encodeFailures += 1;
          if (!loggedFirstFailure) {
            loggedFirstFailure = true;
            log(`PTT BLE: ⚠️ échec d'encodage AMR sur la frame #${pcmFramesReceived} (encoder a renvoyé null, ${pcm.length} échantillons reçus, 160 attendus)`);
          }
          return;
        }
        amrFramesEncoded += 1;
        pending.push(encoded);
        if (pending.length >= AT2Protocol.PTT_FRAMES_PER_PACKET) {
          await flush(AT2Protocol.PTT_FRAMES_PER_PACKET);
        }
      },
      async close() {
        if (pending.length >= AT2Protocol.PTT_TAIL_MIN_FRAMES) {
          await flush(pending.length);
        }
        rxUnsubscribe();
        codec.close();
        log(
          "PTT BLE: transmission terminée — " +
          `${pcmFramesReceived} frame(s) PCM reçue(s) du navigateur, ` +
          `${amrFramesEncoded} encodée(s) en AMR (${encodeFailures} échec(s) d'encodage), ` +
          `${packetsSent} paquet(s) envoyé(s) à la radio (${amrFramesSent} frame(s) AMR au total)`
        );
      },
    };
  }

  return {
    isSupported,
    connect,
    disconnect,
    connected,
    selectChannel,
    setVolume,
    sendText,
    readChannel,
    readAllChannels,
    writeChannel,
    startPtt,
    onPacket
  };
})();
