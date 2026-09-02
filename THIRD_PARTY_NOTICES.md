# Third-Party Notices

This repository includes source code ported from third-party projects.
Each remains under its own license; this file is a convenience summary
and does not replace the original license text.

## Baofeng-ALERVITES-AT2-Android

- Upstream: https://github.com/byf3332/Baofeng-ALERVITES-AT2-Android
- License: Apache License 2.0
- Ported into: `app/protocol/frame.py`, `app/protocol/channel.py`,
  `app/protocol/commands.py`, `app/protocol/messages.py`,
  `app/transport/ble_transport.py` (GATT UUIDs only)

The upstream project itself vendors `OpenCORE-AMR 0.1.3` (Apache 2.0)
for its real-time PTT voice codec. That component is **not** ported
into this repository (see README roadmap) — if a future contribution
adds AMR-NB support here, this file and the project's own NOTICE must
be updated to carry that attribution forward, including the upstream
patent-rights caveat for AMR/AMR-WB implementations noted in the
source project's own THIRD_PARTY_NOTICES.md.

## opencore-amr-js

- Upstream: https://github.com/yxl/opencore-amr-js
- License: Apache License 2.0
- Used as: `app/static/amrnb.js` — a browser (Emscripten-compiled)
  build of the same OpenCORE-AMR codec referenced above, used for
  client-side AMR-NB encode/decode during live PTT in BLE local mode
  (PTT has been confirmed BLE-only — see CONSIGNES_PROJET.md — so this
  is the browser-side counterpart to `app/protocol/amr_codec.py`'s
  server-side ctypes binding to the same native library).
- Modification: `app/static/amrnb.js` includes one small, clearly
  marked patch not present upstream (see the "BEGIN/END minimal patch"
  comment near the end of the file) exposing the module's malloc/free/
  heap access on the `AMR` namespace, so the encoder/decoder state can
  persist across the many small calls a live 20ms-frame PTT stream
  requires, instead of being re-initialized on every call as the
  file's own public `encode()`/`decode()` helpers do. Everything else
  in that file is the unmodified upstream build.
- `app/static/ptt-amr-codec.js` is this project's own frame-by-frame
  wrapper around that build, not third-party code.

Per the upstream project's own patent-rights caveat for AMR/AMR-WB
implementations (see `Baofeng-ALERVITES-AT2-Android`'s
THIRD_PARTY_NOTICES.md, referenced above), the same caveat applies
here since this is the identical underlying codec, just compiled to
run in the browser instead of natively.
