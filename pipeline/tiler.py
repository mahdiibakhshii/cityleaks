"""
tiler.py – Assign parsed OSM features to a 10 m × 10 m tile grid
and serialise each tile to the CityLeaks tile-format JSON schema.

Usage:
    from tiler import Tiler
    t = Tiler(buildings, roads, tile_size=10.0)
    t.write_tiles("output/")
"""

from __future__ import annotations
import json
import math
import os
from pathlib import Path
from typing import Optional

from coords import latlon_to_local, ORIGIN_LAT, ORIGIN_LON
from osm_parser import RawBuilding, RawRoad

SCHEMA_VERSION = 1


# ── Shapely is used for winding-order normalisation only ─────────────────────
try:
    from shapely.geometry import Polygon as ShapelyPolygon
    _HAS_SHAPELY = True
except ImportError:
    _HAS_SHAPELY = False


class Tiler:
    """
    Projects OSM features into local metres, partitions them into tiles,
    and produces one JSON document per tile.
    """

    def __init__(
        self,
        buildings: list[RawBuilding],
        roads: list[RawRoad],
        tile_size: float = 10.0,
    ):
        self.tile_size = tile_size
        self._tiles: dict[tuple[int, int], dict] = {}

        for b in buildings:
            self._add_building(b)
        for r in roads:
            self._add_road(r)

    # ── Public ────────────────────────────────────────────────────────────────

    def write_tiles(self, output_dir: str = "output") -> list[str]:
        """
        Write every accumulated tile to <output_dir>/tile_<i>_<j>.json.
        Returns list of written file paths.
        """
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        written = []
        for (i, j), tile in sorted(self._tiles.items()):
            path = out / f"tile_{i}_{j}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(tile, f, indent=2, ensure_ascii=False)
            written.append(str(path))
        return written

    def tile_count(self) -> int:
        return len(self._tiles)

    # ── Private – tile initialisation ─────────────────────────────────────────

    def _get_or_create_tile(self, i: int, j: int) -> dict:
        key = (i, j)
        if key not in self._tiles:
            ox = i * self.tile_size
            oz = j * self.tile_size
            self._tiles[key] = {
                "tileId": f"{i}_{j}",
                "tileSize": self.tile_size,
                "origin": {"x": round(ox, 4), "z": round(oz, 4)},
                "bounds": {},       # filled per-feature; we'll finalise later
                "version": SCHEMA_VERSION,
                "buildings": [],
                "roads": [],
                "water": [],
                "greens": [],
            }
        return self._tiles[key]

    # ── Private – building tiling ──────────────────────────────────────────────

    def _add_building(self, b: RawBuilding):
        """
        A building is placed in whichever tile contains its centroid.
        The full footprint is kept (may extend into neighbouring tiles).
        """
        local_pts = [latlon_to_local(lat, lon) for lat, lon in b.coords]

        # Drop duplicate closing vertex if present
        if len(local_pts) > 1 and local_pts[0] == local_pts[-1]:
            local_pts = local_pts[:-1]

        if len(local_pts) < 3:
            return

        # Ensure clockwise winding (viewed from +Y) using shapely if available
        local_pts = _ensure_clockwise(local_pts)

        # Centroid tile
        cx = sum(p[0] for p in local_pts) / len(local_pts)
        cz = sum(p[1] for p in local_pts) / len(local_pts)
        i, j = _tile_idx(cx, cz, self.tile_size)

        tile = self._get_or_create_tile(i, j)
        entry: dict = {
            "id": b.osm_id,
            "footprint": [{"x": round(x, 3), "z": round(z, 3)} for x, z in local_pts],
            "height": round(b.height, 2),
        }
        if b.levels is not None:
            entry["levels"] = b.levels
        if b.building_type and b.building_type != "yes":
            entry["type"] = b.building_type
        if b.min_height != 0.0:
            entry["minHeight"] = round(b.min_height, 2)

        tile["buildings"].append(entry)

    # ── Private – road tiling ──────────────────────────────────────────────────

    def _add_road(self, r: RawRoad):
        """
        Roads are split per-segment. Each segment goes into the tile
        containing its midpoint.
        """
        local_pts = [latlon_to_local(lat, lon) for lat, lon in r.coords]
        if len(local_pts) < 2:
            return

        for seg_start, seg_end in zip(local_pts, local_pts[1:]):
            mx = (seg_start[0] + seg_end[0]) / 2
            mz = (seg_start[1] + seg_end[1]) / 2
            i, j = _tile_idx(mx, mz, self.tile_size)
            tile = self._get_or_create_tile(i, j)

            # Merge into existing road entry for this OSM way if possible
            existing = next(
                (rd for rd in tile["roads"] if rd["id"] == r.osm_id), None
            )
            if existing is None:
                entry: dict = {
                    "id": r.osm_id,
                    "points": [
                        {"x": round(seg_start[0], 3), "z": round(seg_start[1], 3)},
                        {"x": round(seg_end[0], 3), "z": round(seg_end[1], 3)},
                    ],
                    "highway": r.highway,
                    "width": round(r.width, 2),
                }
                if r.name:
                    entry["name"] = r.name
                tile["roads"].append(entry)
            else:
                # Append the new end point (avoid duplicating midpoints)
                last = existing["points"][-1]
                ep = {"x": round(seg_end[0], 3), "z": round(seg_end[1], 3)}
                if ep != last:
                    existing["points"].append(ep)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _tile_idx(x: float, z: float, tile_size: float) -> tuple[int, int]:
    return math.floor(x / tile_size), math.floor(z / tile_size)


def _ensure_clockwise(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """
    Return pts in clockwise winding order (viewed from +Y / top-down).
    Uses shapely if available; falls back to signed-area check.
    """
    if _HAS_SHAPELY and len(pts) >= 3:
        poly = ShapelyPolygon(pts)
        # Shapely exterior is CCW by default; we want CW for Unity meshes
        coords = list(poly.exterior.coords)[:-1]   # drop duplicate closing pt
        area = poly.area
        # If area is positive in shapely (CCW), reverse to get CW
        return list(reversed(coords))

    # Fallback: shoelace signed area
    n = len(pts)
    signed = sum(
        (pts[i][0] * pts[(i + 1) % n][1]) - (pts[(i + 1) % n][0] * pts[i][1])
        for i in range(n)
    )
    # Positive signed area → CCW (in standard math coords) → reverse for CW
    if signed > 0:
        return list(reversed(pts))
    return pts
