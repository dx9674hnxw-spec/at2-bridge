# Couches de carte embarquées

Dépose un fichier `.kml` ici et ajoute une entrée dans `config.json`
pour qu'il soit chargé automatiquement dans l'onglet Carte à chaque
démarrage du serveur — pas besoin de repasser par l'import manuel
(bouton **Couches**) à chaque redéploiement.

## `config.json`

Une liste d'objets :

```json
[
  {
    "id": "videoverbalisation_paris",
    "label": "Vidéoverbalisation Paris",
    "file": "videoverbalisation_paris.kml",
    "color": "#ffffff"
  }
]
```

- `id` — identifiant unique de la couche (minuscules/chiffres/`-`/`_`
  uniquement). Le réutiliser met à jour la couche existante plutôt que
  d'en créer une nouvelle.
- `file` — nom du fichier `.kml` dans ce même dossier.
- `label` — nom affiché dans le panneau Couches.
- `color` — optionnel. Couleur par défaut au format `#rrggbb`.

`color` n'est que la couleur *par défaut* : sur son propre poste,
chaque utilisateur peut la changer depuis le panneau Couches (réglage
personnel, stocké dans son navigateur, sans toucher à ce fichier ni
aux autres utilisateurs). Pas d'icône par point : un layer peut
compter plusieurs centaines/milliers de points, et un vrai marqueur
par point (plutôt qu'un simple cercle coloré) a été mesuré trop lourd
sur mobile (iPad) — voir renderMapLayerMarkers() dans app.js.

## Le KML lui-même

Un vrai export KML (des `<Placemark>` avec de vraies coordonnées), pas
un fichier `<NetworkLink>` (pointeur vers une URL Google, sans les
données) — voir `app/kml.py` pour le détail. Dans Google My Maps :
menu ⋮ → **Télécharger un fichier KML** → décoche **« Contenu
réseau »** avant de télécharger.

## Rechargement

Ces couches sont (re)chargées au démarrage du serveur (voir
`app/bundled_layers.py` et le hook de démarrage dans `app/main.py`).
Modifier un fichier `.kml` ou `config.json` ici ne prend effet
qu'après redémarrage du serveur — l'import manuel via le bouton
**Couches** de l'onglet Carte, lui, prend effet immédiatement, sans
toucher au code.
