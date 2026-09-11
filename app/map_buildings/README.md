# Contours de bâtiments (couverture caméra)

Dépose ici un ou plusieurs exports GeoJSON de contours de bâtiments —
tous les fichiers `*.geojson` présents dans ce dossier sont chargés au
démarrage du serveur (`app/buildings.py`). Utilisé pour la fonction
« zone de visibilité » : cliquer sur un point d'une couche (ex. une
caméra) calcule jusqu'où elle peut effectivement voir, en tenant
compte des bâtiments qui bloquent la vue.

## Où obtenir ces données

**Recommandé : [le jeu de données « Volumes bâtis » de la Ville de
Paris](https://opendata.paris.fr/explore/dataset/volumesbatisparis/)**
— la donnée officielle, couvre tout Paris. Onglet **Tableau** ou
**Carte** : filtre par arrondissement (facette `n_ar` si dispo, ou
zoome sur la zone qui t'intéresse), puis onglet **Export → GeoJSON**.
C'est comme ça que `paris_1er.geojson` et `paris_6e.geojson` (déjà dans
ce dossier) ont été obtenus — répète pour d'autres arrondissements afin
d'étendre la couverture au fur et à mesure.

**Alternative : [overpass-turbo.eu](https://overpass-turbo.eu)** (données
OSM, pas officielles mais dispo ailleurs qu'à Paris) — déplace la carte
sur la zone qui t'intéresse, colle cette requête, **Run**, puis
**Export → GeoJSON** :

```
[out:json][timeout:60];
(
  way["building"]({{bbox}});
);
out geom;
```

Dans les deux cas, exporte arrondissement par arrondissement (ou zone
par zone) plutôt que tout Paris d'un coup : un fichier par zone reste
gérable (quelques Mo), et ce n'est pas nécessaire de tout avoir en un
coup — la fonction ne calcule une zone de visibilité qu'autour d'un
point cliqué à la fois (quelques dizaines de mètres), pas pour toute la
carte en même temps.

## Format attendu

Un `FeatureCollection` GeoJSON standard, avec des géométries `Polygon`
ou `MultiPolygon` (tout le reste — points, lignes — est ignoré). Les
autres propriétés de chaque `Feature` (nom, adresse, etc.) ne sont pas
utilisées, seul le contour compte.

## Rechargement

Comme les couches embarquées (`app/map_layers/`), ces fichiers sont
(re)chargés au démarrage du serveur — modifier ou ajouter un fichier
ici ne prend effet qu'après redémarrage.
