# AT2 Bridge — iOS app

Native iOS companion to the AT2 Bridge web app, using **CoreBluetooth**
instead of Web Bluetooth. The main project's README notes that Web
Bluetooth is unavailable on every iOS browser (Safari/WebKit restriction,
including Chrome/Edge on iPhone/iPad since they're WebKit under the hood
too) — this app exists to give iOS users a local-BLE path to the radio
that doesn't depend on the browser at all.

> [!WARNING]
> Same status as the rest of this project: community reverse-engineering,
> not affiliated with Baofeng/Alervites. See the root [`README.md`](../README.md)
> for the full protocol notes, what's confirmed on real hardware vs. not,
> and general project context.

## Scope (v1 — BLE-minimal)

This first version deliberately covers only the part of the protocol
independently confirmed working on real hardware in the Python/web
reference implementation:

- Scan for and connect to an `AT2_…` radio over BLE (CoreBluetooth).
- Read a single channel's configuration (frequencies, CTCSS/DCS tones,
  bandwidth, power, scan flag, frequency hop, digital/analog mode,
  encryption key).
- Write a single channel's configuration.
- Quick channel select (switch the radio's active channel immediately,
  without touching its stored configuration).
- A raw TX/RX log for debugging against the wire protocol.

Not in this version (see the root README's "Roadmap" / "pending hardware
confirmation" sections — same caveats apply here): device settings other
than what's on the channel record, offline messaging, real-time PTT,
codeplug import/export, position/SOS.

## Protocol code

The protocol logic is a direct Swift port of this repo's Python
implementation, kept close on purpose so the two stay easy to compare:

| Swift | Python | What |
|---|---|---|
| `AT2Bridge/Protocol/CRC16.swift` | `app/protocol/frame.py::crc16_ccitt` | CRC-16/CCITT (poly 0x1021, init 0x1234) |
| `AT2Bridge/Protocol/AT2Frame.swift` | `app/protocol/frame.py` | Both frame dialects (legacy 1-byte-length, CPS 2-byte-length) |
| `AT2Bridge/Protocol/AT2Channel.swift` | `app/protocol/channel.py` | Per-channel CPS-dialect read/write, tone tables |
| `AT2Bridge/Protocol/AT2Commands.swift` | `app/protocol/commands.py` | Quick channel select (legacy dialect) |
| `AT2Bridge/BLE/AT2BLEManager.swift` | `app/transport/ble_transport.py` | CoreBluetooth transport (same GATT UUIDs) |

GATT UUIDs (from `BleConstants.kt` in the reference Android app, same as
used by the Python/web BLE transport):

```
SERVICE_UUID = 0000AE60-0000-1000-8000-00805F9B34FB
TX_CHAR_UUID = 0000AE10-0000-1000-8000-00805F9B34FB  (write)
RX_CHAR_UUID = 0000AE05-0000-1000-8000-00805F9B34FB  (notify)
```

If you fix or extend the protocol in the Python reference, mirror the
change here too (and vice versa) — the two are meant to stay in sync.

## Requirements

- Xcode 15+ (this project was authored by hand, without Xcode, since no
  Mac is available in the environment that generated it — open it once
  in Xcode to let it re-index normally; if Xcode complains about the
  project file, regenerating the target from scratch with these same
  Swift sources is a safe fallback).
- iOS 16.0+ deployment target.
- A physical iOS device to test BLE against real hardware (the
  iOS Simulator has no Bluetooth radio).

## Opening the project

```bash
open AT2Bridge.xcodeproj
```

Build and run on a physical device (Bluetooth doesn't work in the
Simulator). On first launch, iOS will prompt for Bluetooth permission
(see `Info.plist`'s `NSBluetoothAlwaysUsageDescription`).

## Pairing steps

Same as the web interface's local BLE mode (see root README, "Starting a
scan"):

1. Close any other app currently connected to the radio (Bluetooth LE
   Explorer, Ola Radio, etc.).
2. Toggle Bluetooth off/on on the radio right before scanning, to restart
   its BLE advertising.
3. Tap "Rechercher un AT2" in the app.
4. Select the discovered `AT2_…` device.

## Known limitations

- Write-side channel confirmation is optimistic (see the comment in
  `AT2BLEManager.writeChannel`): the exact ack frame for a channel write
  hasn't been pinned down yet, same open question as in the Python
  reference (`app/protocol/channel.py` module docstring).
- No background BLE reconnection to previously-known devices yet.
- No device settings, messaging, or PTT — see "Scope" above.
