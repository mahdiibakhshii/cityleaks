# Tile Format Specification

## Overview
Each tile is a JSON document representing a `10m × 10m` region of the city. Coordinates are in **meters relative to origin** (Schwedenplatz: `48.212204, 16.380939`).

## Tile ID Convention
- `tileId`: `"i_j"` (e.g. `"0_0"`, `"-1_2"`)
- `i = floor(x / 10)`, `j = floor(z / 10)`

## JSON Schema

```jsonc
{
  // ── Tile Metadata ──
  "tileId": "0_0",
  "tileSize": 10,                      // meters per side
  "origin": { "x": 0.0, "z": 0.0 },   // world-space corner (SW) of this tile
  "bounds": {
    "minLat": 48.2108, "minLon": 16.3745,
    "maxLat": 48.2126, "maxLon": 16.3789
  },
  "version": 1,

  // ── Buildings ──
  "buildings": [
    {
      "id": "osm_way_12345678",
      "footprint": [                    // polygon vertices (meters, local)
        { "x": 12.5, "z": 34.2 },
        { "x": 18.0, "z": 34.2 },
        { "x": 18.0, "z": 40.1 },
        { "x": 12.5, "z": 40.1 }
      ],
      "height": 15.0,                  // meters (from OSM `height` or `building:levels * 3`)
      "levels": 5,                      // from `building:levels` tag, nullable
      "type": "residential",           // from `building` tag value
      "minHeight": 0.0                 // for buildings on stilts / arcades (optional)
    }
  ],

  // ── Roads ──
  "roads": [
    {
      "id": "osm_way_87654321",
      "points": [                       // polyline vertices (meters, local)
        { "x": 0.0, "z": 50.0 },
        { "x": 45.0, "z": 50.0 },
        { "x": 100.0, "z": 55.0 }
      ],
      "highway": "residential",        // OSM highway tag value
      "width": 6.0,                    // estimated width in meters
      "name": "Taborstraße"            // optional display name
    }
  ],

  // ── Water (optional, future) ──
  "water": [
    {
      "id": "osm_way_11111111",
      "polygon": [
        { "x": 0.0, "z": 0.0 },
        { "x": 200.0, "z": 0.0 },
        { "x": 200.0, "z": 30.0 },
        { "x": 0.0, "z": 30.0 }
      ],
      "type": "river"                  // river | canal | pond | basin
    }
  ],

  // ── Green Spaces (optional, future) ──
  "greens": [
    {
      "id": "osm_way_22222222",
      "polygon": [
        { "x": 50.0, "z": 120.0 },
        { "x": 80.0, "z": 120.0 },
        { "x": 80.0, "z": 150.0 },
        { "x": 50.0, "z": 150.0 }
      ],
      "type": "park"                   // park | garden | grass | forest
    }
  ]
}
```

## Field Reference

### Tile Metadata

| Field | Type | Required | Description |
|---|---|---|---|
| `tileId` | string | ✅ | Grid index `"i_j"` |
| `tileSize` | float | ✅ | Side length in meters (default 200) |
| `origin` | `{x,z}` | ✅ | SW corner in local meters |
| `bounds` | `{minLat,minLon,maxLat,maxLon}` | ✅ | Geographic bounds for re-fetching |
| `version` | int | ✅ | Schema version |

### Building

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | OSM element ID |
| `footprint` | `[{x,z}]` | ✅ | Closed polygon (CW winding, last≠first) |
| `height` | float | ✅ | Total height in meters |
| `levels` | int | ❌ | Number of floors |
| `type` | string | ❌ | OSM `building` tag value |
| `minHeight` | float | ❌ | Base elevation (default 0) |

### Road

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | OSM element ID |
| `points` | `[{x,z}]` | ✅ | Ordered polyline vertices |
| `highway` | string | ✅ | OSM `highway` tag value |
| `width` | float | ✅ | Estimated road width in meters |
| `name` | string | ❌ | Street name |

## Width Estimation by Highway Type

| `highway` value | Default width (m) |
|---|---|
| `motorway` | 14 |
| `trunk` | 12 |
| `primary` | 10 |
| `secondary` | 8 |
| `tertiary` | 7 |
| `residential` | 6 |
| `service` | 4 |
| `footway` / `path` | 2 |
| `cycleway` | 2.5 |
| `pedestrian` | 5 |
| other | 4 |

## Design Notes
- Polygon winding: **clockwise** when viewed from above (Y-up)
- Building footprints are **closed** — last vertex connects back to first; do NOT duplicate the first vertex
- Road polylines are **open** — they don't loop back
- All coordinates are in **meters from world origin** (not tile-local), so meshes can be placed at world `(0,0,0)` without offset
- Heights default to `3.0 * levels` if `height` tag is absent; if both absent, default `9.0m` (3 floors)

---
See: [osm-pipeline.md](osm-pipeline.md) · [project-overview.md](project-overview.md)
