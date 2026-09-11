"""Building footprints for the Map tab's per-camera line-of-sight
coverage feature: click a data-layer point (e.g. a camera from the
Paris vidéoverbalisation KML, see app/map_layers/) and the frontend
asks /api/map/buildings-near for whatever's around it, then computes
and draws a visibility polygon client-side (see computeCameraCoverage()
in app.js) -- buildings block the view past them, so the result reads
as "how far can this point actually see", not just a plain circle.

Also served whole, one file ("zone") at a time, as a plain building-
outline map layer (list_zones() / buildings_in_zone() below, see
GET /api/map/building-zones(/…) in main.py) -- toggle a zone on in the
Map tab to see its building footprints directly, not just the
per-point coverage above. One zone per *.geojson file dropped into
app/map_buildings/ (see that folder's own README.md), typically one
Paris arrondissement each, hence "zone" rather than "arrondissement":
nothing here actually requires the file to be arrondissement-shaped,
that's just been the practical unit so far.

No orientation/field-of-view data exists in the camera KML (see
app/kml.py's own comment on that dataset's actual fields), so this is
necessarily omnidirectional -- how far visibility reaches in *every*
direction up to some assumed range, not a real camera's actual cone.

Add more coverage by dropping another *.geojson export (building
footprints -- either OSM via overpass-turbo.eu, or the Ville de
Paris's own "Volumes bâtis" open-data set, see app/map_buildings/
README.md) into this folder; every file present is loaded at startup,
arrondissement by arrondissement, growing coverage over time. Loaded
once into a flat in-memory list, no spatial index (R-tree etc.): a
naive bounding-box pre-filter per query is plenty fast at this
dataset's scale (tens of thousands of polygons across a handful of
arrondissements so far), and a new dependency for this isn't worth it
unless a much larger area actually needs it -- worth revisiting if
this ever covers all of Paris at once (the full open-data set is
~360k buildings).
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path

logger = logging.getLogger(__name__)

BUILDINGS_DIR = Path(__file__).parent / "map_buildings"

METERS_PER_DEGREE_LAT = 111_320  # good enough at this scale (tens of meters); no attempt at ellipsoid precision

# Each entry: {"ring": [[lon, lat], ...], "bbox": (minlon, minlat, maxlon, maxlat)}
_buildings: list[dict] = []  # every zone's buildings, flattened -- for buildings_near()'s cross-zone bbox query
_zones: dict[str, list[dict]] = {}  # zone id (file stem, e.g. "paris_1er") -> that file's own buildings, in file order


def _label_for_zone(zone_id: str) -> str:
    """"paris_1er" -> "Paris 1er": capitalize each word, but only if it
    starts with a letter -- a naive .title() would turn "1er" into
    "1Er". Falls back to the raw id for anything that ends up empty
    (shouldn't happen for a real filename stem, but a label is cosmetic
    either way -- not worth failing over)."""
    words = zone_id.replace("_", " ").replace("-", " ").split()
    out = [w[0].upper() + w[1:] if w and w[0].isalpha() else w for w in words]
    return " ".join(out) or zone_id


def load_buildings() -> None:
    """Best-effort, per-file and per-feature: a bad file or a feature
    with unusable geometry logs a warning and is skipped rather than
    failing startup -- one malformed export shouldn't take the whole
    map down."""
    _buildings.clear()
    _zones.clear()
    if not BUILDINGS_DIR.exists():
        return
    for path in sorted(BUILDINGS_DIR.glob("*.geojson")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Bâtiments %s illisible: %s", path.name, e)
            continue
        features = data.get("features")
        if not isinstance(features, list):
            logger.warning("Bâtiments %s: pas un FeatureCollection valide", path.name)
            continue

        zone_buildings: list[dict] = []
        for feature in features:
            geom = (feature or {}).get("geometry") or {}
            gtype = geom.get("type")
            if gtype == "Polygon":
                polys = [geom.get("coordinates") or []]
            elif gtype == "MultiPolygon":
                polys = geom.get("coordinates") or []
            else:
                continue  # Point/LineString/etc. -- not a building footprint

            for poly in polys:
                if not poly:
                    continue
                ring = poly[0]  # outer ring only -- holes (inner rings, courtyards) don't matter for a shadow-casting silhouette
                if not isinstance(ring, list) or len(ring) < 3:
                    continue
                try:
                    lons = [float(pt[0]) for pt in ring]
                    lats = [float(pt[1]) for pt in ring]
                except (TypeError, ValueError, IndexError):
                    continue
                zone_buildings.append({
                    "ring": list(zip(lons, lats)),
                    "bbox": (min(lons), min(lats), max(lons), max(lats)),
                })
        # A duplicate stem (e.g. "paris_1er.geojson" next to a leftover
        # "Paris_1er.geojson") would otherwise silently overwrite one
        # zone with the other in _zones below -- glob() order isn't
        # something to rely on for which one wins, so call it out.
        zone_id = path.stem
        if zone_id in _zones:
            logger.warning("Bâtiments %s: id de zone \"%s\" déjà utilisé par un autre fichier, celui-ci écrase le précédent", path.name, zone_id)
        _zones[zone_id] = zone_buildings
        _buildings.extend(zone_buildings)
        logger.info("Bâtiments chargés depuis %s: %d polygone(s)", path.name, len(zone_buildings))


def buildings_near(lat: float, lon: float, radius_m: float, max_count: int = 500) -> list[list[list[float]]]:
    """Every building whose bounding box comes within `radius_m` meters
    of (lat, lon), each as a ring of [lat, lon] pairs (outer ring only,
    see load_buildings()). A cheap bbox filter, not an exact distance
    check -- a building's real closest edge could be a little further
    out than this lets through -- which costs nothing: the client
    re-derives the real visibility polygon itself from these, so a few
    harmless extra candidates just outside the true radius don't change
    the result, just the (tiny) amount of work computing it.
    """
    deg_lat = radius_m / METERS_PER_DEGREE_LAT
    deg_lon = radius_m / (METERS_PER_DEGREE_LAT * max(0.01, math.cos(math.radians(lat))))
    min_lon, max_lon = lon - deg_lon, lon + deg_lon
    min_lat, max_lat = lat - deg_lat, lat + deg_lat

    out: list[list[list[float]]] = []
    for b in _buildings:
        bminlon, bminlat, bmaxlon, bmaxlat = b["bbox"]
        if bmaxlon < min_lon or bminlon > max_lon or bmaxlat < min_lat or bminlat > max_lat:
            continue
        out.append([[lat_, lon_] for lon_, lat_ in b["ring"]])
        if len(out) >= max_count:
            break
    return out


def list_zones() -> list[dict]:
    """One entry per loaded *.geojson file, for the Map tab's "show
    building footprints" layer list (GET /api/map/building-zones) --
    id/label/count, no geometry (that's buildings_in_zone() below, kept
    separate so listing the available zones stays cheap regardless of
    how big any one of them is)."""
    return [
        {"id": zone_id, "label": _label_for_zone(zone_id), "count": len(bldgs)}
        for zone_id, bldgs in sorted(_zones.items())
    ]


def buildings_in_zone(zone_id: str, max_count: int = 20_000) -> list[list[list[float]]] | None:
    """Every building in one zone (whole file, no distance filter --
    unlike buildings_near() above, this is "give me this file's own
    outlines to draw as a layer", not "what's near this point"), each
    as a ring of [lat, lon] pairs. None if the zone id doesn't exist
    (caller turns that into a 404). max_count is a defensive cap, not a
    real limit at today's scale (a few thousand per arrondissement) --
    it'd only ever bite if someone dropped in a single file covering
    all of Paris at once, and even then this just silently truncates
    rather than failing outright."""
    bldgs = _zones.get(zone_id)
    if bldgs is None:
        return None
    return [[[lat_, lon_] for lon_, lat_ in b["ring"]] for b in bldgs[:max_count]]
