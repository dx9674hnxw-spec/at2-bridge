/* Direct browser <-> radio connection via the Web Bluetooth API.
 * Compatible Chrome/Edge desktop + Android only.
 * Web Bluetooth is not supported by iOS browsers.
 *
 * Local mode scope:
 * - Connection + notifications
 * - Channel selection
 * - Volume
 * - Offline messaging, both sending and receiving, all three types
 *   (text/voice/image) -- see sendText()/sendVoice()/sendImage() and
 *   onMessageReceived() below
 * - Channel read/write (CPS dialect)
 * - Live PTT (client-side AMR encode/decode -- see startPtt() below;
 *   PTT is confirmed BLE-only, there is no server-side radio path for it
 *   at all -- see README's "PTT in local BLE mode" section).
 *
 * Full codeplug operations (bulk read/write of all 30 channels) remain
 * out of scope here (and unsupported by the radio in general -- see
 * README's "Confirmed not working" section).
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

  // -- incoming offline messages (text/voice/image) --------------------------
  // Previously local BLE mode never decoded these at all -- every incoming
  // packet was just logged as raw family/command hex. Reassembly now runs
  // via the same MessageAssembler used to validate this port against the
  // server-side (Python) implementation -- see static/protocol.js.
  let messageAssembler = new AT2Protocol.MessageAssembler();
  let messageRxListeners = [];

  function onMessageReceived(cb) {
    messageRxListeners.push(cb);
    return () => {
      messageRxListeners = messageRxListeners.filter((listener) => listener !== cb);
    };
  }

  // Always-on (not tied to a particular connection's lifetime, same as
  // the debug packetListeners above): AT2Protocol.decodeMessage() already
  // rejects anything that isn't an offline-message start/chunk frame
  // (PTT voice/key/session all have a different first body byte, acks
  // are a different family), so no extra filtering is needed here.
  onPacket((pkt) => {
    const completed = messageAssembler.feed(pkt);
    if (completed) messageRxListeners.forEach((cb) => cb(completed));
  });

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

    // Fresh reassembly state per connection -- a stale pending chunk from
    // a previous session/device should never bleed into this one.
    messageAssembler = new AT2Protocol.MessageAssembler();

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

  // Send each frame of a multi-frame message and wait for the radio's
  // ack before sending the next one, retrying a dropped frame instead
  // of the old fixed-delay fire-and-forget (which never noticed a
  // dropped frame at all) -- mirrors app/device.py's
  // _send_message_frames_with_ack(), itself ported from
  // At2ProtocolExecutor.kt::sendOfflineBusinessFrameWithAck.
  const MESSAGE_ACK_TIMEOUT_MS = 1500;
  const MESSAGE_ACK_RETRIES = 3;
  const MESSAGE_ACK_RETRY_BACKOFF_MS = 220;

  async function sendFramesWithAck(frames, tag) {
    for (let index = 0; index < frames.length; index++) {
      const f = frames[index];
      let acked = false;
      for (let attempt = 1; attempt <= MESSAGE_ACK_RETRIES && !acked; attempt++) {
        const waitPromise = waitForPacket(AT2Protocol.isMessageAck, MESSAGE_ACK_TIMEOUT_MS);
        await sendFrame(f);
        acked = !!(await waitPromise);
        if (!acked && attempt < MESSAGE_ACK_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, MESSAGE_ACK_RETRY_BACKOFF_MS));
        }
      }
      if (!acked) {
        throw new Error(
          `${tag}: pas d'accusé de réception de la radio pour la trame ${index + 1}/${frames.length} ` +
          `après ${MESSAGE_ACK_RETRIES} tentatives`
        );
      }
    }
  }

  async function sendText(username, text) {
    // msgId is only actually consumed once the build below succeeds (see
    // sendVoice/sendImage for why: buildXxxFrames() can throw -- e.g. "too
    // large to fragment" -- and nextMsgId++ as a call argument would have
    // burned an id even on a build that never sent anything).
    const frames = AT2Protocol.buildTextMessageFrames(username, text, nextMsgId);
    nextMsgId++;

    await sendFramesWithAck(frames, "Message texte");
  }

  // Store-and-forward voice message (distinct from live PTT streaming --
  // see startPtt() below). `pcm`: Int16Array, 16-bit mono @ 8kHz (same
  // format PttAudio.startCapture produces). AMR-NB encoding happens here,
  // client-side, via the same codec used for live PTT (ptt-amr-codec.js)
  // -- mirrors app/device.py::send_voice_message, which does the
  // equivalent encoding server-side with AmrNbCodec. Previously this was
  // server-mode only for exactly this reason: no AMR encoder ran in the
  // browser until PTT needed one.
  async function sendVoice(username, pcm, durationMs) {
    if (typeof PttAmr === "undefined") {
      throw new Error("ptt-amr-codec.js (and amrnb.js) must be loaded to send voice in local BLE mode");
    }
    const codec = new PttAmr.Codec();
    const encodedChunks = [];
    try {
      const frameSamples = PttAmr.FRAME_SAMPLES; // 160 (20ms @ 8kHz)
      for (let i = 0; i + frameSamples <= pcm.length; i += frameSamples) {
        const encoded = codec.encode(pcm.subarray(i, i + frameSamples));
        if (encoded) encodedChunks.push(encoded);
      }
    } finally {
      codec.close();
    }
    if (encodedChunks.length === 0) {
      throw new Error("aucun audio encodé (enregistrement trop court ?)");
    }
    const encodedVoice = new Uint8Array(encodedChunks.length * PttAmr.ENCODED_FRAME_BYTES);
    encodedChunks.forEach((chunk, i) => encodedVoice.set(chunk, i * PttAmr.ENCODED_FRAME_BYTES));

    const frames = AT2Protocol.buildVoiceMessageFrames(username, encodedVoice, durationMs, nextMsgId);
    nextMsgId++;
    await sendFramesWithAck(frames, "Message vocal");
  }

  // `jpegBytes`: already resized/compressed by the caller (app.js does
  // this with a <canvas>, matching the server's Pillow resize target --
  // see app/protocol/messages.py::IMAGE_LONG_EDGE_PX/IMAGE_JPEG_QUALITY)
  // -- mirrors app/device.py::send_image_message, which likewise expects
  // pre-resized bytes from its caller (the upload endpoint, resizing with
  // Pillow) rather than resizing itself.
  async function sendImage(username, jpegBytes, width, height) {
    const frames = AT2Protocol.buildImageMessageFrames(username, jpegBytes, width, height, nextMsgId);
    nextMsgId++;
    await sendFramesWithAck(frames, "Image");
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

  async function startPtt(onRxPcm, onLog) {
    const log = onLog || (() => {});
    if (typeof PttAmr === "undefined") {
      throw new Error("ptt-amr-codec.js (and amrnb.js) must be loaded for live PTT");
    }

    // Key the radio's transmitter on *before* touching the mic/codec at
    // all -- ported from At2ProtocolExecutor.kt::setOfflineMode(ptt=true)
    // / enterPttPreflight() in the reference Android app. This command
    // was entirely missing here before: voice packets were correctly
    // built, paced and sent, but the radio was never told to enter
    // PTT/offline-comm mode and silently discarded them -- a very
    // plausible explanation for "live PTT sends but the radio does
    // nothing".
    await sendFrame(AT2Protocol.encodeFrame(AT2Protocol.buildOfflineSessionPayload(true)));
    await sendFrame(AT2Protocol.encodeFrame(AT2Protocol.buildPttKeyPayload(true)));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the radio key up, mirrors the reference app's 20ms guard

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

    log("PTT BLE: clé radio activée, session démarrée (attente de frames audio du navigateur)");

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

    // feedPcmFrame() is called fire-and-forget from app.js (the audio
    // callback isn't async), so several calls can be "in flight" at once.
    // Chaining them through `opChain` guarantees true sequential
    // processing and, critically, lets close() await the ENTIRE chain
    // before flushing the tail/logging the summary -- without this, a
    // short PTT press could release the button right as a threshold-
    // triggered flush() (with its pacing delay + BLE write) was still in
    // progress, and close() would log "0 packets sent" despite one being
    // about to complete a moment later. Confirmed as a real bug on real
    // hardware 29/08/2026 (short presses undercounted; longer ones didn't,
    // simply because they left more slack time before release).
    let opChain = Promise.resolve();

    function feedPcmFrame(pcm) {
      opChain = opChain.then(async () => {
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
      });
      return opChain;
    }

    return {
      /** pcm: Int16Array of exactly 160 samples (20ms @ 8kHz mono). */
      feedPcmFrame,
      async close() {
        await opChain.catch(() => {}); // wait for every already-queued frame first
        if (pending.length >= AT2Protocol.PTT_TAIL_MIN_FRAMES) {
          await flush(pending.length);
        }
        rxUnsubscribe();
        codec.close();
        try {
          await sendFrame(AT2Protocol.encodeFrame(AT2Protocol.buildPttKeyPayload(false)));
        } catch (e) {
          log(`PTT BLE: ⚠️ échec d'envoi de la commande de relâchement PTT: ${e.message}`);
        }
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
    sendVoice,
    sendImage,
    readChannel,
    readAllChannels,
    writeChannel,
    startPtt,
    onPacket,
    onMessageReceived
  };
})();
