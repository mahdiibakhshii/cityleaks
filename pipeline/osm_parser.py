"""
osm_parser.py – Extract buildings and roads from an Overpass API JSON response.

Accepts the raw Overpass JSON (the 'elements' list) and returns
structured lists of buildings and roads suitable for tiling.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

# ── Highway width defaults (meters) ──────────────────────────────────────────
HIGHWAY_WIDTHS: dict[str, float] = {
    "motorway":   14.0,
    "trunk":      12.0,
    "primary":    10.0,
    "secondary":   8.0,
    "tertiary":    7.0,
    "residential": 6.0,
    "living_street": 5.0,
    "pedestrian":  5.0,
    "service":     4.0,
    "unclassified": 5.0,
    "cycleway":    2.5,
    "footway":     2.0,
    "path":        2.0,
    "track":       3.0,
    "steps":       2.0,
}
DEFAULT_HIGHWAY_WIDTH = 4.0

# Default building height if no tags present (3 floors × 3 m)
DEFAULT_BUILDING_HEIGHT = 9.0
METERS_PER_LEVEL = 3.0


# ── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class RawBuilding:
    osm_id: str
    coords: list[tuple[float, float]]   # (lat, lon) list, closed ring
    height: float
    levels: Optional[int]
    building_type: str
    min_height: float = 0.0


@dataclass
class RawRoad:
    osm_id: str
    coords: list[tuple[float, float]]   # (lat, lon) polyline
    highway: str
    width: float
    name: Optional[str] = None


# ── Parser ────────────────────────────────────────────────────────────────────

class OsmParser:
    """
    Parses a raw Overpass API JSON response into RawBuilding / RawRoad lists.
    """

    def __init__(self, overpass_json: dict):
        elements = overpass_json.get("elements", [])
        # Index nodes for fast lookup
        self._nodes: dict[int, tuple[float, float]] = {
            el["id"]: (el["lat"], el["lon"])
            for el in elements
            if el["type"] == "node"
        }
        self._ways = [el for el in elements if el["type"] == "way"]

    # ── Public ────────────────────────────────────────────────────────────────

    def buildings(self) -> list[RawBuilding]:
        result = []
        for way in self._ways:
            tags = way.get("tags", {})
            if "building" not in tags:
                continue
            coords = self._resolve_nodes(way.get("nodes", []))
            if len(coords) < 3:
                continue

            height, levels = self._parse_height(tags)
            result.append(RawBuilding(
                osm_id=f"osm_way_{way['id']}",
                coords=coords,
                height=height,
                levels=levels,
                building_type=tags.get("building", "yes"),
                min_height=self._parse_float(tags.get("min_height", "0")) or 0.0,
            ))
        return result

    def roads(self) -> list[RawRoad]:
        result = []
        for way in self._ways:
            tags = way.get("tags", {})
            highway = tags.get("highway")
            if not highway:
                continue
            coords = self._resolve_nodes(way.get("nodes", []))
            if len(coords) < 2:
                continue

            width = self._parse_float(tags.get("width")) or HIGHWAY_WIDTHS.get(highway, DEFAULT_HIGHWAY_WIDTH)
            result.append(RawRoad(
                osm_id=f"osm_way_{way['id']}",
                coords=coords,
                highway=highway,
                width=width,
                name=tags.get("name"),
            ))
        return result

    # ── Private ───────────────────────────────────────────────────────────────

    def _resolve_nodes(self, node_ids: list[int]) -> list[tuple[float, float]]:
        """Map a list of node IDs → (lat, lon) tuples, skipping missing nodes."""
        resolved = []
        for nid in node_ids:
            if nid in self._nodes:
                resolved.append(self._nodes[nid])
        return resolved

    @staticmethod
    def _parse_float(value) -> Optional[float]:
        if value is None:
            return None
        try:
            return float(str(value).replace(",", ".").split()[0])
        except (ValueError, IndexError):
            return None

    def _parse_height(self, tags: dict) -> tuple[float, Optional[int]]:
        """Derive height and levels from OSM tags with fallback chain."""
        # 1) Explicit height tag
        h = self._parse_float(tags.get("height"))
        if h is not None:
            levels = self._parse_float(tags.get("building:levels"))
            return h, int(levels) if levels else None

        # 2) building:levels × meters per level
        levels = self._parse_float(tags.get("building:levels"))
        if levels is not None:
            return levels * METERS_PER_LEVEL, int(levels)

        # 3) Default
        return DEFAULT_BUILDING_HEIGHT, None
