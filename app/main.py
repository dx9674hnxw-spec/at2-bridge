from __future__ import annotations

import asyncio
import base64
import logging

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import auth, store
from app.device import device_manager
from app.protocol.channel import ChannelConfig, parse_cps_xml, tone_options
from app.protocol.messages import CompletedMessage, IMAGE_CHUNK_BYTES, IMAGE_JPEG_QUALITY, IMAGE_LONG_EDGE_PX
from app.transport.ble_transport import scan_for_devices
from app.transport.serial_transport import list_serial_ports

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("at2.main")

app = FastAPI(title="AT2 Bridge")


# ---------------------------------------------------------------------------
# Exception handling
#
# Without this, any RuntimeError raised deep in app/device.py (most
# commonly `_require_transport()` when no radio is connected) surfaces
# to the client as a raw 500 with a Python traceback -- confirmed while
# testing app/static/app.js against a running server with no radio
# attached. Two handlers:
#   - RuntimeError: these are deliberate, human-readable messages
#     raised on purpose by device.py (e.g. "no active connection",
#     "channel out of range") -- safe to relay directly, mapped to 409
#     Conflict (the request was valid, but the current state disallows
#     it right now).
#   - Anything else unexpected: still logged in full server-side (per
#     CONSIGNES_PROJET.md: never silently swallow an error), but the
#     client gets a generic message instead of an internal traceback.
# ---------------------------------------------------------------------------

@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, exc: RuntimeError):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


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


class DualWatchChannelRequest(BaseModel):
    side: str  # "A" or "B"
    channel: int


class DualWatchFocusRequest(BaseModel):
    side: str  # "A" or "B"


class PromptLanguageRequest(BaseModel):
    english: bool


class TxIntervalRequest(BaseModel):
    seconds: int


class SquelchRequest(BaseModel):
    level: int


class VoxRequest(BaseModel):
    enabled: bool


class VoxSensitivityRequest(BaseModel):
    level: int


class TotRequest(BaseModel):
    seconds: int


class ToggleRequest(BaseModel):
    """Generic on/off body, reused for the settings that are just a
    single boolean: tx_inhibit, noise_reduction, prompt_tone, smart_link."""
    enabled: bool


class DeviceNameRequest(BaseModel):
    name: str


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


class LoginRequest(BaseModel):
    password: str


class RawFrameDebugRequest(BaseModel):
    """EXPERIMENTAL / DEBUG ONLY -- see device.py::send_debug_raw_frame.
    frame_hex must be an already fully-encoded frame (AA55...77EE) as a
    hex string, e.g. produced by a protocol hypothesis under test."""
    frame_hex: str
    listen_seconds: float = 2.0


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    if not auth.check_password(req.password):
        raise HTTPException(status_code=401, detail="mot de passe incorrect")
    return {"token": auth.issue_token()}


@app.get("/api/auth/status")
async def auth_status():
    return {"enabled": auth.auth_enabled()}


# ---------------------------------------------------------------------------
# Connection endpoints
# ---------------------------------------------------------------------------

@app.get("/api/connection/status")
async def get_status(_: None = Depends(auth.require_auth)):
    return device_manager.status


@app.get("/api/connection/serial/ports")
async def get_serial_ports(_: None = Depends(auth.require_auth)):
    return list_serial_ports()


@app.post("/api/connection/serial/connect")
async def connect_serial(req: SerialConnectRequest, _: None = Depends(auth.require_auth)):
    await device_manager.connect_serial(req.port, req.baud_rate)
    return device_manager.status


@app.get("/api/connection/ble/scan")
async def ble_scan(_: None = Depends(auth.require_auth)):
    return await scan_for_devices()


@app.post("/api/connection/ble/connect")
async def connect_ble(req: BleConnectRequest, _: None = Depends(auth.require_auth)):
    await device_manager.connect_ble(req.address)
    return device_manager.status


@app.post("/api/connection/disconnect")
async def disconnect(_: None = Depends(auth.require_auth)):
    await device_manager.disconnect()
    return device_manager.status


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

@app.get("/api/channels/tone-options")
async def get_tone_options(_: None = Depends(auth.require_auth)):
    return tone_options()


@app.get("/api/channels")
async def read_channels(_: None = Depends(auth.require_auth)):
    channels = await device_manager.read_all_channels()
    return [c.__dict__ for c in channels]


_MAX_XML_UPLOAD_BYTES = 5 * 1024 * 1024  # a real CPS export is a few KB; 5MB is generous headroom


@app.post("/api/channels/import-xml")
async def import_channels_xml(file: UploadFile = File(...), _: None = Depends(auth.require_auth)):
    """Parses a CPS-format XML export (the official Windows CPS's own
    config save/export, NOT a live protocol capture) into channel
    configs for the UI to review. This never writes to the radio by
    itself -- same as after a live "Read", the person still clicks
    "Write" to actually commit anything. See channel.py::parse_cps_xml.

    Size cap + DOCTYPE/ENTITY rejection: this is now a file-upload
    endpoint accepting untrusted input, so a cheap, dependency-free
    guard against XML entity-expansion ("billion laughs") DoS on
    xml.etree.ElementTree is worth the two extra checks.
    """
    raw = await file.read()
    if len(raw) > _MAX_XML_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="fichier XML trop volumineux")
    upper = raw.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise HTTPException(status_code=400, detail="XML avec DOCTYPE/ENTITY non autorisé")
    try:
        channels = parse_cps_xml(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not channels:
        raise HTTPException(status_code=400, detail="aucun canal configuré trouvé dans ce fichier")
    return [c.__dict__ for c in channels]


@app.put("/api/channels")
async def write_channels(payload: list[ChannelPayload], _: None = Depends(auth.require_auth)):
    if len(payload) != 30:
        return {"error": "expected exactly 30 channels"}
    await device_manager.write_all_channels([p.to_config() for p in payload])
    return {"ok": True}


@app.put("/api/channels/{channel_number}")
async def write_channel(channel_number: int, payload: ChannelPayload, _: None = Depends(auth.require_auth)):
    payload.channel = channel_number
    await device_manager.write_channel(payload.to_config())
    return {"ok": True}


@app.delete("/api/channels/{channel_number}")
async def clear_channel(channel_number: int, _: None = Depends(auth.require_auth)):
    await device_manager.clear_channel(channel_number)
    return {"ok": True}


@app.post("/api/channels/{channel_number}/select")
async def select_channel(channel_number: int, _: None = Depends(auth.require_auth)):
    await device_manager.select_channel(channel_number)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Device settings
# ---------------------------------------------------------------------------

@app.put("/api/device/volume")
async def set_volume(req: VolumeRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_volume(req.level)
    return {"ok": True}


@app.put("/api/device/squelch")
async def set_squelch(req: SquelchRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_squelch(req.level)
    return {"ok": True}


@app.put("/api/device/vox")
async def set_vox(req: VoxRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_vox(req.enabled)
    return {"ok": True}


@app.put("/api/device/vox-sensitivity")
async def set_vox_sensitivity(req: VoxSensitivityRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_vox_sensitivity(req.level)
    return {"ok": True}


@app.put("/api/device/tot")
async def set_tot(req: TotRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_tot_seconds(req.seconds)
    return {"ok": True}


@app.put("/api/device/tx-inhibit")
async def set_tx_inhibit(req: ToggleRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_tx_inhibit(req.enabled)
    return {"ok": True}


@app.put("/api/device/noise-reduction")
async def set_noise_reduction(req: ToggleRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_noise_reduction(req.enabled)
    return {"ok": True}


@app.put("/api/device/prompt-tone")
async def set_prompt_tone(req: ToggleRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_prompt_tone(req.enabled)
    return {"ok": True}


@app.put("/api/device/name")
async def set_device_name(req: DeviceNameRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_device_name(req.name)
    return {"ok": True}


@app.put("/api/device/smart-link")
async def set_smart_link(req: ToggleRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_smart_link(req.enabled)
    return {"ok": True}


@app.put("/api/device/dual-watch")
async def set_dual_watch(req: ToggleRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_dual_watch(req.enabled)
    return {"ok": True}


@app.put("/api/device/dual-watch/channel")
async def select_dual_watch_channel(req: DualWatchChannelRequest, _: None = Depends(auth.require_auth)):
    await device_manager.select_dual_watch_channel(req.side, req.channel)
    return {"ok": True}


@app.put("/api/device/dual-watch/focus")
async def select_dual_watch_focus(req: DualWatchFocusRequest, _: None = Depends(auth.require_auth)):
    await device_manager.select_dual_watch_focus(req.side)
    return {"ok": True}


@app.put("/api/device/prompt-language")
async def set_prompt_language(req: PromptLanguageRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_prompt_language(req.english)
    return {"ok": True}


@app.put("/api/device/tx-interval")
async def set_tx_interval(req: TxIntervalRequest, _: None = Depends(auth.require_auth)):
    await device_manager.set_tx_interval_seconds(req.seconds)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Messaging: text, voice, image (offline / store-and-forward)
# ---------------------------------------------------------------------------

@app.post("/api/messages/text")
async def send_text(req: TextMessageRequest, _: None = Depends(auth.require_auth)):
    await device_manager.send_text_message(req.username, req.text)
    return {"ok": True}


@app.post("/api/messages/voice")
async def send_voice(
    username: str = Form("AT2Bridge"),
    duration_ms: int = Form(...),
    pcm: UploadFile = File(...),
    _: None = Depends(auth.require_auth),
):
    """`pcm` must be raw 16-bit mono PCM @ 8kHz (no container/header) --
    matches what app/static/ptt-audio.js records for voice notes."""
    data = await pcm.read()
    if len(data) % 2 != 0:
        raise HTTPException(status_code=400, detail="PCM data must be an even number of bytes (16-bit samples)")
    await device_manager.send_voice_message(username, data, duration_ms)
    return {"ok": True}


@app.post("/api/messages/image")
async def send_image(
    username: str = Form("AT2Bridge"),
    image: UploadFile = File(...),
    _: None = Depends(auth.require_auth),
):
    """Resizes/recompresses the uploaded image to match the reference
    app's offline-image format (300px long edge, JPEG quality 75) --
    see app/protocol/messages.py::IMAGE_LONG_EDGE_PX/IMAGE_JPEG_QUALITY."""
    try:
        from PIL import Image
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail="Pillow n'est pas installé côté serveur (ajouté à requirements.txt -- rebuild l'image Docker ?)",
        ) from e
    import io

    raw = await image.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"image illisible: {e}") from e

    long_edge = max(img.width, img.height)
    if long_edge > IMAGE_LONG_EDGE_PX:
        scale = IMAGE_LONG_EDGE_PX / long_edge
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))))

    # A single fixed 300px/quality-75 pass can still exceed the protocol's
    # hard cap on chunk count (255 * IMAGE_CHUNK_BYTES -- see
    # build_image_message_frames' "image too large to fragment" check) for
    # busy/detailed photos -- confirmed in testing, this used to just
    # propagate that as a 500. Back off quality first, then dimensions.
    max_image_bytes = 255 * IMAGE_CHUNK_BYTES
    quality = IMAGE_JPEG_QUALITY
    working_img = img
    jpeg_bytes = b""
    for _ in range(8):
        buf = io.BytesIO()
        working_img.save(buf, format="JPEG", quality=quality)
        jpeg_bytes = buf.getvalue()
        if len(jpeg_bytes) <= max_image_bytes:
            break
        if quality > 35:
            quality = max(35, quality - 15)
        else:
            working_img = working_img.resize((
                max(1, round(working_img.width * 0.85)),
                max(1, round(working_img.height * 0.85)),
            ))
    else:
        raise HTTPException(
            status_code=400,
            detail=f"image trop volumineuse même après compression maximale ({len(jpeg_bytes)} octets, max {max_image_bytes})",
        )

    await device_manager.send_image_message(username, jpeg_bytes, working_img.width, working_img.height)
    return {"ok": True, "width": working_img.width, "height": working_img.height, "bytes": len(jpeg_bytes)}


# ---------------------------------------------------------------------------
# Channel names (local, not stored on the radio -- see app/store.py)
# ---------------------------------------------------------------------------

@app.get("/api/channel-names")
async def get_channel_names(_: None = Depends(auth.require_auth)):
    return store.get_channel_names()


@app.put("/api/channel-names/{channel_number}")
async def set_channel_name(channel_number: int, req: ChannelNameRequest, _: None = Depends(auth.require_auth)):
    store.set_channel_name(channel_number, req.name)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Known devices
# ---------------------------------------------------------------------------

@app.get("/api/known-devices")
async def get_known_devices(_: None = Depends(auth.require_auth)):
    return store.get_known_devices()


@app.post("/api/known-devices")
async def remember_device(req: RememberDeviceRequest, _: None = Depends(auth.require_auth)):
    store.remember_device(req.id, req.name, req.transport, req.target)
    return {"ok": True}


@app.delete("/api/known-devices")
async def forget_device(device_id: str, _: None = Depends(auth.require_auth)):
    # device_id as a QUERY parameter, not a path segment (29/08/2026 fix):
    # serial device IDs look like "serial-/dev/ttyACM0" (contain a literal
    # "/"), which broke path-segment routing even after URL-encoding --
    # Starlette/uvicorn reject or early-decode %2F in path segments as a
    # path-traversal precaution, so the route never matched and "Forget"
    # silently 404'd. Query parameters don't have this restriction.
    store.forget_device(device_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Position beacon / SOS (piggybacked on the text messaging channel)
# ---------------------------------------------------------------------------

@app.post("/api/position/send")
async def send_position(req: PositionRequest, _: None = Depends(auth.require_auth)):
    await device_manager.send_position(req.username, req.lat, req.lon, req.note)
    return {"ok": True}


@app.post("/api/position/sos")
async def send_sos(req: PositionRequest, _: None = Depends(auth.require_auth)):
    await device_manager.send_position(req.username, req.lat, req.lon, f"🆘 {req.note}")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Debug: raw frame injection (experimental, for protocol reverse-engineering)
# ---------------------------------------------------------------------------

@app.post("/api/debug/send-raw-frame")
async def debug_send_raw_frame(req: RawFrameDebugRequest, _: None = Depends(auth.require_auth)):
    try:
        await device_manager.send_debug_raw_frame(req.frame_hex, req.listen_seconds)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True}


# ---------------------------------------------------------------------------
# Live log over WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws/log")
async def ws_log(websocket: WebSocket):
    if not auth.require_auth_ws(websocket.query_params.get("token")):
        await websocket.close(code=4401)
        return
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
    finally:
        # Sans ce nettoyage, chaque reconnexion (app.js relance /ws/log
        # toutes les 2s après une coupure) ajoutait un nouveau listener
        # jamais retiré -- fuite mémoire non bornée sur une instance de
        # longue durée. Voir CONSIGNES_PROJET.md.
        device_manager.off_log(_on_log)


@app.websocket("/ws/ptt")
async def ws_ptt(websocket: WebSocket):
    """Bidirectional PTT audio.

    Client -> server: raw binary frames, each exactly 320 bytes of
    16-bit little-endian mono PCM @ 8kHz (20ms). The browser must
    resample its mic input (typically 48kHz) down to this before
    sending -- see app/static/ptt-audio.js.

    Server -> client: raw binary frames, same format, decoded from
    whatever the radio is currently transmitting on the selected
    channel (if anyone is talking).
    """
    if not auth.require_auth_ws(websocket.query_params.get("token")):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    if not device_manager.connected:
        await websocket.close(code=1011, reason="no active radio connection")
        return

    rx_queue: asyncio.Queue[bytes] = asyncio.Queue()

    def _on_rx_pcm(pcm: bytes) -> None:
        rx_queue.put_nowait(pcm)

    device_manager.on_ptt_voice_packet(_on_rx_pcm)
    session = device_manager.start_ptt_session()
    try:
        await session.start()  # keys the radio's transmitter on -- see PttSession.start()
    except Exception:
        logger.exception("PTT key-on failed")
        device_manager.off_ptt_voice_packet(_on_rx_pcm)
        await websocket.close(code=1011, reason="PTT key-on failed")
        return

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
        device_manager.off_ptt_voice_packet(_on_rx_pcm)


@app.websocket("/ws/messages")
async def ws_messages(websocket: WebSocket):
    """Pushes completed incoming offline messages (text/voice/image) as
    JSON. Binary payloads (voice AMR bytes, image JPEG bytes) are
    base64-encoded in the `data_base64` field."""
    if not auth.require_auth_ws(websocket.query_params.get("token")):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    queue: asyncio.Queue[CompletedMessage] = asyncio.Queue()

    def _on_message(msg: CompletedMessage) -> None:
        queue.put_nowait(msg)

    device_manager.on_message_received(_on_message)
    try:
        while True:
            msg = await queue.get()
            payload = {
                "kind": msg.kind,
                "sender": msg.sender,
                "msg_id": msg.msg_id,
                "text": msg.text,
                "duration_ms": msg.duration_ms,
                "width": msg.width,
                "height": msg.height,
                "data_base64": base64.b64encode(msg.data).decode("ascii") if msg.data else None,
            }
            await websocket.send_json(payload)
    except WebSocketDisconnect:
        pass
    finally:
        device_manager.off_message_received(_on_message)


@app.websocket("/ws/ptt-rx")
async def ws_ptt_rx(websocket: WebSocket):
    """Passive, receive-only signal for the "someone is talking" visual
    indicator on the PTT panel -- unlike /ws/ptt, opening this connection
    never keys the local radio's transmitter (no PttSession involved at
    all). It just pings the client once per incoming PTT voice packet, so
    the UI can light up an "RX" indicator even while the user isn't
    holding their own PTT button -- previously the only way to see any
    incoming-voice signal at all was to already be transmitting yourself
    (see /ws/ptt's docstring), which defeats the point of knowing the
    channel is busy *before* keying up over someone else.

    Always accepted regardless of connection state (mirrors /ws/messages)
    -- device_manager.on_ptt_voice_packet() callbacks are stored on the
    manager itself and simply fire once a transport is later connected."""
    if not auth.require_auth_ws(websocket.query_params.get("token")):
        await websocket.close(code=4401)
        return
    await websocket.accept()

    queue: asyncio.Queue[None] = asyncio.Queue()

    def _on_rx_pcm(_pcm: bytes) -> None:
        # Presence-only ping -- the client just needs to know "someone is
        # transmitting right now", not to play back the audio itself.
        queue.put_nowait(None)

    device_manager.on_ptt_voice_packet(_on_rx_pcm)
    try:
        while True:
            await queue.get()
            await websocket.send_text("rx")
    except WebSocketDisconnect:
        pass
    finally:
        device_manager.off_ptt_voice_packet(_on_rx_pcm)


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get("/")
async def index():
    return FileResponse("app/static/index.html")
