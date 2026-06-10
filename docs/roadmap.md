# Roadmap

## Milestone 1 – Tile Schema & First Tile *(done)*
- [x] Define docs structure
- [x] Draft `tile-format.md` with JSON schema (10m tiles, origin 48.212204, 16.380939)
- [x] Python pipeline: `fetch_tiles.py` + `osm_parser.py` + `tiler.py` + `coords.py`
- [x] Tested: 200m radius → 582 tiles, 66 buildings, 271 roads extracted

## Milestone 2 – Unity Prototype (Hardcoded Tile) *(done)*
- [x] `TileData.cs` – JSON data model (JsonUtility-compatible)
- [x] `Triangulator.cs` – ear-clip polygon triangulation for building roofs
- [x] `MeshBuilder.cs` – building extrusion + road ribbon + mesh combiner
- [x] `TileGenerator.cs` – static factory: TileData → GameObject (3 draw calls/tile)
- [x] `TileManager.cs` – UnityWebRequest-based loading, load/unload lifecycle
- [x] `PlayerController.cs` – WASD + tilted follow-camera + scroll zoom
- [x] 582 tiles copied to StreamingAssets/tiles/
- [x] `docs/unity-setup.md` – scene setup & troubleshooting guide

## Milestone 3 – Dynamic Tile Loading
- [ ] `TileManager` computes visible tiles from player position
- [ ] Load/unload tiles as player moves
- [ ] Tile recycling / object pooling

## Milestone 4 – Mesh Optimization
- [ ] Combine meshes per category per tile
- [ ] Shared material instances
- [ ] LOD or culling for distant tiles
- [ ] WebGL performance profiling

## Milestone 5 – Server Integration
- [ ] Python/Node server serving tiles from MongoDB
- [ ] On-demand Overpass fetch for unknown tiles
- [ ] Cache layer
- [ ] WebSocket for real-time tile push

## Milestone 6 – Full Donaukanal Strip
- [ ] Pre-fetch tiles for full Donaukanal area
- [ ] Water surface mesh generation
- [ ] Park/green space polygons
- [ ] Props/trees from OSM tags

## Future
- [ ] Multiplayer (player position streaming)
- [ ] Interaction system
- [ ] Dynamic events / "leaks"

---
See: [project-overview.md](project-overview.md)
