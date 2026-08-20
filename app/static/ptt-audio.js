/* Mic capture -> 8kHz mono 16-bit PCM (320-byte / 20ms frames), and
 * playback of incoming PCM of the same format. Used by app.js to
 * drive /ws/ptt in server mode. Requires getUserMedia (HTTPS or
 * localhost) and a browser with AudioWorklet/ScriptProcessor support.
 */
const PttAudio = (() => {
  let audioCtx = null;
  let micStream = null;
  let sourceNode = null;
  let processorNode = null;
  let onFrame = null; // callback(Int16Array of 160 samples)
  let pcmResidual = new Float32Array(0);

  async function startCapture(frameCallback) {
    onFrame = frameCallback;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    sourceNode = audioCtx.createMediaStreamSource(micStream);

    // ScriptProcessor is deprecated but has universal support (incl.
    // Safari/iOS); AudioWorklet would be the modern replacement.
    processorNode = audioCtx.createScriptProcessor(2048, 1, 1);
    const nativeRate = audioCtx.sampleRate;

    processorNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const combined = new Float32Array(pcmResidual.length + input.length);
      combined.set(pcmResidual);
      combined.set(input, pcmResidual.length);

      const resampled = downsample(combined, nativeRate, 8000);
      let offset = 0;
      while (offset + 160 <= resampled.length) {
        const frame = resampled.subarray(offset, offset + 160);
        onFrame(floatToInt16(frame));
        offset += 160;
      }
      pcmResidual = combined.slice(Math.floor((offset * nativeRate) / 8000));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioCtx.destination); // required by some browsers to keep the graph alive; muted below
    processorNode.channelInterpretation = "discrete";
  }

  function stopCapture() {
    if (processorNode) {
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    pcmResidual = new Float32Array(0);
  }

  function downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      result[i] = buffer[Math.floor(i * ratio)];
    }
    return result;
  }

  function floatToInt16(floatSamples) {
    const out = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // -- playback of incoming PCM (RX side) ------------------------------

  let playCtx = null;
  let playTime = 0;

  function playPcmFrame(int16Array) {
    if (!playCtx) {
      playCtx = new (window.AudioContext || window.webkitAudioContext)();
      playTime = playCtx.currentTime;
    }
    const buffer = playCtx.createBuffer(1, int16Array.length, 8000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < int16Array.length; i++) channel[i] = int16Array[i] / 0x8000;
    const src = playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playCtx.destination);
    const startAt = Math.max(playTime, playCtx.currentTime);
    src.start(startAt);
    playTime = startAt + buffer.duration;
  }

  return { startCapture, stopCapture, playPcmFrame };
})();
