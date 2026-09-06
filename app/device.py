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
        self._message_ack_event = asyncio.Event()
        # Guards the whole send+ack-wait cycle in _send_message_frames_with_ack:
        # _message_ack_event is a single instance shared across every call,
        # so two concurrent sends (e.g. two browser tabs, or two overlapping
        # API requests) would otherwise race on it and interleave their
        # frames on the wire -- an ack meant for one message could satisfy
        # the other's wait, and their raw frames could physically interleave
        # on the transport, silently corrupting/truncating both messages on
        # the receiving radio with no error surfaced anywhere.
        self._message_send_lock = asyncio.Lock()

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

    # -- debug --------------------------------------------------------------

    async def send_debug_raw_frame(self, frame_hex: str, listen_seconds: float = 2.0) -> None:
        """EXPERIMENTAL / DEBUG ONLY. Sends an ALREADY fully-encoded frame
        (AA55...77EE, hex string) as-is -- no envelope/CRC is built here,
        unlike write_channel/send_payload -- so arbitrary protocol
        hypotheses can be tested directly, including intentionally
        malformed ones. TX/RX logging is automatic via the existing
        Journal wiring (on_log/on_packet), so this just sends and waits;
        it does not itself interpret or return the response."""
        t = self._require_transport()
        try:
            frame = bytes.fromhex(frame_hex.strip().replace(" ", ""))
        except ValueError as e:
            raise ValueError(f"hex invalide: {e}") from e
        await t.send_raw_frame(frame)
        listen_seconds = max(0.0, min(listen_seconds, 10.0))  # hard cap, this is a debug tool not a client-controlled sleep
        if listen_seconds:
            await asyncio.sleep(listen_seconds)

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

    async def set_dual_watch(self, enabled: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_dual_watch(enabled))

    async def select_dual_watch_channel(self, side: str, channel_number: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.select_dual_watch_channel(side, channel_number))

    async def select_dual_watch_focus(self, side: str) -> None:
        t = self._require_transport()
        await t.send_payload(commands.select_dual_watch_focus(side))

    async def set_prompt_language(self, english: bool) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_prompt_language(english))

    async def set_tx_interval_seconds(self, seconds: int) -> None:
        t = self._require_transport()
        await t.send_payload(commands.set_tx_interval_seconds(seconds))

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

    # -- messaging ----------------------------------------------------------

    async def send_text_message(self, username: str, text: str) -> None:
        t = self._require_transport()
        msg_id = self._next_msg_id
        self._next_msg_id = (self._next_msg_id + 1) & 0xFFFFFFFF
        frames = messages.build_text_message_frames(username, text, msg_id)
        await self._send_message_frames_with_ack(
            t, frames, "Message texte",
            self.MESSAGE_TEXT_FIRST_CHUNK_DELAY_SECONDS, self.MESSAGE_TEXT_CHUNK_PERIOD_SECONDS,
        )
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
            await self._send_message_frames_with_ack(
                t, frames, "Message vocal",
                self.MESSAGE_VOICE_FIRST_CHUNK_DELAY_SECONDS, self.MESSAGE_VOICE_CHUNK_PERIOD_SECONDS,
            )
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
        await self._send_message_frames_with_ack(
            t, frames, "Image",
            self.MESSAGE_IMAGE_FIRST_CHUNK_DELAY_SECONDS, self.MESSAGE_IMAGE_CHUNK_PERIOD_SECONDS,
        )
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
            if messages.is_message_ack(pkt.family, pkt.command, pkt.body):
                self._message_ack_event.set()
                return
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

    # -- offline messaging: ack-aware sending --------------------------------
    #
    # Each frame is sent, then we wait for the radio's ack (family=0x82,
    # command=0x04) before sending the next one, retrying a dropped frame
    # up to MESSAGE_ACK_RETRIES times -- ported from
    # `At2ProtocolExecutor.kt::sendOfflineBusinessFrameWithAck`. The
    # previous implementation here just fired every frame with a fixed
    # delay and never checked for a response at all: a single dropped
    # frame on a lossy BLE link (a very real failure mode already
    # confirmed elsewhere in this project -- see ble-client.js's
    # concurrent-write comment) would silently truncate whatever the
    # receiving end could reassemble, with zero indication anything went
    # wrong on either end.

    MESSAGE_ACK_TIMEOUT_SECONDS = 1.5
    MESSAGE_ACK_RETRIES = 3
    MESSAGE_ACK_RETRY_BACKOFF_SECONDS = 0.22

    # Minimum, fixed-cadence pacing enforced BETWEEN successive chunk
    # frames of a multi-frame message, on top of the ack-wait above --
    # ported from At2ProtocolExecutor.kt's OFFLINE_*_FIRST_CHUNK_DELAY_MS /
    # OFFLINE_*_CHUNK_PERIOD_MS + delayUntil(). This was missing entirely
    # until now: the ack we wait for is almost immediate (it just confirms
    # the radio queued the frame over BLE), NOT that it finished actually
    # keying up and transmitting that chunk over RF to the other radio. Without
    # this extra floor, frames were pushed to the radio's TX pipeline far
    # faster than it can physically key/transmit each one on air, so most of
    # a message's chunks never actually left the radio (or arrived corrupted)
    # even though every local BLE ack came back fine -- explaining the
    # confirmed symptom (2026-09-05 live test): text (1-2 short frames)
    # arrived fine, but image (up to 255 chunks) never arrived at all, and
    # voice (dozens of chunks) arrived as a corrupt partial reassembly.
    # `next_chunk_at` is a fixed schedule anchored right after frame 0's ack
    # (not "first_chunk_delay + previous chunk's ack latency"), matching the
    # reference's own delayUntil()/nextChunkAtNs accumulation -- it's a
    # floor, so a slow ack round-trip never gets penalized twice.
    MESSAGE_TEXT_FIRST_CHUNK_DELAY_SECONDS = 0.36
    MESSAGE_TEXT_CHUNK_PERIOD_SECONDS = 0.40
    MESSAGE_VOICE_FIRST_CHUNK_DELAY_SECONDS = 0.35
    MESSAGE_VOICE_CHUNK_PERIOD_SECONDS = 0.36
    MESSAGE_IMAGE_FIRST_CHUNK_DELAY_SECONDS = 0.36
    MESSAGE_IMAGE_CHUNK_PERIOD_SECONDS = 0.40

    async def _send_message_frames_with_ack(
        self,
        transport: Transport,
        frames: list[bytes],
        tag: str,
        first_chunk_delay_seconds: float = 0.0,
        chunk_period_seconds: float = 0.0,
    ) -> None:
        # Serializes the whole send+ack-wait cycle across concurrent calls
        # (two overlapping API requests, two browser tabs, ...) -- see
        # _message_send_lock's docstring in __init__ for why this is
        # needed: _message_ack_event is one shared instance, and without
        # this lock two concurrent messages could interleave their frames
        # on the wire and steal each other's acks.
        async with self._message_send_lock:
            loop = asyncio.get_event_loop()
            next_chunk_at: float | None = None
            for index, f in enumerate(frames):
                if index >= 1 and next_chunk_at is not None:
                    wait = next_chunk_at - loop.time()
                    if wait > 0:
                        await asyncio.sleep(wait)
                for attempt in range(1, self.MESSAGE_ACK_RETRIES + 1):
                    self._message_ack_event.clear()
                    await transport.send_raw_frame(f)
                    try:
                        await asyncio.wait_for(
                            self._message_ack_event.wait(), timeout=self.MESSAGE_ACK_TIMEOUT_SECONDS
                        )
                        break
                    except asyncio.TimeoutError:
                        if attempt == self.MESSAGE_ACK_RETRIES:
                            # RuntimeError, not TimeoutError: app/main.py has a
                            # dedicated handler that surfaces a RuntimeError's
                            # message to the client (409) -- any other
                            # exception type is caught by the generic handler
                            # and flattened to a content-free "internal server
                            # error", which would defeat the point of this
                            # error message (see app/main.py's exception
                            # handlers section).
                            raise RuntimeError(
                                f"{tag}: pas d'accusé de réception de la radio pour la trame "
                                f"{index + 1}/{len(frames)} après {self.MESSAGE_ACK_RETRIES} tentatives"
                            )
                        self._log_line(
                            f"{tag}: pas d'accusé pour la trame {index + 1}/{len(frames)}, "
                            f"nouvelle tentative ({attempt}/{self.MESSAGE_ACK_RETRIES})"
                        )
                        await asyncio.sleep(self.MESSAGE_ACK_RETRY_BACKOFF_SECONDS)
                if index == 0:
                    next_chunk_at = loop.time() + first_chunk_delay_seconds
                elif next_chunk_at is not None:
                    next_chunk_at += chunk_period_seconds

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

    async def start(self) -> None:
        """Key the radio's transmitter on. MUST be awaited before feeding
        the first PCM frame -- ported from
        `At2ProtocolExecutor.kt::setOfflineMode(ptt=true)` /
        `enterPttPreflight()` in the reference Android app. This was
        previously entirely missing here: voice packets were built,
        paced, and sent correctly, but the radio was never told to key
        up, so it silently discarded them -- a very plausible explanation
        for live PTT producing no audio on real hardware.
        """
        await self._transport.send_payload(self._ptt_proto.build_offline_session_payload(True))
        await self._transport.send_payload(self._ptt_proto.build_ptt_key_payload(True))
        await asyncio.sleep(0.02)  # give the radio a moment to key up, mirrors the reference app's 20ms guard

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
        try:
            await self._transport.send_payload(self._ptt_proto.build_ptt_key_payload(False))
        except Exception:
            logger.exception("failed to send PTT key-off")
        self._codec.close()
        self._log_line("PTT: transmission terminée")


device_manager = DeviceManager()
