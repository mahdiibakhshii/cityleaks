"""
coords.py – Coordinate utilities for CityLeaks OSM pipeline.

Converts WGS-84 lat/lon to local meter offsets from a defined world origin,
using UTM Zone 33N (EPSG:32633) as the intermediate projection.

Origin: 48.212204°N, 16.380939°E  (Schwedenplatz, Vienna)
Unity axes: X = East, Z = North
"""

from pyproj import Transformer

# ── World origin (Schwedenplatz) ──────────────────────────────────────────────
ORIGIN_LAT = 48.212204
ORIGIN_LON = 16.380939

# ── Projectors ────────────────────────────────────────────────────────────────
_wgs84_to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32633", always_xy=True)

# Pre-compute origin in UTM
_ORIGIN_E, _ORIGIN_N = _wgs84_to_utm.transform(ORIGIN_LON, ORIGIN_LAT)


def latlon_to_local(lat: float, lon: float) -> tuple[float, float]:
    """
    Convert WGS-84 (lat, lon) to local (x, z) in meters from world origin.
    x = East offset, z = North offset.
    """
    e, n = _wgs84_to_utm.transform(lon, lat)
    return e - _ORIGIN_E, n - _ORIGIN_N


def tile_id_from_local(x: float, z: float, tile_size: float = 10.0) -> tuple[int, int]:
    """
    Return (i, j) tile grid indices for a local (x, z) position.
    """
    import math
    return math.floor(x / tile_size), math.floor(z / tile_size)


def tile_bounds_local(i: int, j: int, tile_size: float = 10.0) -> dict:
    """
    Return the SW/NE corners of tile (i, j) in local meter coordinates.
    """
    return {
        "min_x": i * tile_size,
        "min_z": j * tile_size,
        "max_x": (i + 1) * tile_size,
        "max_z": (j + 1) * tile_size,
    }
