"""Common transport interface: both the USB-C serial link and BLE use
the exact same AT2 frame protocol, so they share one reassembly buffer
and expose the same async API to the rest of the app.
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import Callable

from app.protocol.frame import At2Packet, decode_packet, try_decode_frame

logger = logging.getLogger("at2.transport")


class Transport(ABC):
    """Base class for AT2 transports (serial, BLE)."""

    def __init__(self) -> None:
        self._rx_buffer = bytearray()
        self._packet_listeners: list[Callable[[At2Packet], None]] = []
        self._log_listeners: list[Callable[[str], None]] = []
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    def on_packet(self, callback: Callable[[At2Packet], None]) -> None:
        self._packet_listeners.append(callback)

    def on_log(self, callback: Callable[[str], None]) -> None:
        """Register a callback for human-readable transport events (TX/RX
        summaries, undecodable frames) meant for the UI log, distinct from
        the Python-side `logger` -- see app/device.py, which wires this
        into DeviceManager._log_line()."""
        self._log_listeners.append(callback)

    def _log_line(self, line: str) -> None:
        for cb in list(self._log_listeners):
            try:
                cb(line)
            except Exception:
                logger.exception("transport log listener raised")

    def _feed(self, data: bytes) -> None:
        """Feed raw incoming bytes; extracts and dispatches full frames."""
        self._rx_buffer += data
        while True:
            payload, consumed = try_decode_frame(bytes(self._rx_buffer))
            if consumed == 0:
                break
            raw_consumed = bytes(self._rx_buffer[:consumed])
            del self._rx_buffer[:consumed]
            if payload is None:
                # Header found but the frame was incomplete/garbled and
                # try_decode_frame dropped just the header to resync --
                # this previously only went to the Python-side logger,
                # invisible in the UI Journal. Surface it there too since
                # this is exactly the kind of signal needed while
                # validating against real hardware for the first time.
                logger.warning("dropped garbled frame header while resyncing")
                self._log_line(f"RX trame incomplète/corrompue ignorée (resync), brut: {raw_consumed.hex()}")
                continue
            # Raw wire bytes for this exact frame (head+len+payload+crc+tail),
            # logged BEFORE any interpretation -- needed to settle open
            # protocol questions (1-byte vs 2-byte length field, whether a
            # leading 0x00 genuinely exists) that the decoded family/command
            # summary below can't answer on its own. See CONSIGNES_PROJET.md
            # "Contradiction non résolue" (27/08/2026).
            self._log_line(f"RX brut (trame complète sur le fil): {raw_consumed.hex()}")
            packet = decode_packet(payload)
            if packet is None:
                logger.warning("dropped undecodable payload: %s", payload.hex())
                self._log_line(f"RX payload indécodable (brut complet): {payload.hex()}")
                continue
            for cb in list(self._packet_listeners):
                try:
                    cb(packet)
                except Exception:
                    logger.exception("packet listener raised")

    @abstractmethod
    async def connect(self, target: str, **kwargs) -> None:
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        ...

    @abstractmethod
    async def send_payload(self, payload: bytes) -> None:
        """Encode `payload` into a full frame and send it."""
        ...

    @abstractmethod
    async def send_raw_frame(self, frame: bytes) -> None:
        """Send an already-encoded frame (AA55..77EE) as-is."""
        ...

    async def wait_for_packet(
        self, predicate: Callable[[At2Packet], bool], timeout: float = 2.0
    ) -> At2Packet | None:
        """Await the next packet matching `predicate`, or None on timeout."""
        fut: asyncio.Future[At2Packet] = asyncio.get_event_loop().create_future()

        def _listener(pkt: At2Packet) -> None:
            if not fut.done() and predicate(pkt):
                fut.set_result(pkt)

        self.on_packet(_listener)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._packet_listeners.remove(_listener)
