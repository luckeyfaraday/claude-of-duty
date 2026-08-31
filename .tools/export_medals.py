#!/usr/bin/env python3
"""Export the T6 medal artwork and definitions (Nuclear, Double Kill, ...).

`zone/all/code_post_gfx_mp.ff` carries every multiplayer medal image: the
individual popup icons (`hud_medals_nuclear`, `hud_medals_doublekill`, ...) and
the per-category scoreboard atlases (`hud_medals_multikill01`,
`hud_medals_killtype01`, ...). Every image whose name matches the filter is
converted, so the full set lands in `export/web/ui/medals/` as PNG, mirroring
`.tools/export_hud.py`.

The names and scores come from two more zones, and are merged into
`medals.json` next to the icons:

* `zone/all/patch_mp.ff` -- `mp/scoreinfo.csv`, the authoritative medal table
  (script reference -> localize key, icon material, per-gametype score/XP,
  category and sortkey).
* `zone/english/en_patch_mp.ff` -- the localized `MEDAL_*` strings the popup
  and after-action report draw from.
"""
import atexit
import csv
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = f"{ROOT}/.tools"
OUT = f"{ROOT}/export/web/ui/medals"
IMAGE_ZONE = f"{ROOT}/zone/all/code_post_gfx_mp.ff"
SCOREINFO_ZONE = f"{ROOT}/zone/all/patch_mp.ff"
LOCALIZE_ZONE = f"{ROOT}/zone/english/en_patch_mp.ff"

INCLUDE = re.compile(r"^hud_medals_", re.IGNORECASE)

# scoreinfo.csv columns copied into medals.json, beyond the identity columns.
SCORE_COLUMNS = {
    "tdm score": "score",
    "tdm XP": "xp",
}


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(f"{os.path.basename(args[0])} failed ({result.returncode})")
    return result.stdout


def dump_zone(destination, zone, asset_types):
    """Unlink a zone, writing the given asset types into `destination`.

    The Unlinker is a Windows executable: under WSL interop it cannot resolve
    absolute Linux paths like /mnt/c/..., so the output folder is passed
    relative to TOOLS (the process cwd) where both sides agree on it.
    """
    run(
        [
            f"{TOOLS}/Unlinker.exe",
            "--include-assets", asset_types,
            "--image-format", "DDS",
            "-o", os.path.relpath(destination, TOOLS),
            os.path.relpath(zone, TOOLS),
        ],
        cwd=TOOLS,
    )


def convert(sources):
    """Convert DDS files to PNG in OUT, keeping authored resolutions.

    R8G8B8A8_UNORM is required: without it WIC refuses the BC5 two-channel
    normal maps. Paths stay relative to TOOLS for texconv's sake (see
    dump_zone) and the calls are chunked to stay clear of the Windows
    command-line length limit.
    """
    args = [
        f"{TOOLS}/texconv.exe", "-ft", "png", "-m", "1", "-f", "R8G8B8A8_UNORM",
        "-y", "-o", os.path.relpath(OUT, TOOLS),
    ]
    relative = [os.path.relpath(source, TOOLS) for source in sources]
    for start in range(0, len(relative), 32):
        run(args + relative[start:start + 32], cwd=TOOLS)


def parse_localized_strings(path):
    """Read an Unlinker .str dump into a key -> english text dict.

    Entries are `REFERENCE <key>` followed by `LANG_ENGLISH "<text>"`; the
    quoted value may span multiple lines. Marker lines from other languages
    (`LANG_FRENCH` ...) are ignored -- only the first LANG_ block after each
    reference is taken.
    """
    strings = {}
    key = None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            reference = re.match(r"^REFERENCE\s+(\S+)", line)
            if reference:
                key = reference.group(1)
                continue
            english = re.match(r'^LANG_ENGLISH\s+"(.*)$', line)
            if english and key is not None:
                text = english.group(1)
                while not text.endswith('"'):
                    text += "\n" + next(handle, "").rstrip("\n")
                strings[key] = text[:-1]
                key = None
    return strings


def build_medals_json(images_dir, scratch, localized):
    """Merge scoreinfo.csv with the localized MEDAL_* strings.

    Rows with neither a medal reference nor an icon material (plain score
    events like `kill`) are kept only when they carry a score string, so the
    table doubles as the score-feed dictionary.
    """
    csv_path = f"{scratch}/mp/scoreinfo.csv"
    if not os.path.isfile(csv_path):
        raise SystemExit(f"scoreinfo.csv missing from the {os.path.basename(SCOREINFO_ZONE)} dump")
    with open(csv_path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    # DictReader keys keep the header's trailing spaces.
    column = {name.strip(): name for name in rows[0]}

    medals = []
    for row in rows:
        ref = row[column["Script Reference"]].strip()
        key = row[column["Medal Reference"]].strip()
        material = row[column["Medal Backing Material"]].strip()
        icon = f"{material}.png" if material and os.path.isfile(f"{OUT}/{material}.png") else None
        entry = {"ref": ref}
        if key:
            entry["key"] = key
            if key in localized:
                entry["name"] = localized[key]
            desc_key = f"{key}_DESC"
            if desc_key in localized:
                entry["description"] = localized[desc_key]
        if material:
            entry["material"] = material
        if icon:
            entry["icon"] = icon
        for csv_name, json_name in SCORE_COLUMNS.items():
            value = int(row[column[csv_name]] or 0)
            if value:
                entry[json_name] = value
        category = row[column["Medal Category"]].strip()
        if category:
            entry["category"] = category
        sortkey = row[column["Medal Sortkey"]].strip()
        if sortkey:
            entry["sortkey"] = int(sortkey)
        if len(entry) > 1:
            medals.append(entry)

    medals.sort(key=lambda e: (e.get("category", ""), e.get("sortkey", 0), e["ref"]))
    with open(f"{OUT}/medals.json", "w", encoding="utf-8") as handle:
        json.dump(medals, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return medals


def main():
    for tool in ("Unlinker.exe", "texconv.exe"):
        if not os.path.isfile(f"{TOOLS}/{tool}"):
            raise SystemExit(f"missing {TOOLS}/{tool}")
    for zone in (IMAGE_ZONE, SCOREINFO_ZONE, LOCALIZE_ZONE):
        if not os.path.isfile(zone):
            raise SystemExit(f"missing {zone}")

    os.makedirs(OUT, exist_ok=True)
    # The Unlinker is a Windows executable and cannot reach Linux-side temp
    # directories, so scratch space lives inside the repo where both sides
    # see it, and is removed on exit however the run ends.
    scratch = f"{ROOT}/.medals_export_tmp"
    atexit.register(lambda: shutil.rmtree(scratch, ignore_errors=True))
    shutil.rmtree(scratch, ignore_errors=True)
    os.makedirs(scratch)

    dump_zone(scratch, IMAGE_ZONE, "image")
    images = f"{scratch}/images"
    if not os.path.isdir(images):
        raise SystemExit(f"Unlinker wrote no images to {images}")
    wanted = sorted(
        name for name in os.listdir(images)
        if name.endswith(".dds") and INCLUDE.search(name[:-4])
    )
    if not wanted:
        raise SystemExit("no dumped image matched the medal filter")
    convert([f"{images}/{name}" for name in wanted])

    for name in wanted:
        if not os.path.isfile(f"{OUT}/{name[:-4]}.png"):
            raise SystemExit(f"texconv did not write {name[:-4]}.png")

    dump_zone(scratch, SCOREINFO_ZONE, "stringtable")
    dump_zone(scratch, LOCALIZE_ZONE, "localize")
    str_dump = f"{scratch}/english/localizedstrings/{os.path.basename(LOCALIZE_ZONE)[:-3]}.str"
    if not os.path.isfile(str_dump):
        raise SystemExit(f"localize dump missing {str_dump}")
    localized = parse_localized_strings(str_dump)

    medals = build_medals_json(images, scratch, localized)
    named = sum(1 for m in medals if "name" in m)
    with_icon = sum(1 for m in medals if "icon" in m)
    print(
        f"{len(wanted)} images + {len(medals)} score/medal entries "
        f"({named} named, {with_icon} with icons) -> {os.path.relpath(OUT, ROOT)}"
    )


if __name__ == "__main__":
    main()
