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
from app import store

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
        self._ptt_rx_listeners: list = []
        self._message_rx_listeners: list = []
        self._rx_codec = None

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

    def off_log(self, cb) -> None:
        if cb in self._log_listeners:
            self._log_listeners.remove(cb)

    async def connect_serial(self, port: str, baud_rate: int = 115200) -> None:
        await self.disconnect()
        t = SerialTransport()
        t.on_packet(lambda p: self._log_line(f"RX [{p.family:02x}/{p.command:02x}] {p.hex_preview}"))
        t.on_log(self._log_line)
        await t.connect(port, baud_rate=baud_rate)
        self._transport, self._kind, self._target = t, "serial", port
        self._install_ptt_rx_listener(t)
        self._install_message_rx_listener(t)
        # NOTE (29/08/2026): remembering the device is now an EXPLICIT action
        # taken by the frontend (see app.js's btn-connect-serial handler),
        # not an automatic side effect of every successful connect. This used
        # to unconditionally re-add the device via store.remember_device()
        # here, which silently undid "Forget" the moment the person
        # reconnected to the same port for any reason -- confirmed as a real,
        # reported bug. See CONSIGNES_PROJET.md.
        self._log_line(f"Connecté en série sur {port} @ {baud_rate} bauds")

    async def connect_ble(self, address: str) -> None:
        await self.disconnect()
        t = BleTransport()
        t.on_packet(lambda p: self._log_line(f"RX [{p.family:02x}/{p.command:02x}] {p.hex_preview}"))
        t.on_log(self._log_line)
        await t.connect(address)
        self._transport, self._kind, self._target = t, "ble", address
        self._install_ptt_rx_listener(t)
        self._install_message_rx_listener(t)
        # NOTE (29/08/2026): same reasoning as connect_serial above --
        # remembering is now explicit (app.js's btn-scan-ble handler already
        # does its own remember_device call with the proper scanned name
        # right after this returns). No longer done automatically here.
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

    async def set_vox_sensitivity(self, level: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_vox_sensitivity(level))

    async def set_tot_seconds(self, seconds: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_tot_seconds(seconds))

    async def set_tx_inhibit(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_tx_inhibit(enabled))

    async def set_noise_reduction(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_noise_reduction(enabled))

    async def set_prompt_tone(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_prompt_tone(enabled))

    async def set_device_name(self, name: str) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_device_name(name))

    async def set_smart_link(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_smart_link(enabled))

    async def select_channel(self, channel_number: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.select_channel(channel_number))

    # -- debug ----------------------------------------------------------------

    async def send_debug_raw_frame(self, frame: bytes, listen_seconds: float = 2.0) -> None:
        """Backs the "raw frame" debug panel in the UI (app.js's
        #btn-send-raw-frame). Sends an already fully-encoded frame
        (AA55..77EE) as-is -- no protocol validation, this is meant for
        probing undocumented commands while reverse-engineering. TX and
        any RX are already surfaced in the Journal automatically (the TX
        log line comes from Transport.send_raw_frame itself; RX comes
        from the packet listener installed in connect_serial/connect_ble),
        so this just needs to send and give the radio time to answer."""
        t = self._require_transport()
        self._log_line(f"[DEBUG] Envoi trame brute: {frame.hex()}")
        await t.send_raw_frame(frame)
        if listen_seconds > 0:
            await asyncio.sleep(listen_seconds)

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

    async def send_position(self, username: str, lat: float, lon: float, note: str = "") -> None:
        """Position beacon / SOS, piggybacked on the (verified, working)
        text messaging channel -- see README for why this isn't a
        dedicated structured location message type yet."""
        prefix = f"{note + ' ' if note else ''}📍 {lat:.5f},{lon:.5f}"
        await self.send_text_message(username, prefix)

    async def send_voice_message(self, username: str, pcm_16khz_or_8khz: bytes, duration_ms: int) -> None:
        """Store-and-forward voice note (distinct from live PTT). `pcm` must
        be 16-bit mono @ 8kHz, already resampled by the caller (browser
        or upload handler) -- same format PttSession expects."""
        from app.protocol.amr_codec import AmrNbCodec, FRAME_BYTES_PCM

        t = self._require_transport()
        codec = AmrNbCodec()
        try:
            encoded = bytearray()
            for i in range(0, len(pcm_16khz_or_8khz) - FRAME_BYTES_PCM + 1, FRAME_BYTES_PCM):
                frame_pcm = pcm_16khz_or_8khz[i:i + FRAME_BYTES_PCM]
                amr = codec.encode(frame_pcm)
                if amr:
                    encoded += amr
            if not encoded:
                raise ValueError("no audio to send (recording too short?)")
            msg_id = self._next_msg_id
            self._next_msg_id = (self._next_msg_id + 1) & 0xFFFFFFFF
            frames = messages.build_voice_message_frames(username, bytes(encoded), duration_ms, msg_id)
            for f in frames:
                await t.send_raw_frame(f)
                await asyncio.sleep(0.1)
            self._log_line(f"Message vocal envoyé ({duration_ms}ms, {len(frames)} trame(s))")
        finally:
            codec.close()

    async def send_image_message(self, username: str, jpeg_bytes: bytes, width: int, height: int) -> None:
        """`jpeg_bytes` should already be resized/compressed to
        IMAGE_LONG_EDGE_PX / IMAGE_JPEG_QUALITY -- see app/main.py's
        image upload endpoint, which does this with Pillow before
        calling here."""
        t = self._require_transport()
        msg_id = self._next_msg_id
        self._next_msg_id = (self._next_msg_id + 1) & 0xFFFFFFFF
        frames = messages.build_image_message_frames(username, jpeg_bytes, width, height, msg_id)
        for f in frames:
            await t.send_raw_frame(f)
            await asyncio.sleep(0.1)
        self._log_line(f"Image envoyée ({len(jpeg_bytes)} octets, {len(frames)} trame(s))")

    def on_message_received(self, callback) -> None:
        """`callback(CompletedMessage)` fires once a full text/voice/image
        offline message has been reassembled from incoming packets."""
        self._message_rx_listeners.append(callback)

    def off_message_received(self, callback) -> None:
        if callback in self._message_rx_listeners:
            self._message_rx_listeners.remove(callback)

    def _install_message_rx_listener(self, transport: Transport) -> None:
        assembler = messages.MessageAssembler()

        def _on_packet(pkt) -> None:
            # Skip PTT voice packets -- same family/command, distinguished
            # by subtype (see app/protocol/ptt.py::PTT_VOICE_SUBTYPE).
            from app.protocol import ptt as ptt_proto
            if ptt_proto.is_ptt_voice_packet(pkt.family, pkt.command, pkt.body):
                return
            completed = assembler.feed(pkt)
            if completed is None:
                return
            for cb in list(self._message_rx_listeners):
                try:
                    cb(completed)
                except Exception:
                    logger.exception("message rx listener raised")

        transport.on_packet(_on_packet)

    # -- live PTT (real-time voice) -----------------------------------------

    def start_ptt_session(self) -> "PttSession":
        t = self._require_transport()
        return PttSession(t, self._log_line)

    def on_ptt_voice_packet(self, callback) -> None:
        """`callback(pcm_bytes)` is invoked (sync) with 320 bytes of decoded
        PCM for every incoming voice packet on the active transport."""
        self._ptt_rx_listeners.append(callback)

    def off_ptt_voice_packet(self, callback) -> None:
        if callback in self._ptt_rx_listeners:
            self._ptt_rx_listeners.remove(callback)

    def _install_ptt_rx_listener(self, transport: Transport) -> None:
        from app.protocol.amr_codec import AmrNbCodec
        from app.protocol import ptt as ptt_proto

        rx_codec = AmrNbCodec()
        self._rx_codec = rx_codec

        def _on_packet(pkt) -> None:
            if not ptt_proto.is_ptt_voice_packet(pkt.family, pkt.command, pkt.body):
                return
            for amr_frame in ptt_proto.extract_amr_frames(pkt.body):
                pcm = rx_codec.decode(amr_frame)
                for cb in list(self._ptt_rx_listeners):
                    try:
                        cb(pcm)
                    except Exception:
                        logger.exception("PTT rx listener raised")

        transport.on_packet(_on_packet)


class PttSession:
    """One push-to-talk transmission: buffers 20ms PCM frames, AMR-encodes
    them, and sends them to the radio in 100ms (5-frame) packets, exactly
    matching PttVoiceSender.kt's pacing and chunking.
    """

    def __init__(self, transport: Transport, log_line) -> None:
        from app.protocol.amr_codec import AmrNbCodec
        from app.protocol import ptt as ptt_proto

        self._transport = transport
        self._log_line = log_line
        self._codec = AmrNbCodec()
        self._ptt_proto = ptt_proto
        self._pending_amr: list[bytes] = []
        self._last_send = 0.0

    async def feed_pcm_frame(self, pcm_320_bytes: bytes) -> None:
        """Call once per 20ms with exactly 320 bytes of 16-bit mono PCM @8kHz."""
        encoded = self._codec.encode(pcm_320_bytes)
        if encoded is None:
            return
        self._pending_amr.append(encoded)
        if len(self._pending_amr) >= self._ptt_proto.FRAMES_PER_PACKET:
            await self._flush(self._ptt_proto.FRAMES_PER_PACKET)

    async def _flush(self, count: int) -> None:
        if len(self._pending_amr) < count:
            return
        chunk, self._pending_amr = self._pending_amr[:count], self._pending_amr[count:]
        now = asyncio.get_event_loop().time()
        gap = now - self._last_send
        if self._last_send and gap < self._ptt_proto.PACKET_PACING_SECONDS:
            await asyncio.sleep(self._ptt_proto.PACKET_PACING_SECONDS - gap)
        self._last_send = asyncio.get_event_loop().time()
        payload = self._ptt_proto.build_ptt_voice_payload(chunk)
        await self._transport.send_payload(payload)

    async def close(self) -> None:
        if len(self._pending_amr) >= self._ptt_proto.TAIL_MIN_FRAMES:
            await self._flush(len(self._pending_amr))
        self._codec.close()
        self._log_line("PTT: transmission terminée")


device_manager = DeviceManager()
