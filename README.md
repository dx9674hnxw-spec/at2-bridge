# AT2 Bridge

Application web auto-hébergée (Docker) pour piloter une radio bidirectionnelle **Alervites/Baofeng AT2** depuis un serveur Linux, ou directement depuis le navigateur en BLE local — lecture/écriture des canaux, réglages appareil, messagerie texte hors-réseau, PTT temps réel, position/SOS.

> ⚠️ Projet communautaire non affilié à Baofeng/Alervites. Protocole reconstitué par rétro-ingénierie (décompilation du CPS officiel + code source d'un projet Android tiers). Aucune garantie de compatibilité totale — teste prudemment.

## Fonctionnalités

### ✅ Implémenté et testé (sans radio)

- **Codec de trame** — ✅ — Encodage/décodage `AA55 [LEN] [PAYLOAD] [CRC16] 77EE`, CRC16-CCITT (init `0x1234`, poly `0x1021`), 11 tests unitaires.
- **Codec de canal** — ✅ — Encodage/décodage des enregistrements 24 octets (fréquences, tons CTCSS/DCS, bande passante, puissance), round-trip testé.
- **Codec AMR-NB (voix)** — ✅ — Binding ctypes vers `libopencore-amrnb` réel, round-trip encode/decode validé (12 octets/trame MR475, TOC stripped/re-ajouté).
- **Chunking PTT** — ✅ — Construction des paquets vocaux (5 trames AMR/paquet, cadencement 100ms), format confirmé par le code source Kotlin de référence.
- **Messagerie texte (construction de trame)** — ✅ — Fragmentation automatique des messages longs, testée unitairement.
- **Backend FastAPI** — ✅ — Toutes les routes s'importent et répondent (`/api/*`, `/ws/log`, `/ws/ptt`).
- **Stockage local (noms de canaux, appareils connus)** — ✅ — Persistance JSON testée en lecture/écriture.

### ⚠️ Implémenté mais non testé (nécessite la radio)

- **Lecture/écriture des canaux via USB série** — ⚠️ — Port COM virtuel, 115200 bauds ; jamais envoyé à une radio réelle.
- **Lecture/écriture des canaux via BLE** — ⚠️ — UUID GATT réels (`AE60`/`AE10`/`AE05`) extraits d'un projet tiers, connexion jamais testée en conditions réelles.
- **Lecture groupée des 30 canaux (codeplug)** — ⚠️ — Commande de requête déduite par symétrie avec l'écriture, non capturée sur trafic réel.
- **Réglages appareil (volume/squelch/VOX)** — ⚠️ — Commandes construites depuis le code source, jamais vérifiées sur radio.
- **Envoi de messages texte hors-réseau** — ⚠️ — Format de trame porté et testé unitairement, jamais émis vers une radio.
- **PTT temps réel (voix)** — ⚠️ — Capture micro navigateur → 8kHz mono → AMR-NB → trames radio ; chaîne complète jamais testée avec une radio en face.
- **Position/SOS** — ⚠️ — Repose sur le canal de messagerie texte (pas de type de message structuré dédié), jamais émis en conditions réelles.
- **Mode BLE local (Web Bluetooth)** — ⚠️ — Port JS minimal du protocole (sélection de canal, texte), jamais connecté à une radio réelle.
- **Reconnexion aux appareils connus** — ⚠️ — Persistance fonctionnelle, reconnexion réelle non testée.

### 🚧 Non implémenté / Roadmap

- **Messagerie image hors-réseau** — 🚧 — Format documenté côté Android source, non porté.
- **Messagerie vocale hors-réseau (store-and-forward)** — 🚧 — Distincte du PTT temps réel, non portée.
- **Affichage des messages entrants** — 🚧 — Le fil de discussion n'affiche que les messages envoyés ; le décodage des messages reçus n'est pas câblé côté UI.
- **Authentification de l'interface web** — 🚧 — Aucune, à réserver à un réseau de confiance (ex. Tailscale).
- **Gestion simultanée de plusieurs radios** — 🚧 — Une seule connexion active à la fois côté serveur.
- **Flux vidéo / photos périodiques** — 🚧 — Non implémenté ; le débit du protocole (≈330 o/s en messagerie, 4,8 kbps en PTT) rend une vraie vidéo irréaliste.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Navigateur (n'importe quel  │  HTTP  │  Serveur Linux (Docker)      │
│  appareil, y compris iPhone) │◄──────►│  FastAPI (app/main.py)      │
│                              │  WS    │  ├─ app/device.py (état)     │
│  Mode "Serveur" : contrôle   │        │  ├─ app/protocol/ (codec)    │
│  à distance via HTTP/WS      │        │  ├─ app/transport/           │
│                              │        │  │   ├─ serial (pyserial)    │
│  Mode "BLE local" : Web      │        │  │   └─ ble (bleak)          │
│  Bluetooth direct (Chrome/   │        │  └─ app/static/ (frontend)   │
│  Edge desktop/Android only,  │        └───────────┬──────────────────┘
│  indisponible sur iOS)       │                    │ USB-C série / BLE
└──────────────┬───────────────┘                    ▼
               │ Web Bluetooth (si mode local)  ┌─────────────┐
               └────────────────────────────────►│  Radio AT2  │
                                                  └─────────────┘
```

## Déploiement

```bash
git clone https://github.com/dx9674hnxw-spec/at2-bridge.git
cd at2-bridge
docker compose up -d --build
```

Interface servie sur `http://<ip-du-serveur>:8000` (conteneur en `network_mode: host`).

### Accès matériel requis

- **USB série** : branche la radio en USB-C sur le serveur. Le port apparaîtra typiquement en `/dev/ttyACM0` ou `/dev/ttyUSB0` — visible et sélectionnable directement dans l'interface (« USB série » → liste déroulante).
- **BLE (mode serveur)** : le serveur doit avoir un adaptateur Bluetooth (intégré ou dongle USB). Le conteneur a besoin d'accéder à la stack BlueZ de l'hôte via D-Bus (déjà configuré dans `docker-compose.yml`).
- **BLE (mode local)** : aucun matériel serveur requis — c'est le Bluetooth de l'appareil qui affiche la page web (PC/Android) qui est utilisé, via Web Bluetooth.

### Développement local (sans Docker)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Tests

```bash
python -m pytest app/tests -v
```

Les tests couvrent le codec de trame, le CRC16, le codec AMR-NB, le chunking PTT, et l'encodage/décodage des canaux et de la messagerie — indépendamment de tout matériel connecté.

## Limitations connues

- Aucune trame n'a été échangée avec une radio AT2 physique à ce jour — tout le protocole est basé sur la rétro-ingénierie du CPS officiel et d'un projet Android tiers, jamais validé par capture de trafic réel.
- La lecture groupée des 30 canaux (`query_channel_config`) est une déduction par symétrie, pas une commande observée.
- Le PTT temps réel dépend d'un chemin complet (micro → resampling → AMR-NB → BLE/série) qui n'a jamais été exercé de bout en bout avec du matériel.
- Le mode BLE local (Web Bluetooth) n'implémente qu'un sous-ensemble du protocole (sélection de canal, texte) ; le codeplug complet et le PTT restent serveur uniquement.
- Web Bluetooth est indisponible sur tous les navigateurs iOS (restriction Apple/WebKit), quel que soit le navigateur utilisé.
- Aucune authentification sur l'interface web.
- Une seule connexion radio active à la fois côté serveur.

## Origine du protocole

Deux sources ont été croisées, et confirment un protocole **identique** entre USB série et BLE (mêmes trames `AA55...77EE`, même CRC16) :

1. Décompilation du CPS officiel Windows (application Electron) — a livré la structure de trame et le layout exact des enregistrements de canaux.
2. Code source du projet [`Baofeng-ALERVITES-AT2-Android`](https://github.com/byf3332/Baofeng-ALERVITES-AT2-Android) (Apache-2.0) — a confirmé et complété (CRC16 exact, UUID BLE réels, format de messagerie hors-réseau, protocole PTT temps réel).

## Licences tierces

Ce projet contient du code porté (Kotlin → Python/JS) depuis [`Baofeng-ALERVITES-AT2-Android`](https://github.com/byf3332/Baofeng-ALERVITES-AT2-Android), sous licence Apache 2.0. Voir [`NOTICE`](./NOTICE) et [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) pour l'attribution complète, y compris pour le codec `libopencore-amrnb` (Apache 2.0) utilisé pour le PTT.

Code propre à ce projet sous licence MIT — voir [`LICENSE`](./LICENSE).
