#!/usr/bin/env python3
"""
Split a large orthographic map image and its matching collision mask into
1024x1024 game tiles named tile_{col}_{row}.{ext}.

The map and mask MUST be the same resolution and pixel-aligned. If the source
size isn't an exact multiple of the tile size, edge tiles are padded out to a
full tile (map -> black, mask -> opaque = BLOCKED) so the real pixels stay
exactly aligned and players can't walk off the map.

Usage
-----
Drop your two images in tools/originals/ (any name containing "map" / "mask"),
then run:

    pip install pillow
    python tools/split_tiles.py

Or be explicit:

    python tools/split_tiles.py --map originals/vienna.png --mask originals/vienna_mask.png \
        --out client/public/tiles --tile 1024 --map-format webp

Outputs:
  <out>/map/tile_{col}_{row}.{png|webp}
  <out>/mask/tile_{col}_{row}.png
  <out>/manifest.json           (tile list + dimensions, for tooling)

It also prints the exact values to set in shared/protocol.ts.
"""
from __future__ import annotations
import argparse
import json
import math
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required. Install it with:  pip install pillow")

# Allow very large images (16667x16667 ~ 278 MP exceeds Pillow's default guard).
Image.MAX_IMAGE_PIXELS = None

IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
ROOT = Path(__file__).resolve().parent.parent


def find_source(input_dir: Path, keyword: str, avoid: str | None = None) -> Path | None:
    """Find an image in input_dir whose stem contains `keyword` (and not `avoid`)."""
    if not input_dir.is_dir():
        return None
    for p in sorted(input_dir.iterdir()):
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        stem = p.stem.lower()
        if keyword in stem and (avoid is None or avoid not in stem):
            return p
    return None


def has_alpha(img: Image.Image) -> bool:
    return img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)


def split_image(
    src: Path,
    out_dir: Path,
    tile: int,
    *,
    rgba: bool,
    pad_fill,
    ext: str,
    origin_col: int,
    origin_row: int,
    save_kwargs: dict,
    clean: bool,
) -> tuple[list[dict], int, int, int, int]:
    """Split one image into tiles. Returns (tiles, width, height, cols, rows)."""
    print(f"\nOpening {src} ...")
    img = Image.open(src)
    img = img.convert("RGBA" if rgba else "RGB")
    w, h = img.size
    cols = math.ceil(w / tile)
    rows = math.ceil(h / tile)
    print(f"  {w}x{h}px  ->  {cols}x{rows} tiles of {tile}px (origin col/row = {origin_col},{origin_row})")

    if clean and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    produced: list[dict] = []
    total = cols * rows
    n = 0
    for r in range(rows):
        for c in range(cols):
            left, top = c * tile, r * tile
            right, bottom = min(left + tile, w), min(top + tile, h)
            crop = img.crop((left, top, right, bottom))
            if crop.size == (tile, tile):
                tile_img = crop
            else:
                # Edge tile: paste real pixels onto a full padded tile.
                tile_img = Image.new(img.mode, (tile, tile), pad_fill)
                tile_img.paste(crop, (0, 0))

            col = c - origin_col
            row = r - origin_row
            tile_img.save(out_dir / f"tile_{col}_{row}{ext}", **save_kwargs)
            produced.append({"col": col, "row": row})
            n += 1
        print(f"  row {r + 1}/{rows} done ({n}/{total} tiles)")

    img.close()
    return produced, w, h, cols, rows


def make_overview(map_path, out_path, full_w, full_h, src_w, src_h, target, quality):
    """Build a downscaled whole-map image for the monitor view.

    Padded to the FULL tile-grid bounds (full_w x full_h) so it lines up 1:1
    with MAP_BOUNDS — the real pixels go top-left, the leftover edge is black.
    The monitor stretches this across the whole map, so the path overlay (which
    spans MAP_BOUNDS) registers exactly on top of it.
    """
    print(f"\nBuilding overview ({target}px) from {map_path} ...")
    scale = target / max(full_w, full_h)
    ov_w, ov_h = max(1, round(full_w * scale)), max(1, round(full_h * scale))
    real_w, real_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
    canvas = Image.new("RGB", (ov_w, ov_h), (0, 0, 0))
    with Image.open(map_path) as img:
        resized = img.convert("RGB").resize((real_w, real_h), Image.LANCZOS)
    canvas.paste(resized, (0, 0))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, quality=quality, method=6)
    print(f"  wrote {out_path}  ({ov_w}x{ov_h}px, covers full {full_w}x{full_h} bounds)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Split map + mask into 1024px game tiles.")
    ap.add_argument("--input", default=str(ROOT / "tools" / "originals"),
                    help="Folder to auto-find map/mask images (default: tools/originals)")
    ap.add_argument("--map", help="Explicit path to the map image (overrides --input)")
    ap.add_argument("--mask", help="Explicit path to the mask image (overrides --input)")
    ap.add_argument("--out", default=str(ROOT / "client" / "public" / "tiles"),
                    help="Output tiles root (default: client/public/tiles)")
    ap.add_argument("--tile", type=int, default=1024, help="Tile size in pixels (default 1024)")
    ap.add_argument("--map-format", choices=["png", "webp"], default="webp",
                    help="Map tile format (default webp). webp is much smaller for photos.")
    ap.add_argument("--map-quality", type=int, default=82, help="WebP quality for map tiles (1-100)")
    ap.add_argument("--origin", choices=["topleft", "center"], default="topleft",
                    help="Which grid cell is (0,0): topleft (default) or center of the image.")
    ap.add_argument("--no-clean", action="store_true", help="Don't wipe the output dirs first.")
    ap.add_argument("--overview-size", type=int, default=2048,
                    help="Longest edge (px) of the whole-map overview image (default 2048).")
    ap.add_argument("--overview-quality", type=int, default=85, help="WebP quality for the overview.")
    ap.add_argument("--overview-out", help="Overview output path (default: <public>/map_overview.webp)")
    ap.add_argument("--overview-map",
                    help="Alternate image to render the overview FROM (e.g. a stylized / lower-res "
                         "version of the SAME map extent). Bounds still come from the real map, so "
                         "the path overlay stays aligned regardless of this image's resolution.")
    ap.add_argument("--no-overview", action="store_true", help="Skip building the overview image.")
    ap.add_argument("--overview-only", action="store_true",
                    help="Only build the overview image (skip tile splitting; mask not needed).")
    args = ap.parse_args()

    overview_only = args.overview_only
    input_dir = Path(args.input)
    map_path = Path(args.map) if args.map else find_source(input_dir, "map", avoid="mask")
    mask_path = Path(args.mask) if args.mask else find_source(input_dir, "mask")

    if not map_path:
        input_dir.mkdir(parents=True, exist_ok=True)
        sys.exit(
            f"Could not find a map image.\n"
            f"  Put your map image in: {input_dir}  (filename should contain 'map')\n"
            f"  Or pass --map explicitly."
        )
    if not map_path.exists():
        sys.exit(f"Map not found: {map_path}")
    print(f"Map  : {map_path}")

    if not overview_only:
        if not mask_path:
            input_dir.mkdir(parents=True, exist_ok=True)
            sys.exit(
                f"Could not find a mask image.\n"
                f"  Put your mask image in: {input_dir}  (filename should contain 'mask')\n"
                f"  Or pass --mask explicitly. (Use --overview-only to skip the mask.)"
            )
        if not mask_path.exists():
            sys.exit(f"Mask not found: {mask_path}")
        print(f"Mask : {mask_path}")

    # Read source size (and, when splitting, verify map/mask match + alpha).
    if overview_only:
        with Image.open(map_path) as mi:
            gw, gh = mi.size
    else:
        with Image.open(map_path) as mi, Image.open(mask_path) as ki:
            if mi.size != ki.size:
                sys.exit(f"Map size {mi.size} != mask size {ki.size}. They must be identical.")
            mask_has_alpha = has_alpha(ki)
            gw, gh = mi.size
        if not mask_has_alpha:
            print("  WARNING: the mask has no alpha channel. Collision uses ALPHA "
                  "(transparent = walkable, opaque = blocked). Without alpha every "
                  "pixel will read as blocked. Re-export the mask with transparency.")

    tile = args.tile
    cols = math.ceil(gw / tile)
    rows = math.ceil(gh / tile)
    origin_col = cols // 2 if args.origin == "center" else 0
    origin_row = rows // 2 if args.origin == "center" else 0
    full_w, full_h = cols * tile, rows * tile  # padded bounds = what the game uses

    out_root = Path(args.out)
    clean = not args.no_clean
    public_dir = out_root.parent
    overview_out = Path(args.overview_out) if args.overview_out else public_dir / "map_overview.webp"

    # Pixels for the overview come from --overview-map if given, else the real
    # map. Bounds (full_w/full_h, gw/gh) always come from the real map above, so
    # a different-resolution overview image still aligns with the path overlay.
    overview_src = Path(args.overview_map) if args.overview_map else map_path
    if not overview_src.exists():
        sys.exit(f"Overview image not found: {overview_src}")

    # Overview-only: just build the downscaled whole-map image and stop.
    if overview_only:
        make_overview(overview_src, overview_out, full_w, full_h, gw, gh,
                      args.overview_size, args.overview_quality)
        print("\nDone (overview only).")
        return

    # ── Map tiles ──
    map_ext = ".webp" if args.map_format == "webp" else ".png"
    map_save = {"quality": args.map_quality, "method": 5} if args.map_format == "webp" else {"optimize": False}
    map_tiles, _, _, _, _ = split_image(
        map_path, out_root / "map", tile,
        rgba=False, pad_fill=(0, 0, 0), ext=map_ext,
        origin_col=origin_col, origin_row=origin_row, save_kwargs=map_save, clean=clean,
    )

    # ── Mask tiles (PNG, alpha; padding is opaque = blocked) ──
    mask_tiles, _, _, _, _ = split_image(
        mask_path, out_root / "mask", tile,
        rgba=True, pad_fill=(0, 0, 0, 255), ext=".png",
        origin_col=origin_col, origin_row=origin_row, save_kwargs={"optimize": True}, clean=clean,
    )

    # ── Manifest ──
    manifest = {
        "tile": tile,
        "sourceWidth": gw,
        "sourceHeight": gh,
        "cols": cols,
        "rows": rows,
        "originCol": origin_col,
        "originRow": origin_row,
        "mapFormat": map_ext,
        "tiles": map_tiles,
    }
    out_root.mkdir(parents=True, exist_ok=True)
    (out_root / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # ── Overview image (downscaled whole-map view for the monitor page) ──
    if not args.no_overview:
        make_overview(overview_src, overview_out, full_w, full_h, gw, gh,
                      args.overview_size, args.overview_quality)

    rect_call = f"rectTiles({cols}, {rows}" + (f", {origin_col}, {origin_row})" if (origin_col or origin_row) else ")")
    print("\n" + "=" * 64)
    print(f"Done: {len(map_tiles)} map + {len(mask_tiles)} mask tiles ({cols}x{rows} grid).")
    print(f"Output: {out_root}")
    print("\nSet these in shared/protocol.ts -> MAP:")
    print(f"    TILE_WIDTH_PX: {tile},")
    print(f"    TILE_HEIGHT_PX: {tile},")
    print(f"    TILES: {rect_call},")
    if map_ext == ".webp":
        print("\nAnd in client/src/config.ts -> ASSETS:  TILE_EXTENSION_MAP: '.webp'")
    print("=" * 64)


if __name__ == "__main__":
    main()
