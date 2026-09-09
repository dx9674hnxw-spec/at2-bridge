# `beta/` — prototypes en test

Dossier isolé du reste de l'appli : chaque page ici est un **fichier HTML
autonome** (son propre `<html>`/`<style>`/`<script>`, aucun `import`/`require`
vers `app.js` ou `style.css` autre qu'un simple `<link>` pour réutiliser les
couleurs/typo). Le but : pouvoir casser une expérimentation sans jamais
pouvoir casser l'appli principale.

## Comment c'est branché

L'onglet **Beta** de l'appli (`index.html` → `#tab-beta`) charge ces pages
dans des `<iframe>` — voir `BETA_PAGES` dans `app.js`. Une iframe est une
vraie frontière : si une page d'ici plante en JS, l'appli autour continue de
tourner normalement.

Comme l'iframe est servie depuis la même origine, elle partage le
`localStorage` de l'appli (ex. `at2_beacons`, `at2_theme`) — pratique pour
prototyper contre de vraies données déjà reçues, mais à garder en tête :
une page d'ici peut lire/écrire cet état partagé.

## Workflow

1. **Prototyper** : nouveau fichier ici, ajouté à `BETA_PAGES` dans
   `app.js` (une ligne). Rien d'autre à modifier.
2. **Tester / évaluer** : onglet Beta → sous-onglet correspondant, en
   conditions quasi réelles (vraies données si dispo, vrai Leaflet, vrai
   thème).
3. **Décider** : ça reste, ça se transforme, ou ça part à la poubelle.
4. **Porter** : une fois validé, le code utile est réécrit *dans* `app.js`
   / `style.css` / `index.html` (pas de copier-coller de tout le fichier —
   ces pages beta ont des raccourcis, doublons et flags de debug qui n'ont
   rien à faire dans le code principal). Le fichier ici est ensuite retiré
   de `BETA_PAGES` et supprimé.

## Honnêteté matérielle

Le README principal est très strict sur la distinction "acquittement du
protocole" ≠ "confirmé sur le matériel réel" — même règle ici. Chaque page
dit explicitement dans son propre bandeau ce qui est **réel** (une vraie
commande du protocole, une vraie API navigateur) et ce qui est **simulé**
(données d'exemple, mesure inexistante côté radio). Le protocole AT2
reverse-engineered (`app/protocol/commands.py`) n'expose ni RSSI, ni scan
large-bande, ni capture spectrale — seulement sélection de canal et
réglages. Une page qui prétendrait mesurer un vrai signal serait trompeuse ;
mieux vaut prototyper l'ergonomie avec des données simulées, clairement
annoncées, en attendant de savoir si/comment une vraie mesure serait un
jour possible.

## Déjà porté

- **Scan de canaux** (était `frequency-scan.html`) — vit maintenant dans
  l'onglet **Scan** de l'appli principale (`index.html` → `#tab-scan`,
  logique dans `app.js`). La sélection de canal est réelle
  (`sendChannelSelect()`, même commande `select_channel()` que le
  sélecteur de canal normal) et la "détection d'activité" a été
  reformulée en un vrai signal (l'indicateur RX existant,
  `markIncomingRfActivity()`, via l'event `at2:rf-activity`) au lieu du
  tirage aléatoire du prototype — voir le commentaire en tête de la
  section Scan dans `app.js` pour le détail de ce qui a changé au
  portage.

## Prototypes actuels

- `map-redesign.html` — refonte de l'onglet Carte : bascule "Suivi auto"
  explicite, filtre par ancienneté, traînées (historique réel par
  expéditeur), fondu des marqueurs avec l'âge, clustering simple à l'écran,
  bandeau SOS persistant, export GPX réel, et deux boutons de confort pour
  tester sans matériel (`+ Balise de test` / `🧹 Suppr. balises de test`,
  qui écrivent/nettoient des entrées taguées `synthetic:true` dans
  `at2_beacons`).
- `spectrum.html` — concept de spectromètre/waterfall (trace + cascade en
  Canvas, pics simulés, hold max, span/fréquence centrale réglables).
  Entièrement simulé et annoncé comme tel : le matériel actuel ne peut
  physiquement pas fournir ces données (pas de récepteur large-bande, pas
  de RSSI exposé) — à évaluer uniquement comme interface, pas comme
  fonctionnalité portable telle quelle.
- `record-replay.html` — enregistrement/lecture via le micro du
  navigateur (`MediaRecorder`, même famille d'API que `ptt-audio.js`) :
  fonctionne réellement, lecture réelle, rien de persistant (tout est
  perdu au rechargement). "Renvoyer en PTT" est volontairement désactivé
  avec une explication — cette page n'a pas accès à la connexion
  série/BLE active de l'appli ; porter cette action réelle nécessiterait
  de relier un clip au pipeline PTT existant (`ptt-amr-codec.js`,
  WebSocket `/ws/ptt`).
