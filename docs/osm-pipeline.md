# OSM Pipeline

## Overview
Two-phase pipeline: **offline preprocessing** (Python) and **runtime loading** (Unity C#).

## Phase 1 – Offline Preprocessing (Python)

```
Overpass API / .osm file
        │
        ▼
  1. Fetch raw OSM data for region
  2. Partition into grid tiles (e.g. 200m × 200m)
  3. Per tile, extract:
     ├── Building footprints (polygons + height/levels)
     ├── Roads/paths (polylines + highway type)
     └── Water/park polygons (optional)
  4. Reproject lat/lon → local meters (origin = Schwedenplatz)
  5. Save tile fingerprint → MongoDB (or JSON for dev)
```

### Coordinate System
- **Projection**: UTM Zone 33N (EPSG:32633)
- **Origin**: Schwedenplatz (`48.212204°N, 16.380939°E`)
- All coordinates stored as meters relative to origin
- Unity axes: X = East, Z = North, Y = Up

### Tile Grid
- Fixed-size square tiles (default `10m × 10m`)
- Tile ID: `(i, j)` where `i = floor(x / tileSize)`, `j = floor(z / tileSize)`
- Origin tile: `(0, 0)` contains Schwedenplatz

## Phase 2 – Runtime Loading (Unity)

```
Player position
      │
      ▼
TileManager
  ├── Compute visible tile IDs from player (x, z)
  ├── Request missing tiles from server (API/WS)
  ├── Pass tile data to TileGenerator
  └── Unload distant tiles (recycle meshes)

TileGenerator
  ├── Extrude building polygons → prism meshes
  ├── Polyline → road surface quads
  ├── Combine meshes per category (1 mesh per material per tile)
  └── Instantiate as single GameObject per tile
```

### WebGL Constraints
- Generate meshes **once** on tile load, not per frame
- Combine meshes to minimize draw calls
- Pool/recycle tile GameObjects
- Avoid large dynamic allocations in Update()

---
See: [tile-format.md](tile-format.md) · [project-overview.md](project-overview.md)
