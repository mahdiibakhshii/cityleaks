# Unity Scene Setup – Milestone 2

## Prerequisites
- Unity 6 (URP 17.x) project open at `CityLeaksUnity/`
- Tiles already in `Assets/StreamingAssets/tiles/` (run `copy_tiles_to_unity.py`)

## One-time Scene Setup

### 1. Open the sample scene
`File → Open Scene → Assets/Scenes/SampleScene`

### 2. Clear the default objects
Delete the default Cube (if any). Keep the **Main Camera** and **Directional Light**.

### 3. Create the Player GameObject
- `Hierarchy → + → Create Empty` → name it **Player**
- Set Transform Position to `(0, 0, 0)`
- Add Component → `PlayerController` (Scripts)
- Leave *Cam* field empty (auto-finds Camera.main)

### 4. Create the TileManager GameObject
- `Hierarchy → + → Create Empty` → name it **TileManager**
- Add Component → `TileManager` (Scripts)
- In the Inspector:
  | Field | Value | Notes |
  |---|---|---|
  | Player | drag the **Player** GameObject here | Required |
  | Tile Size | `10` | Must match pipeline `--tile-size` |
  | Load Radius | `20` | 200 m visible in each direction |
  | Unload Radius | `25` | Keep > Load Radius |
  | Max Loads Per Frame | `12` | Stagger to avoid frame spikes |
  | Tiles Folder | `tiles` | StreamingAssets subfolder |
  | Building Material | *(leave empty for auto flat-grey)* | Or assign a URP Lit material |
  | Road Material | *(leave empty for auto flat-dark)* | |
  | Ground Material | *(leave empty for auto flat-green)* | |

### 5. Set the Main Camera tag
- Select **Main Camera** → Inspector → Tag → `MainCamera`
  (usually set by default)

### 6. Set URP Renderer to Lit
- Edit → Project Settings → Graphics → check URP Asset is assigned

### 7. Press Play
The player spawns at world origin (Schwedenplatz).  
Use **WASD** or **Arrow keys** to move.  
Mouse scroll zooms.  
Tiles around you load automatically (≤ 1-2 seconds each).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Black screen | Make sure Directional Light exists and URP asset is configured |
| No tiles loading | Check `Assets/StreamingAssets/tiles/` contains `tile_*.json` files |
| `TileManager: No player assigned` warning | Drag Player GO into the Player field |
| Meshes inside-out | Likely a winding edge case; call `RecalculateNormals` on the mesh or flip via the material's Cull mode |
| Very slow in Play mode | Reduce Load Radius to 2–3; increase _checkInterval in TileManager |

---

## Controls Reference

| Key | Action |
|---|---|
| W / A / S / D | Move North / West / South / East |
| Arrow keys | Same as WASD |
| Scroll wheel | Zoom camera in / out |

---
See: [osm-pipeline.md](osm-pipeline.md) · [roadmap.md](roadmap.md)
