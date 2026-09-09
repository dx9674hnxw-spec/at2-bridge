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
  renderChanFreq();
  renderScanState();
  refreshBetaLabels();
  applyModeUi();
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
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
  $("#theme-toggle").title = t("theme.title");
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
let logLines = []; // { timestamp, text, cls, el }
let lastActionStart = 0;
let logFilterText = "";
let unseenLogLines = 0;

// Keeps a long session's memory/DOM bounded, same idea as alertHistory's
// 200-entry cap and the beacon store's 300 -- this one previously had no
// cap at all, so it could grow forever.
const LOG_MAX_LINES = 800;

function classifyLogLine(text) {
  if (/^RX\b/.test(text)) return "log-rx";
  if (/^TX\b/.test(text)) return "log-tx";
  if (/^\[DEBUG\]/.test(text)) return "log-debug";
  if (/⚠️|erreur|error|échec|failed/i.test(text)) return "log-error";
  return "log-info";
}

function lineMatchesFilter(entry) {
  if (!logFilterText) return true;
  return entry.text.toLowerCase().includes(logFilterText) || entry.timestamp.includes(logFilterText);
}

// "At the bottom" with a little slack (40px) rather than an exact ===0
// check -- otherwise a fractional-pixel scroll position (common with
// high-DPI displays/trackpad momentum) would count as "scrolled away"
// and start holding back new lines behind the jump badge for no reason.
function isLogAtBottom() {
  const el = $("#log-console");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function updateLogJumpBadge() {
  const badge = $("#log-jump-badge");
  badge.hidden = unseenLogLines === 0;
  if (unseenLogLines > 0) badge.textContent = t("log.newLines", { n: unseenLogLines });
}

function scrollLogToBottom() {
  const el = $("#log-console");
  el.scrollTop = el.scrollHeight;
  unseenLogLines = 0;
  updateLogJumpBadge();
}

function renderLogLine(entry) {
  const el = $("#log-console");
  const span = document.createElement("span");
  span.className = `log-line ${entry.cls}`;
  span.textContent = `[${entry.timestamp}] ${entry.text}\n`;
  span.style.display = lineMatchesFilter(entry) ? "" : "none";
  entry.el = span;
  el.appendChild(span);
}

function trimLogOverflow() {
  if (logLines.length <= LOG_MAX_LINES) return;
  const overflow = logLines.length - LOG_MAX_LINES;
  for (let i = 0; i < overflow; i++) logLines[i].el.remove();
  logLines.splice(0, overflow);
  lastActionStart = Math.max(0, lastActionStart - overflow);
}

function appendLog(line) {
  const now = new Date().toLocaleTimeString("fr-FR");
  const entry = { timestamp: now, text: line, cls: classifyLogLine(line) };
  const wasAtBottom = isLogAtBottom();
  logLines.push(entry);
  if (entry.cls !== "log-rx") lastActionStart = logLines.length - 1;
  renderLogLine(entry);
  trimLogOverflow();
  // Only the auto-scroll/badge care whether this line is actually visible
  // under the current filter -- no point yanking the view to the bottom,
  // or counting toward "N new lines", for something the filter is hiding.
  if (lineMatchesFilter(entry)) {
    if (wasAtBottom) scrollLogToBottom();
    else { unseenLogLines++; updateLogJumpBadge(); }
  }
}

$("#log-filter").addEventListener("input", (e) => {
  logFilterText = e.target.value.trim().toLowerCase();
  for (const entry of logLines) entry.el.style.display = lineMatchesFilter(entry) ? "" : "none";
  // Typing a filter reshuffles what's visible around the current scroll
  // position in a way "was I at the bottom" can't meaningfully answer
  // anymore -- simplest correct behavior is to jump to the bottom of
  // whatever now matches and clear the "new lines" counter with it.
  scrollLogToBottom();
});

$("#log-jump-badge").addEventListener("click", scrollLogToBottom);

$("#btn-log-clear").addEventListener("click", () => {
  logLines = [];
  lastActionStart = 0;
  unseenLogLines = 0;
  $("#log-console").innerHTML = "";
  updateLogJumpBadge();
});

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
  updatePageTitle();
}

// Every tab always showed the same generic "AT2 Bridge" title -- no way
// to tell, from the browser's tab bar/window list, which physical radio a
// given tab is actually talking to. Confirmed as a real point of
// confusion (05/09/2026): with two tabs open side by side, each connected
// to a different radio over local BLE and sharing the same PC speakers,
// there was no way to tell which tab's audio was actually playing when
// testing incoming voice. Local BLE takes priority, matching
// activeTransport()'s own precedence (BLE wins if, unusually, both are
// connected at once).
function updatePageTitle() {
  if (AT2BleClient.connected() && localDeviceInfo) {
    document.title = `${localDeviceInfo.name} — AT2 Bridge`;
  } else if (connected && activeServerTarget) {
    document.title = `${activeServerTarget} — AT2 Bridge`;
  } else {
    document.title = "AT2 Bridge";
  }
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
    // Background prefetch: connecting itself already succeeded, so a
    // failure here (e.g. an empty/unconfigured codeplug) stays silent --
    // it only means the PTT panel's frequency block and the Canaux table
    // keep showing "—" until "Lire les 30 canaux" is used by hand.
    loadAllChannels().catch(() => {});
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
    loadAllChannels().catch(() => {}); // background prefetch, see loadAllChannels()'s comment
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
    loadAllChannels().catch(() => {}); // background prefetch, see loadAllChannels()'s comment
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

function formatMhz(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(4) : "—";
}

// RX frequency front and center (mirrors a physical radio's own display),
// TX/tone/bandwidth as a sub-line -- previously only the local channel
// name and the H/N/📡/D icon row were shown here, with the actual
// frequencies visible only in the Canaux tab's table.
function renderChanFreq() {
  const cfg = lastReadChannels.find((c) => c.channel === activeChannel);
  const duplexBadge = $("#chan-freq-duplex");
  if (!cfg || !cfg.rx_mhz) {
    $("#chan-freq-rx").textContent = "—";
    $("#chan-freq-sub").textContent = t("chan.readFirst");
    duplexBadge.hidden = true;
    return;
  }
  $("#chan-freq-rx").textContent = formatMhz(cfg.rx_mhz);
  const bw = cfg.bandwidth_narrow ? t("chan.narrow") : t("chan.wide");
  const tone = (cfg.tx_tone && cfg.tx_tone !== "OFF") ? cfg.tx_tone : ((cfg.rx_tone && cfg.rx_tone !== "OFF") ? cfg.rx_tone : null);
  const parts = [t("chan.txFreqLabel", { mhz: formatMhz(cfg.tx_mhz) })];
  if (tone) parts.push(t("chan.toneLabel", { tone }));
  parts.push(bw);
  $("#chan-freq-sub").textContent = parts.join(" · ");
  // Derived, not a stored field: true whenever this channel's TX and RX
  // genuinely differ (a repeater offset), not a claim about any specific
  // repeater identity.
  duplexBadge.hidden = Math.abs((cfg.tx_mhz || 0) - (cfg.rx_mhz || 0)) < 0.0001;
}

// Bare protocol call, no UI side effects -- split out of
// applyActiveChannel() so the Scan tab can key an arbitrary channel on
// the radio while it cycles without also dragging the Messaging tab's
// active group along on every dwell step (see applyScanFinish() below).
async function sendChannelSelect(ch) {
  const transport = activeTransport();
  if (transport === "server") await api("POST", `/api/channels/${ch}/select`);
  else if (transport === "local") await AT2BleClient.selectChannel(ch);
}

async function applyActiveChannel(select = true) {
  renderChanSelect();
  renderChanOpts();
  renderChanFreq();
  $("#ptt-device-sub").textContent = `${t("channelLabel", { n: String(activeChannel).padStart(2, "0") })}${channelNames[activeChannel] ? " · " + channelNames[activeChannel] : ""}`;
  renderMessagingPanel(); // Messaging tab's group list/status grid/thread track the same active channel
  if (select) {
    try { await sendChannelSelect(activeChannel); }
    catch (e) { appendLog(t("chan.selectError", { error: e.message })); }
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
  // Dispatched unconditionally, ahead of the pttActive short-circuit below
  // (that one's just about not fighting the TX indicator visually) -- the
  // Scan tab's pause-on-activity listens for this and it's real incoming
  // traffic either way. See the Scan tab section further down.
  window.dispatchEvent(new Event("at2:rf-activity"));
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

// `centerMap`: also pan/zoom the Leaflet view straight to the fresh fix and
// re-arm auto-follow (see mapUserInteracted above). Only "Centrer sur moi"
// wants that -- the automatic call below, on page load, shouldn't jump the
// map before the user has even opened the Map tab.
function requestLocation(centerMap) {
  if (!navigator.geolocation) { updateGpsFix(false, t("gps.unavailable")); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      $("#gps-coords").textContent = formatCoords(lastCoords.lat, lastCoords.lon);
      $("#gps-accuracy").textContent = t("gps.accuracy", { meters: Math.round(lastCoords.acc) });
      updateGpsFix(true, t("gps.fixAcquired"));
      if (centerMap) mapUserInteracted = false;
      renderMapIfActive(); // distances/bearings on the Map tab depend on lastCoords
      if (centerMap && mapViewMode === "map" && leafletMap) {
        mapProgrammaticMove = true;
        leafletMap.setView([lastCoords.lat, lastCoords.lon], Math.max(leafletMap.getZoom(), 15));
        mapProgrammaticMove = false;
      }
    },
    () => updateGpsFix(false, t("gps.denied")),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
requestLocation();

// SOS alert tone: a short synthesized two-tone siren, sent as a real
// store-and-forward voice message (same AT2Protocol.buildVoiceMessageFrames
// / AmrNbCodec path as a recorded voice note -- see #btn-record-voice
// below) alongside the SOS text, so a receiving radio/app gets an audible
// alert too, not just a silent text bubble. Synthesized rather than
// recorded from the mic: no permission prompt needed in the moment, and
// it's identical every time so it reads as a deliberate alert tone rather
// than whatever the mic happened to pick up.
const ALERT_TONE_SAMPLE_RATE = 8000; // must match sendVoice()'s expected PCM rate
function generateAlertTonePcm() {
  const freqA = 950, freqB = 1400; // classic two-tone siren pitch
  const segmentMs = 220;
  const repeats = 5; // ~2.2s total -- long enough to be unmistakable, short enough to send quickly
  const segmentSamples = Math.round(ALERT_TONE_SAMPLE_RATE * segmentMs / 1000);
  const fadeSamples = Math.round(ALERT_TONE_SAMPLE_RATE * 0.005); // 5ms fade in/out per segment, avoids clicks at each tone switch
  const pcm = new Int16Array(segmentSamples * 2 * repeats);
  const amp = 0.55 * 32767;
  let idx = 0;
  for (let r = 0; r < repeats; r++) {
    for (const freq of [freqA, freqB]) {
      for (let i = 0; i < segmentSamples; i++) {
        let env = 1;
        if (i < fadeSamples) env = i / fadeSamples;
        else if (i > segmentSamples - fadeSamples) env = (segmentSamples - i) / fadeSamples;
        pcm[idx++] = Math.round(amp * env * Math.sin((2 * Math.PI * freq * i) / ALERT_TONE_SAMPLE_RATE));
      }
    }
  }
  const durationMs = Math.round((pcm.length / ALERT_TONE_SAMPLE_RATE) * 1000);
  return { pcm, durationMs };
}

// Best-effort: a failed tone shouldn't make sosConfirmSend() report the
// whole SOS as failed when the actual position/text (the critical part)
// went out fine. Logged either way so it's never silently skipped.
async function sendAlertTone(username, transport) {
  const { pcm, durationMs } = generateAlertTonePcm();
  try {
    if (transport === "server") {
      const form = new FormData();
      form.append("username", username);
      form.append("duration_ms", String(durationMs));
      form.append("pcm", new Blob([pcm.buffer], { type: "application/octet-stream" }), "alert.pcm");
      await apiUpload("/api/messages/voice", form);
    } else if (transport === "local") {
      await AT2BleClient.sendVoice(username, pcm, durationMs);
      appendLog(`Tonalité d'alerte envoyée (BLE local, ${(durationMs / 1000).toFixed(1)}s).`);
    }
  } catch (e) {
    appendLog(`⚠️ Échec d'envoi de la tonalité d'alerte: ${e.message}`);
  }
}

// Throws on any failure to actually send (no GPS fix, no connection) --
// used to swallow both cases with just a toast and no throw, which the
// SOS button's hold-to-confirm handler took as success: it flipped to
// "✔ Sent" with a timestamp even when nothing had gone out. Every caller
// already wraps this in try/catch and shows e.message itself, so
// throwing here is enough to fix all of them at once instead of getting
// the "did it actually send" check right in each caller separately.
async function sendPositionPayload(url, note) {
  if (!lastCoords) throw new Error(t("gps.noCoords"));
  const username = $("#msg-username")?.value || "AT2Bridge";
  const transport = activeTransport();
  if (transport === "server") {
    await api("POST", url, { username, lat: lastCoords.lat, lon: lastCoords.lon, note });
  } else if (transport === "local") {
    // Same wire format as device.py::send_position (bare "lat,lon", 5
    // decimals, no ° symbol) -- was previously built from formatCoords()
    // (meant for the on-screen readout only, "48.88800° , 2.38453°"),
    // making local-BLE position messages a different shape than server
    // mode's for no protocol reason. Matters now that the Map tab parses
    // this text back out to plot beacons.
    // The /api/position/sos server route prefixes the note with 🆘 itself
    // (see main.py) before it ever reaches send_position() -- local mode
    // calls AT2BleClient.sendText() directly, bypassing that route, so it
    // needs the same prefix here or an SOS goes out wire-identical to a
    // routine "send my position now" beacon (no emergency marker at all
    // for a receiving radio/app to key off of).
    const fullNote = url === "/api/position/sos" ? `🆘 ${note}` : note;
    const posText = `${fullNote ? fullNote + " " : ""}📍 ${lastCoords.lat.toFixed(5)},${lastCoords.lon.toFixed(5)}`;
    await AT2BleClient.sendText(username, posText);
    // Server mode gets this for free (backend logs the send, streamed
    // into the Journal over the log WS -- see ws.onmessage below); local
    // mode runs client-side only, so without this the Journal shows every
    // incoming RX packet but never what actually went out.
    appendLog(`Message texte envoyé (BLE local): "${posText}"`);
  } else {
    throw new Error(t("gps.noActiveConnection"));
  }
  // Position/text above is the critical part of an SOS and has already
  // thrown by now if it failed; the tone is a best-effort addition on
  // top (sendAlertTone() never throws, see its own comment), so this
  // never turns a real SOS send into a reported failure.
  if (url === "/api/position/sos") await sendAlertTone(username, transport);
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

// SOS used to send on a single click of a small button right next to the
// reason dropdown -- one misclick or fat-thumb tap fired a real emergency
// alert. Now a hold-to-confirm interaction, same language as PTT's own
// press-and-hold (#ptt-btn, same tab): sending only actually happens once
// the hold completes; letting go early cancels, same failure mode as
// releasing PTT early. SOS_HOLD_MS must match the CSS transition duration
// on .sos-hold-fill (style.css) -- that fill is a visual cue only, this
// timer is what actually gates the send.
const SOS_HOLD_MS = 1400;
let sosHoldTimer = null;
let sosHolding = false;

function sosSetLabel(key) { $("#sos-hold-label").textContent = t(key); }

function sosStartHold() {
  if (sosHolding || $("#sos-btn").classList.contains("sent")) return;
  sosHolding = true;
  $("#sos-btn").classList.add("holding");
  sosSetLabel("gps.sosHolding");
  sosHoldTimer = setTimeout(sosConfirmSend, SOS_HOLD_MS);
}
function sosCancelHold() {
  if (!sosHolding) return;
  sosHolding = false;
  clearTimeout(sosHoldTimer);
  $("#sos-btn").classList.remove("holding");
  sosSetLabel("gps.sosHoldLabel");
}
async function sosConfirmSend() {
  sosHolding = false;
  const btn = $("#sos-btn");
  btn.classList.remove("holding");
  const preset = $("#sos-preset").value;
  try {
    await sendPositionPayload("/api/position/sos", preset);
    btn.classList.add("sent");
    sosSetLabel("gps.sosSent");
    $("#sos-status").textContent = t("gps.sosSentAt", { time: new Date().toLocaleTimeString("fr-FR", { hour12: false }) });
    setTimeout(() => {
      btn.classList.remove("sent");
      sosSetLabel("gps.sosHoldLabel");
      $("#sos-status").textContent = t("gps.sosIdleHint");
    }, 3000);
  } catch (e) {
    sosSetLabel("gps.sosHoldLabel");
    $("#sos-status").textContent = t("gps.sosIdleHint");
    showToast(e.message, "error");
  }
}
const sosBtn = $("#sos-btn");
sosBtn.addEventListener("mousedown", sosStartHold);
sosBtn.addEventListener("touchstart", (e) => { e.preventDefault(); sosStartHold(); });
["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((evt) => sosBtn.addEventListener(evt, sosCancelHold));

// ---------------------------------------------------------------------------
// Map tab: last known position of every sender who has shared a GPS
// beacon. There's no structured "Position" message type in the real
// protocol (see README) -- device.py::send_position/send_sos just format
// it as plain text prefixed with 📍/🆘, so this mirrors every completed
// text message (see addMessage() above) through the same parser used for
// the chat bubbles, and keeps a dedicated store of whatever matches.
// ---------------------------------------------------------------------------

const BEACON_STORE_KEY = "at2_beacons";
const BEACON_MAX = 300;

// Tolerates two shapes: server mode's bare "lat,lon" (5 decimals, no °,
// see device.py::send_position) and local BLE mode's previous "lat° ,
// lon°" (fixed above to match server mode, but old messages already
// sitting in a browser's localStorage may still be in that shape).
const POSITION_RE = /📍\s*(-?\d{1,3}(?:\.\d+)?)°?\s*,\s*(-?\d{1,3}(?:\.\d+)?)°?/;

function parsePositionText(text) {
  if (!text) return null;
  const m = POSITION_RE.exec(text);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const note = text.slice(0, m.index).replace(/^🆘\s*/, "").trim();
  return { lat, lon, note, sos: text.includes("🆘") };
}

function loadBeacons() {
  try {
    const raw = localStorage.getItem(BEACON_STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveBeacons() {
  try { localStorage.setItem(BEACON_STORE_KEY, JSON.stringify(beacons)); } catch (e) {}
}
let beacons = loadBeacons();
let nextBeaconId = 1;

// `msg`: the same object addMessage() just stored (kind, sender, mine,
// text). Shown app-wide on the map regardless of which channel it arrived
// on -- a GPS fix means the same thing everywhere, and the protocol has
// no real per-channel addressing anyway (see README), so the chat tab's
// channel bucketing isn't meaningful here.
function recordBeaconFromMessage(msg) {
  if (msg.kind !== "text") return;
  const parsed = parsePositionText(msg.text);
  if (!parsed) return;
  beacons.push({
    id: nextBeaconId++, sender: msg.sender, mine: !!msg.mine,
    lat: parsed.lat, lon: parsed.lon, note: parsed.note, sos: parsed.sos,
    time: Date.now(),
  });
  if (beacons.length > BEACON_MAX) beacons.splice(0, beacons.length - BEACON_MAX);
  saveBeacons();
  renderMapIfActive();
}

// One marker per sender (the most recent beacon they've sent), not a full
// trail -- keeps both the list and the map legible with more than a
// handful of people. Sorted most-recent-first.
function latestBeaconsBySender() {
  const bySender = new Map();
  for (const b of beacons) {
    const key = b.mine ? "__mine__" : b.sender;
    const cur = bySender.get(key);
    if (!cur || b.time > cur.time) bySender.set(key, b);
  }
  return Array.from(bySender.values()).sort((a, b) => b.time - a.time);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
function timeAgoLabel(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t("map.secondsAgo", { n: s });
  if (s < 3600) return t("map.minutesAgo", { n: Math.round(s / 60) });
  if (s < 86400) return t("map.hoursAgo", { n: Math.round(s / 3600) });
  return t("map.daysAgo", { n: Math.round(s / 86400) });
}

// Leaflet loaded (see index.html's script tag) only if the client had
// Internet access to fetch it from cdnjs -- `L` stays undefined otherwise
// (this app runs off-grid by design, so that's an expected, not
// exceptional, outcome). Falls back to the dependency-free radar view,
// user-toggleable rather than auto-detected: there's no reliable, cheap
// way to tell "the library loaded fine but tiles themselves are
// unreachable" after the fact.
const LEAFLET_AVAILABLE = typeof L !== "undefined";
let leafletMap = null;
let leafletMarkers = [];
let mapViewMode = LEAFLET_AVAILABLE ? "map" : "radar";
if (!LEAFLET_AVAILABLE) {
  $("#map-view-toggle").disabled = true;
  $("#map-view-toggle").title = t("map.leafletUnavailable");
}

// True once the user has panned/zoomed the map by hand. Every incoming
// beacon used to re-run fitBounds() unconditionally, which yanked the view
// back to "fit everyone" a second or two into any manual drag -- on a live
// swarm of radios that beacon every few seconds this made the map feel
// undraggable. Once the user has touched it, auto-fit backs off and only
// resumes on an explicit "Centrer sur moi" click. mapProgrammaticMove tells
// the dragstart/zoomstart listener below to ignore moves *we* trigger
// (fitBounds/setView), so those don't get misread as user interaction.
let mapUserInteracted = false;
let mapProgrammaticMove = false;

function ensureLeafletMap() {
  if (leafletMap || !LEAFLET_AVAILABLE) return;
  leafletMap = L.map("map-canvas").setView([0, 0], 2);
  // CARTO's "Dark Matter" basemap instead of stock OSM tiles: same
  // OpenStreetMap data, styled dark so it doesn't look like a bright
  // light-mode rectangle dropped into an otherwise all-dark app. Free,
  // no API key/account (unlike Mapbox or Stadia's hosted Stamen tiles) --
  // matters here since this app has no backend account of its own to hold
  // a key for. Attribution to both required by their terms.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(leafletMap);
  leafletMap.on("dragstart zoomstart", () => {
    if (!mapProgrammaticMove) mapUserInteracted = true;
  });
}

function renderMapBeaconList(list) {
  const el = $("#map-beacon-list");
  if (!list.length) {
    el.innerHTML = `<div class="hint" style="padding:16px 4px;">${t("map.empty")}</div>`;
    return;
  }
  el.innerHTML = list.map((b) => {
    const dist = lastCoords ? t("map.distanceKm", { km: haversineKm(lastCoords.lat, lastCoords.lon, b.lat, b.lon).toFixed(2) }) : "—";
    const label = b.mine ? t("map.you") : b.sender;
    return `
      <div class="map-beacon-row ${b.sos ? "sos" : ""}" data-lat="${b.lat}" data-lon="${b.lon}">
        <span class="map-beacon-dot"></span>
        <div class="map-beacon-info">
          <div class="map-beacon-name">${escapeHtml(label)}${b.sos ? " 🆘" : ""}</div>
          <div class="map-beacon-sub">${dist} · ${timeAgoLabel(b.time)}${b.note ? " · " + escapeHtml(b.note) : ""}</div>
        </div>
      </div>`;
  }).join("");
  el.querySelectorAll(".map-beacon-row").forEach((row) => {
    row.addEventListener("click", () => {
      const lat = parseFloat(row.dataset.lat);
      const lon = parseFloat(row.dataset.lon);
      if (mapViewMode === "map" && leafletMap) leafletMap.setView([lat, lon], 14);
    });
  });
}

function renderRadar(list) {
  const svg = $("#map-radar");
  const size = 320;
  const center = size / 2;
  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => `<circle cx="${center}" cy="${center}" r="${center * f - 4}" class="radar-ring" />`)
    .join("");
  let parts = [];
  if (lastCoords && list.length) {
    let maxKm = 1;
    for (const b of list) maxKm = Math.max(maxKm, haversineKm(lastCoords.lat, lastCoords.lon, b.lat, b.lon));
    const scale = (center - 28) / maxKm;
    for (const b of list) {
      const km = haversineKm(lastCoords.lat, lastCoords.lon, b.lat, b.lon);
      const brg = bearingDegrees(lastCoords.lat, lastCoords.lon, b.lat, b.lon);
      const rad = ((brg - 90) * Math.PI) / 180; // 0°=North drawn pointing up
      const r = km * scale;
      const x = center + r * Math.cos(rad);
      const y = center + r * Math.sin(rad);
      const label = b.mine ? t("map.you") : b.sender;
      parts.push(`<circle cx="${x}" cy="${y}" r="6" class="radar-point ${b.sos ? "sos" : ""}" />`);
      parts.push(`<text x="${x}" y="${y - 10}" class="radar-label">${escapeHtml(label)}</text>`);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.innerHTML = `
    ${rings}
    <line x1="${center}" y1="4" x2="${center}" y2="${size - 4}" class="radar-axis" />
    <line x1="4" y1="${center}" x2="${size - 4}" y2="${center}" class="radar-axis" />
    <circle cx="${center}" cy="${center}" r="5" class="radar-self" />
    ${parts.join("")}
  `;
}

function renderMap() {
  const list = latestBeaconsBySender();
  $("#map-sub").textContent = t("map.knownCount", { n: list.length });
  renderMapBeaconList(list);

  if (mapViewMode === "map" && LEAFLET_AVAILABLE) {
    ensureLeafletMap();
    $("#map-canvas").hidden = false;
    $("#map-radar").hidden = true;
    // Must run before fitBounds() below: Leaflet computes the fit against
    // its cached container size, which is stale/zero the first time the
    // tab becomes visible (or after the window was resized while another
    // tab was open) and produces a wrongly centered/zoomed view otherwise.
    leafletMap.invalidateSize();
    leafletMarkers.forEach((m) => leafletMap.removeLayer(m));
    leafletMarkers = [];
    const bounds = [];
    if (lastCoords) {
      const mine = L.circleMarker([lastCoords.lat, lastCoords.lon], {
        radius: 7, color: "#3b82f6", fillColor: "#3b82f6", fillOpacity: 1, weight: 2,
      }).addTo(leafletMap).bindTooltip(t("map.you"));
      leafletMarkers.push(mine);
      bounds.push([lastCoords.lat, lastCoords.lon]);
    }
    for (const b of list) {
      if (b.mine) continue; // already drawn from lastCoords above (more current than the last beacon sent)
      const color = b.sos ? "#ef4444" : "#10b981";
      const marker = L.circleMarker([b.lat, b.lon], {
        radius: 7, color, fillColor: color, fillOpacity: 0.9, weight: 2,
      }).addTo(leafletMap).bindTooltip(`${b.sender}${b.sos ? " 🆘" : ""}`);
      leafletMarkers.push(marker);
      bounds.push([b.lat, b.lon]);
    }
    // Only auto-fit while the user hasn't taken the wheel themselves --
    // otherwise every beacon from a live swarm snaps the view back and the
    // map effectively can't be dragged. "Centrer sur moi" resets the flag
    // to explicitly opt back into auto-follow.
    if (bounds.length && !mapUserInteracted) {
      mapProgrammaticMove = true;
      leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      mapProgrammaticMove = false;
    }
  } else {
    $("#map-canvas").hidden = true;
    $("#map-radar").hidden = false;
    renderRadar(list);
  }
}

function renderMapIfActive() {
  if ($("#tab-map").classList.contains("active")) renderMap();
}

$("#map-view-toggle").addEventListener("click", () => {
  if (!LEAFLET_AVAILABLE) return showToast(t("map.leafletUnavailable"), "info");
  mapViewMode = mapViewMode === "map" ? "radar" : "map";
  $("#map-view-toggle").textContent = mapViewMode === "map" ? t("map.viewRadar") : t("map.viewMap");
  renderMap();
});
$("#map-center-btn").addEventListener("click", () => {
  requestLocation(true);
  showToast(t("map.locating"), "info");
});
// The generic tab switcher (see "Tabs" above) only toggles .active classes;
// hook the Map tab specifically to (re)render once its panel is actually
// visible -- Leaflet reports a zero-size map until invalidateSize() runs
// against a visible container, and the beacon list should reflect
// anything received while another tab was open.
$$(".tab").forEach((tabBtn) => {
  if (tabBtn.dataset.tab === "map") tabBtn.addEventListener("click", () => setTimeout(renderMap, 0));
});
// Keep the tile layer aligned with its container on viewport/orientation
// changes -- otherwise resizing the window (or rotating a tablet) leaves
// Leaflet's cached size stale until the next beacon triggers a re-render.
window.addEventListener("resize", () => {
  if (leafletMap && mapViewMode === "map") leafletMap.invalidateSize();
});

// ---------------------------------------------------------------------------
// Channel scan: a full-width card in the Devices tab (#scan-card in
// index.html), right below the PTT/channel-selection grid -- not its own
// tab, since it acts on the same channel selection PTT and the channel
// dropdown do; not nested inside #ptt-panel either (tried that first --
// that column was too narrow, left the whole section stacked vertically
// with unused width beside it). Cycles through the channels already read
// into lastReadChannels (Canaux tab), sending the real select_channel
// command for each one via
// sendChannelSelect() -- ported from the Beta tab's frequency-scan.html
// prototype, same idea minus the simulated activity. "Activity detected"
// reuses the RX indicator's real incoming-PTT-packet signal (see the
// "at2:rf-activity" event dispatched from markIncomingRfActivity() above);
// there is no RSSI/squelch telemetry in this protocol to detect with, and
// this only catches traffic relayed through this app, not any radio
// chatter -- see scan.activityNote / beta/README.md's "Honnêteté
// matérielle" for why that limit is stated up front rather than implied.
// ---------------------------------------------------------------------------
let scanRunning = false;
let scanPaused = false;
let scanTimerId = null;
let scanRafId = null;
let scanChannelBeforeStart = null;
let scanCurrentKey = null; // the channel object currently being dwelled on
let scanPriorityCh = null;
let scanIncluded = new Set(); // session-only "include in this scan" set, seeded from scan_add but not written back to the radio

function scanEligibleChannels() {
  // Only channels with a known RX frequency are worth cycling to --
  // emptyChannels() placeholders (never actually read) have none.
  return lastReadChannels.filter((c) => scanIncluded.has(c.channel) && c.rx_mhz);
}
function scanOrderedChannels() {
  const list = scanEligibleChannels();
  if (scanPriorityCh != null) {
    const p = lastReadChannels.find((c) => c.channel === scanPriorityCh);
    if (p && p.rx_mhz) {
      const out = [];
      for (const c of list) { out.push(c); if (c.channel !== p.channel) out.push(p); }
      return out.length ? out : [p];
    }
  }
  return list;
}

function renderScanState() {
  const hasChannels = lastReadChannels.some((c) => c.rx_mhz);
  $("#scan-empty-state").hidden = hasChannels;
  $("#scan-layout").hidden = !hasChannels;
  $$(".scan-toggle-btn").forEach((btn) => { btn.disabled = !hasChannels; });
  if (!hasChannels) { $("#scan-sub").textContent = t("scan.subEmpty"); return; }
  // Reseed the session-only include set only the first time real channels
  // show up (or after a fresh read replaces the list entirely) -- avoids
  // clobbering checkboxes the user already unticked on a re-render that
  // isn't actually new data (e.g. a language switch).
  const knownChannels = new Set(lastReadChannels.map((c) => c.channel));
  for (const ch of [...scanIncluded]) if (!knownChannels.has(ch)) scanIncluded.delete(ch);
  if (!scanIncluded.size) {
    for (const c of lastReadChannels) if (c.rx_mhz && c.scan_add !== false) scanIncluded.add(c.channel);
  }
  renderScanChannelTable();
  renderScanPrioritySelect();
  updateScanSub();
}

function renderScanChannelTable() {
  const grid = $("#scan-chan-table");
  const rows = lastReadChannels.filter((c) => c.rx_mhz);
  grid.innerHTML = rows.map((c) => {
    const name = channelNames[c.channel] || c.name || "";
    return `
    <div class="scan-chan-chip ${!scanIncluded.has(c.channel) ? "excluded" : ""} ${c.channel === scanPriorityCh ? "priority" : ""} ${scanCurrentKey === c.channel ? "current" : ""}" data-ch="${c.channel}" title="${t("scan.includeInScan")}">
      <div class="scan-chan-num">CH${String(c.channel).padStart(2, "0")}</div>
      ${name ? `<div class="scan-chan-chip-name">${escapeHtml(name)}</div>` : ""}
    </div>`;
  }).join("");
  grid.querySelectorAll(".scan-chan-chip").forEach((chip) => chip.addEventListener("click", () => {
    const ch = Number(chip.dataset.ch);
    if (scanIncluded.has(ch)) scanIncluded.delete(ch); else scanIncluded.add(ch);
    renderScanChannelTable(); renderScanPrioritySelect(); updateScanSub();
  }));
}
function renderScanPrioritySelect() {
  const sel = $("#scan-priority-select");
  const current = String(scanPriorityCh ?? "");
  sel.innerHTML = `<option value="">${t("scan.priorityNone")}</option>` +
    lastReadChannels.filter((c) => c.rx_mhz).map((c) => {
      const name = channelNames[c.channel] || c.name || "";
      return `<option value="${c.channel}">CH${String(c.channel).padStart(2, "0")}${name ? " · " + escapeHtml(name) : ""}</option>`;
    }).join("");
  sel.value = current;
}
$("#scan-priority-select").addEventListener("change", (e) => {
  scanPriorityCh = e.target.value ? Number(e.target.value) : null;
  renderScanChannelTable();
});
$("#scan-read-btn").addEventListener("click", async () => {
  try { await loadAllChannels(); } catch (e) { showToast(e.message, "error"); }
});

function updateScanSub() {
  const n = lastReadChannels.filter((c) => c.rx_mhz).length;
  $("#scan-sub").textContent = scanRunning
    ? t("scan.subRunning", { active: scanIncluded.size })
    : t("scan.subReady", { n, active: scanIncluded.size });
}

function fmtScanClock() { return new Date().toLocaleTimeString(getLang() === "en" ? "en-GB" : "fr-FR", { hour12: false }); }
function scanLog(text, hit) {
  const log = $("#scan-log");
  const row = document.createElement("div");
  row.className = "scan-log-row" + (hit ? " hit" : "");
  row.innerHTML = `<span class="scan-log-time">${fmtScanClock()}</span><span>${escapeHtml(text)}</span>`;
  log.insertBefore(row, log.firstChild);
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

function setScanDisplay(c, statusText, hit) {
  $("#scan-display").classList.toggle("hit", !!hit);
  $("#scan-status").textContent = statusText;
  const name = c ? (channelNames[c.channel] || c.name || "") : "";
  $("#scan-ch-num").textContent = c ? `CH${String(c.channel).padStart(2, "0")}` : "—";
  $("#scan-ch-name").textContent = c ? (name || "—") : t("scan.idleHint");
  $("#scan-ch-freq").textContent = c ? `${formatMhz(c.rx_mhz)} MHz` : " ";
  scanCurrentKey = c ? c.channel : null;
  $$(".scan-chan-chip").forEach((r) => r.classList.toggle("current", c && Number(r.dataset.ch) === c.channel));
}

function animateScanProgress(durationMs) {
  cancelAnimationFrame(scanRafId);
  const bar = $("#scan-progress-bar");
  const start = performance.now();
  function tick(now) {
    const pct = Math.min(100, ((now - start) / durationMs) * 100);
    bar.style.width = pct + "%";
    if (pct < 100 && scanRunning && !scanPaused) scanRafId = requestAnimationFrame(tick);
  }
  scanRafId = requestAnimationFrame(tick);
}

let scanStepIdx = -1;
async function scanStep() {
  if (!scanRunning || scanPaused) return;
  const list = scanOrderedChannels();
  if (!list.length) { stopScan(); scanLog(t("scan.logNoChannels"), false); return; }
  scanStepIdx = (scanStepIdx + 1) % list.length;
  const c = list[scanStepIdx];
  try { await sendChannelSelect(c.channel); }
  catch (e) { appendLog(t("chan.selectError", { error: e.message })); }
  if (!scanRunning) return; // stopped while the select command was in flight
  setScanDisplay(c, t("scan.statusScanning"), false);
  const dwell = Number($("#scan-dwell-range").value);
  animateScanProgress(dwell);
  scanTimerId = setTimeout(() => {
    if (!scanRunning || scanPaused) return;
    const name = channelNames[c.channel] || c.name || "";
    scanLog(t("scan.logVisit", { n: String(c.channel).padStart(2, "0"), name }), false);
    scanStep();
  }, dwell);
}

// Fires on genuine incoming-PTT-packet activity (see the "at2:rf-activity"
// listener below) -- pauses the scan on whatever channel it's currently
// dwelling on, same UX the Beta prototype validated, just triggered by a
// real signal instead of Math.random().
function onScanActivityDetected() {
  if (!scanRunning || scanPaused || scanStepIdx < 0) return;
  const list = scanOrderedChannels();
  const c = list[scanStepIdx];
  if (!c) return;
  scanPaused = true;
  clearTimeout(scanTimerId);
  const pauseS = Number($("#scan-pause-range").value);
  const name = channelNames[c.channel] || c.name || "";
  setScanDisplay(c, t("scan.statusHit"), true);
  scanLog(t("scan.logHit", { n: String(c.channel).padStart(2, "0"), name, s: pauseS }), true);
  animateScanProgress(pauseS * 1000);
  scanTimerId = setTimeout(() => { scanPaused = false; scanStep(); }, pauseS * 1000);
}
window.addEventListener("at2:rf-activity", onScanActivityDetected);

function startScan() {
  if (!scanOrderedChannels().length) { scanLog(t("scan.logNoChannels"), false); return; }
  scanChannelBeforeStart = activeChannel;
  scanRunning = true; scanPaused = false; scanStepIdx = -1;
  $$(".scan-toggle-btn").forEach((btn) => { btn.textContent = t("scan.stopBtn"); btn.classList.add("btn-danger"); });
  updateScanSub();
  scanLog(t("scan.logStarted"), false);
  scanStep();
}
function stopScan() {
  scanRunning = false; scanPaused = false;
  clearTimeout(scanTimerId); cancelAnimationFrame(scanRafId);
  $$(".scan-toggle-btn").forEach((btn) => { btn.textContent = t("scan.startBtn"); btn.classList.remove("btn-danger"); });
  $("#scan-progress-bar").style.width = "0%";
  setScanDisplay(null, t("scan.statusIdle"), false);
  updateScanSub();
  scanLog(t("scan.logStopped"), false);
  // Hand the radio (and the Messaging tab, which tracks the same
  // activeChannel) back to whatever channel was active before the scan
  // started -- otherwise both are left on whatever channel the scan
  // happened to land on when stopped.
  if (scanChannelBeforeStart != null && scanChannelBeforeStart !== activeChannel) {
    activeChannel = scanChannelBeforeStart;
    applyActiveChannel(true).catch(() => {});
  } else if (scanChannelBeforeStart != null) {
    sendChannelSelect(scanChannelBeforeStart).catch((e) => appendLog(t("chan.selectError", { error: e.message })));
  }
  scanChannelBeforeStart = null;
}
$$(".scan-toggle-btn").forEach((btn) => btn.addEventListener("click", () => { scanRunning ? stopScan() : startScan(); }));

// Always visible now (full-width card, no disclosure to expand into) --
// render the real empty/ready state immediately instead of leaving the
// static HTML placeholders up until the next channel read or language
// switch happens to trigger a re-render.
renderScanState();

// ---------------------------------------------------------------------------
// Beta tab: isolated prototypes, each its own static page under
// app/static/beta/ (own HTML/CSS/JS -- see beta/README.md) loaded in an
// <iframe> so a bug in an experiment can't reach the rest of the app.
// Adding a new one to try is one line here plus the file itself; nothing
// else in this app needs to change.
// ---------------------------------------------------------------------------
const BETA_PAGES = [
  { id: "map-redesign", i18nKey: "beta.page.mapRedesign", src: "/static/beta/map-redesign.html" },
  { id: "spectrum", i18nKey: "beta.page.spectrum", src: "/static/beta/spectrum.html" },
  { id: "record-replay", i18nKey: "beta.page.recordReplay", src: "/static/beta/record-replay.html" },
];

function buildBetaTab() {
  const nav = $("#beta-subtabs");
  const frames = $("#beta-frames");
  nav.innerHTML = BETA_PAGES.map((p, i) => `<button class="beta-subtab ${i === 0 ? "active" : ""}" data-beta="${p.id}"></button>`).join("");
  frames.innerHTML = BETA_PAGES.map((p, i) => `<iframe class="beta-frame ${i === 0 ? "active" : ""}" data-beta="${p.id}" loading="lazy"></iframe>`).join("");
  nav.querySelectorAll(".beta-subtab").forEach((btn) => {
    btn.addEventListener("click", () => {
      nav.querySelectorAll(".beta-subtab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      frames.querySelectorAll(".beta-frame").forEach((f) => f.classList.toggle("active", f.dataset.beta === btn.dataset.beta));
      activateBetaFrame(btn.dataset.beta);
    });
  });
  refreshBetaLabels();
}
// iframe src is only set the first time a sub-tab is actually shown --
// same reasoning as the Map tab's own lazy render: no point loading
// Leaflet + OSM tiles for an experiment nobody opened this session.
function activateBetaFrame(id) {
  const frame = $(`.beta-frame[data-beta="${id}"]`);
  const page = BETA_PAGES.find((p) => p.id === id);
  if (frame && page && !frame.getAttribute("src")) frame.src = page.src;
}
function refreshBetaLabels() {
  $$(".beta-subtab").forEach((btn) => {
    const page = BETA_PAGES.find((p) => p.id === btn.dataset.beta);
    if (page) btn.textContent = t(page.i18nKey);
  });
  $$(".beta-frame").forEach((f) => {
    const page = BETA_PAGES.find((p) => p.id === f.dataset.beta);
    if (page) f.title = t(page.i18nKey);
  });
}
buildBetaTab();
$$(".tab").forEach((tabBtn) => {
  if (tabBtn.dataset.tab === "beta") tabBtn.addEventListener("click", () => activateBetaFrame(BETA_PAGES[0].id));
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

// Shared by the "Lire les 30 canaux" button and the auto-read fired right
// after every successful connection (see connectServerTransport()/
// btn-local-connect/reconnectKnownDevice below) -- so the PTT panel's
// RX/TX frequency block and the Canaux table aren't stuck on "—" until
// the user remembers to click "Lire" by hand. Throws on failure/no
// connection; callers decide whether that's worth surfacing to the user.
async function loadAllChannels() {
  const transport = activeTransport();
  let channels;
  if (transport === "server") {
    channels = await api("GET", "/api/channels");
  } else if (transport === "local") {
    channels = await AT2BleClient.readAllChannels();
  } else {
    throw new Error(t("gps.noActiveConnection"));
  }
  lastReadChannels = channels.length ? channels : emptyChannels();
  renderChannelTable(lastReadChannels);
  renderChanOpts();
  renderChanFreq();
  renderScanState(); // Scan tab's channel list/empty-state tracks the same read
}

$("#btn-read-channels").addEventListener("click", async () => {
  try {
    await loadAllChannels();
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
    renderChanFreq();
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

// Live numeric readout next to each range slider in the Réglages tab --
// without this, a slider's exact value (e.g. squelch 0-9 on a wide track)
// was only visible by carefully eyeballing the handle position.
const SETTINGS_SLIDERS = [
  ["volume-slider", "volume-value", (v) => v],
  ["squelch-slider", "squelch-value", (v) => v],
  ["vox-sensitivity-slider", "vox-sensitivity-value", (v) => v],
  ["tot-slider", "tot-value", (v) => `${v}s`],
  ["tx-interval-slider", "tx-interval-value", (v) => `${v}s`],
];
function refreshSettingValue(sliderId) {
  const entry = SETTINGS_SLIDERS.find(([s]) => s === sliderId);
  if (!entry) return;
  const [, valueId, format] = entry;
  $(`#${valueId}`).textContent = format($(`#${sliderId}`).value);
}
SETTINGS_SLIDERS.forEach(([sliderId]) => {
  $(`#${sliderId}`).addEventListener("input", () => refreshSettingValue(sliderId));
  refreshSettingValue(sliderId);
});

// Dual Watch's Focus A/B is a segmented control between two mutually
// exclusive, immediate actions -- there's no "current value" sitting in a
// field to batch (clicking one just tells the radio which side to key up
// on right now), unlike every other setting below which is sent as one
// batch via "Appliquer les changements". The active segment is a local UI
// selection, not a confirmed radio read-back (no query exists for it).
$$("#dual-watch-focus-segmented button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const transport = activeTransport();
    if (transport !== "server" && transport !== "local") return showToast(t("gps.noActiveConnection"), "info");
    const side = btn.dataset.action === "set-dual-watch-focus-a" ? "A" : "B";
    try {
      if (transport === "server") await api("PUT", "/api/device/dual-watch/focus", { side });
      else await AT2BleClient.setDualWatchFocus(side);
      $$("#dual-watch-focus-segmented button").forEach((b) => b.classList.toggle("active", b === btn));
      showToast(t("settings.applied"), "success");
    } catch (e) { showToast(e.message, "error"); }
  });
});

function setSettingsReadStatus(text) {
  const el = $("#settings-read-status");
  el.textContent = text;
  el.hidden = !text;
}

// Unsaved-changes tracking: every field below that "Appliquer les
// changements" can send is compared against `settingsBaseline` --
// whatever this session last confirmed the radio actually has (the HTML
// defaults at load, then updated field-by-field on every successful
// apply or read). The footer counter reflects real drift from that
// baseline, not just "has this input been touched".
const SETTINGS_TRACKED_IDS = [
  "volume-slider", "squelch-slider", "vox-toggle", "vox-sensitivity-slider",
  "tot-slider", "tx-interval-slider", "tx-inhibit-toggle", "noise-reduction-toggle",
  "prompt-tone-toggle", "prompt-language-toggle", "device-name-input", "smart-link-toggle",
  "dual-watch-toggle", "dual-watch-channel-a", "dual-watch-channel-b",
];
function getFieldValue(id) {
  const el = $(`#${id}`);
  return el.type === "checkbox" ? el.checked : el.value;
}
let settingsBaseline = {};
function captureSettingsBaseline() {
  SETTINGS_TRACKED_IDS.forEach((id) => { settingsBaseline[id] = getFieldValue(id); });
}
function refreshUnsavedCount() {
  const count = SETTINGS_TRACKED_IDS.filter((id) => getFieldValue(id) !== settingsBaseline[id]).length;
  const el = $("#settings-unsaved");
  el.textContent = t("settings.unsavedCount", { n: count });
  el.hidden = count === 0;
}
captureSettingsBaseline();
SETTINGS_TRACKED_IDS.forEach((id) => {
  $(`#${id}`).addEventListener("input", refreshUnsavedCount);
});

// Read-back: confirmed on real hardware (07/09/2026, see README) that the
// radio DOES answer these queries -- contrary to what this project assumed
// until then. Each entry's `server`/`local` resolve to a plain value
// (level/seconds as a number, enabled/english as a boolean) regardless of
// transport, so `apply` doesn't need to know which one answered. Reads
// happen one at a time and independently: a setting the radio doesn't
// answer (e.g. an unconfirmed one, or a flaky link) just doesn't update
// its control instead of aborting the whole batch. Each successful read
// also becomes the new baseline for that field.
$("#btn-read-settings").addEventListener("click", async () => {
  const transport = activeTransport();
  if (transport !== "server" && transport !== "local") return showToast(t("gps.noActiveConnection"), "info");
  const btn = $("#btn-read-settings");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("settings.reading");
  const reads = [
    { id: "volume-slider",
      server: () => api("GET", "/api/device/volume").then((d) => d.level),
      local: () => AT2BleClient.queryVolume(),
      apply: (v) => { $("#volume-slider").value = v; refreshSettingValue("volume-slider"); } },
    { id: "squelch-slider",
      server: () => api("GET", "/api/device/squelch").then((d) => d.level),
      local: () => AT2BleClient.querySquelch(),
      apply: (v) => { $("#squelch-slider").value = v; refreshSettingValue("squelch-slider"); } },
    { id: "vox-toggle",
      server: () => api("GET", "/api/device/vox").then((d) => d.enabled),
      local: () => AT2BleClient.queryVox(),
      apply: (v) => { $("#vox-toggle").checked = v; } },
    { id: "vox-sensitivity-slider",
      server: () => api("GET", "/api/device/vox-sensitivity").then((d) => d.level),
      local: () => AT2BleClient.queryVoxSensitivity(),
      apply: (v) => { $("#vox-sensitivity-slider").value = v; refreshSettingValue("vox-sensitivity-slider"); } },
    { id: "tot-slider",
      server: () => api("GET", "/api/device/tot").then((d) => d.seconds),
      local: () => AT2BleClient.queryTot(),
      apply: (v) => { $("#tot-slider").value = v; refreshSettingValue("tot-slider"); } },
    { id: "tx-inhibit-toggle",
      server: () => api("GET", "/api/device/tx-inhibit").then((d) => d.enabled),
      local: () => AT2BleClient.queryTxInhibit(),
      apply: (v) => { $("#tx-inhibit-toggle").checked = v; } },
    { id: "tx-interval-slider",
      server: () => api("GET", "/api/device/tx-interval").then((d) => d.seconds),
      local: () => AT2BleClient.queryTxInterval(),
      apply: (v) => { $("#tx-interval-slider").value = v; refreshSettingValue("tx-interval-slider"); } },
    { id: "noise-reduction-toggle",
      server: () => api("GET", "/api/device/noise-reduction").then((d) => d.enabled),
      local: () => AT2BleClient.queryNoiseReduction(),
      apply: (v) => { $("#noise-reduction-toggle").checked = v; } },
    { id: "dual-watch-toggle",
      server: () => api("GET", "/api/device/dual-watch").then((d) => d.enabled),
      local: () => AT2BleClient.queryDualWatch(),
      apply: (v) => { $("#dual-watch-toggle").checked = v; } },
    { id: "prompt-tone-toggle",
      server: () => api("GET", "/api/device/prompt-tone").then((d) => d.enabled),
      local: () => AT2BleClient.queryPromptTone(),
      apply: (v) => { $("#prompt-tone-toggle").checked = v; } },
    { id: "prompt-language-toggle",
      server: () => api("GET", "/api/device/prompt-language").then((d) => d.english),
      local: () => AT2BleClient.queryPromptLanguage(),
      apply: (v) => { $("#prompt-language-toggle").checked = v; } },
  ];
  let ok = 0, fail = 0;
  for (const r of reads) {
    try {
      const value = await (transport === "server" ? r.server() : r.local());
      r.apply(value);
      settingsBaseline[r.id] = getFieldValue(r.id);
      ok++;
    } catch (e) {
      fail++;
    }
  }
  btn.disabled = false;
  btn.textContent = originalLabel;
  setSettingsReadStatus(t("settings.readAt", { time: new Date().toLocaleTimeString() }));
  refreshUnsavedCount();
  showToast(t("settings.readResult", { ok, fail }), fail ? "info" : "success");
});

// Apply all: one button sends every setting on this tab to the radio in a
// single pass, instead of a separate "Appliquer" per row. Each entry
// carries both a server call (PUT to the backend) and a local-BLE call
// (AT2BleClient, straight to the radio over Web Bluetooth) -- local BLE
// mode used to only support Volume here, silently no-opping every other
// field (see protocol.js/ble-client.js's "device settings" sections for
// the byte-format ports that made the rest possible). Each successful
// send also becomes the new baseline for that field, so the unsaved
// counter reflects only what genuinely didn't make it (a failed field
// stays flagged unsaved).
$("#btn-apply-settings").addEventListener("click", async () => {
  const transport = activeTransport();
  if (transport !== "server" && transport !== "local") return showToast(t("gps.noActiveConnection"), "info");

  const btn = $("#btn-apply-settings");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("settings.applying");

  const tasks = [
    { id: "volume-slider",
      server: () => api("PUT", "/api/device/volume", { level: parseInt($("#volume-slider").value, 10) }),
      local: () => AT2BleClient.setVolume(parseInt($("#volume-slider").value, 10)) },
    { id: "squelch-slider",
      server: () => api("PUT", "/api/device/squelch", { level: parseInt($("#squelch-slider").value, 10) }),
      local: () => AT2BleClient.setSquelch(parseInt($("#squelch-slider").value, 10)) },
    { id: "vox-toggle",
      server: () => api("PUT", "/api/device/vox", { enabled: $("#vox-toggle").checked }),
      local: () => AT2BleClient.setVox($("#vox-toggle").checked) },
    { id: "vox-sensitivity-slider",
      server: () => api("PUT", "/api/device/vox-sensitivity", { level: parseInt($("#vox-sensitivity-slider").value, 10) }),
      local: () => AT2BleClient.setVoxSensitivity(parseInt($("#vox-sensitivity-slider").value, 10)) },
    { id: "tot-slider",
      server: () => api("PUT", "/api/device/tot", { seconds: parseInt($("#tot-slider").value, 10) }),
      local: () => AT2BleClient.setTot(parseInt($("#tot-slider").value, 10)) },
    { id: "tx-inhibit-toggle",
      server: () => api("PUT", "/api/device/tx-inhibit", { enabled: $("#tx-inhibit-toggle").checked }),
      local: () => AT2BleClient.setTxInhibit($("#tx-inhibit-toggle").checked) },
    { id: "tx-interval-slider",
      server: () => api("PUT", "/api/device/tx-interval", { seconds: parseInt($("#tx-interval-slider").value, 10) }),
      local: () => AT2BleClient.setTxInterval(parseInt($("#tx-interval-slider").value, 10)) },
    { id: "noise-reduction-toggle",
      server: () => api("PUT", "/api/device/noise-reduction", { enabled: $("#noise-reduction-toggle").checked }),
      local: () => AT2BleClient.setNoiseReduction($("#noise-reduction-toggle").checked) },
    { id: "prompt-tone-toggle",
      server: () => api("PUT", "/api/device/prompt-tone", { enabled: $("#prompt-tone-toggle").checked }),
      local: () => AT2BleClient.setPromptTone($("#prompt-tone-toggle").checked) },
    { id: "prompt-language-toggle",
      server: () => api("PUT", "/api/device/prompt-language", { english: $("#prompt-language-toggle").checked }),
      local: () => AT2BleClient.setPromptLanguage($("#prompt-language-toggle").checked) },
    { id: "smart-link-toggle",
      server: () => api("PUT", "/api/device/smart-link", { enabled: $("#smart-link-toggle").checked }),
      local: () => AT2BleClient.setSmartLink($("#smart-link-toggle").checked) },
    { id: "dual-watch-toggle",
      server: () => api("PUT", "/api/device/dual-watch", { enabled: $("#dual-watch-toggle").checked }),
      local: () => AT2BleClient.setDualWatch($("#dual-watch-toggle").checked) },
    { id: "dual-watch-channel-a",
      server: () => api("PUT", "/api/device/dual-watch/channel", { side: "A", channel: parseInt($("#dual-watch-channel-a").value, 10) }),
      local: () => AT2BleClient.setDualWatchChannel("A", parseInt($("#dual-watch-channel-a").value, 10)) },
    { id: "dual-watch-channel-b",
      server: () => api("PUT", "/api/device/dual-watch/channel", { side: "B", channel: parseInt($("#dual-watch-channel-b").value, 10) }),
      local: () => AT2BleClient.setDualWatchChannel("B", parseInt($("#dual-watch-channel-b").value, 10)) },
  ];
  // Device name is skipped when left blank, same guard the old per-field
  // handler had -- never overwrite the radio's name with an empty string
  // just because the field wasn't touched.
  const deviceName = $("#device-name-input").value.trim();
  if (deviceName) {
    tasks.push({ id: "device-name-input",
      server: () => api("PUT", "/api/device/name", { name: deviceName }),
      local: () => AT2BleClient.setDeviceName(deviceName) });
  }

  let ok = 0, fail = 0;
  for (const task of tasks) {
    try {
      await (transport === "server" ? task.server() : task.local());
      settingsBaseline[task.id] = getFieldValue(task.id);
      ok++;
    } catch (e) {
      fail++;
    }
  }
  btn.disabled = false;
  btn.textContent = originalLabel;
  refreshUnsavedCount();
  showToast(t("settings.applyAllResult", { ok, fail }), fail ? "info" : "success");
});

// Reset: purely a form reset (back to each field's HTML default value) --
// does NOT send anything to the radio (the baseline is untouched, so any
// field whose default differs from the last known radio state correctly
// shows back up as unsaved). Still requires clicking "Appliquer les
// changements" afterward to actually apply anything.
$("#btn-reset-settings").addEventListener("click", () => {
  $$("#tab-device input").forEach((el) => {
    if (el.type === "checkbox") el.checked = el.defaultChecked;
    else el.value = el.defaultValue;
  });
  SETTINGS_SLIDERS.forEach(([sliderId]) => refreshSettingValue(sliderId));
  setSettingsReadStatus("");
  refreshUnsavedCount();
  showToast(t("settings.resetDone"), "info");
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
  recordBeaconFromMessage(msg);
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
  // addMessage() above already stores the beacon (map) and the bubble
  // (messaging thread) via recordBeaconFromMessage()/renderThread() -- both
  // silent, only visible to someone already looking at that tab/channel.
  // An incoming SOS needs to be noticed regardless of what's on screen, so
  // it also gets the two pieces that were entirely missing: a footer toast,
  // and the alert tone actually playing here instead of sitting behind a
  // manual ▶ on a voice bubble the sender's own separate sendAlertTone()
  // call may or may not have arrived/decoded yet. Synthesized locally
  // rather than waiting on that voice message so the sound is instant and
  // doesn't depend on a second, uncorrelated message landing first.
  if (msg.kind === "text") {
    const parsed = parsePositionText(msg.text);
    if (parsed && parsed.sos) announceIncomingSos(msg.sender, parsed.note);
  }
}

function announceIncomingSos(sender, note) {
  showToast(t("gps.sosReceived", { sender: sender || "?", note: note || "" }), "error");
  try {
    const src = playPcm(generateAlertTonePcm().pcm);
    // This fires from a WS/BLE notification, not a click, so there's no
    // user gesture on the call stack -- some browsers keep a freshly
    // created AudioContext (or one that's never played anything yet)
    // suspended until one happens. resume() doesn't itself need a
    // gesture to be *called*, it just may not actually unmute without
    // one depending on the browser's autoplay policy; this is the best
    // effort available without requiring the user to have clicked
    // something (e.g. play a voice message) earlier in the session.
    if (src.context.state === "suspended") src.context.resume().catch(() => {});
    src.start();
  } catch (e) {
    appendLog(`⚠️ Échec de lecture de la tonalité d'alerte reçue: ${e.message}`);
  }
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

