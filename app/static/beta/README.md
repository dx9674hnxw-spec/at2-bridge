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

## Prototypes actuels

- `map-redesign.html` — refonte de l'onglet Carte : bascule "Suivi auto"
  explicite, filtre par ancienneté, traînées (historique réel par
  expéditeur), fondu des marqueurs avec l'âge, clustering simple à l'écran,
  bandeau SOS persistant, export GPX réel, et deux boutons de confort pour
  tester sans matériel (`+ Balise de test` / `🧹 Suppr. balises de test`,
  qui écrivent/nettoient des entrées taguées `synthetic:true` dans
  `at2_beacons`).
