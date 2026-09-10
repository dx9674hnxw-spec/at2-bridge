# Contours de bâtiments (couverture caméra)

Dépose ici un ou plusieurs exports GeoJSON de contours de bâtiments —
tous les fichiers `*.geojson` présents dans ce dossier sont chargés au
démarrage du serveur (`app/buildings.py`). Utilisé pour la fonction
« zone de visibilité » : cliquer sur un point d'une couche (ex. une
caméra) calcule jusqu'où elle peut effectivement voir, en tenant
compte des bâtiments qui bloquent la vue.

## Où obtenir ces données

**Recommandé : [overpass-turbo.eu](https://overpass-turbo.eu)** — déplace
la carte sur la zone qui t'intéresse, colle cette requête, **Run**, puis
**Export → GeoJSON** :

```
[out:json][timeout:60];
(
  way["building"]({{bbox}});
);
out geom;
```

**Alternative : [opendata.paris.fr](https://opendata.paris.fr)** —
cherche « emprise des bâtiments », filtre par arrondissement si
possible, exporte en GeoJSON.

Commence par une petite zone (un quartier, un arrondissement) plutôt
que tout Paris d'un coup : le fichier grossit vite (des centaines de Mo
pour toute la ville), et ce n'est pas nécessaire — la fonction ne
calcule une zone de visibilité qu'autour d'un point cliqué à la fois
(quelques dizaines de mètres), pas pour toute la carte en même temps.

## Format attendu

Un `FeatureCollection` GeoJSON standard, avec des géométries `Polygon`
ou `MultiPolygon` (tout le reste — points, lignes — est ignoré). Les
autres propriétés de chaque `Feature` (nom, adresse, etc.) ne sont pas
utilisées, seul le contour compte.

## Rechargement

Comme les couches embarquées (`app/map_layers/`), ces fichiers sont
(re)chargés au démarrage du serveur — modifier ou ajouter un fichier
ici ne prend effet qu'après redémarrage.
