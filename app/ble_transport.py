"""BLE transport, using the GATT UUIDs reverse-engineered (btsnoop capture)
in the reference Android app (`BleConstants.kt`, Apache-2.0):

    SERVICE_UUID = 0000AE60-0000-1000-8000-00805F9B34FB
    TX_CHAR_UUID = 0000AE10-0000-1000-8000-00805F9B34FB  (write)
    RX_CHAR_UUID = 0000AE05-0000-1000-8000-00805F9B34FB  (notify)

Requires a BLE adapter on the host (USB dongle passed through to the
container, or the host's built-in adapter with `network_mode: host`).
"""
from __future__ import annotations

import asyncio
import logging

from bleak import BleakClient, BleakScanner

from app.protocol.frame import encode_frame
from .base import Transport

logger = logging.getLogger("at2.transport.ble")

SERVICE_UUID = "0000ae60-0000-1000-8000-00805f9b34fb"
TX_CHAR_UUID = "0000ae10-0000-1000-8000-00805f9b34fb"
RX_CHAR_UUID = "0000ae05-0000-1000-8000-00805f9b34fb"


async def scan_for_devices(timeout: float = 5.0) -> list[dict]:
    devices = await BleakScanner.discover(timeout=timeout)
    return [{"address": d.address, "name": d.name or "(unknown)"} for d in devices]


class BleTransport(Transport):
    def __init__(self) -> None:
        super().__init__()
        self._client: BleakClient | None = None

    async def connect(self, target: str, **kwargs) -> None:
        """`target` is the BLE MAC address (or UUID on macOS)."""
        await self.disconnect()
        self._client = BleakClient(target)
        await self._client.connect()
        await self._client.start_notify(RX_CHAR_UUID, self._on_notify)
        self._connected = True
        logger.info("BLE connected: %s", target)

    def _on_notify(self, _handle: int, data: bytearray) -> None:
        self._feed(bytes(data))

    async def disconnect(self) -> None:
        self._connected = False
        if self._client is not None:
            try:
                if self._client.is_connected:
                    await self._client.stop_notify(RX_CHAR_UUID)
                    await self._client.disconnect()
            except Exception:
                logger.exception("error during BLE disconnect")
            self._client = None

    async def send_payload(self, payload: bytes) -> None:
        await self.send_raw_frame(encode_frame(payload))

    async def send_raw_frame(self, frame: bytes) -> None:
        if not self._client or not self._connected:
            raise RuntimeError("BLE transport not connected")
        # Same TX log format as SerialTransport.send_raw_frame -- see that
        # file for why offsets 4/5 give family/command.
        if len(frame) >= 6:
            family, command = frame[4], frame[5]
            self._log_line(f"TX [{family:02x}/{command:02x}] {frame.hex()}")
        else:
            self._log_line(f"TX (trame courte, brute): {frame.hex()}")
        # Chunk to the negotiated MTU minus ATT overhead if needed; bleak
        # handles write fragmentation for write-with-response internally
        # on most backends, but very old firmwares may need explicit
        # chunking -- revisit if writes silently fail on long frames.
        await self._client.write_gatt_char(TX_CHAR_UUID, frame, response=True)
