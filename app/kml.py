"""Parses a KML file's <Placemark> points -- used by the Map tab's
generic "import a data layer" feature (see /api/map/layers/{id}/import
in main.py), first exercised with a Paris video-surveillance camera
map exported from Google My Maps, but not specific to that dataset:
anything that's a KML file of point Placemarks works the same way.

Deliberately does NOT resolve KML <NetworkLink> elements (a pointer to
a live URL, not actual data -- see the docstring below). This project
has no HTTP client dependency today (see requirements.txt) and no way
to test a live fetch against an arbitrary external host from this
sandboxed dev environment either way, so rather than add an unverified
live-fetch feature, this asks for the real exported data once (a
one-time file upload, same shape as /api/channels/import-xml) and
stores it -- same trust model as that endpoint, and it keeps working
offline afterwards, which matters for an app whose whole reason to
exist is working off-grid.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET


def _local_tag(tag: str) -> str:
    """Strips the namespace off an ElementTree tag ("{http://www.opengis.
    net/kml/2.2}Placemark" -> "Placemark") -- KML has shipped under a
    couple of different namespace URIs over the years (2.0, 2.1, 2.2),
    and matching by local name only sidesteps having to enumerate them."""
    return tag.rsplit("}", 1)[-1]


def parse_kml_placemarks(kml_bytes: bytes) -> list[dict]:
    """Returns every point Placemark found anywhere in the document
    (nested inside any number of <Folder>/<Document> levels) as
    {"name": str, "description": str, "lat": float, "lon": float}.

    Only Placemarks with a single-point <coordinates> (a <Point>) count
    -- a <LineString>/<Polygon>'s <coordinates> holds many whitespace-
    separated tuples, which isn't a single map marker's worth of data
    and isn't what this feature is for (individual camera/POI markers,
    not tracing shapes), so those are silently skipped rather than
    guessed at.
    """
    try:
        root = ET.fromstring(kml_bytes)
    except ET.ParseError as e:
        raise ValueError(f"KML illisible: {e}") from e

    points: list[dict] = []
    for placemark in root.iter():
        if _local_tag(placemark.tag) != "Placemark":
            continue
        name = ""
        description = ""
        lat: float | None = None
        lon: float | None = None
        for child in placemark.iter():
            tag = _local_tag(child.tag)
            if tag == "name" and not name:
                name = (child.text or "").strip()
            elif tag == "description" and not description:
                description = (child.text or "").strip()
            elif tag == "coordinates" and lat is None:
                text = (child.text or "").strip()
                parts = text.split()
                if len(parts) != 1:
                    continue  # a shape (line/polygon), not a single point -- see docstring
                fields = parts[0].split(",")
                if len(fields) < 2:
                    continue
                try:
                    lon, lat = float(fields[0]), float(fields[1])
                except ValueError:
                    lat = lon = None
        if lat is not None and lon is not None:
            points.append({"name": name, "description": description, "lat": lat, "lon": lon})

    if not points:
        # The single most likely reason this comes up empty: Google My
        # Maps' own "Download KML" dialog defaults to a <NetworkLink>
        # pointer (a live URL to fetch, not the actual data) unless
        # "Contenu réseau"/"Network Links" is unchecked before
        # downloading -- worth calling out by name since the fix is a
        # one-click settings change in that same dialog, not a
        # different export tool.
        has_network_link = any(_local_tag(e.tag) == "NetworkLink" for e in root.iter())
        if has_network_link:
            raise ValueError(
                "Ce fichier est un pointeur Google My Maps (NetworkLink) vers les données, "
                "pas les données elles-mêmes. Dans My Maps : menu ⋮ → Télécharger un fichier KML "
                "→ décoche « Contenu réseau » avant de télécharger, puis réimporte ce fichier-là."
            )
        raise ValueError("aucun point (Placemark) trouvé dans ce fichier KML")

    return points
