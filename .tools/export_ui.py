#!/usr/bin/env python3
"""Export the T6 frontend art the browser menu draws with.

`zone/all/ui_mp.ff` carries the whole Black Ops II multiplayer frontend: 525
images and 584 materials. The menu only needs a dozen of them, so this dumps
the zone once and converts just that subset to PNG under `export/web/ui/`.

The weapon cards live in the code-post graphics zone rather than ui_mp.ff;
the hk416/M27 card is a patch asset.  They are included here so the exact same
named-subset export path handles all of the frontend art.

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
CODE_POST_GFX_ZONE = f"{ROOT}/zone/all/code_post_gfx_mp.ff"
PATCH_ZONE = f"{ROOT}/zone/all/patch_mp.ff"

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

    # Authentic weapon card art.  The small cards use the authored `_big`
    # plates because they include the full silhouette and transparent margin.
    # hk416/M27 is patched into patch_mp.ff; the remaining AR cards are in
    # code_post_gfx_mp.ff.
    "menu_mp_weapons_hk416": None,
    "menu_mp_weapons_an94": None,
    "menu_mp_weapons_an94_big": None,
    "menu_mp_weapons_sa58": None,
    "menu_mp_weapons_sa58_big": None,
    "menu_mp_weapons_saritch": None,
    "menu_mp_weapons_saritch_big": None,
    "menu_mp_weapons_scar": None,
    "menu_mp_weapons_scar_big": None,
    "menu_mp_weapons_sig556": None,
    "menu_mp_weapons_sig556_big": None,
    "menu_mp_weapons_tar21": None,
    "menu_mp_weapons_tar21_big": None,
    "menu_mp_weapons_type95": None,
    "menu_mp_weapons_type95_big": None,
    "menu_mp_weapons_xm8": None,
    "menu_mp_weapons_xm8_big": None,
}

# patch_mp.ff only contains the hk416 base plate.  Keep the card template
# uniform by publishing that authentic plate under the `_big` filename too;
# no placeholder art is invented for the missing variant.
ASSET_ALIASES = {
    "menu_mp_weapons_hk416_big": "menu_mp_weapons_hk416",
}

ASSET_ZONES = {
    name: PATCH_ZONE
    for name in ("menu_mp_weapons_hk416",)
}
ASSET_ZONES.update({
    name: CODE_POST_GFX_ZONE
    for name in ASSETS
    if name.startswith("menu_mp_weapons_") and name not in ASSET_ZONES
})


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(f"{os.path.basename(args[0])} failed ({result.returncode})")
    return result.stdout


def dump_zone(destination, zone=ZONE):
    """Unlink ui_mp.ff, writing its images as DDS into `destination`."""
    run(
        [
            f"{TOOLS}/Unlinker.exe",
            "--include-assets", "image,material",
            "--image-format", "DDS",
            "-o", destination,
            zone,
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
    for zone in {ZONE, *ASSET_ZONES.values()}:
        if not os.path.isfile(zone):
            raise SystemExit(f"missing {zone}")

    os.makedirs(OUT, exist_ok=True)
    by_zone = {}
    for name, size in ASSETS.items():
        zone = ASSET_ZONES.get(name, ZONE)
        by_zone.setdefault(zone, []).append((name, size))

    for zone, assets in by_zone.items():
        with tempfile.TemporaryDirectory(prefix="ui_mp_") as scratch:
            images = dump_zone(scratch, zone)

            # Group by output size so the common case is a single texconv call.
            batches = {}
            for name, size in assets:
                source = f"{images}/{name}.dds"
                if not os.path.isfile(source):
                    raise SystemExit(f"{name} is not in {os.path.basename(zone)}")
                batches.setdefault(size, []).append(source)
            for size, sources in batches.items():
                convert(sources, size)

    for alias, source in ASSET_ALIASES.items():
        shutil.copyfile(f"{OUT}/{source}.png", f"{OUT}/{alias}.png")

    written = 0
    for name in ASSETS:
        target = f"{OUT}/{name}.png"
        if not os.path.isfile(target):
            raise SystemExit(f"texconv did not write {target}")
        written += os.path.getsize(target)
    for name in ASSET_ALIASES:
        written += os.path.getsize(f"{OUT}/{name}.png")
    print(f"{len(ASSETS) + len(ASSET_ALIASES)} images -> {os.path.relpath(OUT, ROOT)} ({written / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
