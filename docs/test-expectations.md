# CityLeaks – Test Expectations & Next Steps

> Reference for verifying the prototype is working, diagnosing failures,  
> and planning the next development phase.

---

## 1. Pipeline Test (Python)

### How to run
```bash
cd pipeline
python fetch_tiles.py --radius 200 --tile-size 10 --out output
python copy_tiles_to_unity.py
```

### Expected output
```
[fetch] Querying Overpass API (radius=200.0m) ...
[fetch] Received 1876 elements from https://overpass-api.de/api/interpreter
[parse] Extracting buildings and roads ...
[parse] Found 66 buildings, 271 roads.
[tile]  Partitioning into 10.0m tiles ...
[tile]  582 tiles written to 'output/':
        output\tile_-34_-3.json
        ...
Done.
```

### Validation checks
| Check | Expected | Tool |
|---|---|---|
| Element count | ≥ 1800 elements | `fetch_tiles.py` output |
| Buildings | ≥ 60 | `[parse]` line |
| Roads | ≥ 200 | `[parse]` line |
| Tile count | ≥ 550 | `[tile]` line |
| tile_0_0.json exists | Yes (road data at origin) | `ls output/tile_0_0.json` |
| A building tile | e.g. `tile_-10_-12.json` has `"buildings": [...]` | `cat output/tile_-10_-12.json` |

### Common failures
| Error | Cause | Fix |
|---|---|---|
| `504 Gateway Timeout` | Overpass server busy | Script auto-retries 3 mirrors; wait 30s and retry |
| `UnicodeEncodeError` in terminal | Windows cp1252 console | Pipe to file: `python fetch_tiles.py > out.txt 2>&1` |
| `ModuleNotFoundError: pyproj` | Missing deps | `python -m pip install -r requirements.txt` |
| 0 buildings found | Overpass query returned no ways | Check `_overpass_cache.json` has `"ways"` in elements |

---

## 2. Unity Runtime Test

### Setup checklist
- [ ] Unity 6 project open at `CityLeaksUnity/`
- [ ] `Assets/StreamingAssets/tiles/` contains 582 `.json` files
- [ ] Scene has **Player** empty + `PlayerController` component
- [ ] Scene has **TileManager** empty + `TileManager` component, Player field assigned
- [ ] Main Camera has Tag = `MainCamera`
- [ ] URP asset assigned in Project Settings → Graphics

### What you should see on Play
| Time | Event |
|---|---|
| 0 s | Player spawns at (0, 0, 0). TileManager.Start() fires, loads tiles around origin. |
| 0–2 s | First coroutines complete. Ground quads appear (green). Roads appear (dark). |
| 2–5 s | Building meshes appear (grey prisms). Tile_-10_-12 has an 11-floor apartment block. |
| Move | Walk WASD → new tiles load 0.5–1.5 s after crossing tile boundary. |
| Walk away | After moving ~70 m, origin tiles unload (destroyed). |

### Pass/fail criteria

| Criterion | Pass | Fail |
|---|---|---|
| Ground appears | Flat green quad at y=0 around origin | Black void / no mesh |
| Roads appear | Dark flat ribbons on ground | Missing / inside-out |
| Buildings appear | Grey prisms at correct positions | Missing / floating / faces-in |
| Camera follows player | Smooth tilted follow | Camera static / no camera found |
| Tiles load on movement | New tiles appear 1–2 s after entering new area | Infinite load / error spam |
| Distant tiles unload | Console shows no "Destroy" errors | Memory grows unbounded |

---

## 3. Expected Performance

### Mesh geometry (per 10m tile)
| Category | Typical vertex count | Draw calls |
|---|---|---|
| Ground | 4 verts | 1 |
| Buildings (combined) | 50–400 verts | 1 |
| Roads (combined) | 20–200 verts | 1 |
| **Total per tile** | **~300 avg** | **3** |

### Tile counts by radius (loadRadius × 2 + 1)²
| loadRadius | Max tiles in view | Max draw calls | Estimated MB RAM |
|---|---|---|---|
| 3 | 49 | 147 | ~5 MB |
| 5 | 121 | 363 | ~12 MB |
| 7 | 225 | 675 | ~22 MB |
| 10 | 441 | 1323 | ~42 MB |

> Note: Most tiles are sparse (roads only or just ground) — real draw call count is 30–50% of theoretical maximum.

### Target FPS (WebGL)
| Scenario | Target | Acceptable |
|---|---|---|
| Standing still, loadRadius=5 | 60 fps | ≥ 30 fps |
| Walking, continuous tile loading | 45 fps | ≥ 20 fps |
| Large open area, loadRadius=7 | 45 fps | ≥ 25 fps |

> WebGL renders single-threaded. Tile generation (mesh building) happens on the main thread inside a coroutine — it yields between tiles to avoid frame hitches.  
> **If you get hitches:** Reduce `loadRadius` or add a `yield return null` inside the generation loop.

### Memory budget (WebGL)
| Item | Estimate |
|---|---|
| Tile JSON files (582 × ~800 B avg) | ~465 KB disk |
| Loaded tile meshes (loadRadius=5, 121 tiles) | ~12 MB GPU + ~4 MB CPU |
| Unloaded tiles (destroyed) | ~0 (GC collected) |
| Total reasonable budget | < 100 MB for 200m coverage |

---

## 4. Known Issues & Debugging Guide

### Issue: Black or missing buildings
**Cause:** Winding order incorrect → normals pointing inward → backface culled.  
**Debug:** In Unity, `Edit → Frame Debugger` → check if draw calls exist. If they do, use `Scene View → Shading Mode → Wireframe` to see if mesh exists but normals are inverted.  
**Fix options:**
1. In Material Inspector → set Render Face = "Both" (URP Lit: add `Cull Off` to shader or use `DoubleSided` material)
2. OR: call `mesh.RecalculateNormals()` after flipping triangle order in `MeshBuilder.cs`

### Issue: Roads appear as black lines instead of ribbons
**Cause:** Road width is 0 or very small, or points are duplicate (same position → degenerate quad).  
**Debug:** Log `r.width` and `(pb-pa).sqrMagnitude` in `MeshBuilder.RoadMesh`.  
**Fix:** Minimum width guard already in place (`halfW = width/2`). Check `osm_parser.py` HIGHWAY_WIDTHS dict has the right highway type.

### Issue: Tiles not loading (no mesh appears)
**Cause options:** (a) File path wrong, (b) JSON parse error, (c) TileManager player reference missing.  
**Debug steps:**
1. Check Console for `[TileManager]` warning about no player
2. Enable verbose logging: add `Debug.Log(url)` before `UnityWebRequest.Get(url)` in `LoadTile`
3. Paste that URL in a browser — if it 404s, the file path is wrong
4. If file loads but no mesh: add `Debug.Log(data.buildings.Count)` after `FromJson`

### Issue: Tile parse returns empty buildings list
**Cause:** `JsonUtility.FromJson` silently fails on malformed JSON or mismatched field names.  
**Debug:** Log `req.downloadHandler.text.Substring(0, 200)` to verify JSON content.  
**Fix:** Ensure JSON field names exactly match `TileData.cs` field names (case-sensitive).

### Issue: ParseKey crashes on tile ID
**Symptom:** `FormatException` or `IndexOutOfRangeException` in `TileManager.ParseKey`.  
**Cause:** Tile ID format changed, or a null key was inserted into `_loaded`.  
**Fix:** Add try/catch in ParseKey and skip malformed keys. Never insert null keys (fixed: we insert null *values* for 404 tiles, keys are always valid strings).

### Issue: Ear-clipping produces no roof (empty/flat building top)
**Cause:** Degenerate footprint (collinear vertices, duplicate vertices, self-intersection).  
**Debug:** Log `roofIdx.Length` after triangulation. If 0 → degenerate polygon.  
**Workaround:** Fall back to fan triangulation from centroid for polygons where ear-clip fails.

---

## 5. Next Steps (Milestone 3–6)

### Priority 1 – Fix before proceeding
- [ ] **Test winding in Unity Play mode** — verify buildings are not inside-out. If they are, flip triangle winding in `MeshBuilder.BuildingMesh` walls.
- [ ] **Verify tile-0_0 loads** — origin should show a footway road segment.
- [ ] **Verify a building tile** — walk to approximate position of `tile_-10_-12` (x=-100m, z=-120m) and confirm 11-floor apartment appears.

### Priority 2 – Milestone 5 (Server)
- [ ] Build a lightweight Node.js or Python FastAPI server
- [ ] Serve tile JSON from MongoDB (import pipeline output as seed data)
- [ ] Add on-demand Overpass fetch when a requested tile is missing from DB
- [ ] Unity: replace `file://` URL with `http://localhost:PORT/tiles/i/j`
- [ ] Add WebSocket for future real-time push

### Priority 3 – Milestone 6 (Full Donaukanal)
- [ ] Increase fetch radius to 1000–2000 m
- [ ] Add water polygon extraction (`waterway=canal`, `natural=water`) to `osm_parser.py`
- [ ] Add green space extraction (`leisure=park`, `landuse=grass`) to `osm_parser.py`
- [ ] Implement `MeshBuilder.WaterMesh()` and `MeshBuilder.GreenMesh()` (flat polygons, ear-clip)
- [ ] Implement `TileGenerator.CreateTileObject()` water/green layers

### Priority 4 – Optimization
- [ ] **Main-thread mesh generation** currently happens synchronously inside coroutine. For large tiles, consider splitting across frames with `yield return null` between buildings.
- [ ] **Object pooling:** Instead of `Destroy()` + `new GameObject()`, recycle tile roots.
- [ ] **LOD:** Very distant tiles (near unloadRadius) could use simplified mesh or just ground quad.
- [ ] **Frustum culling:** Only load tiles in camera frustum, not full circle.

### Priority 5 – Multiplayer / Interaction
- [ ] Player position streaming via WebSocket
- [ ] Server-side player list → ghost avatar prefabs
- [ ] Interaction colliders on buildings (raycast from camera)
- [ ] "CityLeaks" event system (server pushes events to clients)

---

## 6. Useful One-Liners

```bash
# Re-fetch with cached data (no network)
python fetch_tiles.py --local output/_overpass_cache.json

# Check a specific tile
python -c "import json; d=json.load(open('output/tile_-10_-12.json')); print(d['buildings'][0])"

# Count tiles with buildings
python -c "
import json, os
n = sum(1 for f in os.listdir('output') if f.endswith('.json') and not f.startswith('_')
        and json.load(open(f'output/{f}'))['buildings'])
print(n, 'tiles with buildings')
"

# Fetch larger area (500m radius)
python fetch_tiles.py --radius 500 --out output_500m
python copy_tiles_to_unity.py --src output_500m
```
