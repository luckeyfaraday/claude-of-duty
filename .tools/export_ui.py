#!/usr/bin/env python3
"""Export the T6 frontend art the browser menu draws with.

`zone/all/ui_mp.ff` carries the whole Black Ops II multiplayer frontend: 525
images and 584 materials. The menu only needs a dozen of them, so this dumps
the zone once and converts just that subset to PNG under `export/web/ui/`.

The `.menu` layout definitions in the same zone are deliberately not used --
the Unlinker lists them but writes nothing for T6 menudefs, so the browser
rebuilds the layout itself and takes only the art from here.
"""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = f"{ROOT}/.tools"
OUT = f"{ROOT}/export/web/ui"
ZONE = f"{ROOT}/zone/all/ui_mp.ff"

# Asset name -> output size, or None to keep the authored resolution. The
# originals are power-of-two and mostly small; only the fog strip is worth
# shrinking, since it tiles and scrolls and never shows its detail.
ASSETS = {
    # Four layers of the original `menu,main`, in the order ui_mp.zone links
    # them: backdrop, scrolling fog, glow, logo plate.
    "menu_mp_background_main2": None,
    "bg_fogscrollthin": (1024, 256),
    "menu_mp_background_glow": None,
    "menu_mp_background_logo": None,
    # Panel and button chrome. These are white-on-alpha tint targets -- the
    # game recolours them at runtime, and so does the browser menu.
    "menu_mp_lobby_frame_outer": None,
    "menu_mp_lobby_frame_line": None,
    "menu_button_backing": None,
    "menu_button_backing_highlight": None,
    "menu_select_highlight": None,
    # The map card, for the title screen.
    "menu_mp_map_select_hijacked_final": None,
}


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(f"{os.path.basename(args[0])} failed ({result.returncode})")
    return result.stdout


def dump_zone(destination):
    """Unlink ui_mp.ff, writing its images as DDS into `destination`."""
    run(
        [
            f"{TOOLS}/Unlinker.exe",
            "--include-assets", "image,material",
            "--image-format", "DDS",
            "-o", destination,
            ZONE,
        ],
        cwd=TOOLS,
    )
    images = f"{destination}/images"
    if not os.path.isdir(images):
        raise SystemExit(f"Unlinker wrote no images to {images}")
    return images


def convert(sources, size):
    """Convert a batch of DDS files to PNG in OUT, optionally resampling.

    R8G8B8A8_UNORM is required: without it WIC refuses the BC5 two-channel
    normal maps, and several frontend plates are BC5.
    """
    args = [f"{TOOLS}/texconv.exe", "-ft", "png", "-m", "1", "-f", "R8G8B8A8_UNORM", "-y", "-o", OUT]
    if size:
        args += ["-w", str(size[0]), "-h", str(size[1])]
    run(args + sources)


def main():
    for tool in ("Unlinker.exe", "texconv.exe"):
        if not os.path.isfile(f"{TOOLS}/{tool}"):
            raise SystemExit(f"missing {TOOLS}/{tool}")
    if not os.path.isfile(ZONE):
        raise SystemExit(f"missing {ZONE}")

    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ui_mp_") as scratch:
        images = dump_zone(scratch)

        # Group by output size so the common case is a single texconv call.
        batches = {}
        for name, size in ASSETS.items():
            source = f"{images}/{name}.dds"
            if not os.path.isfile(source):
                raise SystemExit(f"{name} is not in {os.path.basename(ZONE)}")
            batches.setdefault(size, []).append(source)
        for size, sources in batches.items():
            convert(sources, size)

    written = 0
    for name in ASSETS:
        target = f"{OUT}/{name}.png"
        if not os.path.isfile(target):
            raise SystemExit(f"texconv did not write {target}")
        written += os.path.getsize(target)
    print(f"{len(ASSETS)} images -> {os.path.relpath(OUT, ROOT)} ({written / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
