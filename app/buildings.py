"""Building footprints for the Map tab's per-camera line-of-sight
coverage feature: click a data-layer point (e.g. a camera from the
Paris vidéoverbalisation KML, see app/map_layers/) and the frontend
asks /api/map/buildings-near for whatever's around it, then computes
and draws a visibility polygon client-side (see computeCameraCoverage()
in app.js) -- buildings block the view past them, so the result reads
as "how far can this point actually see", not just a plain circle.

Also served whole, one arrondissement at a time, as a plain building-
outline map layer (list_zones() / buildings_in_zone() below, see
GET /api/map/building-zones(/…) in main.py) -- toggle one on in the
Map tab to see its building footprints directly, not just the
per-point coverage above. Files in app/map_buildings/ (see that
folder's own README.md) are named "<numéro><lettre?>_AR_paris.geojson"
-- an arrondissement number, an optional letter (A/B/C…) when a single
arrondissement needed more than one file, then "_AR_paris" -- and
list_zones() groups every file sharing a number into one entry for
that arrondissement, so "19A_AR_paris.geojson" + "19B_AR_paris.geojson"
both show up as one thing ("Paris 19e"), not two. A file that doesn't
match that pattern (an older one-off upload, say) just shows up as its
own entry under its own name instead, rather than being dropped --
hence "zone" in these function names, not "arrondissement": the
grouping is arrondissement-shaped when the filename says so, but
nothing here actually requires it.

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
import re
from pathlib import Path

logger = logging.getLogger(__name__)

BUILDINGS_DIR = Path(__file__).parent / "map_buildings"

METERS_PER_DEGREE_LAT = 111_320  # good enough at this scale (tens of meters); no attempt at ellipsoid precision

# "19A_AR_paris" -> "19" (arrondissement number), "1_AR_paris" -> "1".
# Case-insensitive and tolerant of the "AR"/"paris" separator being
# missing (some real uploads have come in as e.g. "1_ARparis") since
# that's just a naming slip, not a different dataset -- the number is
# what actually matters for grouping. Doesn't match the app's own
# earlier one-off test files ("paris_1er", "paris_6e", ...), which is
# exactly the point: those fall back to their own individual entry
# rather than being folded into a group (see list_zones() below).
_ARRONDISSEMENT_RE = re.compile(r"^(\d{1,2})[A-Za-z]?[_\s]?AR[_\s]?paris$", re.IGNORECASE)

# Each entry: {"ring": [[lon, lat], ...], "bbox": (minlon, minlat, maxlon, maxlat)}
_buildings: list[dict] = []  # every zone's buildings, flattened -- for buildings_near()'s cross-zone bbox query
_zones: dict[str, list[dict]] = {}  # zone id (file stem, e.g. "19A_AR_paris") -> that file's own buildings, in file order


def _arrondissement_number(zone_id: str) -> str | None:
    m = _ARRONDISSEMENT_RE.match(zone_id)
    return m.group(1) if m else None


def _label_for_arrondissement(num: str) -> str:
    n = int(num)
    return f"Paris {'1er' if n == 1 else f'{n}e'}"


def _label_for_zone(zone_id: str) -> str:
    """Fallback label for a file that doesn't match the arrondissement
    naming convention above: "paris_1er" -> "Paris 1er" -- capitalize
    each word, but only if it starts with a letter, since a naive
    .title() would turn "1er" into "1Er". Falls back to the raw id for
    anything that ends up empty (shouldn't happen for a real filename
    stem, but a label is cosmetic either way -- not worth failing
    over)."""
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


def _zone_ids_by_arrondissement() -> dict[str, list[str]]:
    """Every loaded zone id that matches the arrondissement naming
    convention, grouped by its number -- e.g. {"19": ["19A_AR_paris",
    "19B_AR_paris"]}. Recomputed from _zones on each call rather than
    kept as its own state: cheap (a handful of short strings, at most
    one regex match per loaded file) and one less thing that could get
    out of sync with _zones itself."""
    groups: dict[str, list[str]] = {}
    for zone_id in _zones:
        num = _arrondissement_number(zone_id)
        if num is not None:
            groups.setdefault(num, []).append(zone_id)
    return groups


def list_zones() -> list[dict]:
    """Display-level zones for the Map tab's "show building footprints"
    layer list (GET /api/map/building-zones) -- id/label/count, no
    geometry (that's buildings_in_zone() below, kept separate so
    listing stays cheap regardless of how big any one zone is).

    Files matching "<numéro><lettre?>_AR_paris" (see this module's own
    docstring) are grouped into one entry per arrondissement number
    (id = that number, e.g. "19"), count = every matching file's
    buildings summed -- the point of the naming convention is exactly
    this, one arrondissement worth showing as one thing regardless of
    how many files it took to cover it. Arrondissement entries come
    first, in numeric order (1, 2, … 20), since that's how someone
    scanning the list would expect to find one. Anything that doesn't
    match falls back to its own entry (_label_for_zone()), listed after,
    alphabetically."""
    groups = _zone_ids_by_arrondissement()
    grouped_ids = {zid for ids in groups.values() for zid in ids}
    standalone = sorted(zid for zid in _zones if zid not in grouped_ids)

    out = [
        {"id": num, "label": _label_for_arrondissement(num), "count": sum(len(_zones[z]) for z in ids)}
        for num, ids in sorted(groups.items(), key=lambda kv: int(kv[0]))
    ]
    out.extend(
        {"id": zone_id, "label": _label_for_zone(zone_id), "count": len(_zones[zone_id])}
        for zone_id in standalone
    )
    return out


def buildings_in_zone(zone_id: str, max_count: int = 100_000) -> list[list[list[float]]] | None:
    """Every building in one display-level zone from list_zones() above
    -- an arrondissement number (combining every file that shares it)
    if `zone_id` is one, otherwise one specific file's own buildings
    (whole file, no distance filter -- unlike buildings_near() above,
    this is "give me this zone's own outlines to draw as a layer", not
    "what's near this point"). Each building as a ring of [lat, lon]
    pairs. None if `zone_id` matches neither (caller turns that into a
    404). max_count is a defensive cap, not a real limit at today's
    scale (tens of thousands combined per arrondissement) -- it'd only
    ever bite if someone dropped in a single file covering all of
    Paris at once, and even then this just silently truncates rather
    than failing outright."""
    groups = _zone_ids_by_arrondissement()
    if zone_id in groups:
        bldgs = [b for z in groups[zone_id] for b in _zones[z]]
    else:
        bldgs = _zones.get(zone_id)
        if bldgs is None:
            return None
    return [[[lat_, lon_] for lon_, lat_ in b["ring"]] for b in bldgs[:max_count]]
