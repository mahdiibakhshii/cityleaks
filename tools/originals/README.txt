Put your two source images here, then run from the project root:

    pip install pillow          (first time only)
    python tools/split_tiles.py

The script auto-detects them by name:
  - the MASK file must have "mask" in its filename   (e.g. vienna_mask.png)
  - the MAP file should have "map" in its filename    (e.g. vienna_map.png)
    (or just be the other image that isn't the mask)

Both must be the SAME resolution and pixel-aligned. The mask must have an
ALPHA channel: transparent = walkable, opaque (your buildings) = blocked.

Output goes to client/public/tiles/{map,mask}/ as tile_{col}_{row}.*, plus a
manifest.json. The script prints the exact TILES line to set in
shared/protocol.ts.

Options:
  --map-format webp     smaller map tiles (then set ASSETS.TILE_EXTENSION_MAP='.webp')
  --origin center       make the center cell (0,0) instead of the top-left
  --tile 1024           tile size (default 1024)
