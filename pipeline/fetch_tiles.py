"""
fetch_tiles.py – Main entry point for the CityLeaks OSM pipeline.

Queries the Overpass API for a radius around the world origin
(Schwedenplatz: 48.212204, 16.380939), extracts buildings and roads,
and writes one JSON tile file per 10 m × 10 m cell into ./output/.

Usage:
    python fetch_tiles.py [--radius 500] [--tile-size 10] [--out output/]

Examples:
    python fetch_tiles.py                        # 500 m radius, default out
    python fetch_tiles.py --radius 200           # smaller area for quick test
    python fetch_tiles.py --out ../tiles/        # custom output directory
"""

from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path

import requests

from coords import ORIGIN_LAT, ORIGIN_LON
from osm_parser import OsmParser
from tiler import Tiler

# ── Overpass endpoints (tried in order) ──────────────────────────────────────
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# ── Overpass query template ───────────────────────────────────────────────────
#   around:<radius>,<lat>,<lon>  →  sphere around origin
#   We fetch ways only (buildings + roads). Nodes are included automatically
#   via `out body qt` with the `>` recurse.
QUERY_TEMPLATE = """
[out:json][timeout:60];
(
  way["building"](around:{radius},{lat},{lon});
  way["highway"](around:{radius},{lat},{lon});
);
out body;
>;
out skel qt;
"""


def fetch_overpass(radius: float) -> dict:
    query = QUERY_TEMPLATE.format(
        radius=int(radius),
        lat=ORIGIN_LAT,
        lon=ORIGIN_LON,
    )
    last_error = None
    for attempt, url in enumerate(OVERPASS_URLS):
        wait = 2 ** attempt  # 1s, 2s, 4s between mirrors
        if attempt > 0:
            print(f"[fetch] Retrying with mirror {url} (wait {wait}s) ...")
            time.sleep(wait)
        else:
            print(f"[fetch] Querying Overpass API (radius={radius}m) ...")
        try:
            resp = requests.post(
                url,
                data={"data": query},
                timeout=90,
                headers={"User-Agent": "CityLeaks-Pipeline/1.0"},
            )
            resp.raise_for_status()
            data = resp.json()
            n_elements = len(data.get("elements", []))
            print(f"[fetch] Received {n_elements} elements from {url}")
            return data
        except requests.exceptions.RequestException as e:
            print(f"[fetch] Failed ({url}): {e}")
            last_error = e
    raise RuntimeError(f"All Overpass mirrors failed. Last error: {last_error}")


def main():
    parser = argparse.ArgumentParser(description="CityLeaks OSM tile fetcher")
    parser.add_argument("--radius",    type=float, default=500.0,
                        help="Fetch radius in meters around origin (default: 500)")
    parser.add_argument("--tile-size", type=float, default=10.0,
                        help="Tile grid cell size in meters (default: 10)")
    parser.add_argument("--out",       type=str,   default="output",
                        help="Output directory for tile JSON files (default: output/)")
    parser.add_argument("--local",     type=str,   default=None,
                        help="Load Overpass JSON from a local file instead of fetching")
    args = parser.parse_args()

    # ── 1. Obtain raw OSM data ─────────────────────────────────────────────
    if args.local:
        print(f"[fetch] Loading local file: {args.local}")
        with open(args.local, "r", encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = fetch_overpass(args.radius)
        # Optionally cache the raw response for debugging
        cache_path = Path(args.out) / "_overpass_cache.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False)
        print(f"[fetch] Raw response cached -> {cache_path}")

    # ── 2. Parse ───────────────────────────────────────────────────────────
    print("[parse] Extracting buildings and roads ...")
    osm = OsmParser(raw)
    buildings = osm.buildings()
    roads     = osm.roads()
    print(f"[parse] Found {len(buildings)} buildings, {len(roads)} roads.")

    # ── 3. Tile ────────────────────────────────────────────────────────────
    print(f"[tile]  Partitioning into {args.tile_size}m tiles …")
    tiler = Tiler(buildings, roads, tile_size=args.tile_size)
    written = tiler.write_tiles(args.out)
    print(f"[tile]  {tiler.tile_count()} tiles written to '{args.out}/':")
    for p in written[:20]:
        print(f"        {p}")
    if len(written) > 20:
        print(f"        ... and {len(written) - 20} more.")

    print("\nDone.")


if __name__ == "__main__":
    main()
