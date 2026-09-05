const $ = (sel) => document.querySelector(sel);

/** Escapes HTML-significant characters before interpolating untrusted
 * content into innerHTML templates. "Untrusted" here includes anything
 * that ultimately comes from the radio link (message sender/text --
 * ANY transmitter in range can craft these), from shared server storage
 * that any authenticated user of the instance's single shared password
 * can write (channel names), or server-side error text echoed back
 * verbatim into the UI. Without this, any of those is a stored/reflected
 * XSS vector. See CONSIGNES_PROJET.md. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let mode = "server"; // "server" | "local"
let connected = false;
let localDeviceInfo = null;
let activeServerTarget = null; // {kind, target} of the current server-mode connection, for
let activeServerKind = null;   // highlighting the matching row in the known-devices list.

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
// ---------------------------------------------------------------------------
// Alerts: a Blender-style status footer showing the latest message, click
// to open the full session history -- replaces the earlier floating
// top-right toast stack (29/08/2026 redesign). showToast() keeps the exact
// same call signature used everywhere else in this file (message, type);
// only what happens visually changed, so no other call site needed touching.
// ---------------------------------------------------------------------------
let alertHistory = []; // { timestamp, message, type }

function renderAlertFooter(entry) {
  const footer = $("#alert-footer");
  footer.hidden = false;
  footer.classList.remove("alert-footer-info", "alert-footer-success", "alert-footer-error", "pulse");
  void footer.offsetWidth; // force reflow so the "pulse" animation restarts even for same-type messages in a row
  footer.classList.add(`alert-footer-${entry.type}`, "pulse");
  footer.querySelector(".alert-footer-text").textContent = entry.message;
}

function renderAlertHistory() {
  const list = $("#alert-history-list");
  if (!alertHistory.length) {
    list.innerHTML = `<div class="hint">${t("alerts.empty")}</div>`;
    return;
  }
  list.innerHTML = alertHistory.map((e) => `
    <div class="alert-history-item alert-history-${e.type}">
      <span class="alert-history-time">${e.timestamp}</span>
      <span class="alert-history-msg">${escapeHtml(e.message)}</span>
    </div>`).join("");
}

function showToast(message, type = "info") {
  const entry = { timestamp: new Date().toLocaleTimeString("fr-FR"), message, type };
  alertHistory.unshift(entry);
  if (alertHistory.length > 200) alertHistory.length = 200; // cap session history size
  renderAlertFooter(entry);
  if (!$("#alert-history-overlay").hidden) renderAlertHistory(); // keep an open panel live
}

$("#alert-footer").addEventListener("click", (e) => {
  e.stopPropagation();
  renderAlertHistory();
  $("#alert-history-overlay").hidden = false;
});
$("#alert-history-close").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#alert-history-overlay").hidden = true;
});
// Même mécanisme que #prefs-menu ci-dessus (un seul listener document,
// vérification de confinement) plutôt qu'un listener séparé sur l'overlay
// lui-même -- c'est le schéma déjà éprouvé dans ce projet pour ce genre
// de panneau qui doit se fermer au clic extérieur.
document.addEventListener("click", (e) => {
  const overlay = $("#alert-history-overlay");
  const panel = $(".alert-history-panel");
  if (!overlay.hidden && !panel.contains(e.target) && e.target !== $("#alert-footer")) {
    overlay.hidden = true;
  }
});

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
  const wasActive = activeServerTarget;
  activeServerTarget = status.connected ? status.target : null;
  activeServerKind = status.connected ? status.kind : null;
  if (wasActive !== activeServerTarget) loadDeviceList();
}

// Server-side connection: unified transport toggle (USB serial / server
// Bluetooth) driving one shared dropdown + one shared "Connect" button,
// replacing what used to be two visually-peer-looking buttons ("USB série"
// as a disguised connect action, "Scanner BLE" opening a native prompt())
// that behaved completely differently -- a real source of confusion
// (Ely, 29/08/2026). The dropdown's *content* and the refresh/scan button's
// behavior change based on which transport is selected; "Connect" always
// acts on the currently selected transport + dropdown value.
let selectedServerTransport = "serial"; // "serial" | "ble"

async function refreshTargetList() {
  const select = $("#target-select");
  if (selectedServerTransport === "serial") {
    const ports = await api("GET", "/api/connection/serial/ports");
    select.innerHTML = ports.length
      ? ports.map((p) => `<option value="${p.path}">${p.path} — ${p.description}</option>`).join("")
      : `<option value="">${t("devices.noPortsFound")}</option>`;
  } else {
    const devices = await api("GET", "/api/connection/ble/scan");
    select.innerHTML = devices.length
      ? devices.map((d) => `<option value="${d.address}" data-name="${d.name}">${d.name} (${d.address})</option>`).join("")
      : `<option value="">${t("devices.noBleFound")}</option>`;
  }
}

function applyServerTransportUi() {
  $("#transport-serial").classList.toggle("active", selectedServerTransport === "serial");
  $("#transport-ble").classList.toggle("active", selectedServerTransport === "ble");
  const refreshBtn = $("#btn-refresh-target");
  refreshBtn.title = t(selectedServerTransport === "serial" ? "btn.refreshPorts" : "btn.scanBle");
  $("#target-select").innerHTML = "";
}

$("#new-conn-toggle").addEventListener("click", (e) => {
  e.currentTarget.classList.toggle("open");
  $("#new-conn-body").classList.toggle("open");
});

$$(".transport-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedServerTransport = btn.dataset.transport;
    applyServerTransportUi();
    refreshTargetList().catch((e) => showToast(e.message, "error"));
  });
});

$("#btn-refresh-target").addEventListener("click", () => refreshTargetList().catch((e) => showToast(e.message, "error")));

$("#btn-connect-server").addEventListener("click", async () => {
  const select = $("#target-select");
  const value = select.value;
  if (!value) return showToast(t(selectedServerTransport === "serial" ? "devices.selectPortFirst" : "devices.noBleFound"), "info");
  try {
    if (selectedServerTransport === "serial") {
      await api("POST", "/api/connection/serial/connect", { port: value, baud_rate: 115200 });
      // Mémorisation explicite (29/08/2026) -- ce n'est plus un effet de bord
      // automatique de connect_serial côté serveur, qui annulait "Oublier"
      // dès qu'on se reconnectait au même port. Voir CONSIGNES_PROJET.md.
      await api("POST", "/api/known-devices", {
        id: `serial-${value}`, name: value, transport: "serial", target: value,
      });
    } else {
      const name = select.selectedOptions[0]?.dataset.name || value;
      await api("POST", "/api/connection/ble/connect", { address: value });
      await api("POST", "/api/known-devices", {
        id: `ble-${value}`, name, transport: "ble", target: value,
      });
    }
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
    // Mémorisation explicite (comme pour série/BLE serveur) -- transport
    // distinct "ble-local" car Web Bluetooth ne permet jamais de se
    // reconnecter silencieusement à une adresse précise (le sélecteur
    // natif du navigateur se rouvre toujours) ; reconnectKnownDevice()
    // le gère différemment de la BLE serveur pour cette raison.
    await api("POST", "/api/known-devices", {
      id: `ble-local-${localDeviceInfo.id}`, name: localDeviceInfo.name, transport: "ble-local", target: localDeviceInfo.id,
    });
    await loadDeviceList();
  } catch (e) { showToast(e.message, "error"); }
});
$("#btn-local-disconnect").addEventListener("click", async () => {
  await AT2BleClient.disconnect();
  updateLocalStatusUi();
});
// Body hex included (not just family/command) since this is the only
// window we have into traffic this app doesn't fully understand yet --
// see AT2Protocol.isIncomingRfActivity()'s comment on the incoming-voice
// signature confirmed live 05/09/2026, itself found this way.
AT2BleClient.onPacket((pkt) => appendLog(
  `RX local [${pkt.family.toString(16)}/${pkt.command.toString(16)}] body=${Array.from(pkt.body).map((b) => b.toString(16).padStart(2, "0")).join("")}`
));

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
    list.innerHTML = known.map((d) => {
      // Server-mode match: target+kind come from a real API call, fully
      // reliable. Local-BLE match: now ALSO reliable, since we store the
      // exact same localDeviceInfo.id ourselves at connect time (see
      // btn-local-connect) rather than trying to guess/derive a MAC
      // address independently.
      const isActive = (mode === "server" && connected && d.transport === activeServerKind && d.target === activeServerTarget)
        || (mode === "local" && d.transport === "ble-local" && AT2BleClient.connected() && d.target === localDeviceInfo?.id);
      const transportLabel = d.transport === "serial" ? t("transport.serial")
        : d.transport === "ble-local" ? t("transport.bleLocal") : t("transport.ble");
      return `
      <div class="card device-card${isActive ? " is-connected" : ""}">
        <img class="device-thumb" src="/static/at2-icon.png" alt="AT2" />
        <div class="device-card-info">
          <div class="device-card-name">${escapeHtml(d.name)} <span class="transport-badge transport-badge-${d.transport === "serial" ? "serial" : "ble"}">${transportLabel}</span></div>
          <div class="device-card-model">${d.target}</div>
        </div>
        <div class="device-card-actions">
          ${isActive ? "" : `<button class="btn-primary" onclick="reconnectKnownDevice('${d.id}', '${d.transport}', '${d.target}')">${t("devices.connect")}</button>`}
          <button class="btn-ghost" onclick="forgetKnownDevice('${d.id}')">${t("devices.forget")}</button>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = `<div class="card hint">${e.message}</div>`;
  }
}

async function reconnectKnownDevice(id, transport, target) {
  // Switch the Serveur/BLE local mode toggle to match this device's own
  // transport BEFORE connecting -- previously `mode` never changed here,
  // so clicking "Connecter" on a known BLE-local device actually connected
  // fine in the background but left the "Serveur" panel showing (wrong
  // hint text, wrong connect/disconnect button visible), making it look
  // like nothing happened until the mode tab was flipped by hand (reported
  // 05/09/2026). Doing it up front, not just on success, also means a
  // failed connect still leaves the user looking at the right panel to
  // retry from.
  mode = transport === "ble-local" ? "local" : "server";
  applyModeUi();
  try {
    if (transport === "ble-local") {
      // Web Bluetooth ne permet jamais de cibler silencieusement une
      // adresse précise -- le sélecteur natif du navigateur se rouvre
      // systématiquement, quel que soit l'appareil "connu" cliqué.
      localDeviceInfo = await AT2BleClient.connect();
      updateLocalStatusUi();
      appendLog(`BLE local connecté: ${localDeviceInfo.name}`);
    } else if (transport === "ble") {
      await api("POST", "/api/connection/ble/connect", { address: target });
    } else {
      await api("POST", "/api/connection/serial/connect", { port: target, baud_rate: 115200 });
    }
    await refreshStatus();
    await loadDeviceList();
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
  renderMessagingPanel(); // Messaging tab's group list/status grid/thread track the same active channel
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
      // Incoming audio playback + the RX indicator are both driven by the
      // always-on AT2BleClient.onIncomingAudio()/onPacket() listeners
      // registered once at startup (see below) -- not passed in here --
      // so they also work while just standing by, not only mid-session.
      pttSession = await AT2BleClient.startPtt(appendLog);
      // startPtt() now awaits a radio key-on handshake before returning
      // (see ble-client.js), so a very short tap can release the button
      // before it resolves -- mirror the reference app (PttUiController.kt)
      // and bail out cleanly instead of starting mic capture for a press
      // that already ended, leaving the radio keyed up for nothing.
      if (!pttActive) {
        await pttSession.close();
        pttSession = null;
        return;
      }
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

$("#ptt-help").addEventListener("click", () => showToast(t("chan.optsLegend"), "info"));

// ---------------------------------------------------------------------------
// Passive "someone is talking" RX indicator -- previously the only way to
// see incoming voice activity at all was to already be transmitting
// yourself (the `.rx` class added inside startPtt() above, for audio the
// radio echoes back mid-session). This lights up the same indicator/wave
// from incoming PTT voice packets alone, with no local mic capture and no
// keying of the local transmitter, so the channel's busy state is visible
// BEFORE pressing PTT -- server mode via a dedicated receive-only
// websocket (/ws/ptt-rx, never keys the radio, unlike /ws/ptt), local BLE
// mode by watching the same packet stream ble-client.js already exposes.
// ---------------------------------------------------------------------------
let rfActivityTimer = null;

function markIncomingRfActivity() {
  if (pttActive) return; // already showing our own TX state, don't fight it
  $("#rf-indicator").classList.add("rx");
  $("#rf-label").textContent = t("chan.receiving");
  waveEl.classList.add("rx-active");
  clearTimeout(rfActivityTimer);
  rfActivityTimer = setTimeout(() => {
    $("#rf-indicator").classList.remove("rx");
    $("#rf-label").textContent = t("chan.standby");
    waveEl.classList.remove("rx-active");
  }, 500);
}

function connectPttRxSocket() {
  const ws = new WebSocket(wsUrl("/ws/ptt-rx"));
  ws.onmessage = () => markIncomingRfActivity();
  ws.onclose = () => setTimeout(connectPttRxSocket, 2000);
}

AT2BleClient.onPacket((pkt) => {
  if (AT2Protocol.isIncomingRfActivity(pkt)) markIncomingRfActivity();
});

// Actual playback of that incoming voice -- previously nothing decoded or
// played this traffic at all, indicator or not (see ble-client.js's
// onIncomingAudio()/rxAudioCodec). Best-effort: the exact byte layout of
// the real-hardware signature is unconfirmed (see
// AT2Protocol.extractRfActivityAudioFrames()'s comment) -- if it still
// sounds wrong, the Journal's "RX local" lines now include the body hex.
AT2BleClient.onIncomingAudio((pcm) => PttAudio.playPcmFrame(pcm));

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
      <td><input type="text" class="ch-name" value="${escapeHtml(channelNames[ch.channel] || ch.name || "")}" placeholder="—" /></td>
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

// Shared by the Settings tab's "Appliquer" button and the inline volume
// slider in the Messaging tab (see renderMessagingPanel()) -- one real
// code path for both instead of duplicating the transport branching.
async function applyVolumeLevel(level) {
  const transport = activeTransport();
  if (transport === "server") await api("PUT", "/api/device/volume", { level });
  else if (transport === "local") await AT2BleClient.setVolume(level);
  else return showToast(t("gps.noActiveConnection"), "info");
}

$$("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    try {
      if (action === "set-volume") {
        await applyVolumeLevel(parseInt($("#volume-slider").value, 10));
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
      if (action === "set-prompt-language") await api("PUT", "/api/device/prompt-language", { english: $("#prompt-language-toggle").checked });
      if (action === "set-tx-interval") await api("PUT", "/api/device/tx-interval", { seconds: parseInt($("#tx-interval-slider").value, 10) });
      if (action === "set-device-name") {
        const name = $("#device-name-input").value.trim();
        if (!name) return showToast(t("settings.deviceNameRequired"), "info");
        await api("PUT", "/api/device/name", { name });
      }
      if (action === "set-smart-link") await api("PUT", "/api/device/smart-link", { enabled: $("#smart-link-toggle").checked });
      if (action === "set-dual-watch") await api("PUT", "/api/device/dual-watch", { enabled: $("#dual-watch-toggle").checked });
      if (action === "set-dual-watch-channel-a") {
        const channel = parseInt($("#dual-watch-channel-a").value, 10);
        await api("PUT", "/api/device/dual-watch/channel", { side: "A", channel });
      }
      if (action === "set-dual-watch-channel-b") {
        const channel = parseInt($("#dual-watch-channel-b").value, 10);
        await api("PUT", "/api/device/dual-watch/channel", { side: "B", channel });
      }
      if (action === "set-dual-watch-focus-a") await api("PUT", "/api/device/dual-watch/focus", { side: "A" });
      if (action === "set-dual-watch-focus-b") await api("PUT", "/api/device/dual-watch/focus", { side: "B" });
    } catch (e) { showToast(e.message, "error"); }
  });
});

// ---------------------------------------------------------------------------
// Off-grid messaging. Groups = radio channels used as chat rooms: the wire
// protocol has no per-channel addressing at all -- a message just goes out
// on whichever channel the radio is currently tuned to, and arrives however
// it currently receives -- so "which group a message belongs to" is purely
// a client-side bucketing by the channel active at send/receive time,
// persisted in localStorage (this project had no message persistence at
// all before: a reload used to lose the entire conversation).
// ---------------------------------------------------------------------------

const MSG_STORE_KEY = "at2_messages_by_channel";
const MSG_MAX_PER_CHANNEL = 60;

function loadMessageStore() {
  try {
    const raw = localStorage.getItem(MSG_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveMessageStore() {
  try {
    // Sent voice notes keep their raw PCM in memory for instant, lossless
    // local playback (see playVoiceMessage) -- but that's 16000 bytes/s
    // uncompressed, serialized as a JSON number array (worse still). Never
    // persist it: a reload loses the play button on *sent* voice notes,
    // not the message itself, which is a fine trade-off against filling
    // localStorage's ~5-10MB quota after a handful of voice notes.
    const trimmed = {};
    for (const ch of Object.keys(messagesByChannel)) {
      trimmed[ch] = messagesByChannel[ch].map((m) => (m.pcm ? { ...m, pcm: undefined } : m));
    }
    localStorage.setItem(MSG_STORE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // Quota exceeded / private browsing -- degrade to session-only rather
    // than breaking the UI.
  }
}

let messagesByChannel = loadMessageStore();
let nextLocalMsgId = 1;

function channelMessages(channel) {
  if (!messagesByChannel[channel]) messagesByChannel[channel] = [];
  return messagesByChannel[channel];
}

function addMessage(channel, msg) {
  const list = channelMessages(channel);
  list.push({ ...msg, localId: nextLocalMsgId++, time: Date.now() });
  if (list.length > MSG_MAX_PER_CHANNEL) list.splice(0, list.length - MSG_MAX_PER_CHANNEL);
  saveMessageStore();
  renderGroupList();
  if (channel === activeChannel) renderThread();
}

// -- group sidebar + status grid --------------------------------------------

function groupItemHtml(channel) {
  const name = channelNames[channel] || t("msg.channelFallback", { n: String(channel).padStart(2, "0") });
  const cfg = lastReadChannels.find((c) => c.channel === channel);
  const freqText = cfg && cfg.rx_mhz ? `${cfg.rx_mhz} MHz` : "—";
  const count = channelMessages(channel).length;
  const active = channel === activeChannel;
  const initials = (channelNames[channel] || "").trim().slice(0, 2).toUpperCase() || String(channel).padStart(2, "0");
  return `
    <div class="group-item ${active ? "active" : ""}" data-channel="${channel}">
      <div class="group-avatar">${escapeHtml(initials)}</div>
      <div class="group-meta">
        <div class="group-name">${escapeHtml(name)}</div>
        <div class="group-sub">CH${String(channel).padStart(2, "0")} · ${freqText}</div>
      </div>
      ${count > 0 ? `<span class="group-badge">${count}</span>` : ""}
    </div>`;
}

function renderGroupList() {
  const list = $("#group-list");
  list.innerHTML = Array.from({ length: 30 }, (_, i) => i + 1).map(groupItemHtml).join("");
  list.querySelectorAll(".group-item").forEach((el) => {
    el.addEventListener("click", () => selectGroup(parseInt(el.dataset.channel, 10)));
  });
}

function selectGroup(channel) {
  if (channel === activeChannel) return;
  activeChannel = channel;
  applyActiveChannel(); // real channel switch on the radio -- also refreshes this panel, see the hook added there
}

function renderMsgStatusGrid() {
  const cfg = lastReadChannels.find((c) => c.channel === activeChannel);
  const freq = cfg && cfg.rx_mhz ? cfg.rx_mhz : "—";
  const mode = cfg ? (cfg.mode_digital ? t("chan.digital") : t("chan.analog")) : "—";
  const tone = cfg ? (cfg.rx_tone || "OFF") : "—";
  const enc = cfg ? (cfg.encrypt_key ? String(cfg.encrypt_key) : "OFF") : "—";
  $("#msg-status-grid").innerHTML = `
    <div class="status-cell"><div class="sc-value accent">${escapeHtml(String(freq))}</div><div class="sc-label">${t("msg.statusFreq")}</div></div>
    <div class="status-cell"><div class="sc-value">${escapeHtml(mode)}</div><div class="sc-label">${t("msg.statusMode")}</div></div>
    <div class="status-cell"><div class="sc-value">${escapeHtml(tone)}</div><div class="sc-label">${t("msg.statusTone")}</div></div>
    <div class="status-cell"><div class="sc-value ${enc === "OFF" || enc === "—" ? "" : "warn"}">${escapeHtml(enc)}</div><div class="sc-label">${t("msg.statusEnc")}</div></div>
  `;
}

function renderMessagingPanel() {
  const name = channelNames[activeChannel] || t("msg.channelFallback", { n: String(activeChannel).padStart(2, "0") });
  $("#active-group-name").textContent = name;
  $("#active-group-sub").textContent = `CH${String(activeChannel).padStart(2, "0")} · ${t("msg.messageCount", { n: channelMessages(activeChannel).length })}`;
  renderGroupList();
  renderMsgStatusGrid();
  renderThread();
}

// -- message bubbles ---------------------------------------------------------

// Decorative only -- not a real waveform of the audio, just something
// visually alive instead of a flat line (same approach the demo uses).
function voiceWaveBarsHtml(seed) {
  let html = "";
  for (let i = 0; i < 18; i++) {
    const h = 4 + Math.round(Math.abs(Math.sin(seed * (i + 1))) * 12);
    html += `<span style="height:${h}px"></span>`;
  }
  return html;
}

function formatVoiceDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `0:${String(s).padStart(2, "0")}`;
}

function msgBubbleHtml(msg) {
  const time = new Date(msg.time).toLocaleTimeString(getLang() === "fr" ? "fr-FR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  let body;
  if (msg.kind === "text") {
    body = `<div class="msg-body">${escapeHtml(msg.text ?? "")}</div>`;
  } else if (msg.kind === "image" && msg.dataBase64) {
    const caption = msg.caption ? `<div class="cap-text">${escapeHtml(msg.caption)}</div>` : "";
    body = `<div class="msg-body img-body${msg.caption ? " img-caption" : ""}"><img src="data:image/jpeg;base64,${msg.dataBase64}" />${caption}</div>`;
  } else if (msg.kind === "voice" && (msg.dataBase64 || msg.pcm)) {
    const seconds = Math.round((msg.durationMs || 0) / 1000);
    body = `<div class="msg-body"><div class="voice-row"><button class="voice-play">▶</button><div class="voice-wave">${voiceWaveBarsHtml(msg.localId || seconds || 1)}</div><div class="voice-dur">${formatVoiceDuration(seconds)}</div></div></div>`;
  } else if (msg.kind === "voice") {
    body = `<div class="msg-body">${t("msg.voiceReceived", { seconds: Math.round((msg.durationMs || 0) / 1000) })}</div>`;
  } else {
    body = `<div class="msg-body">${t("msg.unknownKind", { kind: msg.kind })}</div>`;
  }
  return `<div class="msg-bubble ${msg.mine ? "mine" : ""}" data-msg-id="${msg.localId}"><div class="meta">${msg.mine ? t("msg.me") : escapeHtml(msg.sender || "?")} · ${time}</div>${body}</div>`;
}

function renderThread() {
  const thread = $("#msg-thread");
  const list = channelMessages(activeChannel);
  thread.innerHTML = list.length ? list.map(msgBubbleHtml).join("") : `<div class="msg-empty">${t("msg.noMessages")}</div>`;
  thread.querySelectorAll(".msg-bubble .voice-play").forEach((btn) => {
    const bubble = btn.closest(".msg-bubble");
    const msg = list.find((m) => String(m.localId) === bubble.dataset.msgId);
    if (msg) btn.addEventListener("click", () => playVoiceMessage(msg, btn));
  });
  thread.scrollTop = thread.scrollHeight;
}

// -- voice playback -----------------------------------------------------
// Sent messages keep their raw PCM around in memory -- no AMR round-trip
// needed to play back our own audio. Received messages only ever have the
// AMR bytes that actually came over the air, so those go through the
// codec (ptt-amr-codec.js, same one used for live PTT).
let voicePlaybackCtx = null;

function playPcm(int16Array) {
  if (!voicePlaybackCtx) voicePlaybackCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = voicePlaybackCtx.createBuffer(1, int16Array.length, 8000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < int16Array.length; i++) channelData[i] = int16Array[i] / 0x8000;
  const src = voicePlaybackCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(voicePlaybackCtx.destination);
  return src;
}

function decodeAmrToPcm(base64Amr) {
  const binary = atob(base64Amr);
  const amrBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) amrBytes[i] = binary.charCodeAt(i);
  const codec = new PttAmr.Codec();
  const frameCount = Math.floor(amrBytes.length / PttAmr.ENCODED_FRAME_BYTES);
  const pcm = new Int16Array(frameCount * PttAmr.FRAME_SAMPLES);
  try {
    for (let i = 0; i < frameCount; i++) {
      const amrFrame = amrBytes.subarray(i * PttAmr.ENCODED_FRAME_BYTES, (i + 1) * PttAmr.ENCODED_FRAME_BYTES);
      pcm.set(codec.decode(amrFrame), i * PttAmr.FRAME_SAMPLES);
    }
  } finally {
    codec.close();
  }
  return pcm;
}

async function playVoiceMessage(msg, btn) {
  if (!msg.pcm && (typeof PttAmr === "undefined" || typeof AMR === "undefined")) {
    return showToast(t("msg.voicePlaybackUnavailable"), "error");
  }
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "🔊";
  try {
    const pcm = msg.pcm ? Int16Array.from(msg.pcm) : decodeAmrToPcm(msg.dataBase64);
    const src = playPcm(pcm);
    src.onended = () => { btn.disabled = false; btn.textContent = originalLabel; };
    src.start();
  } catch (e) {
    showToast(t("msg.voicePlaybackError", { error: e.message }), "error");
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// -- clear this channel's local history (repurposed "eject" icon -- there's
// no real concept of "leaving" a channel-as-group, but clearing its saved
// history locally is a genuinely useful action now that messages persist).
$("#btn-clear-channel-history").addEventListener("click", () => {
  if (!channelMessages(activeChannel).length) return;
  if (!confirm(t("msg.clearHistoryConfirm", { n: String(activeChannel).padStart(2, "0") }))) return;
  messagesByChannel[activeChannel] = [];
  saveMessageStore();
  renderMessagingPanel();
});

// -- inline volume slider (mirrors the Settings tab's, see applyVolumeLevel)
$("#msg-volume-slider").addEventListener("change", (e) => {
  applyVolumeLevel(parseInt(e.target.value, 10)).catch((err) => showToast(err.message, "error"));
});

// -- sending: text ------------------------------------------------------
async function sendTextMessage() {
  const username = $("#msg-username").value || "AT2Bridge";
  const text = $("#msg-text").value.trim();
  if (!text) return;
  try {
    const transport = activeTransport();
    if (transport === "server") await api("POST", "/api/messages/text", { username, text });
    else if (transport === "local") await AT2BleClient.sendText(username, text);
    else return showToast(t("gps.noActiveConnection"), "info");
    addMessage(activeChannel, { kind: "text", sender: username, mine: true, text });
    $("#msg-text").value = "";
  } catch (e) { showToast(e.message, "error"); }
}
$("#btn-send-message").addEventListener("click", sendTextMessage);
$("#msg-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendTextMessage(); });

// -- sending: image. Server mode uploads the original and lets Pillow
// resize it server-side; local BLE mode has no server in the loop, so the
// same resize (300px long edge, JPEG quality ~75, matching
// app/protocol/messages.py::IMAGE_LONG_EDGE_PX/IMAGE_JPEG_QUALITY) happens
// client-side via <canvas> instead, then the actual bytes go straight to
// AT2BleClient.sendImage(). ---------------------------------------------

// Resizes/re-encodes `file` to the wire format via <canvas>, returning
// both the JPEG bytes (what local BLE mode actually sends) and a base64
// copy (what every mode uses for the bubble preview) in one pass.
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image decode failed")); };
    img.src = url;
  });
}

function encodeCanvasJpeg(img, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("image encode failed")); return; }
      blob.arrayBuffer().then((buf) => resolve({ bytes: new Uint8Array(buf), width, height }));
    }, "image/jpeg", quality);
  });
}

// Resizes/re-encodes `file` to fit the protocol's hard cap on chunk count
// (255 * 132 = 33660 bytes -- app/protocol/messages.py's
// build_image_message_frames raises "image too large to fragment" past
// that). A single fixed 300px/quality-0.75 pass can still exceed it for
// busy/detailed photos -- confirmed in testing, this used to just throw
// outright. Backs off quality first (75% -> 35% floor), then shrinks the
// long edge further if quality alone isn't enough.
async function resizeImageForWire(file, maxEdge = 300, quality = 0.75) {
  const MAX_IMAGE_BYTES = 255 * 132;
  const img = await loadImageElement(file);
  let edge = maxEdge;
  let q = quality;
  let result = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await encodeCanvasJpeg(img, edge, q);
    if (result.bytes.length <= MAX_IMAGE_BYTES) return result;
    if (q > 0.35) q = Math.max(0.35, q - 0.15);
    else edge = Math.max(60, Math.round(edge * 0.85));
  }
  throw new Error(`image trop volumineuse même après compression maximale (${result.bytes.length} octets, max ${MAX_IMAGE_BYTES})`);
}

// Server mode doesn't need the real bytes client-side (the server does
// its own independent resize for the wire) -- just a lightweight preview
// so the bubble has something to show without storing a full-resolution
// original in localStorage.
function downscaleImageToBase64(file, maxEdge = 300, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image preview failed")); };
    img.src = url;
  });
}

$("#btn-attach-image").addEventListener("click", () => {
  if (!activeTransport()) return showToast(t("gps.noActiveConnection"), "info");
  $("#image-file-input").click();
});

$("#image-file-input").addEventListener("change", async () => {
  const file = $("#image-file-input").files[0];
  if (!file) return;
  const username = $("#msg-username").value || "AT2Bridge";
  try {
    const transport = activeTransport();
    let dataBase64;
    if (transport === "server") {
      const form = new FormData();
      form.append("username", username);
      form.append("image", file);
      [dataBase64] = await Promise.all([
        downscaleImageToBase64(file).catch(() => null),
        apiUpload("/api/messages/image", form),
      ]);
    } else if (transport === "local") {
      const { bytes, width, height } = await resizeImageForWire(file);
      await AT2BleClient.sendImage(username, bytes, width, height);
      dataBase64 = uint8ToBase64(bytes);
    } else {
      return showToast(t("gps.noActiveConnection"), "info");
    }
    addMessage(activeChannel, { kind: "image", sender: username, mine: true, dataBase64, caption: file.name });
  } catch (e) {
    showToast(e.message, "error");
  } finally {
    $("#image-file-input").value = "";
  }
});

// -- sending: voice notes (store-and-forward, distinct from live PTT).
// Reuses PttAudio.startCapture/stopCapture as-is (already exported by
// ptt-audio.js) to accumulate a full recording instead of streaming it.
// Local BLE mode AMR-encodes client-side via AT2BleClient.sendVoice() --
// see that function's comment in ble-client.js -- the same codec startPtt()
// already uses for live PTT, just applied to a full recording instead of
// a stream. --------------------------------------------------------------
let voiceRecording = false;
let voiceChunks = [];

$("#btn-record-voice").addEventListener("click", async () => {
  if (!activeTransport()) return showToast(t("gps.noActiveConnection"), "info");
  const btn = $("#btn-record-voice");

  if (!voiceRecording) {
    voiceRecording = true;
    voiceChunks = [];
    btn.classList.add("active");
    btn.textContent = "⏹️";
    try {
      await PttAudio.startCapture((int16Frame) => { voiceChunks.push(int16Frame); });
    } catch (e) {
      voiceRecording = false;
      btn.classList.remove("active");
      btn.textContent = "🎙️";
      showToast(t("msg.micUnavailable", { error: e.message }), "error");
    }
  } else {
    voiceRecording = false;
    PttAudio.stopCapture();
    btn.classList.remove("active");
    btn.textContent = "🎙️";

    const totalSamples = voiceChunks.reduce((sum, c) => sum + c.length, 0);
    if (totalSamples === 0) return;
    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of voiceChunks) { merged.set(c, offset); offset += c.length; }
    const durationMs = Math.round((totalSamples / 8000) * 1000);

    const username = $("#msg-username").value || "AT2Bridge";
    try {
      const transport = activeTransport();
      if (transport === "server") {
        const form = new FormData();
        form.append("username", username);
        form.append("duration_ms", String(durationMs));
        form.append("pcm", new Blob([merged.buffer], { type: "application/octet-stream" }), "voice.pcm");
        await apiUpload("/api/messages/voice", form);
      } else if (transport === "local") {
        await AT2BleClient.sendVoice(username, merged, durationMs);
      } else {
        return showToast(t("gps.noActiveConnection"), "info");
      }
      addMessage(activeChannel, { kind: "voice", sender: username, mine: true, durationMs, pcm: Array.from(merged) });
    } catch (e) {
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
// Incoming offline messages (text/voice/image) -- server mode via
// /ws/messages, local BLE mode via AT2BleClient.onMessageReceived() (see
// static/protocol.js::MessageAssembler / static/ble-client.js -- local BLE
// mode previously didn't decode incoming messages at all, only logged the
// raw family/command of every packet).
// ---------------------------------------------------------------------------

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// `msg`: {kind, sender, text?, dataBase64?, durationMs?, width?, height?} --
// no channel tag on the wire, so bucketed under whichever channel is
// currently active (the only one the radio could have received this on).
function handleIncomingMessage(msg) {
  addMessage(activeChannel, {
    kind: msg.kind,
    sender: msg.sender,
    mine: false,
    text: msg.text,
    dataBase64: msg.dataBase64 || null,
    durationMs: msg.durationMs || null,
    width: msg.width || null,
    height: msg.height || null,
  });
}

function connectMessagesSocket() {
  const ws = new WebSocket(wsUrl("/ws/messages"));
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleIncomingMessage({
        kind: msg.kind, sender: msg.sender, text: msg.text, dataBase64: msg.data_base64,
        durationMs: msg.duration_ms, width: msg.width, height: msg.height,
      });
    } catch (e) { appendLog(t("msg.unreadable", { error: e.message })); }
  };
  ws.onclose = () => setTimeout(connectMessagesSocket, 2000);
}

AT2BleClient.onMessageReceived((msg) => {
  handleIncomingMessage({
    kind: msg.kind,
    sender: msg.sender,
    text: msg.text,
    dataBase64: msg.data ? uint8ToBase64(msg.data) : null,
    durationMs: msg.durationMs,
    width: msg.width,
    height: msg.height,
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function startApp() {
  connectLogSocket();
  connectMessagesSocket();
  connectPttRxSocket();
  loadDeviceList();
  loadChannelNames().then(() => applyActiveChannel(false));
  api("GET", "/api/channels/tone-options").then((opts) => { toneOptions = opts; }).catch(() => {});
  refreshStatus();
  refreshTargetList();
  setInterval(() => { if (mode === "server") refreshStatus(); }, 5000);
}

checkAuthStatus().then((ok) => { if (ok) startApp(); });

