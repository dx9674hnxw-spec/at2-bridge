"""Loads Map-tab data layers shipped inside the app itself (see
app/map_layers/config.json) alongside the ones a user imports at
runtime through the Map tab's own upload UI (see /api/map/layers/* in
main.py). Both end up in the exact same store.map_layers table -- a
bundled layer is just seeded from disk at startup instead of uploaded,
so dropping a new KML in app/map_layers/ (see that folder's own
README) plus a restart is enough, no need to re-upload through the UI
after every redeploy.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from app import kml, store

logger = logging.getLogger(__name__)

BUNDLED_LAYERS_DIR = Path(__file__).parent / "map_layers"
CONFIG_PATH = BUNDLED_LAYERS_DIR / "config.json"

# Same shape main.py's /api/map/layers/{layer_id}/import enforces on a
# manually-uploaded layer's id -- kept in sync deliberately, since both
# end up as keys in the exact same store.map_layers table.
_LAYER_ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")


def load_bundled_layers() -> None:
    """Best-effort, per-entry: a missing config.json is a normal "no
    bundled layers configured" case (not an error), and one bad entry or
    unreadable/malformed KML file logs a warning and skips just that
    entry rather than failing app startup entirely -- a typo in one
    layer's config shouldn't take the whole map down.
    """
    if not CONFIG_PATH.exists():
        return
    try:
        entries = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("app/map_layers/config.json illisible, couches embarquées ignorées: %s", e)
        return
    if not isinstance(entries, list):
        logger.warning("app/map_layers/config.json: attendu une liste, couches embarquées ignorées")
        return

    for entry in entries:
        if not isinstance(entry, dict):
            logger.warning("app/map_layers/config.json: entrée invalide (pas un objet): %r", entry)
            continue
        layer_id = entry.get("id", "")
        filename = entry.get("file", "")
        if not _LAYER_ID_RE.match(layer_id):
            logger.warning("app/map_layers/config.json: id de couche invalide: %r", layer_id)
            continue
        if not filename:
            logger.warning("app/map_layers/config.json: 'file' manquant pour la couche %r", layer_id)
            continue

        kml_path = BUNDLED_LAYERS_DIR / filename
        try:
            # Belt-and-suspenders against a "../../something" filename in
            # config.json ever escaping app/map_layers/ -- config.json is
            # a repo file a developer edits, not user input, but this is
            # a cheap check and there's no reason not to have it anyway.
            kml_path.resolve().relative_to(BUNDLED_LAYERS_DIR.resolve())
        except ValueError:
            logger.warning("app/map_layers/config.json: 'file' en dehors du dossier autorisé: %r", filename)
            continue

        try:
            raw = kml_path.read_bytes()
        except OSError as e:
            logger.warning("Couche embarquée %r: impossible de lire %s: %s", layer_id, filename, e)
            continue
        try:
            points = kml.parse_kml_placemarks(raw)
        except ValueError as e:
            logger.warning("Couche embarquée %r: %s: %s", layer_id, filename, e)
            continue

        store.save_map_layer(
            layer_id, entry.get("label") or layer_id, points,
            icon=entry.get("icon") or None, color=entry.get("color") or None,
        )
        logger.info("Couche embarquée chargée: %s (%d points)", layer_id, len(points))
