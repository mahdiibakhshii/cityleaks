"""
copy_tiles_to_unity.py – Copy pipeline output tiles into Unity StreamingAssets.

Run this after fetch_tiles.py.  The script copies all tile_*.json files
from the pipeline output folder into the Unity project's StreamingAssets/tiles/
directory, which is where TileManager.cs looks for tile data.

Usage:
    python copy_tiles_to_unity.py [--src output] [--dst ../CityLeaksUnity/Assets/StreamingAssets/tiles]
"""
import argparse
import shutil
import os
from pathlib import Path

UNITY_TILES_DEFAULT = "../CityLeaksUnity/Assets/StreamingAssets/tiles"

def main():
    parser = argparse.ArgumentParser(description="Copy tile JSON files to Unity StreamingAssets")
    parser.add_argument("--src", default="output",           help="Pipeline output directory")
    parser.add_argument("--dst", default=UNITY_TILES_DEFAULT, help="Unity StreamingAssets/tiles path")
    args = parser.parse_args()

    src = Path(args.src)
    dst = Path(args.dst)

    if not src.exists():
        print(f"[error] Source directory not found: {src}")
        print("        Run fetch_tiles.py first.")
        return

    dst.mkdir(parents=True, exist_ok=True)
    print(f"[copy] {src} -> {dst}")

    copied = 0
    skipped = 0
    for f in sorted(src.glob("tile_*.json")):
        target = dst / f.name
        shutil.copy2(f, target)
        copied += 1

    print(f"[copy] {copied} tiles copied, {skipped} skipped.")
    print("       Open/refresh Unity to detect the new files in StreamingAssets.")

if __name__ == "__main__":
    main()
