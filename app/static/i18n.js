/* Centralized bilingual (fr/en) text for the whole app. Two ways to
 * use a translated string:
 *
 *   1. Static markup: add `data-i18n="key"` (textContent),
 *      `data-i18n-placeholder="key"` (placeholder), or
 *      `data-i18n-title="key"` (title) to an element in index.html.
 *      `applyTranslations()` (called on load and on language switch)
 *      fills these in automatically.
 *
 *   2. Dynamic JS strings (alerts, generated labels, template
 *      literals): call `t("key")` directly, or `t("key", {var: val})`
 *      for strings with a `{var}` placeholder.
 *
 * Adding a new string later: add the key to BOTH dictionaries below
 * (fr is the fallback if a key is missing in en, so at minimum keep
 * fr complete), then use it via one of the two methods above --
 * never hardcode new user-facing text directly in index.html/app.js.
 */
const I18N_DICT = {
  fr: {
    // Topbar
    "mode.server": "Serveur",
    "mode.local": "BLE local",
    "theme.dark": "🌙 Sombre",
    "theme.light": "☀️ Clair",
    "theme.title": "Basculer thème clair/sombre",
    "prefs.title": "Préférences",
    "conn.disconnected": "Déconnecté",
    "conn.connected": "Connecté ({kind} · {target})",
    "conn.disconnectedLocal": "Déconnecté (BLE local)",
    "conn.connectedLocal": "Connecté (local · {name})",
    "btn.refreshPorts": "↻",
    "btn.connectSerial": "USB série",
    "btn.scanBle": "Scanner BLE",
    "btn.disconnect": "Déconnecter",
    "btn.connectLocal": "Connecter (Web Bluetooth)",
    "mode.localUnsupported": "Web Bluetooth non disponible sur ce navigateur (indisponible sur tout navigateur iOS)",

    // Tabs
    "tab.devices": "Appareils",
    "tab.channels": "Canaux",
    "tab.settings": "Réglages",
    "tab.messages": "Messagerie",
    "tab.log": "Journal",

    // Debug: envoi de trame brute (expérimental)
    "debug.rawFrameTitle": "🧪 Debug — Envoi de trame brute (expérimental)",
    "debug.rawFrameHint": "Contourne toute la couche protocole. Réservé aux tests d'hypothèses de rétro-ingénierie — voir CONSIGNES_PROJET.md.",
    "debug.rawFramePlaceholder": "aa55...77ee",
    "debug.rawFrameSend": "Envoyer",
    "debug.rawFrameSending": "Envoi en cours…",
    "debug.rawFrameInvalidHex": "Hex de trame invalide.",
    "debug.rawFrameNoConnection": "Aucune connexion active — connecte-toi d'abord.",
    "mode.notSupportedLocal": "Pas encore disponible en mode BLE local — utilise le mode Serveur.",

    // Devices tab
    "devices.empty": "Aucun appareil connu pour l'instant — scanne en BLE ou connecte-toi en série pour en enregistrer un.",
    "devices.connect": "Connecter",
    "devices.forget": "Oublier",
    "devices.noBleFound": "Aucun appareil BLE trouvé à proximité du serveur.",
    "devices.noPortsFound": "Aucun port détecté",
    "devices.selectPortFirst": "Sélectionne un port série d'abord.",

    // Channel switcher
    "chan.prev": "Canal précédent",
    "chan.next": "Canal suivant",
    "chan.rename": "Renommer ce canal",
    "chan.renamePrompt": "Nom pour le canal {channel} :",
    "chan.standby": "Standby",
    "chan.highPower": "Puissance haute",
    "chan.lowPower": "Puissance basse",
    "chan.narrow": "Bande étroite",
    "chan.wide": "Bande large",
    "chan.scanAdded": "Ajouté au scan",
    "chan.scanExcluded": "Exclu du scan",
    "chan.digital": "Numérique",
    "chan.analog": "Analogique",
    "chan.readFirst": "Lis les canaux pour voir les options",
    "chan.selectError": "Erreur sélection canal: {error}",

    // PTT panel
    "ptt.hintServer": "Maintiens pour émettre — encode et transmet la voix en temps réel",
    "ptt.hintLocal": "PTT vocal indisponible en mode BLE local (nécessite le décodeur du serveur)",
    "ptt.button": "PTT",

    // GPS panel
    "gps.title": "Position & urgence",
    "gps.locating": "Localisation…",
    "gps.unavailable": "Géolocalisation indisponible",
    "gps.denied": "Localisation refusée",
    "gps.fixAcquired": "Fix GPS acquis",
    "gps.accuracyUnknown": "précision inconnue",
    "gps.accuracy": "précision ≈ {meters} m",
    "gps.beaconAuto": "Balise position auto",
    "gps.beaconOff": "Balise désactivée",
    "gps.beaconOn": "Balise active — envoi toutes les {interval}",
    "gps.beaconNext": "Dernière balise envoyée à l'instant · prochaine dans {interval}",
    "gps.sendNow": "📍 Envoyer ma position maintenant",
    "gps.sentAt": "Position envoyée à l'instant ({coords})",
    "gps.noCoords": "Pas de position GPS disponible.",
    "gps.sos": "🆘 SOS",
    "gps.sosSent": "✔ Envoyé",
    "gps.sosPresetLost": "Perdu, besoin d'un itinéraire",
    "gps.sosPresetInjured": "Blessé, besoin de secours médical",
    "gps.sosPresetStuck": "Bloqué, besoin d'une évacuation",
    "gps.noActiveConnection": "Aucune connexion active.",
    "gps.intervalSeconds": "{n} s",
    "gps.intervalMinutes": "{n} min",

    // Channels tab
    "channels.readAll": "Lire les 30 canaux",
    "channels.writeAll": "Écrire les 30 canaux",
    "channels.readHint": "La lecture groupée est reconstituée par symétrie du protocole — vérifie avant d'écrire.",
    "channels.importXml": "📄 Importer XML",
    "channels.importXmlSuccess": "{count} canal(aux) importé(s) depuis le fichier — vérifie avant d'écrire.",
    "channels.importXmlEmpty": "Aucun canal configuré trouvé dans ce fichier.",
    "channels.write": "Écrire",
    "channels.writtenOk": "Codeplug écrit.",
    "channels.need30rows": "Il faut exactement 30 lignes (utilise « Lire » d'abord).",
    "channels.colCh": "Ch",
    "channels.colName": "Nom (local)",
    "channels.colRx": "RX MHz",
    "channels.colTx": "TX MHz",
    "channels.colToneRx": "Ton RX",
    "channels.colToneTx": "Ton TX",
    "channels.colBw": "BW étroite",
    "channels.colPower": "Puissance haute",
    "channels.colScan": "Scan",
    "channels.colDigital": "Numérique",

    // Settings tab
    "settings.title": "Réglages appareil",
    "settings.noConnection": "Aucune connexion active",
    "settings.volume": "Volume (1–8)",
    "settings.squelch": "Squelch (0–9)",
    "settings.vox": "VOX activé",
    "settings.apply": "Appliquer",
    "settings.basicHint": "Ces trois réglages ont été vérifiés en communication avec le backend (voir README pour le détail testé/non testé sur radio réelle).",
    "settings.advancedTitle": "Réglages avancés",
    "settings.voxSensitivity": "Sensibilité VOX (1–5)",
    "settings.tot": "Temporisation TX — secondes (0 = désactivé, max 240)",
    "settings.txInhibit": "Inhibition TX (bloque l'émission)",
    "settings.noiseReduction": "Réduction de bruit",
    "settings.promptTone": "Tonalité de confirmation",
    "settings.deviceName": "Nom de l'appareil",
    "settings.smartLink": "Smart Link (pont vers apps tierces)",
    "settings.advancedHint": "Ces 7 réglages sont câblés au protocole réel mais jamais testés sur radio physique — voir README.",
    "settings.deviceNameRequired": "Entre un nom d'appareil.",

    // Messages tab
    "msg.usernamePlaceholder": "Pseudo",
    "msg.textPlaceholder": "Message hors-réseau à envoyer sur le canal actif…",
    "msg.attachImage": "Joindre une image",
    "msg.attachImageBtn": "🖼️ Image",
    "msg.recordVoice": "Message vocal",
    "msg.recordVoiceBtn": "🎙️ Vocal",
    "msg.stopRecording": "⏹️ Arrêter",
    "msg.send": "Envoyer",
    "msg.hint": "Texte hors-réseau câblé de bout en bout. Image/vocal : format du protocole implémenté, boutons pas encore reliés à l'envoi (voir README).",
    "msg.recording": "Enregistrement en cours…",
    "msg.sending": "Envoi…",
    "msg.micUnavailable": "Micro indisponible: {error}",
    "msg.imageSent": "🖼️ Image envoyée ({filename})",
    "msg.voiceSent": "🎙️ Message vocal envoyé ({seconds}s)",
    "msg.serverModeRequiredImage": "L'envoi d'image nécessite le mode Serveur.",
    "msg.serverModeRequiredVoice": "L'envoi vocal nécessite le mode Serveur.",
    "msg.unreadable": "Message entrant illisible: {error}",
    "msg.voiceReceived": "🎙️ Message vocal ({seconds}s) — lecture non câblée côté navigateur pour les messages reçus.",
    "msg.unknownKind": "Message de type inconnu ({kind})",
    "msg.me": "Moi",

    // Login overlay
    "login.title": "Connexion requise",
    "login.subtitle": "Ce serveur AT2 Bridge est protégé par mot de passe.",
    "login.passwordPlaceholder": "Mot de passe",
    "login.submit": "Se connecter",
    "login.error": "Mot de passe incorrect.",
    "login.sessionExpired": "Session expirée, reconnecte-toi.",

    // Generic
    "channelLabel": "CH{n}",
  },

  en: {
    "mode.server": "Server",
    "mode.local": "Local BLE",
    "theme.dark": "🌙 Dark",
    "theme.light": "☀️ Light",
    "theme.title": "Toggle light/dark theme",
    "prefs.title": "Preferences",
    "conn.disconnected": "Disconnected",
    "conn.connected": "Connected ({kind} · {target})",
    "conn.disconnectedLocal": "Disconnected (local BLE)",
    "conn.connectedLocal": "Connected (local · {name})",
    "btn.refreshPorts": "↻",
    "btn.connectSerial": "USB serial",
    "btn.scanBle": "Scan BLE",
    "btn.disconnect": "Disconnect",
    "btn.connectLocal": "Connect (Web Bluetooth)",
    "mode.localUnsupported": "Web Bluetooth unavailable in this browser (unavailable on every iOS browser)",

    "tab.devices": "Devices",
    "tab.channels": "Channels",
    "tab.settings": "Settings",
    "tab.messages": "Messaging",
    "tab.log": "Log",

    // Debug: raw frame send (experimental)
    "debug.rawFrameTitle": "🧪 Debug — Send raw frame (experimental)",
    "debug.rawFrameHint": "Bypasses the entire protocol layer. For testing reverse-engineering hypotheses only — see CONSIGNES_PROJET.md.",
    "debug.rawFramePlaceholder": "aa55...77ee",
    "debug.rawFrameSend": "Send",
    "debug.rawFrameSending": "Sending…",
    "debug.rawFrameInvalidHex": "Invalid frame hex.",
    "debug.rawFrameNoConnection": "No active connection — connect first.",
    "mode.notSupportedLocal": "Not available in local BLE mode yet — use Server mode.",

    "devices.empty": "No known devices yet — scan over BLE or connect via serial to remember one.",
    "devices.connect": "Connect",
    "devices.forget": "Forget",
    "devices.noBleFound": "No BLE device found near the server.",
    "devices.noPortsFound": "No port detected",
    "devices.selectPortFirst": "Select a serial port first.",

    "chan.prev": "Previous channel",
    "chan.next": "Next channel",
    "chan.rename": "Rename this channel",
    "chan.renamePrompt": "Name for channel {channel}:",
    "chan.standby": "Standby",
    "chan.highPower": "High power",
    "chan.lowPower": "Low power",
    "chan.narrow": "Narrow band",
    "chan.wide": "Wide band",
    "chan.scanAdded": "Added to scan",
    "chan.scanExcluded": "Excluded from scan",
    "chan.digital": "Digital",
    "chan.analog": "Analog",
    "chan.readFirst": "Read the channels to see options",
    "chan.selectError": "Channel select error: {error}",

    "ptt.hintServer": "Hold to transmit — encodes and streams voice in real time",
    "ptt.hintLocal": "Live PTT unavailable in local BLE mode (needs the server's decoder)",
    "ptt.button": "PTT",

    "gps.title": "Position & emergency",
    "gps.locating": "Locating…",
    "gps.unavailable": "Geolocation unavailable",
    "gps.denied": "Location permission denied",
    "gps.fixAcquired": "GPS fix acquired",
    "gps.accuracyUnknown": "accuracy unknown",
    "gps.accuracy": "accuracy ≈ {meters} m",
    "gps.beaconAuto": "Auto position beacon",
    "gps.beaconOff": "Beacon disabled",
    "gps.beaconOn": "Beacon active — sending every {interval}",
    "gps.beaconNext": "Last beacon sent just now · next in {interval}",
    "gps.sendNow": "📍 Send my position now",
    "gps.sentAt": "Position sent just now ({coords})",
    "gps.noCoords": "No GPS position available.",
    "gps.sos": "🆘 SOS",
    "gps.sosSent": "✔ Sent",
    "gps.sosPresetLost": "Lost, need directions",
    "gps.sosPresetInjured": "Injured, need medical help",
    "gps.sosPresetStuck": "Stuck, need evacuation",
    "gps.noActiveConnection": "No active connection.",
    "gps.intervalSeconds": "{n}s",
    "gps.intervalMinutes": "{n}min",

    "channels.readAll": "Read all 30 channels",
    "channels.writeAll": "Write all 30 channels",
    "channels.readHint": "The bulk read is reconstructed by protocol symmetry — verify before writing.",
    "channels.importXml": "📄 Import XML",
    "channels.importXmlSuccess": "{count} channel(s) imported from file — verify before writing.",
    "channels.importXmlEmpty": "No configured channel found in this file.",
    "channels.write": "Write",
    "channels.writtenOk": "Codeplug written.",
    "channels.need30rows": "Need exactly 30 rows (use \u00abRead\u00bb first).",
    "channels.colCh": "Ch",
    "channels.colName": "Name (local)",
    "channels.colRx": "RX MHz",
    "channels.colTx": "TX MHz",
    "channels.colToneRx": "RX tone",
    "channels.colToneTx": "TX tone",
    "channels.colBw": "Narrow BW",
    "channels.colPower": "High power",
    "channels.colScan": "Scan",
    "channels.colDigital": "Digital",

    "settings.title": "Device settings",
    "settings.noConnection": "No active connection",
    "settings.volume": "Volume (1–8)",
    "settings.squelch": "Squelch (0–9)",
    "settings.vox": "VOX enabled",
    "settings.apply": "Apply",
    "settings.basicHint": "These three settings have been verified to communicate with the backend (see README for what's tested vs. untested on real hardware).",
    "settings.advancedTitle": "Advanced settings",
    "settings.voxSensitivity": "VOX sensitivity (1–5)",
    "settings.tot": "TX timeout — seconds (0 = disabled, max 240)",
    "settings.txInhibit": "TX inhibit (blocks transmission)",
    "settings.noiseReduction": "Noise reduction",
    "settings.promptTone": "Confirmation tone",
    "settings.deviceName": "Device name",
    "settings.smartLink": "Smart Link (bridge to third-party apps)",
    "settings.advancedHint": "These 7 settings are wired to the real protocol but never tested on physical hardware — see README.",
    "settings.deviceNameRequired": "Enter a device name.",

    "msg.usernamePlaceholder": "Username",
    "msg.textPlaceholder": "Off-grid message to send on the active channel…",
    "msg.attachImage": "Attach an image",
    "msg.attachImageBtn": "🖼️ Image",
    "msg.recordVoice": "Voice message",
    "msg.recordVoiceBtn": "🎙️ Voice",
    "msg.stopRecording": "⏹️ Stop",
    "msg.send": "Send",
    "msg.hint": "Text messaging is wired end-to-end. Image/voice: protocol format implemented, buttons not yet wired to sending (see README).",
    "msg.recording": "Recording…",
    "msg.sending": "Sending…",
    "msg.micUnavailable": "Microphone unavailable: {error}",
    "msg.imageSent": "🖼️ Image sent ({filename})",
    "msg.voiceSent": "🎙️ Voice message sent ({seconds}s)",
    "msg.serverModeRequiredImage": "Sending images requires Server mode.",
    "msg.serverModeRequiredVoice": "Sending voice requires Server mode.",
    "msg.unreadable": "Unreadable incoming message: {error}",
    "msg.voiceReceived": "🎙️ Voice message ({seconds}s) — playback not wired for received messages yet.",
    "msg.unknownKind": "Unknown message type ({kind})",
    "msg.me": "Me",

    "login.title": "Login required",
    "login.subtitle": "This AT2 Bridge server is password-protected.",
    "login.passwordPlaceholder": "Password",
    "login.submit": "Log in",
    "login.error": "Incorrect password.",
    "login.sessionExpired": "Session expired, please log in again.",

    "channelLabel": "CH{n}",
  },
};

let currentLang = localStorage.getItem("at2_lang") || (navigator.language.startsWith("fr") ? "fr" : "en");

function t(key, vars) {
  let str = (I18N_DICT[currentLang] && I18N_DICT[currentLang][key]) ?? I18N_DICT.fr[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, v);
    }
  }
  return str;
}

function applyTranslations() {
  document.documentElement.setAttribute("lang", currentLang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("at2_lang", lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
}

function getLang() {
  return currentLang;
}
