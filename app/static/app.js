const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let mode = "server"; // "server" | "local"
let connected = false;
let localDeviceInfo = null;

// ---------------------------------------------------------------------------
// Auth (shared-password token, see app/auth.py -- no-op if server-side
// auth is disabled, i.e. AT2_BRIDGE_PASSWORD unset)
// ---------------------------------------------------------------------------
let authToken = sessionStorage.getItem("at2_token") || null;

function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${location.host}${path}`;
  return authToken ? `${base}?token=${encodeURIComponent(authToken)}` : base;
}

function showLoginOverlay(errored) {
  $("#login-overlay").style.display = "flex";
  $("#login-error").style.display = errored ? "block" : "none";
}

function hideLoginOverlay() {
  $("#login-overlay").style.display = "none";
}

async function checkAuthStatus() {
  const res = await fetch("/api/auth/status");
  const { enabled } = await res.json();
  if (enabled && !authToken) {
    showLoginOverlay(false);
    return false;
  }
  return true;
}

$("#login-submit").addEventListener("click", async () => {
  const password = $("#login-password").value;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) { showLoginOverlay(true); return; }
    const { token } = await res.json();
    authToken = token;
    sessionStorage.setItem("at2_token", token);
    hideLoginOverlay();
    startApp();
  } catch (e) {
    showLoginOverlay(true);
  }
});
$("#login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#login-submit").click();
});

async function api(method, path, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    authToken = null;
    sessionStorage.removeItem("at2_token");
    showLoginOverlay(false);
    throw new Error("Session expirée, reconnecte-toi.");
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function apiUpload(path, formData) {
  const headers = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(path, { method: "POST", headers, body: formData });
  if (res.status === 401) {
    authToken = null;
    sessionStorage.removeItem("at2_token");
    showLoginOverlay(false);
    throw new Error("Session expirée, reconnecte-toi.");
  }
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

function appendLog(line) {
  const el = $("#log-console");
  const now = new Date().toLocaleTimeString("fr-FR");
  el.textContent += `[${now}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Mode toggle (server vs local Web Bluetooth)
// ---------------------------------------------------------------------------
function applyModeUi() {
  $("#mode-server").classList.toggle("active", mode === "server");
  $("#mode-local").classList.toggle("active", mode === "local");
  $("#server-controls").hidden = mode !== "server";
  $("#local-controls").hidden = mode !== "local";
  $("#ptt-hint").textContent = mode === "server"
    ? "Maintiens pour émettre — encode et transmet la voix en temps réel"
    : "PTT vocal indisponible en mode BLE local (nécessite le décodeur du serveur)";
  $("#ptt-btn").disabled = mode === "local";
}

const localSupported = AT2BleClient.isSupported();
if (!localSupported) {
  $("#mode-local").disabled = true;
  $("#mode-local").title = "Web Bluetooth non disponible sur ce navigateur (indisponible sur tout navigateur iOS)";
}

$("#mode-server").addEventListener("click", () => { mode = "server"; applyModeUi(); refreshStatus(); });
$("#mode-local").addEventListener("click", () => {
  if (!localSupported) return;
  mode = "local";
  applyModeUi();
  updateLocalStatusUi();
});
applyModeUi();

// ---------------------------------------------------------------------------
// Server-mode connection
// ---------------------------------------------------------------------------
function setConnUi(isConnected, label) {
  connected = isConnected;
  $("#brand-mark").classList.toggle("connected", isConnected);
  $("#status-pill").classList.toggle("up", isConnected);
  $("#conn-label").textContent = label;
}

async function refreshStatus() {
  if (mode !== "server") return;
  const status = await api("GET", "/api/connection/status");
  setConnUi(status.connected, status.connected ? `Connecté (${status.kind} · ${status.target})` : "Déconnecté");
  $("#btn-disconnect").hidden = !status.connected;
}

async function refreshSerialPorts() {
  const ports = await api("GET", "/api/connection/serial/ports");
  const select = $("#serial-port-select");
  select.innerHTML = ports.length
    ? ports.map((p) => `<option value="${p.path}">${p.path} — ${p.description}</option>`).join("")
    : `<option value="">Aucun port détecté</option>`;
}

$("#btn-refresh-ports").addEventListener("click", refreshSerialPorts);

$("#btn-connect-serial").addEventListener("click", async () => {
  const port = $("#serial-port-select").value;
  if (!port) return alert("Sélectionne un port série d'abord.");
  try {
    await api("POST", "/api/connection/serial/connect", { port, baud_rate: 115200 });
    await refreshStatus();
  } catch (e) { alert(e.message); }
});

$("#btn-scan-ble").addEventListener("click", async () => {
  try {
    const devices = await api("GET", "/api/connection/ble/scan");
    if (!devices.length) return alert("Aucun appareil BLE trouvé à proximité du serveur.");
    const names = devices.map((d, i) => `${i}: ${d.name} (${d.address})`).join("\n");
    const choice = prompt(`Appareils trouvés :\n${names}\n\nEntre le numéro à connecter :`);
    const idx = parseInt(choice, 10);
    if (Number.isNaN(idx) || !devices[idx]) return;
    await api("POST", "/api/connection/ble/connect", { address: devices[idx].address });
    await api("POST", "/api/known-devices", {
      id: `ble-${devices[idx].address}`, name: devices[idx].name, transport: "ble", target: devices[idx].address,
    });
    await refreshStatus();
    await loadDeviceList();
  } catch (e) { alert(e.message); }
});

$("#btn-disconnect").addEventListener("click", async () => {
  await api("POST", "/api/connection/disconnect");
  await refreshStatus();
});

// ---------------------------------------------------------------------------
// Local mode (Web Bluetooth) connection
// ---------------------------------------------------------------------------
function updateLocalStatusUi() {
  const isConnected = AT2BleClient.connected();
  setConnUi(isConnected, isConnected ? `Connecté (local · ${localDeviceInfo?.name || "?"})` : "Déconnecté (BLE local)");
  $("#btn-local-disconnect").hidden = !isConnected;
}

$("#btn-local-connect").addEventListener("click", async () => {
  try {
    localDeviceInfo = await AT2BleClient.connect();
    updateLocalStatusUi();
    appendLog(`BLE local connecté: ${localDeviceInfo.name}`);
  } catch (e) { alert(e.message); }
});
$("#btn-local-disconnect").addEventListener("click", async () => {
  await AT2BleClient.disconnect();
  updateLocalStatusUi();
});
AT2BleClient.onPacket((pkt) => appendLog(`RX local [${pkt.family.toString(16)}/${pkt.command.toString(16)}]`));

// ---------------------------------------------------------------------------
// Devices tab: known devices list
// ---------------------------------------------------------------------------
async function loadDeviceList() {
  const list = $("#device-list");
  try {
    const known = await api("GET", "/api/known-devices");
    if (!known.length) {
      list.innerHTML = `<div class="card hint">Aucun appareil connu pour l'instant — scanne en BLE ou connecte-toi en série pour en enregistrer un.</div>`;
      return;
    }
    list.innerHTML = known.map((d) => `
      <div class="card device-card">
        <div class="device-thumb">📻</div>
        <div class="device-card-info">
          <div class="device-card-name">${d.name}</div>
          <div class="device-card-model">${d.transport.toUpperCase()} · ${d.target}</div>
        </div>
        <div class="device-card-actions">
          <button class="btn-primary" onclick="reconnectKnownDevice('${d.id}', '${d.transport}', '${d.target}')">Connecter</button>
          <button class="btn-ghost" onclick="forgetKnownDevice('${d.id}')">Oublier</button>
        </div>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<div class="card hint">${e.message}</div>`;
  }
}

async function reconnectKnownDevice(id, transport, target) {
  try {
    if (transport === "ble") await api("POST", "/api/connection/ble/connect", { address: target });
    else await api("POST", "/api/connection/serial/connect", { port: target, baud_rate: 115200 });
    await refreshStatus();
  } catch (e) { alert(e.message); }
}

async function forgetKnownDevice(id) {
  await api("DELETE", `/api/known-devices/${id}`);
  await loadDeviceList();
}

// ---------------------------------------------------------------------------
// Compact channel switcher
// ---------------------------------------------------------------------------
let channelNames = {};
let activeChannel = 1;
let lastReadChannels = [];

async function loadChannelNames() {
  channelNames = await api("GET", "/api/channel-names");
}

function renderChanSelect() {
  const sel = $("#chan-select");
  sel.innerHTML = Array.from({ length: 30 }, (_, i) => i + 1)
    .map((n) => `<option value="${n}">CH${String(n).padStart(2, "0")} · ${channelNames[n] || "—"}</option>`)
    .join("");
  sel.value = activeChannel;
}

function renderChanOpts() {
  const cfg = lastReadChannels.find((c) => c.channel === activeChannel);
  const opts = cfg
    ? [
        { icon: cfg.high_power ? "H" : "L", title: cfg.high_power ? "Puissance haute" : "Puissance basse", on: cfg.high_power },
        { icon: cfg.bandwidth_narrow ? "N" : "W", title: cfg.bandwidth_narrow ? "Bande étroite" : "Bande large", on: cfg.bandwidth_narrow },
        { icon: "📡", title: cfg.scan_add ? "Ajouté au scan" : "Exclu du scan", on: cfg.scan_add },
        { icon: cfg.mode_digital ? "D" : "A", title: cfg.mode_digital ? "Numérique" : "Analogique", on: cfg.mode_digital, warn: cfg.mode_digital },
      ]
    : [{ icon: "?", title: "Lis les canaux pour voir les options", on: false }];
  $("#chan-opts").innerHTML = opts
    .map((o) => `<span class="chan-opt-icon ${o.on ? (o.warn ? "warn-on" : "on") : ""}" title="${o.title}">${o.icon}</span>`)
    .join("");
}

async function applyActiveChannel(select = true) {
  renderChanSelect();
  renderChanOpts();
  $("#ptt-device-sub").textContent = `CH${String(activeChannel).padStart(2, "0")}${channelNames[activeChannel] ? " · " + channelNames[activeChannel] : ""}`;
  if (select) {
    try {
      if (mode === "server") await api("POST", `/api/channels/${activeChannel}/select`);
      else if (AT2BleClient.connected()) await AT2BleClient.selectChannel(activeChannel);
    } catch (e) { appendLog(`Erreur sélection canal: ${e.message}`); }
  }
}

$("#chan-select").addEventListener("change", (e) => { activeChannel = parseInt(e.target.value, 10); applyActiveChannel(); });
$("#chan-prev").addEventListener("click", () => { activeChannel = activeChannel > 1 ? activeChannel - 1 : 30; applyActiveChannel(); });
$("#chan-next").addEventListener("click", () => { activeChannel = activeChannel < 30 ? activeChannel + 1 : 1; applyActiveChannel(); });
$("#chan-rename").addEventListener("click", async () => {
  const name = prompt(`Nom pour le canal ${activeChannel} :`, channelNames[activeChannel] || "");
  if (name === null) return;
  await api("PUT", `/api/channel-names/${activeChannel}`, { name });
  await loadChannelNames();
  applyActiveChannel(false);
});

// ---------------------------------------------------------------------------
// Live PTT (server mode: real mic capture + AMR encode server-side + WS)
// ---------------------------------------------------------------------------
const waveEl = $("#ptt-wave");
for (let i = 0; i < 40; i++) {
  const bar = document.createElement("span");
  bar.style.height = "3px";
  waveEl.appendChild(bar);
}
function setWaveHeights(active) {
  waveEl.querySelectorAll("span").forEach((bar) => {
    bar.style.height = (active ? 4 + Math.random() * 46 : 3) + "px";
  });
}
let waveTimer = setInterval(() => setWaveHeights(false), 90);

let pttSocket = null;
let pttActive = false;
let pttStart = null;
let pttTimerInterval = null;

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function startPtt() {
  if (mode !== "server" || !connected || pttActive) return;
  pttActive = true;
  pttStart = Date.now();
  $("#ptt-btn").classList.add("pressed");
  waveEl.classList.add("active");
  $("#rf-indicator").classList.add("tx");
  $("#rf-label").textContent = "TX";
  pttTimerInterval = setInterval(() => {
    $("#ptt-timer").textContent = formatTimer(Date.now() - pttStart);
  }, 200);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  pttSocket = new WebSocket(wsUrl("/ws/ptt"));
  pttSocket.binaryType = "arraybuffer";
  pttSocket.onmessage = (evt) => {
    const pcm = new Int16Array(evt.data);
    PttAudio.playPcmFrame(pcm);
    $("#rf-indicator").classList.add("rx");
  };
  pttSocket.onopen = async () => {
    await PttAudio.startCapture((int16Frame) => {
      if (pttSocket && pttSocket.readyState === WebSocket.OPEN) {
        pttSocket.send(int16Frame.buffer);
      }
      setWaveHeights(true);
    });
  };
  pttSocket.onerror = () => appendLog("PTT WS erreur");
}

function stopPtt() {
  if (!pttActive) return;
  pttActive = false;
  PttAudio.stopCapture();
  if (pttSocket) { pttSocket.close(); pttSocket = null; }
  $("#ptt-btn").classList.remove("pressed");
  waveEl.classList.remove("active");
  $("#rf-indicator").classList.remove("tx", "rx");
  $("#rf-label").textContent = "Standby";
  clearInterval(pttTimerInterval);
  $("#ptt-timer").textContent = "00:00";
}

const pttBtn = $("#ptt-btn");
pttBtn.addEventListener("mousedown", startPtt);
pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startPtt(); });
["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((evt) => pttBtn.addEventListener(evt, stopPtt));

// ---------------------------------------------------------------------------
// GPS position + SOS
// ---------------------------------------------------------------------------
let lastCoords = null;
let beaconTimer = null;

function formatCoords(lat, lon) { return `${lat.toFixed(5)}° , ${lon.toFixed(5)}°`; }
function updateGpsFix(locked, label) {
  $("#gps-fix").classList.toggle("locked", locked);
  $("#gps-fix-label").textContent = label;
}

function requestLocation() {
  if (!navigator.geolocation) { updateGpsFix(false, "Géolocalisation indisponible"); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      $("#gps-coords").textContent = formatCoords(lastCoords.lat, lastCoords.lon);
      $("#gps-accuracy").textContent = `précision ≈ ${Math.round(lastCoords.acc)} m`;
      updateGpsFix(true, "Fix GPS acquis");
    },
    () => updateGpsFix(false, "Localisation refusée"),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
requestLocation();

async function sendPositionPayload(url, note) {
  if (!lastCoords) return alert("Pas de position GPS disponible.");
  const username = $("#msg-username")?.value || "AT2Bridge";
  if (mode === "server") {
    await api("POST", url, { username, lat: lastCoords.lat, lon: lastCoords.lon, note });
  } else if (AT2BleClient.connected()) {
    await AT2BleClient.sendText(username, `${note} 📍 ${formatCoords(lastCoords.lat, lastCoords.lon)}`);
  } else {
    alert("Aucune connexion active.");
  }
}

$("#gps-send-now").addEventListener("click", async () => {
  try {
    await sendPositionPayload("/api/position/send", "");
    $("#beacon-status").textContent = `Position envoyée à l'instant (${formatCoords(lastCoords.lat, lastCoords.lon)})`;
  } catch (e) { alert(e.message); }
});

$("#beacon-toggle").addEventListener("change", (e) => {
  const status = $("#beacon-status");
  if (e.target.checked) {
    const seconds = parseInt($("#beacon-interval").value, 10);
    const label = seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
    status.textContent = `Balise active — envoi toutes les ${label}`;
    beaconTimer = setInterval(async () => {
      requestLocation();
      try { await sendPositionPayload("/api/position/send", ""); } catch (_) {}
      status.textContent = `Dernière balise envoyée à l'instant · prochaine dans ${label}`;
    }, seconds * 1000);
  } else {
    clearInterval(beaconTimer);
    status.textContent = "Balise désactivée";
  }
});
$("#beacon-interval").addEventListener("change", () => {
  if ($("#beacon-toggle").checked) $("#beacon-toggle").dispatchEvent(new Event("change"));
});

$("#sos-btn").addEventListener("click", async () => {
  const btn = $("#sos-btn");
  const preset = $("#sos-preset").value;
  try {
    await sendPositionPayload("/api/position/sos", preset);
    btn.classList.add("sent");
    btn.textContent = "✔ Envoyé";
    setTimeout(() => { btn.classList.remove("sent"); btn.textContent = "🆘 SOS"; }, 2200);
  } catch (e) { alert(e.message); }
});

// ---------------------------------------------------------------------------
// Channel table (bulk read/write)
// ---------------------------------------------------------------------------
let toneOptions = ["OFF"];

function channelRowHtml(ch) {
  const toneSelect = (value) => `<select class="tone-select">${toneOptions.map((t) => `<option value="${t}" ${t === value ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  return `
    <tr data-channel="${ch.channel}">
      <td>${ch.channel}</td>
      <td><input type="text" class="ch-name" value="${channelNames[ch.channel] || ch.name || ""}" placeholder="—" /></td>
      <td class="freq-cell"><input type="number" step="0.00001" class="ch-rx" value="${ch.rx_mhz ?? ""}" /></td>
      <td class="freq-cell"><input type="number" step="0.00001" class="ch-tx" value="${ch.tx_mhz ?? ""}" /></td>
      <td>${toneSelect(ch.rx_tone ?? "OFF")}</td>
      <td>${toneSelect(ch.tx_tone ?? "OFF")}</td>
      <td><input type="checkbox" class="ch-bw" ${ch.bandwidth_narrow ? "checked" : ""} /></td>
      <td><input type="checkbox" class="ch-power" ${ch.high_power ? "checked" : ""} /></td>
      <td><input type="checkbox" class="ch-scan" ${ch.scan_add !== false ? "checked" : ""} /></td>
      <td><input type="checkbox" class="ch-digital" ${ch.mode_digital ? "checked" : ""} /></td>
      <td><button class="btn-ghost btn-write-one">Écrire</button></td>
    </tr>`;
}

function emptyChannels() {
  return Array.from({ length: 30 }, (_, i) => ({ channel: i + 1, rx_tone: "OFF", tx_tone: "OFF", bandwidth_narrow: true, high_power: true, scan_add: true }));
}

function renderChannelTable(channels) {
  $("#channel-table-body").innerHTML = channels.map(channelRowHtml).join("");
  $$(".btn-write-one").forEach((btn) => btn.addEventListener("click", async (e) => writeChannelRow(e.target.closest("tr"))));
}

function readChannelRow(row) {
  const num = parseInt(row.dataset.channel, 10);
  return {
    channel: num,
    name: row.querySelector(".ch-name").value || null,
    rx_mhz: parseFloat(row.querySelector(".ch-rx").value) || null,
    tx_mhz: parseFloat(row.querySelector(".ch-tx").value) || null,
    rx_tone: row.querySelectorAll(".tone-select")[0].value,
    tx_tone: row.querySelectorAll(".tone-select")[1].value,
    bandwidth_narrow: row.querySelector(".ch-bw").checked,
    high_power: row.querySelector(".ch-power").checked,
    scan_add: row.querySelector(".ch-scan").checked,
    mode_digital: row.querySelector(".ch-digital").checked,
    busy_lock: false, hop_on: false, encrypt_key: 0,
  };
}

async function writeChannelRow(row) {
  const cfg = readChannelRow(row);
  try {
    await api("PUT", `/api/channels/${cfg.channel}`, cfg);
    if (cfg.name) await api("PUT", `/api/channel-names/${cfg.channel}`, { name: cfg.name });
  } catch (e) { alert(e.message); }
}

$("#btn-read-channels").addEventListener("click", async () => {
  try {
    const channels = await api("GET", "/api/channels");
    lastReadChannels = channels.length ? channels : emptyChannels();
    renderChannelTable(lastReadChannels);
    renderChanOpts();
  } catch (e) { alert(e.message); }
});

$("#btn-write-channels").addEventListener("click", async () => {
  const configs = $$("#channel-table-body tr").map(readChannelRow);
  if (configs.length !== 30) return alert("Il faut exactement 30 lignes (utilise « Lire » d'abord).");
  try {
    await api("PUT", "/api/channels", configs);
    alert("Codeplug écrit.");
  } catch (e) { alert(e.message); }
});

renderChannelTable(emptyChannels());

// ---------------------------------------------------------------------------
// Device settings
// ---------------------------------------------------------------------------
$$("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      if (btn.dataset.action === "set-volume") await api("PUT", "/api/device/volume", { level: parseInt($("#volume-slider").value, 10) });
      if (btn.dataset.action === "set-squelch") await api("PUT", "/api/device/squelch", { level: parseInt($("#squelch-slider").value, 10) });
      if (btn.dataset.action === "set-vox") await api("PUT", "/api/device/vox", { enabled: $("#vox-toggle").checked });
    } catch (e) { alert(e.message); }
  });
});

// ---------------------------------------------------------------------------
// Messaging (single thread tied to the active channel; outgoing only for
// now -- inbound offline-message decoding isn't wired yet, see README)
// ---------------------------------------------------------------------------
function pushSentBubble(text) {
  const thread = $("#msg-thread");
  const el = document.createElement("div");
  el.className = "msg-bubble mine";
  el.innerHTML = `<div class="meta">Moi · ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div><div class="msg-body">${text}</div>`;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

$("#btn-send-message").addEventListener("click", async () => {
  const username = $("#msg-username").value || "AT2Bridge";
  const text = $("#msg-text").value.trim();
  if (!text) return;
  try {
    if (mode === "server") await api("POST", "/api/messages/text", { username, text });
    else if (AT2BleClient.connected()) await AT2BleClient.sendText(username, text);
    else return alert("Aucune connexion active.");
    pushSentBubble(text);
    $("#msg-text").value = "";
  } catch (e) { alert(e.message); }
});

// -- Image messages (server mode only -- image encoding happens server-side
// with Pillow, see app/main.py; no BLE-local equivalent yet) ---------------
$("#btn-attach-image").addEventListener("click", () => {
  if (mode !== "server") return alert("L'envoi d'image nécessite le mode Serveur.");
  $("#image-file-input").click();
});

$("#image-file-input").addEventListener("change", async () => {
  const file = $("#image-file-input").files[0];
  if (!file) return;
  const username = $("#msg-username").value || "AT2Bridge";
  const form = new FormData();
  form.append("username", username);
  form.append("image", file);
  try {
    await apiUpload("/api/messages/image", form);
    pushSentBubble(`🖼️ Image envoyée (${file.name})`);
  } catch (e) {
    alert(e.message);
  } finally {
    $("#image-file-input").value = "";
  }
});

// -- Voice notes (store-and-forward, distinct from live PTT). Reuses
// PttAudio.startCapture/stopCapture as-is (already exported by
// ptt-audio.js) to accumulate a full recording instead of streaming it. -
let voiceRecording = false;
let voiceChunks = [];

$("#btn-record-voice").addEventListener("click", async () => {
  if (mode !== "server") return alert("L'envoi vocal nécessite le mode Serveur.");
  const btn = $("#btn-record-voice");
  const status = $("#voice-record-status");

  if (!voiceRecording) {
    voiceRecording = true;
    voiceChunks = [];
    btn.textContent = "⏹️ Arrêter";
    status.textContent = "Enregistrement en cours…";
    try {
      await PttAudio.startCapture((int16Frame) => { voiceChunks.push(int16Frame); });
    } catch (e) {
      voiceRecording = false;
      btn.textContent = "🎙️ Vocal";
      status.textContent = "";
      alert(`Micro indisponible: ${e.message}`);
    }
  } else {
    voiceRecording = false;
    PttAudio.stopCapture();
    btn.textContent = "🎙️ Vocal";
    status.textContent = "Envoi…";

    const totalSamples = voiceChunks.reduce((sum, c) => sum + c.length, 0);
    if (totalSamples === 0) { status.textContent = ""; return; }
    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of voiceChunks) { merged.set(c, offset); offset += c.length; }
    const durationMs = Math.round((totalSamples / 8000) * 1000);

    const username = $("#msg-username").value || "AT2Bridge";
    const form = new FormData();
    form.append("username", username);
    form.append("duration_ms", String(durationMs));
    form.append("pcm", new Blob([merged.buffer], { type: "application/octet-stream" }), "voice.pcm");
    try {
      await apiUpload("/api/messages/voice", form);
      pushSentBubble(`🎙️ Message vocal envoyé (${Math.round(durationMs / 1000)}s)`);
      status.textContent = "";
    } catch (e) {
      status.textContent = "";
      alert(e.message);
    }
  }
});

// ---------------------------------------------------------------------------
// Live log (server mode only)
// ---------------------------------------------------------------------------
function connectLogSocket() {
  const ws = new WebSocket(wsUrl("/ws/log"));
  ws.onmessage = (evt) => appendLog(evt.data);
  ws.onclose = () => setTimeout(connectLogSocket, 2000);
}

// ---------------------------------------------------------------------------
// Incoming offline messages (text/voice/image) -- /ws/messages
// ---------------------------------------------------------------------------
function pushReceivedBubble(msg) {
  const thread = $("#msg-thread");
  const el = document.createElement("div");
  el.className = "msg-bubble";
  const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  let body;
  if (msg.kind === "text") {
    body = `<div class="msg-body">${msg.text ?? ""}</div>`;
  } else if (msg.kind === "image" && msg.data_base64) {
    body = `<div class="msg-body"><img src="data:image/jpeg;base64,${msg.data_base64}" style="max-width:220px; border-radius:6px; display:block;" /></div>`;
  } else if (msg.kind === "voice") {
    body = `<div class="msg-body">🎙️ Message vocal (${Math.round((msg.duration_ms || 0) / 1000)}s) — lecture non câblée côté navigateur pour les messages reçus.</div>`;
  } else {
    body = `<div class="msg-body">Message de type inconnu (${msg.kind})</div>`;
  }
  el.innerHTML = `<div class="meta">${msg.sender || "?"} · ${time}</div>${body}`;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

function connectMessagesSocket() {
  const ws = new WebSocket(wsUrl("/ws/messages"));
  ws.onmessage = (evt) => {
    try { pushReceivedBubble(JSON.parse(evt.data)); } catch (e) { appendLog(`Message entrant illisible: ${e.message}`); }
  };
  ws.onclose = () => setTimeout(connectMessagesSocket, 2000);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function startApp() {
  connectLogSocket();
  connectMessagesSocket();
  loadDeviceList();
  loadChannelNames().then(() => applyActiveChannel(false));
  api("GET", "/api/channels/tone-options").then((opts) => { toneOptions = opts; }).catch(() => {});
  refreshStatus();
  refreshSerialPorts();
  setInterval(() => { if (mode === "server") refreshStatus(); }, 5000);
}

checkAuthStatus().then((ok) => { if (ok) startApp(); });

