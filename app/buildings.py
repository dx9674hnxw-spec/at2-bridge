"""Building footprints for the Map tab's per-camera line-of-sight
coverage feature: click a data-layer point (e.g. a camera from the
Paris vidéoverbalisation KML, see app/map_layers/) and the frontend
asks /api/map/buildings-near for whatever's around it, then computes
and draws a visibility polygon client-side (see computeCameraCoverage()
in app.js) -- buildings block the view past them, so the result reads
as "how far can this point actually see", not just a plain circle.

No orientation/field-of-view data exists in the camera KML (see
app/kml.py's own comment on that dataset's actual fields), so this is
necessarily omnidirectional -- how far visibility reaches in *every*
direction up to some assumed range, not a real camera's actual cone.

Add more coverage by dropping another *.geojson export (OSM building
footprints, e.g. via overpass-turbo.eu -- see app/map_buildings/
README.md) into this folder; every file present is loaded at startup.
Loaded once into a flat in-memory list, no spatial index (R-tree etc.):
a naive bounding-box pre-filter per query is plenty fast at this
dataset's scale (a few thousand polygons for one test neighborhood),
and a new dependency for this isn't worth it unless a much larger area
actually needs it -- worth revisiting if this ever covers all of Paris
at once (a few hundred thousand buildings).
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
_buildings: list[dict] = []


def load_buildings() -> None:
    """Best-effort, per-file and per-feature: a bad file or a feature
    with unusable geometry logs a warning and is skipped rather than
    failing startup -- one malformed export shouldn't take the whole
    map down."""
    _buildings.clear()
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

        count = 0
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
                _buildings.append({
                    "ring": list(zip(lons, lats)),
                    "bbox": (min(lons), min(lats), max(lons), max(lats)),
                })
                count += 1
        logger.info("Bâtiments chargés depuis %s: %d polygone(s)", path.name, count)


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
