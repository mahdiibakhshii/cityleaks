# CityLeaks – Project Progress

> **Last updated:** 2026-06-08  
> **Purpose:** Master status document for agents and developers.  
> Reference this before making changes or debugging.

---

## Milestone Status

| # | Milestone | Status |
|---|---|---|
| 1 | Tile schema + Python OSM pipeline | **DONE** |
| 2 | Unity TileGenerator + TileManager prototype | **DONE** |
| 3 | Dynamic tile loading (player-driven, load/unload) | **DONE** (implemented in M2 TileManager) |
| 4 | Mesh optimization (combine, shared materials) | **DONE** (implemented in M2 MeshBuilder) |
| 5 | Server integration (MongoDB, REST/WS) | **NOT STARTED** |
| 6 | Full Donaukanal strip + water/green meshes | **NOT STARTED** |

---

## Repository Layout

```
f:\unity projects\CityLeaks\
│
├── docs/                          ← All documentation
│   ├── project-overview.md        ← Concept, stack, architecture diagram
│   ├── osm-pipeline.md            ← Offline + runtime pipeline flow
│   ├── tile-format.md             ← JSON schema reference (buildings, roads, water, greens)
│   ├── unity-setup.md             ← Step-by-step Unity scene setup guide
│   ├── roadmap.md                 ← Milestone checklist
│   ├── progress.md                ← THIS FILE
│   ├── implementation-notes.md    ← Per-file deep dive (logic, edge cases, issues)
│   └── test-expectations.md       ← What to verify, performance targets, next steps
│
├── pipeline/                      ← Python OSM preprocessing tools
│   ├── requirements.txt           ← requests, pyproj, shapely
│   ├── coords.py                  ← lat/lon → UTM → local metres
│   ├── osm_parser.py              ← Overpass JSON → RawBuilding / RawRoad structs
│   ├── tiler.py                   ← Feature → 10m tile grid → JSON files
│   ├── fetch_tiles.py             ← CLI entry point (fetch + parse + tile)
│   ├── copy_tiles_to_unity.py     ← Copy output/*.json → Unity StreamingAssets/tiles/
│   └── output/                    ← Generated tile JSON files (582 tiles, 200m radius)
│       └── _overpass_cache.json   ← Cached Overpass API response (re-use with --local)
│
└── CityLeaksUnity/                ← Unity 6 project (URP 17.4)
    └── Assets/
        ├── Scripts/
        │   ├── Data/
        │   │   └── TileData.cs            ← JSON data model (JsonUtility-compatible)
        │   ├── Generation/
        │   │   ├── Triangulator.cs        ← Ear-clip polygon triangulator
        │   │   └── MeshBuilder.cs         ← Building extrusion + road ribbon + combiner
        │   ├── TileGenerator.cs           ← Static factory: TileData → GameObject
        │   ├── TileManager.cs             ← Tile lifecycle (load/unload + coroutines)
        │   └── PlayerController.cs        ← WASD movement + follow camera
        └── StreamingAssets/
            └── tiles/                     ← 582 tile JSON files (tile_i_j.json)
```

---

## Key Parameters

| Parameter | Value | Where configured |
|---|---|---|
| World origin | `48.212204°N, 16.380939°E` | `pipeline/coords.py` → `ORIGIN_LAT/LON` |
| Tile size | `10 m × 10 m` | Pipeline default; `TileManager.tileSize` |
| Tiles fetched | **2547 tiles**, 500 m radius, **411 buildings**, **1220 roads** | `pipeline/output/` |
| Load radius | `20` tiles default (200 m visible) | `TileManager.loadRadius` |
| Unload radius | `25` tiles default | `TileManager.unloadRadius` |
| Max loads/frame | `12` (staggered, nearest first) | `TileManager.maxLoadsPerFrame` |
| Tile poll rate | 3.3 Hz (every 0.3 s) | `TileManager._checkInterval` |
| Road y-offset | 0.03 m above ground | `MeshBuilder.RoadMesh(yOffset)` |
| Building default height | 9 m (3 floors × 3 m) | `osm_parser.py` → `DEFAULT_BUILDING_HEIGHT` |
| Render pipeline | Universal Render Pipeline 17.4 | `CityLeaksUnity/Packages/manifest.json` |
| Unity version | Unity 6 | — |

---

## Data Flow (End to End)

```
Overpass API
     │  HTTP POST (Overpass QL, radius=200m around origin)
     ▼
fetch_tiles.py
     │  Calls osm_parser.py → OsmParser(raw_json)
     │  buildings: List[RawBuilding]   roads: List[RawRoad]
     │  Calls tiler.py → Tiler(buildings, roads, tile_size=10)
     │  Partitions by centroid/midpoint into (i,j) grid cells
     ▼
output/tile_i_j.json  (582 files)
     │
     ▼
copy_tiles_to_unity.py  →  StreamingAssets/tiles/
     │
     ▼
TileManager.cs (Unity, runtime)
     │  UnityWebRequest.Get("file://…/tile_i_j.json")
     │  JsonUtility.FromJson<TileData>(json)
     ▼
TileGenerator.cs
     │  MeshBuilder.BuildingMesh(b) × N  →  CombineMeshes()
     │  MeshBuilder.RoadMesh(r)     × N  →  CombineMeshes()
     │  MeshBuilder.GroundMesh()
     ▼
GameObject "Tile_i_j"
     ├── Ground     (MeshFilter + MeshRenderer, 1 draw call)
     ├── Buildings  (combined mesh,             1 draw call)
     └── Roads      (combined mesh,             1 draw call)
```

---

## Current Data Coverage

- **Area:** ~500 m radius around Schwedenplatz (Donaukanal / 1st–2nd district, up to Prater edge)
- **Tile grid:** roughly `tile_-61_-53` to `tile_64_59` (non-contiguous — only tiles with OSM features)
- **Tiles in StreamingAssets:** 2547
- **OSM features captured:** Buildings (with height/levels), roads/paths (with highway type + width)
- **NOT yet captured:** Water bodies (Donaukanal), parks, green spaces

---

## Pending Issues (Known)

1. **Winding edge cases** — Some highly non-convex OSM building footprints may fail ear-clipping (degenerate polygon abort path). Roof geometry may be missing for these. Walls will still render.
2. **Tile ID parse with negative j** — `ParseKey()` in TileManager finds underscore at `index 1+` for negative i. If i is negative and j is also negative (e.g., `"-10_-12"`), the split uses the FIRST underscore after index 0 = correct. Verified mentally; needs runtime test.
3. **Null tiles cached (intentional)** — `_loaded[key] = null` marks 404 tiles so they're never retried. If new tiles are added to StreamingAssets during a Play session, they won't load until restart.
4. **No water/green mesh generation** — `WaterData` and `GreenData` classes exist in `TileData.cs` but `TileGenerator.cs` doesn't generate meshes for them yet.
5. **Building footprints cross tile boundaries** — Buildings are assigned to the tile containing their centroid, but their footprint polygon may extend into adjacent tiles. This is visually fine but means a building might visually overlap a neighboring tile's ground quad.
6. **Material auto-creation at runtime** — If no materials are assigned in Inspector, `TileManager` creates URP Lit materials at runtime. These are not asset-backed and won't persist across sessions. For production, assign Materials in Inspector.
7. **Empty grid cells generate ground-only tiles** — Tiles with no buildings/roads still get a ground quad rendered. This is intentional (seamless ground plane) but adds draw calls for fully empty tiles.
