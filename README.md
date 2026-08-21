# AT2 Bridge

Application web auto-hébergée (Docker) pour piloter une radio bidirectionnelle **Alervites/Baofeng AT2** directement depuis un serveur Linux — lecture/écriture des canaux, réglages appareil, messagerie texte hors-réseau — en USB-C série ou en Bluetooth Low Energy.

> ⚠️ Projet communautaire non affilié à Baofeng/Alervites. Le protocole a été reconstitué par rétro-ingénierie (décompilation du logiciel CPS officiel + lecture du code source d'un projet Android tiers). Il n'y a **aucune garantie** de compatibilité totale ni d'absence de régression sur le firmware de la radio — teste prudemment, idéalement avec une radio de secours sous la main.

## Ce qui fonctionne (V1)

- **Transport USB-C série** (port COM virtuel, 115200 bauds) — protocole entièrement porté et testé unitairement.
- **Transport BLE** (`bleak`) — UUID de service/caractéristiques réels, extraits d'un projet Android open-source qui les a capturés sur trafic réel (btsnoop).
- **Lecture/écriture des 30 canaux** : fréquences RX/TX, tons CTCSS/DCS, bande passante, puissance, mode analogique/numérique, ajout au scan.
- **Réglages appareil** : volume, squelch, VOX, sélection de canal actif.
- **Messagerie texte hors-réseau** (le canal "off-grid" de l'appli Ola Radio) — fragmentation automatique des messages longs.
- Interface web unique (aucune build JS requise), journal d'activité en direct.

## Ce qui n'est PAS encore implémenté

- **PTT temps réel (voix)** : nécessite l'encodage/décodage AMR-NB (codec `OpenCORE-AMR`, trames de 12 octets/20ms) et un flux audio navigateur↔serveur↔radio. C'est la pièce la plus complexe du protocole ; voir `Roadmap` plus bas.
- **Messagerie image et vocale hors-réseau** : le format est documenté dans le projet Android source, mais non porté ici — seul le texte l'est.
- **Lecture groupée des 30 canaux** : la requête de lecture (`app/protocol/commands.py::query_channel_config`) est déduite par symétrie avec la commande d'écriture (même family/command, family de requête au lieu de family d'écriture), car elle n'a pas été capturée sur trafic réel dans le projet source. **À valider sur radio réelle** avant de faire confiance aux résultats en écriture groupée.

## Origine du protocole

Deux sources ont été croisées, et les deux confirment un protocole **identique** entre USB série et BLE (mêmes trames `AA55...77EE`, même CRC16) :

1. Décompilation du CPS officiel Windows (application Electron) — a livré la structure de trame et le layout exact des enregistrements de canaux.
2. Code source du projet [`Baofeng-ALERVITES-AT2-Android`](https://github.com/byf3332/Baofeng-ALERVITES-AT2-Android) (Apache-2.0) — a confirmé et complété (CRC16 exact, UUID BLE réels, format de messagerie hors-réseau).

Voir `NOTICE` et `THIRD_PARTY_NOTICES.md` pour l'attribution complète du code porté.

## Démarrage rapide (Docker)

```bash
git clone <url-de-ton-repo>
cd at2-bridge
docker compose up -d --build
```

L'interface est servie sur `http://<ip-du-serveur>:8000` (le conteneur tourne en `network_mode: host`, voir `docker-compose.yml` pour le détail des accès USB/BLE requis).

### Accès matériel requis

- **USB série** : branche la radio en USB-C sur le serveur. Le port apparaîtra typiquement en `/dev/ttyACM0` ou `/dev/ttyUSB0` — visible et sélectionnable directement dans l'interface (« USB série » → liste déroulante).
- **BLE** : le serveur doit avoir un adaptateur Bluetooth (intégré ou dongle USB). Le conteneur a besoin d'accéder à la stack BlueZ de l'hôte via D-Bus (déjà configuré dans `docker-compose.yml`).

## Développement local (sans Docker)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Tests

```bash
python -m pytest app/tests -v
```

Les tests couvrent le codec de trame, le CRC16, l'encodage/décodage des canaux et de la messagerie — indépendamment de tout matériel connecté.

## Roadmap

1. **Valider la lecture groupée des canaux** sur une radio réelle (capturer le trafic pendant un "Read from device" dans le CPS ou l'app Ola Radio, comparer avec `query_channel_config()`).
2. **Messagerie image/vocale hors-réseau** (formats déjà documentés côté Android, portage direct possible).
3. **PTT temps réel** : intégrer `OpenCORE-AMR` (ou un binding Python équivalent) pour encoder/décoder l'audio AMR-NB MR475, streamer entre le micro du navigateur (WebRTC/WebAudio) et la radio par trames de 12 octets/20ms.
4. Authentification de l'interface web (actuellement aucune — à réserver à un réseau de confiance, ex. Tailscale).

## Licence

Code de ce projet sous licence MIT. Contient des portions portées depuis un projet tiers sous licence Apache 2.0 — voir `LICENSE`, `NOTICE` et `THIRD_PARTY_NOTICES.md`.
