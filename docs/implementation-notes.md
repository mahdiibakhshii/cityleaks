# CityLeaks – Implementation Notes

> Deep technical reference for each source file.  
> Read `progress.md` first for overall context.

---

## Python Pipeline

### `pipeline/coords.py`

**Purpose:** Single source of truth for coordinate conversion.

**Key constants:**
```python
ORIGIN_LAT = 48.212204   # Schwedenplatz exact pin
ORIGIN_LON = 16.380939
```

**Projection chain:**
```
lat/lon (WGS-84 / EPSG:4326)
    ↓  pyproj Transformer (always_xy=True)
UTM Zone 33N (EPSG:32633)  [easting E, northing N in metres]
    ↓  subtract origin UTM coords
Local (x, z) in metres     [x = East offset, z = North offset]
```

**`always_xy=True`** is critical — pyproj 3.x defaults to authority-mandated axis order (lat/lon for EPSG:4326), which would swap coords. `always_xy=True` forces (lon, lat) input matching our usage.

**Edge cases:**
- All coordinates are absolute world metres, NOT tile-local. A building at tile (-10,-12) still has footprint vertices like `x=-92.97, z=-127.14` — these are relative to the world origin, not the tile origin.
- `tile_id_from_local` and `tile_bounds_local` are helper functions but are NOT used by Unity — Unity recomputes tile index from `worldPos / tileSize`.

---

### `pipeline/osm_parser.py`

**Purpose:** Isolates all Overpass JSON parsing. Knows nothing about tiles or projections.

**Input:** Raw Overpass API JSON dict (the `elements` array).

**Node index:** Pre-builds `{node_id: (lat, lon)}` dict on init. O(1) lookup per way.

**Height fallback chain (buildings):**
1. `height` tag (metres, accepts "15.5 m" → strips units)
2. `building:levels` × 3.0 m/floor
3. Default: 9.0 m (3 floors)

**Width fallback (roads):** Looks up `HIGHWAY_WIDTHS` dict by `highway` tag. Falls back to 4.0 m.

**Known issues:**
- Does not handle OSM `relation` elements (multi-polygon buildings). Only `way` elements are processed. Large buildings defined as relations (e.g. Stephansdom) will be **silently skipped**.
- `_parse_float` strips unit suffixes (e.g. "15 m" → 15.0) but only takes the first token. "~15" would fail and return None → triggers height fallback.

---

### `pipeline/tiler.py`

**Purpose:** Takes parsed feature lists, projects coords to local metres, assigns features to tiles, serialises JSON.

**Building placement:** Centroid of footprint → tile containing centroid. Full footprint is stored (may extend beyond tile boundaries).

**Road placement:** Each polyline **segment** (pair of consecutive points) is placed in the tile containing the segment midpoint. Consecutive segments belonging to the same OSM way are **merged** into one road entry per tile (appending new end-points).

**Winding normalisation:** Uses Shapely (if installed) or a shoelace signed-area fallback to enforce CW winding for polygon footprints (as required by tile-format spec).

**Output format:** `output/tile_i_j.json` — one file per occupied grid cell. Empty tiles are NOT written (no file = no features = Unity gets 404 → silently skipped).

**Known issues:**
- `_ensure_clockwise` with Shapely reverses ALL polygons because Shapely exterior is always CCW. This means it always reverses, regardless of OSM source winding. For simple polygons this is fine; degenerate self-intersecting polygons may produce unexpected results.
- The `bounds` field in each tile JSON is always `{}` (empty). It was planned to be populated with geographic lat/lon bounds per tile but was deferred. Unity doesn't use it.

---

### `pipeline/fetch_tiles.py`

**Purpose:** CLI entry point. Orchestrates fetch → parse → tile → write.

**Overpass mirrors (tried in order):**
1. `https://overpass-api.de/api/interpreter` (primary)
2. `https://overpass.kumi.systems/api/interpreter`
3. `https://overpass.private.coffee/api/interpreter`

**Retry logic:** Exponential backoff (1s, 2s, 4s) between mirror attempts. Raises `RuntimeError` if all fail.

**Cache:** Raw Overpass response saved to `output/_overpass_cache.json`. Re-use with:
```bash
python fetch_tiles.py --local output/_overpass_cache.json
```

**Overpass query:**
```
[out:json][timeout:60];
(
  way["building"](around:{radius},{lat},{lon});
  way["highway"](around:{radius},{lat},{lon});
);
out body;
>;
out skel qt;
```
`>` recurses to fetch all member nodes of the matched ways. `out skel qt` outputs nodes in compact form sorted by quadtile.

---

## Unity Scripts

### `Assets/Scripts/Data/TileData.cs`

**Purpose:** POCOs matching tile JSON schema. All fields public for `JsonUtility`.

**JsonUtility constraints respected:**
- All serialised types marked `[System.Serializable]`
- Lists initialised inline (`= new List<T>()`) so they're empty (not null) even if JSON omits the field
- No properties, no constructors with args, no Dictionary

**Fields NOT in the JSON** that may default:
- `BuildingData.levels` → defaults to 0 if absent from JSON (0 means "unknown", not 0 floors — handled by osm_parser with fallback height)
- `BuildingData.minHeight` → defaults to 0.0 (correct, ground level)
- `BuildingData.type` → defaults to null/empty string

---

### `Assets/Scripts/Generation/Triangulator.cs`

**Purpose:** Ear-clip triangulation for concave building roof polygons.

**Algorithm:**
1. Build index ring [0..n-1]
2. Normalise to CCW (reverse ring if signed area < 0)
3. Find convex vertices (left-turn = Cross2D > 0 for CCW polygon)
4. Check no other vertex is strictly inside the ear triangle
5. Clip ear, repeat until 3 vertices remain

**Output winding:** CCW from above (+Y) → Unity front-face from +Y → correct for roof.

**Safety cap:** `maxIter = n² + 10` to abort on degenerate polygons (self-intersecting, duplicate vertices).

**Known limitations:**
- Point-in-triangle test uses strict inequality (returns false for exactly-on-edge points). This means near-collinear vertices may cause ear-not-found → abort → incomplete roof.
- Does not handle holes in polygons (OSM multi-polygon relations with inner rings). Not needed for current data set.
- For very large polygons (>100 vertices, e.g. a large city block) the O(n³) ear search can be slow. Acceptable for current 10m tile granularity where typical footprints have 4–16 vertices.

---

### `Assets/Scripts/Generation/MeshBuilder.cs`

**Purpose:** Raw mesh geometry — building walls + roof, road ribbons, ground quads, mesh combiner.

#### Building Walls

Each wall is an independent quad (4 unique vertices, no sharing between quads → flat shading per wall).

**Vertex layout per wall:** `[bl, br, tl, tr]` (bottom-left, bottom-right, top-left, top-right relative to the edge direction)

**Triangle winding (derived mathematically):**
```
Triangle 1: (bl, br, tl) → indices (0, 1, 2)
Triangle 2: (tl, br, tr) → indices (2, 1, 3)
```
Normal = `Cross(edge_dir_normalized, Vector3.up)` = outward for CW footprints.

**Derivation:** For a CW polygon, interior is to the right of each directed edge. `Cross(dir, up)` points left (outward). Verified: `Cross((0,0,1), (0,1,0)) = (-1,0,0)` = outward for the left edge of a square at Z=0 edge walking +Z.

**RecalculateNormals call:** Called after manually setting normals. This cleans up any floating-point noise at vertices shared between adjacent walls (there are none — walls don't share vertices — but the call also validates bounds).

#### Building Roof

- Vertices placed at `y = top`
- Indices from `Triangulator.Triangulate()` directly into footprint vertex array
- No vertex duplication for the roof (shared at polygon vertices)
- Result: slightly averaged normals at polygon corners, but since all triangles face +Y anyway, this is barely noticeable

#### Road Mesh

**Vertex layout per segment:** `[al, ar, bl, br]` (a=start point, b=end point, l=left, r=right of travel direction)

**Left-perpendicular:** `perp = (-dir.z, 0, dir.x)` (90° CCW rotation of dir in XZ)

**Triangle winding (CCW from above):**
```
Triangle 1: (al, bl, br) → indices (0, 2, 3)
Triangle 2: (al, br, ar) → indices (0, 3, 1)
```

**Known issue:** No junction handling at road intersections or polyline bends. Adjacent segments create independent quads with gaps at sharp bends. Cosmetically acceptable for prototype.

**yOffset = 0.03 m:** Road surface floats 3 cm above y=0 to prevent Z-fighting with ground plane.

#### Mesh Combiner

- Uses `Mesh.CombineMeshes(instances, mergeSubMeshes: true, useMatrices: false)`
- `useMatrices: false` = input mesh vertices are already in world space → no additional transform applied
- `IndexFormat.UInt32` set on combined mesh to handle >65535 vertices for large tiles

---

### `Assets/Scripts/TileGenerator.cs`

**Purpose:** Static factory — takes `TileData`, returns a fully populated `GameObject`.

**Produced hierarchy per tile:**
```
Tile_i_j  (root at worldPositionStays=false, so position = (0,0,0))
├── Ground     (MeshFilter + MeshRenderer)
├── Buildings  (combined mesh, MeshFilter + MeshRenderer)
└── Roads      (combined mesh, MeshFilter + MeshRenderer)
```

**Draw calls per tile:** 3 (one per sub-object). In a 5-tile-radius view (11×11 = 121 tiles max), worst case = 363 draw calls. Realistically much lower as most tiles have only roads or only ground.

**Null guards:** Every layer checks for null material and non-empty feature list before generating anything.

---

### `Assets/Scripts/TileManager.cs`

**Purpose:** Lifecycle manager — decides which tiles to load/unload based on player position.

**Tile check cadence:** Every 0.25 seconds (`_checkInterval`). Not every frame — avoids string allocation per frame.

**Loading state machine per tile:**
```
(none) → _loading.Add(key) → StartCoroutine(LoadTile)
  → [success] _loaded[key] = GameObject
  → [404 / parse fail] _loaded[key] = null  (permanently skipped until restart)
```

**UnityWebRequest path construction:**
```csharp
#if UNITY_EDITOR || UNITY_STANDALONE
    "file://" + Path.Combine(Application.streamingAssetsPath, folder, filename)
#else
    Path.Combine(Application.streamingAssetsPath, folder, filename)  // WebGL: already URL
#endif
```

**ParseKey edge case:** Input like `"-10_-12"`. `key[0] == '-'` so `IndexOf('_', 1)` → finds underscore at position 3. `Substring(0,3)` = `"-10"`, `Substring(4)` = `"-12"`. Correct.

**Unload:** Compares Chebyshev distance (max of |Δi|, |Δj|) to `unloadRadius`. Tiles where either axis exceeds the radius are destroyed.

**Material fallback:** If inspector fields empty, creates URP Lit materials:
- Building: `Color(0.75, 0.70, 0.65)` — warm grey
- Road:     `Color(0.35, 0.35, 0.38)` — dark grey-blue  
- Ground:   `Color(0.48, 0.55, 0.42)` — muted green

All materials: `_Metallic=0, _Smoothness=0` for flat low-poly look.

---

### `Assets/Scripts/PlayerController.cs`

**Purpose:** Test controller — WASD movement in XZ + smooth follow camera.

**Input:** Raw `Input.GetKey()` polling (not the new Input System). Bypasses InputSystem_Actions.inputactions entirely. Works immediately in Play mode without any asset setup.

**Camera rig:** Camera is NOT a child of Player. It follows with `Vector3.Lerp` + `Quaternion.Lerp` for smooth damping.

**Camera position formula:**
```csharp
backDist = camHeight / Tan(camTilt)
camTarget = playerPos + Vector3(0, camHeight, -backDist)
```
Result: camera sits above-and-behind, angled down at `camTilt` degrees.

**Zoom:** Scroll wheel changes `_currentHeight`, clamped to `[camHeightMin, camHeightMax]`.
