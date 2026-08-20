from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.device import device_manager
from app.protocol.channel import ChannelConfig, tone_options
from app.transport.ble_transport import scan_for_devices
from app.transport.serial_transport import list_serial_ports
from app import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="AT2 Bridge")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SerialConnectRequest(BaseModel):
    port: str
    baud_rate: int = 115200


class BleConnectRequest(BaseModel):
    address: str


class ChannelPayload(BaseModel):
    channel: int
    rx_mhz: float | None = None
    tx_mhz: float | None = None
    rx_tone: str = "OFF"
    tx_tone: str = "OFF"
    busy_lock: bool = False
    bandwidth_narrow: bool = True
    high_power: bool = True
    scan_add: bool = True
    hop_on: bool = False
    mode_digital: bool = False
    encrypt_key: int = 0
    name: str | None = None

    def to_config(self) -> ChannelConfig:
        return ChannelConfig(**self.model_dump())


class VolumeRequest(BaseModel):
    level: int


class SquelchRequest(BaseModel):
    level: int


class VoxRequest(BaseModel):
    enabled: bool


class SelectChannelRequest(BaseModel):
    channel: int


class TextMessageRequest(BaseModel):
    username: str = "AT2Bridge"
    text: str


class ChannelNameRequest(BaseModel):
    name: str


class RememberDeviceRequest(BaseModel):
    id: str
    name: str
    transport: str
    target: str


class PositionRequest(BaseModel):
    username: str = "AT2Bridge"
    lat: float
    lon: float
    note: str = ""


class PositionRequest(BaseModel):
    username: str = "AT2Bridge"
    lat: float
    lon: float
    accuracy_m: float | None = None


class SosRequest(BaseModel):
    username: str = "AT2Bridge"
    preset: str
    lat: float | None = None
    lon: float | None = None


# ---------------------------------------------------------------------------
# Connection endpoints
# ---------------------------------------------------------------------------

@app.get("/api/connection/status")
async def get_status():
    return device_manager.status


@app.get("/api/connection/serial/ports")
async def get_serial_ports():
    return list_serial_ports()


@app.post("/api/connection/serial/connect")
async def connect_serial(req: SerialConnectRequest):
    await device_manager.connect_serial(req.port, req.baud_rate)
    return device_manager.status


@app.get("/api/connection/ble/scan")
async def ble_scan():
    return await scan_for_devices()


@app.post("/api/connection/ble/connect")
async def connect_ble(req: BleConnectRequest):
    await device_manager.connect_ble(req.address)
    return device_manager.status


@app.post("/api/connection/disconnect")
async def disconnect():
    await device_manager.disconnect()
    return device_manager.status


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

@app.get("/api/channels/tone-options")
async def get_tone_options():
    return tone_options()


@app.get("/api/channels")
async def read_channels():
    channels = await device_manager.read_all_channels()
    return [c.__dict__ for c in channels]


@app.put("/api/channels")
async def write_channels(payload: list[ChannelPayload]):
    if len(payload) != 30:
        return {"error": "expected exactly 30 channels"}
    await device_manager.write_all_channels([p.to_config() for p in payload])
    return {"ok": True}


@app.put("/api/channels/{channel_number}")
async def write_channel(channel_number: int, payload: ChannelPayload):
    payload.channel = channel_number
    await device_manager.write_channel(payload.to_config())
    return {"ok": True}


@app.delete("/api/channels/{channel_number}")
async def clear_channel(channel_number: int):
    await device_manager.clear_channel(channel_number)
    return {"ok": True}


@app.post("/api/channels/{channel_number}/select")
async def select_channel(channel_number: int):
    await device_manager.select_channel(channel_number)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Device settings
# ---------------------------------------------------------------------------

@app.put("/api/device/volume")
async def set_volume(req: VolumeRequest):
    await device_manager.set_volume(req.level)
    return {"ok": True}


@app.put("/api/device/squelch")
async def set_squelch(req: SquelchRequest):
    await device_manager.set_squelch(req.level)
    return {"ok": True}


@app.put("/api/device/vox")
async def set_vox(req: VoxRequest):
    await device_manager.set_vox(req.enabled)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Messaging
# ---------------------------------------------------------------------------

@app.post("/api/messages/text")
async def send_text(req: TextMessageRequest):
    await device_manager.send_text_message(req.username, req.text)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Channel names (local, not stored on the radio -- see app/store.py)
# ---------------------------------------------------------------------------

@app.get("/api/channel-names")
async def get_channel_names():
    return store.get_channel_names()


@app.put("/api/channel-names/{channel_number}")
async def set_channel_name(channel_number: int, req: ChannelNameRequest):
    store.set_channel_name(channel_number, req.name)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Known devices (local persistence so the UI can list previously-seen
# radios even before a fresh BLE scan or without a serial port attached)
# ---------------------------------------------------------------------------

@app.get("/api/known-devices")
async def get_known_devices():
    return store.get_known_devices()


@app.post("/api/known-devices")
async def remember_device(req: RememberDeviceRequest):
    store.remember_device(req.id, req.name, req.transport, req.target)
    return {"ok": True}


@app.delete("/api/known-devices/{device_id}")
async def forget_device(device_id: str):
    store.forget_device(device_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Position beacon / SOS (piggybacked on the verified text messaging channel)
# ---------------------------------------------------------------------------

@app.post("/api/position/send")
async def send_position(req: PositionRequest):
    await device_manager.send_position(req.username, req.lat, req.lon, req.note)
    return {"ok": True}


@app.post("/api/position/sos")
async def send_sos(req: PositionRequest):
    await device_manager.send_position(req.username, req.lat, req.lon, f"🆘 {req.note}")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Live log over WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws/log")
async def ws_log(websocket: WebSocket):
    await websocket.accept()
    queue: asyncio.Queue[str] = asyncio.Queue()

    def _on_log(line: str) -> None:
        queue.put_nowait(line)

    device_manager.on_log(_on_log)
    try:
        while True:
            line = await queue.get()
            await websocket.send_text(line)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/ptt")
async def ws_ptt(websocket: WebSocket):
    """Bidirectional PTT audio.

    Client -> server: raw binary frames, each exactly 320 bytes of
    16-bit little-endian mono PCM @ 8kHz (20ms). The browser must
    resample its mic input (typically 48kHz) down to this before
    sending -- see app/static/ptt.js.

    Server -> client: raw binary frames, same format, decoded from
    whatever the radio is currently transmitting on the selected
    channel (if anyone is talking).
    """
    await websocket.accept()
    if not device_manager.connected:
        await websocket.close(code=1011, reason="no active radio connection")
        return

    rx_queue: asyncio.Queue[bytes] = asyncio.Queue()

    def _on_rx_pcm(pcm: bytes) -> None:
        rx_queue.put_nowait(pcm)

    device_manager.on_ptt_voice_packet(_on_rx_pcm)
    session = device_manager.start_ptt_session()

    async def _rx_forward() -> None:
        while True:
            pcm = await rx_queue.get()
            await websocket.send_bytes(pcm)

    forward_task = asyncio.create_task(_rx_forward())
    try:
        while True:
            data = await websocket.receive_bytes()
            await session.feed_pcm_frame(data)
    except WebSocketDisconnect:
        pass
    finally:
        forward_task.cancel()
        await session.close()


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get("/")
async def index():
    return FileResponse("app/static/index.html")
