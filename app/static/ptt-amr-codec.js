/* Real-time AMR-NB (MR475) encode/decode wrapper around the compiled
 * opencore-amr-js module (see amrnb.js, loaded before this script).
 *
 * Frame-by-frame API mirroring app/protocol/amr_codec.py's AmrNbCodec
 * class exactly (same constants, same TOC-byte stripping convention),
 * so this project's live PTT protocol (app/protocol/ptt.py) works
 * identically whether audio is encoded server-side (server mode) or
 * client-side in the browser (BLE local mode).
 *
 * Buffers are allocated once per codec instance and reused across
 * calls -- this build's WASM heap has a fixed size and never grows, so
 * caching pointers (not re-malloc'ing every 20ms frame) is both safe
 * and necessary for real-time performance.
 */
const PttAmr = (() => {
  const FRAME_SAMPLES = 160; // 20ms @ 8kHz
  const FRAME_BYTES_PCM = 320; // 160 samples * 2 bytes (16-bit)
  const ENCODED_FRAME_BYTES = 12; // MR475 core frame, TOC stripped
  const MR475_MODE = 0;
  const MR475_TOC = 0x04;

  class Codec {
    constructor() {
      if (typeof AMR === "undefined" || typeof AMR._malloc !== "function") {
        throw new Error("amrnb.js must be loaded before ptt-amr-codec.js (and must include the AMR._malloc/_HEAPU8 patch -- see amrnb.js header)");
      }
      this._encState = AMR.Encoder_Interface_init(0);
      this._decState = AMR.Decoder_Interface_init();
      if (!this._encState || !this._decState) {
        throw new Error("AMR codec initialization failed");
      }
      // Persistent buffers, reused across calls to avoid malloc/free
      // churn on every 20ms frame during a live PTT session.
      this._encInPtr = AMR._malloc(FRAME_SAMPLES * 2);
      this._encOutPtr = AMR._malloc(32);
      this._decInPtr = AMR._malloc(ENCODED_FRAME_BYTES + 1);
      this._decOutPtr = AMR._malloc(FRAME_SAMPLES * 2);
    }

    /** pcm: Int16Array of exactly 160 samples (one 20ms frame @ 8kHz
     * mono). Returns a 12-byte Uint8Array (MR475 core frame, TOC
     * stripped), or null if the encoder produced no output for this
     * particular frame (mirrors amr_codec.py's encode() contract). */
    encode(pcm) {
      if (pcm.length !== FRAME_SAMPLES) {
        throw new Error(`expected ${FRAME_SAMPLES} samples, got ${pcm.length}`);
      }
      const inView = new Int16Array(AMR._HEAPU8().buffer, this._encInPtr, FRAME_SAMPLES);
      inView.set(pcm);
      const produced = AMR.Encoder_Interface_Encode(this._encState, MR475_MODE, this._encInPtr, this._encOutPtr, 0);
      if (produced !== ENCODED_FRAME_BYTES + 1) return null;
      const outView = new Uint8Array(AMR._HEAPU8().buffer, this._encOutPtr, ENCODED_FRAME_BYTES + 1);
      // out[0] is the TOC byte; strip it to match the over-the-air
      // format -- same convention as amr_codec.py, server side.
      return outView.slice(1, ENCODED_FRAME_BYTES + 1);
    }

    /** frame: 12-byte Uint8Array (MR475 core frame, no TOC). Returns
     * an Int16Array of 160 PCM samples. */
    decode(frame) {
      if (frame.length !== ENCODED_FRAME_BYTES) {
        throw new Error(`expected a ${ENCODED_FRAME_BYTES}-byte frame, got ${frame.length}`);
      }
      const inView = new Uint8Array(AMR._HEAPU8().buffer, this._decInPtr, ENCODED_FRAME_BYTES + 1);
      inView[0] = MR475_TOC;
      inView.set(frame, 1);
      AMR.Decoder_Interface_Decode(this._decState, this._decInPtr, this._decOutPtr, 0);
      const outView = new Int16Array(AMR._HEAPU8().buffer, this._decOutPtr, FRAME_SAMPLES);
      return outView.slice();
    }

    close() {
      if (this._encState) { AMR.Encoder_Interface_exit(this._encState); this._encState = null; }
      if (this._decState) { AMR.Decoder_Interface_exit(this._decState); this._decState = null; }
      if (this._encInPtr) { AMR._free(this._encInPtr); this._encInPtr = null; }
      if (this._encOutPtr) { AMR._free(this._encOutPtr); this._encOutPtr = null; }
      if (this._decInPtr) { AMR._free(this._decInPtr); this._decInPtr = null; }
      if (this._decOutPtr) { AMR._free(this._decOutPtr); this._decOutPtr = null; }
    }
  }

  return { Codec, FRAME_SAMPLES, FRAME_BYTES_PCM, ENCODED_FRAME_BYTES };
})();
