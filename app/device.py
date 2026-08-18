"""Holds the single active radio connection (serial or BLE) and exposes
high-level operations (read/write channels, device settings) on top of
the raw transport + protocol layers.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from app.protocol import channel as chan
from app.protocol import commands
from app.protocol import messages
from app.protocol.frame import At2Packet
from app.transport.base import Transport
from app.transport.ble_transport import BleTransport
from app.transport.serial_transport import SerialTransport

logger = logging.getLogger("at2.device")

ConnectionKind = Literal["serial", "ble"]


class DeviceManager:
    def __init__(self) -> None:
        self._transport: Transport | None = None
        self._kind: ConnectionKind | None = None
        self._target: str | None = None
        self._log: list[str] = []
        self._log_listeners: list = []
        self._next_msg_id = 1

    # -- connection lifecycle -------------------------------------------------

    @property
    def connected(self) -> bool:
        return bool(self._transport and self._transport.connected)

    @property
    def status(self) -> dict:
        return {
            "connected": self.connected,
            "kind": self._kind,
            "target": self._target,
        }

    def _log_line(self, line: str) -> None:
        logger.info(line)
        self._log.append(line)
        self._log = self._log[-500:]
        for cb in list(self._log_listeners):
            try:
                cb(line)
            except Exception:
                logger.exception("log listener raised")

    def on_log(self, cb) -> None:
        self._log_listeners.append(cb)

    async def connect_serial(self, port: str, baud_rate: int = 115200) -> None:
        await self.disconnect()
        t = SerialTransport()
        t.on_packet(lambda p: self._log_line(f"RX [{p.family:02x}/{p.command:02x}] {p.hex_preview}"))
        await t.connect(port, baud_rate=baud_rate)
        self._transport, self._kind, self._target = t, "serial", port
        self._log_line(f"Connecté en série sur {port} @ {baud_rate} bauds")

    async def connect_ble(self, address: str) -> None:
        await self.disconnect()
        t = BleTransport()
        t.on_packet(lambda p: self._log_line(f"RX [{p.family:02x}/{p.command:02x}] {p.hex_preview}"))
        await t.connect(address)
        self._transport, self._kind, self._target = t, "ble", address
        self._log_line(f"Connecté en BLE sur {address}")

    async def disconnect(self) -> None:
        if self._transport:
            await self._transport.disconnect()
            self._log_line("Déconnecté")
        self._transport, self._kind, self._target = None, None, None

    def _require_transport(self) -> Transport:
        if not self._transport or not self._transport.connected:
            raise RuntimeError("no active connection")
        return self._transport

    # -- channels ---------------------------------------------------------

    async def write_channel(self, config: chan.ChannelConfig) -> None:
        t = self._require_transport()
        record = chan.encode_channel_record(config)
        from app.protocol.frame import build_payload
        await t.send_payload(build_payload(0x02, 0x02, record))
        self._log_line(f"Canal {config.channel} écrit")

    async def clear_channel(self, channel_number: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.clear_channel(channel_number))
        self._log_line(f"Canal {channel_number} effacé")

    async def read_all_channels(self, timeout: float = 8.0) -> list[chan.ChannelConfig]:
        """Request the codeplug and reassemble channel records from the
        incoming family=0x02/command=0x02 packets.

        NOTE: the exact chunking of the *read* response was not directly
        observed (see commands.query_channel_config docstring). This
        collects raw 0x02/0x02 packet bodies until either 720 bytes have
        been reassembled or `timeout` elapses, then parses what it has.
        """
        t = self._require_transport()
        collected = bytearray()
        done = asyncio.Event()

        def _listener(pkt: At2Packet) -> None:
            if pkt.family == 0x02 and pkt.command == 0x02:
                collected.extend(pkt.body)
                if len(collected) >= chan.CHANNEL_COUNT * chan.CHANNEL_RECORD_LEN:
                    done.set()

        t.on_packet(_listener)
        await t.send_payload(commands.query_channel_config())
        try:
            await asyncio.wait_for(done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._log_line(f"Lecture codeplug incomplète: {len(collected)} octets reçus")
        finally:
            t._packet_listeners.remove(_listener)  # noqa: SLF001

        usable = bytes(collected[: (len(collected) // chan.CHANNEL_RECORD_LEN) * chan.CHANNEL_RECORD_LEN])
        if not usable:
            return []
        return chan.parse_codeplug_read_chunks([usable])

    async def write_all_channels(self, configs: list[chan.ChannelConfig]) -> None:
        t = self._require_transport()
        chunks = chan.build_codeplug_write_chunks(configs)
        for i, chunk in enumerate(chunks):
            await t.send_payload(commands.write_channel_chunk(chunk))
            self._log_line(f"Codeplug: bloc {i + 1}/{len(chunks)} envoyé")
            await asyncio.sleep(0.05)

    # -- device settings ----------------------------------------------------

    async def set_volume(self, level: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_volume(level))

    async def set_squelch(self, level: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_squelch(level))

    async def set_vox(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_vox(enabled))

    async def select_channel(self, channel_number: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.select_channel(channel_number))

    # -- messaging ----------------------------------------------------------

    async def send_text_message(self, username: str, text: str) -> None:
        t = self._require_transport()
        msg_id = self._next_msg_id
        self._next_msg_id = (self._next_msg_id + 1) & 0xFFFFFFFF
        frames = messages.build_text_message_frames(username, text, msg_id)
        for f in frames:
            await t.send_raw_frame(f)
            await asyncio.sleep(0.35)
        self._log_line(f"Message texte envoyé ({len(text)} caractères, {len(frames)} trame(s))")


device_manager = DeviceManager()
