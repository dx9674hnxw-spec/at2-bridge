![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)
![Python](https://img.shields.io/badge/Python-3.12-blue.svg?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=flat&logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-33_passed-success.svg?logo=pytest)
![Radio](https://img.shields.io/badge/🛜_Radio-Baofeng_AT2-8A2BE2.svg)

# AT2 Bridge

Application web auto-hébergée (Docker) pour piloter une radio bidirectionnelle **Alervites/Baofeng AT2** depuis un serveur Linux, ou directement depuis le navigateur en BLE local — canaux, réglages appareil, messagerie hors-réseau (texte/image/voix), PTT temps réel, position/SOS, authentification.

> [!WARNING]
> **Projet communautaire non affilié à Baofeng/Alervites.** Protocole reconstitué par rétro-ingénierie. Aucune garantie de compatibilité totale — teste prudemment.

## Fonctionnalités

###  Implémenté et testé (sans radio)

- **Codec de trame** — Encodage/décodage `AA55 [LEN] [PAYLOAD] [CRC16] 77EE`, CRC16-CCITT (init `0x1234`, poly `0x1021`).
- **Codec de canal** — Enregistrements 24 octets (fréquences, tons CTCSS/DCS, bande passante, puissance), round-trip testé.
- **Codec AMR-NB (voix)** — Binding ctypes vers `libopencore-amrnb` réel, round-trip encode/decode validé.
- **Chunking PTT temps réel** — Paquets vocaux (5 trames AMR/paquet, cadencement 100ms), format confirmé par le code source de référence.
- **Messagerie texte/voix/image (construction + décodage + réassemblage)** — Les trois formats hors-réseau portés depuis `At2OfflineMessageCodec.kt` ; round-trip testé pour les trois types, y compris messages concurrents entrelacés et chunks orphelins.
- **Backend FastAPI** — 32 routes HTTP + 4 WebSocket, toutes s'importent et répondent.
- **Authentification** — Token HMAC signé, activable/désactivable via variable d'environnement, testée (émission, vérification, expiration, altération de signature).
- **Gestion d'erreurs propre** — `RuntimeError` (ex: pas de connexion active) renvoyées en HTTP 409 clair ; toute autre erreur inattendue loggée en entier côté serveur mais sans traceback exposé au client.
- **Stockage local** (noms de canaux, appareils connus) — Persistance JSON testée, y compris l'enregistrement automatique d'un appareil à la connexion série.
- **33 tests unitaires** — `app/tests/test_protocol.py`.

###  Implémenté mais non testé (nécessite la radio)

- **Lecture/écriture des canaux** (USB série et BLE) — jamais envoyé à une radio réelle.
- **Lecture groupée des 30 canaux (codeplug)** — commande déduite par symétrie, non observée sur trafic réel.
- **Réglages appareil** (volume/squelch/VOX) — seuls réglages câblés à ce jour ; jamais vérifiés sur radio.
- **Envoi de messages texte/voix/image hors-réseau** — format testé unitairement, jamais émis vers une radio.
- **Réception de messages hors-réseau** — décodage + WebSocket (`/ws/messages`) + affichage dans le fil de discussion entièrement câblés côté client, jamais reçu de vraie trame radio ; lecture audio des messages vocaux reçus non implémentée (affichage texte uniquement pour l'instant).
- **PTT temps réel (voix)** — capture micro → 8kHz mono → AMR-NB → trames radio, chaîne complète jamais testée avec une radio en face.
- **Position/SOS** — repose sur le canal de messagerie texte (pas de type structuré dédié), jamais émis en conditions réelles.
- **Mode BLE local (Web Bluetooth)** — port JS minimal (canal, texte), jamais connecté à une radio réelle.
- **Reconnexion aux appareils connus** — persistance fonctionnelle, reconnexion réelle non testée.
- **Formulaire de connexion (auth frontend)** — flux complet testé côté API (login, token, 401, session expirée), jamais utilisé via l'interface réelle en conditions de terrain.

###  Non implémenté / Roadmap

- **Réglages avancés** (sensibilité VOX, temporisation TX, inhibition TX, réduction de bruit, tonalité de confirmation, nom d'appareil, Smart Link) — commandes déjà présentes dans `app/protocol/commands.py` (portées du protocole réel) mais volontairement non exposées à l'UI pour l'instant.
- **Lecture audio des messages vocaux reçus** — le message arrive et s'affiche, mais aucun lecteur audio n'est encore branché côté navigateur.
- **Type de message structuré "Position"** — actuellement du texte formaté, pas le format natif observé dans l'app Ola Radio.
- **Gestion simultanée de plusieurs radios** — une seule connexion active à la fois côté serveur.
- **Flux vidéo / photos périodiques** — non implémenté ; débit du protocole (≈330 o/s messagerie, 4,8 kbps PTT) rend une vraie vidéo irréaliste.
- **Nettoyage des messages partiels abandonnés** — l'assembleur de messages entrants n'a pas de timeout si une transmission est interrompue en cours de route.

## Architecture

```mermaid
graph TD
    Browser[Navigateur Client] <-->|HTTP / WS| Server[Serveur Linux FastAPI / Docker]
    Server <-->|USB / BLE| Radio[Radio AT2]
    Browser <-->|Web Bluetooth| Radio
