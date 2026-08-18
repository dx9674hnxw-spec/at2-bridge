const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
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
// Connection
// ---------------------------------------------------------------------------
function setConnUi(status) {
  const led = $("#conn-led");
  const label = $("#conn-label");
  led.className = "led " + (status.connected ? "led-connected" : "led-off");
  label.textContent = status.connected
    ? `Connecté (${status.kind} · ${status.target})`
    : "Déconnecté";
  $("#btn-disconnect").hidden = !status.connected;
}

async function refreshStatus() {
  const status = await api("GET", "/api/connection/status");
  setConnUi(status);
}

async function refreshSerialPorts() {
  const ports = await api("GET", "/api/connection/serial/ports");
  const select = $("#serial-port-select");
  select.innerHTML = "";
  if (ports.length === 0) {
    select.innerHTML = `<option value="">Aucun port détecté</option>`;
    return;
  }
  ports.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.description}`;
    select.appendChild(opt);
  });
}

$("#btn-refresh-ports").addEventListener("click", refreshSerialPorts);

$("#btn-connect-serial").addEventListener("click", async () => {
  const port = $("#serial-port-select").value;
  if (!port) return alert("Sélectionne un port série d'abord.");
  $("#conn-led").className = "led led-connecting";
  try {
    await api("POST", "/api/connection/serial/connect", { port, baud_rate: 115200 });
    await refreshStatus();
  } catch (e) {
    alert(e.message);
    await refreshStatus();
  }
});

$("#btn-scan-ble").addEventListener("click", async () => {
  $("#conn-led").className = "led led-connecting";
  try {
    const devices = await api("GET", "/api/connection/ble/scan");
    if (devices.length === 0) {
      alert("Aucun appareil BLE trouvé à proximité.");
      await refreshStatus();
      return;
    }
    const names = devices.map((d, i) => `${i}: ${d.name} (${d.address})`).join("\n");
    const choice = prompt(`Appareils trouvés :\n${names}\n\nEntre le numéro à connecter :`);
    const idx = parseInt(choice, 10);
    if (Number.isNaN(idx) || !devices[idx]) return;
    await api("POST", "/api/connection/ble/connect", { address: devices[idx].address });
    await refreshStatus();
  } catch (e) {
    alert(e.message);
    await refreshStatus();
  }
});

$("#btn-disconnect").addEventListener("click", async () => {
  await api("POST", "/api/connection/disconnect");
  await refreshStatus();
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
let toneOptions = ["OFF"];

function channelRowHtml(ch) {
  const toneSelect = (value) =>
    `<select class="tone-select">${toneOptions
      .map((t) => `<option value="${t}" ${t === value ? "selected" : ""}>${t}</option>`)
      .join("")}</select>`;
  return `
    <tr data-channel="${ch.channel}">
      <td>${ch.channel}</td>
      <td><input type="text" class="ch-name" value="${ch.name ?? ""}" placeholder="—" /></td>
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
  $$(".btn-write-one").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const row = e.target.closest("tr");
      await writeChannelRow(row);
    })
  );
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
    busy_lock: false,
    hop_on: false,
    encrypt_key: 0,
  };
}

async function writeChannelRow(row) {
  const cfg = readChannelRow(row);
  try {
    await api("PUT", `/api/channels/${cfg.channel}`, cfg);
  } catch (e) {
    alert(e.message);
  }
}

$("#btn-read-channels").addEventListener("click", async () => {
  try {
    const channels = await api("GET", "/api/channels");
    renderChannelTable(channels.length ? channels : emptyChannels());
  } catch (e) {
    alert(e.message);
  }
});

$("#btn-write-channels").addEventListener("click", async () => {
  const rows = $$("#channel-table-body tr");
  const configs = rows.map(readChannelRow);
  if (configs.length !== 30) return alert("Il faut exactement 30 lignes (utilise « Lire » d'abord).");
  try {
    await api("PUT", "/api/channels", configs);
    alert("Codeplug écrit.");
  } catch (e) {
    alert(e.message);
  }
});

// initial empty table so the UI isn't blank before first read
renderChannelTable(emptyChannels());
api("GET", "/api/channels/tone-options").then((opts) => {
  toneOptions = opts;
});

// ---------------------------------------------------------------------------
// Device settings
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      switch (btn.dataset.action) {
        case "set-volume":
          await api("PUT", "/api/device/volume", { level: parseInt($("#volume-slider").value, 10) });
          break;
        case "set-squelch":
          await api("PUT", "/api/device/squelch", { level: parseInt($("#squelch-slider").value, 10) });
          break;
        case "set-vox":
          await api("PUT", "/api/device/vox", { enabled: $("#vox-toggle").checked });
          break;
        case "select-channel":
          await api("POST", `/api/channels/${parseInt($("#select-channel-input").value, 10)}/select`);
          break;
      }
    } catch (e) {
      alert(e.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
$("#btn-send-message").addEventListener("click", async () => {
  const username = $("#msg-username").value || "AT2Bridge";
  const text = $("#msg-text").value.trim();
  if (!text) return;
  try {
    await api("POST", "/api/messages/text", { username, text });
    $("#msg-text").value = "";
  } catch (e) {
    alert(e.message);
  }
});

// ---------------------------------------------------------------------------
// Live log (WebSocket)
// ---------------------------------------------------------------------------
function connectLogSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/log`);
  const console_ = $("#log-console");
  ws.onmessage = (evt) => {
    console_.textContent += evt.data + "\n";
    console_.scrollTop = console_.scrollHeight;
  };
  ws.onclose = () => setTimeout(connectLogSocket, 2000);
}
connectLogSocket();

refreshStatus();
refreshSerialPorts();
setInterval(refreshStatus, 5000);
