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
