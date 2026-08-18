"""USB-C serial transport (115200 baud, matches the official CPS)."""
from __future__ import annotations

import asyncio
import logging

import serial
import serial.tools.list_ports

from app.protocol.frame import encode_frame
from .base import Transport

logger = logging.getLogger("at2.transport.serial")

BAUD_RATE = 115200


def list_serial_ports() -> list[dict]:
    return [
        {"path": p.device, "description": p.description, "hwid": p.hwid}
        for p in serial.tools.list_ports.comports()
    ]


class SerialTransport(Transport):
    def __init__(self) -> None:
        super().__init__()
        self._ser: serial.Serial | None = None
        self._reader_task: asyncio.Task | None = None

    async def connect(self, target: str, **kwargs) -> None:
        baud = kwargs.get("baud_rate", BAUD_RATE)
        await self.disconnect()
        loop = asyncio.get_event_loop()

        def _open() -> serial.Serial:
            return serial.Serial(target, baudrate=baud, timeout=0.1)

        self._ser = await loop.run_in_executor(None, _open)
        self._connected = True
        self._reader_task = asyncio.create_task(self._read_loop())
        logger.info("serial connected: %s @ %d baud", target, baud)

    async def _read_loop(self) -> None:
        loop = asyncio.get_event_loop()
        assert self._ser is not None
        try:
            while self._connected:
                data = await loop.run_in_executor(None, self._ser.read, 256)
                if data:
                    self._feed(data)
                else:
                    await asyncio.sleep(0.02)
        except Exception:
            logger.exception("serial read loop crashed")
            self._connected = False

    async def disconnect(self) -> None:
        self._connected = False
        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None

    async def send_payload(self, payload: bytes) -> None:
        await self.send_raw_frame(encode_frame(payload))

    async def send_raw_frame(self, frame: bytes) -> None:
        if not self._ser or not self._connected:
            raise RuntimeError("serial transport not connected")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._ser.write, frame)
