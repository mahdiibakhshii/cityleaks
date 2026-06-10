# CityLeaks – Project Overview

## Concept
A multiplayer urban exploration game set in a low-poly 3D recreation of Vienna, built from real OpenStreetMap data. Players move through a WebGL-rendered city that extends dynamically as they explore.

## Tech Stack

| Layer | Technology |
|---|---|
| Game Engine | Unity 2022+ / Unity 6 (WebGL build) |
| City Data | OpenStreetMap (Overpass API) |
| Preprocessing | Python (osmium, shapely, pyproj) |
| Tile Storage | MongoDB |
| Transport | REST API / WebSocket |
| Rendering | Low-poly flat-shaded meshes, 2.5D camera |

## Architecture (High Level)

```
OSM Data ──► Python Pipeline ──► MongoDB
                                    │
                                    ▼
            Unity WebGL ◄── REST/WS Server
```

1. **Offline/Online Pipeline** – Fetches OSM data, extracts features, converts to tile fingerprints, stores in MongoDB.
2. **Server** – Serves tile data to Unity clients via API/WebSocket.
3. **Unity Runtime** – `TileManager` loads/unloads tiles around player; `TileGenerator` builds low-poly meshes from tile data.

## Origin Point
- **Schwedenplatz, Vienna** → world position `(0, 0)`
- Lat/Lon: `48.212204, 16.380939` (precise)

## OSM Attribution
This project uses data from [OpenStreetMap](https://www.openstreetmap.org/) © OpenStreetMap contributors, licensed under [ODbL](https://opendatacommons.org/licenses/odbl/).

---
See: [osm-pipeline.md](osm-pipeline.md) · [tile-format.md](tile-format.md) · [roadmap.md](roadmap.md)
