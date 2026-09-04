const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let mode = "server"; // "server" | "local"
let connected = false;
let localDeviceInfo = null;

/** Returns "server" | "local" | null based on which transport is
 * ACTUALLY connected -- ignores the `mode` tab entirely for routing
 * purposes (mode only controls which panel/controls are visible).
 * A stray click back to the "Serveur" tab while a BLE session was
 * still live previously caused PTT/channel actions to silently go to
 * a stale server connection instead -- confirmed via browser console
 * on 29/08/2026 (stack trace showed the server WebSocket path firing
 * for a PTT press made while BLE was connected). Preferring whichever
 * transport is actually connected removes this whole class of bugs;
 * there's no real use case in this app for wanting to route a command
 * to a DIFFERENT transport than the one currently connected. BLE wins
 * if, unusually, both happen to be connected at once. */
function activeTransport() {
  if (AT2BleClient.connected()) return "local";
  if (connected) return "server";
  return null;
}

// ---------------------------------------------------------------------------
// Language (i18n.js defines t()/setLang()/getLang()/applyTranslations()).
// Apply translations immediately so the login overlay (if shown before
// startApp() runs) is already in the right language.
// ---------------------------------------------------------------------------
applyTranslations();

$("#lang-toggle").textContent = getLang().toUpperCase();
$("#lang-toggle").addEventListener("click", () => {
  const next = getLang() === "fr" ? "en" : "fr";
  setLang(next);
  $("#lang-toggle").textContent = next.toUpperCase();
  refreshDynamicTranslations();
});

/** Re-render pieces of the UI that were built with t() at some point in
 * the past (e.g. connection status, channel options) so a language
 * switch mid-session doesn't leave stale text behind. Safe to call
 * even if some of these haven't run yet (they no-op on empty state). */
function refreshDynamicTranslations() {
  if (mode === "server") refreshStatus().catch(() => {});
  else updateLocalStatusUi();
  renderChanOpts();
  applyModeUi();
  if (!$("#device-list").children.length || $("#device-list").textContent.trim()) loadDeviceList();
}

// ---------------------------------------------------------------------------
// Theme (light/dark), persisted in localStorage -- pure UI preference,
// unrelated to the radio protocol, so it's fine independent of anything
// device-specific.
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-toggle").textContent = theme === "light" ? t("theme.light") : t("theme.dark");
}

const savedTheme = localStorage.getItem("at2_theme") || "dark";
applyTheme(savedTheme);

$("#theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "light" ? "dark" : "light";
  localStorage.setItem("at2_theme", next);
  applyTheme(next);
});

// ---------------------------------------------------------------------------
// Preferences dropdown (⚙ button in the topbar, merges theme + language
// into one menu now that the connection controls moved to the Devices tab).
// ---------------------------------------------------------------------------
$("#prefs-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#prefs-menu").hidden = !$("#prefs-menu").hidden;
});
document.addEventListener("click", (e) => {
  const menu = $("#prefs-menu");
  if (!menu.hidden && !menu.contains(e.target) && e.target !== $("#prefs-toggle")) {
    menu.hidden = true;
  }
});
// Keep the menu open after picking a preference (theme/lang) so someone
// can adjust both without re-opening -- only close on outside click above.

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
    throw new Error(t("login.sessionExpired"));
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
    throw new Error(t("login.sessionExpired"));
  }
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Journal (Log tab) -- structured lines (not just raw text) so we can
// color-code by type, copy just the last exchange, and export to a file.
// "Last exchange" = everything from the last non-RX line (a TX/DEBUG/PTT
// action) to the end -- matches the TX-then-RX(es) pattern already used
// consistently everywhere in this project's logging (serial/BLE transports,
// PttSession, the raw-frame debug tool), so no per-feature special-casing
// is needed here.
// ---------------------------------------------------------------------------
let logLines = []; // { timestamp, text, cls }
let lastActionStart = 0;

function classifyLogLine(text) {
  if (/^RX\b/.test(text)) return "log-rx";
  if (/^TX\b/.test(text)) return "log-tx";
  if (/^\[DEBUG\]/.test(text)) return "log-debug";
  if (/⚠️|erreur|error|échec|failed/i.test(text)) return "log-error";
  return "log-info";
}

function renderLogLine(entry) {
  const el = $("#log-console");
  const span = document.createElement("span");
  span.className = `log-line ${entry.cls}`;
  span.textContent = `[${entry.timestamp}] ${entry.text}\n`;
  el.appendChild(span);
}

function appendLog(line) {
  const now = new Date().toLocaleTimeString("fr-FR");
  const entry = { timestamp: now, text: line, cls: classifyLogLine(line) };
  logLines.push(entry);
  if (entry.cls !== "log-rx") lastActionStart = logLines.length - 1;
  renderLogLine(entry);
  const el = $("#log-console");
  el.scrollTop = el.scrollHeight;
}

function formatLogEntries(entries) {
  return entries.map((e) => `[${e.timestamp}] ${e.text}`).join("\n");
}

async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // fall through to the legacy fallback below
    }
  }
  // navigator.clipboard requires a secure context (HTTPS/localhost), same
  // restriction as getUserMedia -- fall back to the older execCommand
  // approach, which still works over plain HTTP in most browsers, so
  // "Copier" doesn't silently fail the same way the PTT mic capture did.
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$("#btn-log-copy-all").addEventListener("click", async () => {
  if (!logLines.length) return showToast(t("log.empty"), "info");
  const ok = await copyToClipboard(formatLogEntries(logLines));
  showToast(t(ok ? "log.copiedAll" : "log.copyFailed"), ok ? "success" : "error");
});

$("#btn-log-copy-last").addEventListener("click", async () => {
  if (!logLines.length) return showToast(t("log.empty"), "info");
  const ok = await copyToClipboard(formatLogEntries(logLines.slice(lastActionStart)));
  showToast(t(ok ? "log.copiedLast" : "log.copyFailed"), ok ? "success" : "error");
});

$("#btn-log-export").addEventListener("click", () => {
  if (!logLines.length) return showToast(t("log.empty"), "info");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadTextFile(`at2bridge-journal-${stamp}.txt`, formatLogEntries(logLines));
});

// ---------------------------------------------------------------------------
// Toast notifications (non-blocking, replaces alert() -- see style.css for
// the color-coded border variants: info=blue, success=green, error=red)
// ---------------------------------------------------------------------------
function showToast(message, type = "info", durationMs = 4000) {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  // Force a reflow before adding "show" so the CSS transition actually
  // plays (otherwise the initial + final state would apply in the same
  // frame and the fade-in would be skipped).
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    el.classList.add("hide");
    setTimeout(() => el.remove(), 220);
  }, durationMs);
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
  $("#ptt-hint").textContent = mode === "server" ? t("ptt.hintServer") : t("ptt.hintLocalBle");
  $("#ptt-btn").disabled = false;
}

const localSupported = AT2BleClient.isSupported();
if (!localSupported) {
  $("#mode-local").disabled = true;
  $("#mode-local").title = t("mode.localUnsupported");
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
  setConnUi(status.connected, status.connected ? t("conn.connected", { kind: status.kind, target: status.target }) : t("conn.disconnected"));
  $("#btn-disconnect").hidden = !status.connected;
}

async function refreshSerialPorts() {
  const ports = await api("GET", "/api/connection/serial/ports");
  const select = $("#serial-port-select");
  select.innerHTML = ports.length
    ? ports.map((p) => `<option value="${p.path}">${p.path} — ${p.description}</option>`).join("")
    : `<option value="">${t("devices.noPortsFound")}</option>`;
}

$("#btn-refresh-ports").addEventListener("click", refreshSerialPorts);

$("#btn-connect-serial").addEventListener("click", async () => {
  const port = $("#serial-port-select").value;
  if (!port) return showToast(t("devices.selectPortFirst"), "info");
  try {
    await api("POST", "/api/connection/serial/connect", { port, baud_rate: 115200 });
    // Mémorisation explicite (29/08/2026) -- ce n'est plus un effet de bord
    // automatique de connect_serial côté serveur, qui annulait "Oublier"
    // dès qu'on se reconnectait au même port. Voir CONSIGNES_PROJET.md.
    await api("POST", "/api/known-devices", {
      id: `serial-${port}`, name: port, transport: "serial", target: port,
    });
    await refreshStatus();
    await loadDeviceList();
  } catch (e) { showToast(e.message, "error"); }
});

$("#btn-scan-ble").addEventListener("click", async () => {
  try {
    const devices = await api("GET", "/api/connection/ble/scan");
    if (!devices.length) return showToast(t("devices.noBleFound"), "info");
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
  } catch (e) { showToast(e.message, "error"); }
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
  setConnUi(isConnected, isConnected ? t("conn.connectedLocal", { name: localDeviceInfo?.name || "?" }) : t("conn.disconnectedLocal"));
  $("#btn-local-disconnect").hidden = !isConnected;
}

$("#btn-local-connect").addEventListener("click", async () => {
  try {
    localDeviceInfo = await AT2BleClient.connect();
    updateLocalStatusUi();
    appendLog(`BLE local connecté: ${localDeviceInfo.name}`);
  } catch (e) { showToast(e.message, "error"); }
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
      list.innerHTML = `<div class="card hint">${t("devices.empty")}</div>`;
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
          <button class="btn-primary" onclick="reconnectKnownDevice('${d.id}', '${d.transport}', '${d.target}')">${t("devices.connect")}</button>
          <button class="btn-ghost" onclick="forgetKnownDevice('${d.id}')">${t("devices.forget")}</button>
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
  } catch (e) { showToast(e.message, "error"); }
}

async function forgetKnownDevice(id) {
  try {
    // device_id as a query parameter, not a path segment -- see main.py's
    // forget_device route for why (slash-containing serial device IDs
    // broke path-segment routing even when URL-encoded).
    await api("DELETE", `/api/known-devices?device_id=${encodeURIComponent(id)}`);
    await loadDeviceList();
  } catch (e) {
    showToast(e.message, "error");
  }
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
        { icon: cfg.high_power ? "H" : "L", title: cfg.high_power ? t("chan.highPower") : t("chan.lowPower"), on: cfg.high_power },
        { icon: cfg.bandwidth_narrow ? "N" : "W", title: cfg.bandwidth_narrow ? t("chan.narrow") : t("chan.wide"), on: cfg.bandwidth_narrow },
        { icon: "📡", title: cfg.scan_add ? t("chan.scanAdded") : t("chan.scanExcluded"), on: cfg.scan_add },
        { icon: cfg.mode_digital ? "D" : "A", title: cfg.mode_digital ? t("chan.digital") : t("chan.analog"), on: cfg.mode_digital, warn: cfg.mode_digital },
      ]
    : [{ icon: "?", title: t("chan.readFirst"), on: false }];
  $("#chan-opts").innerHTML = opts
    .map((o) => `<span class="chan-opt-icon ${o.on ? (o.warn ? "warn-on" : "on") : ""}" title="${o.title}">${o.icon}</span>`)
    .join("");
}

async function applyActiveChannel(select = true) {
  renderChanSelect();
  renderChanOpts();
  $("#ptt-device-sub").textContent = `${t("channelLabel", { n: String(activeChannel).padStart(2, "0") })}${channelNames[activeChannel] ? " · " + channelNames[activeChannel] : ""}`;
  if (select) {
    try {
      const transport = activeTransport();
      if (transport === "server") await api("POST", `/api/channels/${activeChannel}/select`);
      else if (transport === "local") await AT2BleClient.selectChannel(activeChannel);
    } catch (e) { appendLog(t("chan.selectError", { error: e.message })); }
  }
}

$("#chan-select").addEventListener("change", (e) => { activeChannel = parseInt(e.target.value, 10); applyActiveChannel(); });
$("#chan-prev").addEventListener("click", () => { activeChannel = activeChannel > 1 ? activeChannel - 1 : 30; applyActiveChannel(); });
$("#chan-next").addEventListener("click", () => { activeChannel = activeChannel < 30 ? activeChannel + 1 : 1; applyActiveChannel(); });
$("#chan-rename").addEventListener("click", async () => {
  const name = prompt(t("chan.renamePrompt", { channel: activeChannel }), channelNames[activeChannel] || "");
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
let pttSession = null; // BLE local mode
let pttActive = false;
let pttStart = null;
let pttTimerInterval = null;

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function startPtt() {
  if (pttActive) return;
  const transport = activeTransport();
  if (!transport) return showToast(t("gps.noActiveConnection"), "info");

  pttActive = true;
  pttStart = Date.now();
  $("#ptt-btn").classList.add("pressed");
  waveEl.classList.add("active");
  $("#rf-indicator").classList.add("tx");
  $("#rf-label").textContent = "TX";
  pttTimerInterval = setInterval(() => {
    $("#ptt-timer").textContent = formatTimer(Date.now() - pttStart);
  }, 200);

  if (transport === "server") {
    pttSocket = new WebSocket(wsUrl("/ws/ptt"));
    pttSocket.binaryType = "arraybuffer";
    pttSocket.onmessage = (evt) => {
      const pcm = new Int16Array(evt.data);
      PttAudio.playPcmFrame(pcm);
      $("#rf-indicator").classList.add("rx");
    };
    pttSocket.onopen = async () => {
      try {
        await PttAudio.startCapture((int16Frame) => {
          if (pttSocket && pttSocket.readyState === WebSocket.OPEN) {
            pttSocket.send(int16Frame.buffer);
          }
          setWaveHeights(true);
        });
      } catch (e) {
        showToast(t("ptt.micError", { error: e.message }), "error");
        stopPtt();
      }
    };
    pttSocket.onerror = () => appendLog("PTT WS erreur");
  } else {
    // BLE local mode: AMR encode/decode happens entirely in the browser
    // (see static/ptt-amr-codec.js + static/amrnb.js) since PTT has been
    // confirmed BLE-only -- see CONSIGNES_PROJET.md.
    try {
      pttSession = AT2BleClient.startPtt(
        (pcm) => {
          PttAudio.playPcmFrame(pcm);
          $("#rf-indicator").classList.add("rx");
        },
        appendLog
      );
      await PttAudio.startCapture((int16Frame) => {
        pttSession.feedPcmFrame(int16Frame).catch((e) => appendLog(`PTT BLE erreur d'envoi: ${e.message}`));
        setWaveHeights(true);
      });
    } catch (e) {
      appendLog(`PTT BLE erreur d'initialisation: ${e.message}`);
      showToast(t("ptt.micError", { error: e.message }), "error");
      stopPtt();
    }
  }
}

function stopPtt() {
  if (!pttActive) return;
  pttActive = false;
  PttAudio.stopCapture();
  if (pttSocket) { pttSocket.close(); pttSocket = null; }
  if (pttSession) { pttSession.close().catch(() => {}); pttSession = null; }
  $("#ptt-btn").classList.remove("pressed");
  waveEl.classList.remove("active");
  $("#rf-indicator").classList.remove("tx", "rx");
  $("#rf-label").textContent = t("chan.standby");
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
  if (!navigator.geolocation) { updateGpsFix(false, t("gps.unavailable")); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      $("#gps-coords").textContent = formatCoords(lastCoords.lat, lastCoords.lon);
      $("#gps-accuracy").textContent = t("gps.accuracy", { meters: Math.round(lastCoords.acc) });
      updateGpsFix(true, t("gps.fixAcquired"));
    },
    () => updateGpsFix(false, t("gps.denied")),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
requestLocation();

async function sendPositionPayload(url, note) {
  if (!lastCoords) return showToast(t("gps.noCoords"), "info");
  const username = $("#msg-username")?.value || "AT2Bridge";
  const transport = activeTransport();
  if (transport === "server") {
    await api("POST", url, { username, lat: lastCoords.lat, lon: lastCoords.lon, note });
  } else if (transport === "local") {
    await AT2BleClient.sendText(username, `${note} 📍 ${formatCoords(lastCoords.lat, lastCoords.lon)}`);
  } else {
    showToast(t("gps.noActiveConnection"), "info");
  }
}

$("#gps-send-now").addEventListener("click", async () => {
  try {
    await sendPositionPayload("/api/position/send", "");
    $("#beacon-status").textContent = t("gps.sentAt", { coords: formatCoords(lastCoords.lat, lastCoords.lon) });
  } catch (e) { showToast(e.message, "error"); }
});

$("#beacon-toggle").addEventListener("change", (e) => {
  const status = $("#beacon-status");
  if (e.target.checked) {
    const seconds = parseInt($("#beacon-interval").value, 10);
    const label = seconds >= 60 ? t("gps.intervalMinutes", { n: seconds / 60 }) : t("gps.intervalSeconds", { n: seconds });
    status.textContent = t("gps.beaconOn", { interval: label });
    beaconTimer = setInterval(async () => {
      requestLocation();
      try { await sendPositionPayload("/api/position/send", ""); } catch (_) {}
      status.textContent = t("gps.beaconNext", { interval: label });
    }, seconds * 1000);
  } else {
    clearInterval(beaconTimer);
    status.textContent = t("gps.beaconOff");
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
    btn.textContent = t("gps.sosSent");
    setTimeout(() => { btn.classList.remove("sent"); btn.textContent = t("gps.sos"); }, 2200);
  } catch (e) { showToast(e.message, "error"); }
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
      <td><input type="checkbox" class="ch-busylock" ${ch.busy_lock ? "checked" : ""} /></td>
      <td><input type="checkbox" class="ch-hop" ${ch.hop_on ? "checked" : ""} /></td>
      <td><input type="number" min="0" max="255" step="1" class="ch-enckey" value="${ch.encrypt_key ?? 0}" /></td>
      <td><button class="btn-ghost btn-write-one">${t("channels.write")}</button></td>
    </tr>`;
}

function emptyChannels() {
  return Array.from({ length: 30 }, (_, i) => ({
    channel: i + 1, rx_tone: "OFF", tx_tone: "OFF", bandwidth_narrow: true, high_power: true, scan_add: true,
    busy_lock: false, hop_on: false, encrypt_key: 0,
  }));
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
    busy_lock: row.querySelector(".ch-busylock").checked,
    hop_on: row.querySelector(".ch-hop").checked,
    encrypt_key: parseInt(row.querySelector(".ch-enckey").value, 10) || 0,
  };
}

async function writeChannelRow(row) {
  const cfg = readChannelRow(row);
  try {
    const transport = activeTransport();
    if (transport === "server") {
      await api("PUT", `/api/channels/${cfg.channel}`, cfg);
      if (cfg.name) await api("PUT", `/api/channel-names/${cfg.channel}`, { name: cfg.name });
    } else if (transport === "local") {
      await AT2BleClient.writeChannel(cfg);
      if (cfg.name) await api("PUT", `/api/channel-names/${cfg.channel}`, { name: cfg.name });
    } else {
      return showToast(t("gps.noActiveConnection"), "info");
    }
  } catch (e) { showToast(e.message, "error"); }
}

$("#btn-read-channels").addEventListener("click", async () => {
  try {
    let channels;
    const transport = activeTransport();
    if (transport === "server") {
      channels = await api("GET", "/api/channels");
    } else if (transport === "local") {
      channels = await AT2BleClient.readAllChannels();
    } else {
      return showToast(t("gps.noActiveConnection"), "info");
    }
    lastReadChannels = channels.length ? channels : emptyChannels();
    renderChannelTable(lastReadChannels);
    renderChanOpts();
  } catch (e) { showToast(e.message, "error"); }
});

// -- Import depuis un export XML de la CPS officielle (pas une lecture live
// -- ne remplit que le tableau a l'ecran, "Ecrire" reste necessaire pour
// -- committer quoi que ce soit sur la radio, comme apres une lecture live.
$("#btn-import-xml").addEventListener("click", () => $("#xml-file-input").click());

$("#xml-file-input").addEventListener("change", async () => {
  const file = $("#xml-file-input").files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const imported = await apiUpload("/api/channels/import-xml", form);
    // "Ecrire les 30 canaux" exige exactement 30 lignes -- on part d'un
    // tableau vide par defaut et on ne remplace que les canaux presents
    // dans le fichier (les slots absents du XML restent vides/par defaut).
    const merged = emptyChannels();
    for (const imp of imported) {
      const idx = merged.findIndex((c) => c.channel === imp.channel);
      if (idx !== -1) merged[idx] = imp;
    }
    lastReadChannels = merged;
    renderChannelTable(lastReadChannels);
    renderChanOpts();
    showToast(t("channels.importXmlSuccess", { count: imported.length }), "success");
  } catch (e) {
    showToast(e.message, "error");
  } finally {
    $("#xml-file-input").value = "";
  }
});

$("#btn-write-channels").addEventListener("click", async () => {
  const configs = $$("#channel-table-body tr").map(readChannelRow);
  if (configs.length !== 30) return showToast(t("channels.need30rows"), "info");
  try {
    const transport = activeTransport();
    if (transport === "server") {
      await api("PUT", "/api/channels", configs);
    } else if (transport === "local") {
      for (const cfg of configs) await AT2BleClient.writeChannel(cfg);
    } else {
      return showToast(t("gps.noActiveConnection"), "info");
    }
    showToast(t("channels.writtenOk"), "success");
  } catch (e) { showToast(e.message, "error"); }
});

renderChannelTable(emptyChannels());

// ---------------------------------------------------------------------------
// Device settings
// ---------------------------------------------------------------------------
$$("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    try {
      if (action === "set-volume") {
        const level = parseInt($("#volume-slider").value, 10);
        const transport = activeTransport();
        if (transport === "server") await api("PUT", "/api/device/volume", { level });
        else if (transport === "local") await AT2BleClient.setVolume(level);
        else return showToast(t("gps.noActiveConnection"), "info");
        return;
      }
      // Les autres réglages ne sont pas encore câblés côté client BLE
      // (ble-client.js ne supporte pour l'instant que connect/selectChannel/
      // setVolume/sendText/PTT) -- éviter un appel serveur voué à échouer
      // avec un 409 confus quand aucune connexion serveur n'est active.
      if (activeTransport() !== "server") return showToast(t("mode.notSupportedLocal"), "info");
      if (action === "set-squelch") await api("PUT", "/api/device/squelch", { level: parseInt($("#squelch-slider").value, 10) });
      if (action === "set-vox") await api("PUT", "/api/device/vox", { enabled: $("#vox-toggle").checked });
      if (action === "set-vox-sensitivity") await api("PUT", "/api/device/vox-sensitivity", { level: parseInt($("#vox-sensitivity-slider").value, 10) });
      if (action === "set-tot") await api("PUT", "/api/device/tot", { seconds: parseInt($("#tot-slider").value, 10) });
      if (action === "set-tx-inhibit") await api("PUT", "/api/device/tx-inhibit", { enabled: $("#tx-inhibit-toggle").checked });
      if (action === "set-noise-reduction") await api("PUT", "/api/device/noise-reduction", { enabled: $("#noise-reduction-toggle").checked });
      if (action === "set-prompt-tone") await api("PUT", "/api/device/prompt-tone", { enabled: $("#prompt-tone-toggle").checked });
      if (action === "set-device-name") {
        const name = $("#device-name-input").value.trim();
        if (!name) return showToast(t("settings.deviceNameRequired"), "info");
        await api("PUT", "/api/device/name", { name });
      }
      if (action === "set-smart-link") await api("PUT", "/api/device/smart-link", { enabled: $("#smart-link-toggle").checked });
    } catch (e) { showToast(e.message, "error"); }
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
  el.innerHTML = `<div class="meta">${t("msg.me")} · ${new Date().toLocaleTimeString(getLang() === "fr" ? "fr-FR" : "en-US", { hour: "2-digit", minute: "2-digit" })}</div><div class="msg-body">${text}</div>`;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

$("#btn-send-message").addEventListener("click", async () => {
  const username = $("#msg-username").value || "AT2Bridge";
  const text = $("#msg-text").value.trim();
  if (!text) return;
  try {
    const transport = activeTransport();
    if (transport === "server") await api("POST", "/api/messages/text", { username, text });
    else if (transport === "local") await AT2BleClient.sendText(username, text);
    else return showToast(t("gps.noActiveConnection"), "info");
    pushSentBubble(text);
    $("#msg-text").value = "";
  } catch (e) { showToast(e.message, "error"); }
});

// -- Image messages (server mode only -- image encoding happens server-side
// with Pillow, see app/main.py; no BLE-local equivalent yet) ---------------
$("#btn-attach-image").addEventListener("click", () => {
  if (activeTransport() !== "server") return showToast(t("msg.serverModeRequiredImage"), "info");
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
    pushSentBubble(t("msg.imageSent", { filename: file.name }));
  } catch (e) {
    showToast(e.message, "error");
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
  if (activeTransport() !== "server") return showToast(t("msg.serverModeRequiredVoice"), "info");
  const btn = $("#btn-record-voice");
  const status = $("#voice-record-status");

  if (!voiceRecording) {
    voiceRecording = true;
    voiceChunks = [];
    btn.textContent = t("msg.stopRecording");
    status.textContent = t("msg.recording");
    try {
      await PttAudio.startCapture((int16Frame) => { voiceChunks.push(int16Frame); });
    } catch (e) {
      voiceRecording = false;
      btn.textContent = t("msg.recordVoiceBtn");
      status.textContent = "";
      showToast(t("msg.micUnavailable", { error: e.message }), "error");
    }
  } else {
    voiceRecording = false;
    PttAudio.stopCapture();
    btn.textContent = t("msg.recordVoiceBtn");
    status.textContent = t("msg.sending");

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
      pushSentBubble(t("msg.voiceSent", { seconds: Math.round(durationMs / 1000) }));
      status.textContent = "";
    } catch (e) {
      status.textContent = "";
      showToast(e.message, "error");
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
// Debug: raw frame send (experimental -- see CONSIGNES_PROJET.md)
// ---------------------------------------------------------------------------
$("#btn-send-raw-frame").addEventListener("click", async () => {
  const input = $("#raw-frame-input");
  const frameHex = input.value.trim().replace(/\s+/g, "");
  if (!frameHex) return;
  if (!/^[0-9a-fA-F]+$/.test(frameHex)) return showToast(t("debug.rawFrameInvalidHex"), "error");
  if (!connected) return showToast(t("debug.rawFrameNoConnection"), "info");

  const btn = $("#btn-send-raw-frame");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("debug.rawFrameSending");
  try {
    await api("POST", "/api/debug/send-raw-frame", { frame_hex: frameHex, listen_seconds: 2.0 });
    // La réponse détaillée (paquets reçus, hex complet) apparaît dans le
    // Journal via _log_line côté serveur -- pas besoin de la ré-afficher ici.
  } catch (e) {
    showToast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// ---------------------------------------------------------------------------
// Incoming offline messages (text/voice/image) -- /ws/messages
// ---------------------------------------------------------------------------
function pushReceivedBubble(msg) {
  const thread = $("#msg-thread");
  const el = document.createElement("div");
  el.className = "msg-bubble";
  const time = new Date().toLocaleTimeString(getLang() === "fr" ? "fr-FR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  let body;
  if (msg.kind === "text") {
    body = `<div class="msg-body">${msg.text ?? ""}</div>`;
  } else if (msg.kind === "image" && msg.data_base64) {
    body = `<div class="msg-body"><img src="data:image/jpeg;base64,${msg.data_base64}" style="max-width:220px; border-radius:6px; display:block;" /></div>`;
  } else if (msg.kind === "voice") {
    body = `<div class="msg-body">${t("msg.voiceReceived", { seconds: Math.round((msg.duration_ms || 0) / 1000) })}</div>`;
  } else {
    body = `<div class="msg-body">${t("msg.unknownKind", { kind: msg.kind })}</div>`;
  }
  el.innerHTML = `<div class="meta">${msg.sender || "?"} · ${time}</div>${body}`;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

function connectMessagesSocket() {
  const ws = new WebSocket(wsUrl("/ws/messages"));
  ws.onmessage = (evt) => {
    try { pushReceivedBubble(JSON.parse(evt.data)); } catch (e) { appendLog(t("msg.unreadable", { error: e.message })); }
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

