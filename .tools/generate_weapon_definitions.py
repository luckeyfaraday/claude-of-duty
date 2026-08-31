#!/usr/bin/env python3
"""Generate browser viewmodel definitions from T6 weapon-file records.

The exported weapon records are backslash-delimited key/value pairs.  This
script keeps the authored model names, attachment index/offsets, timing,
magazine size, damage, and clip names in one source of truth while emitting
the small JavaScript objects consumed by ``export/web/index.html``.

Examples::

    python .tools/generate_weapon_definitions.py sa58 saritch scar sig556 tar21 type95 xm8
    python .tools/generate_weapon_definitions.py --all

Display names are the BO2 in-game names.  They are intentionally hardcoded:
the checked-in localization file contains Windows configuration strings, not
the multiplayer weapon labels.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEAPON_DIR = ROOT / "artifacts" / "weapon-data" / "weapons"

ROSTER = ("hk416", "an94", "sa58", "saritch", "scar", "sig556", "tar21", "type95", "xm8")
DISPLAY_NAMES = {
    "hk416": "M27",
    "an94": "AN-94",
    "sa58": "FAL OSW",
    "saritch": "SMR",
    "scar": "SCAR-H",
    "sig556": "SWAT-556",
    "tar21": "MTAR",
    "type95": "Type 25",
    "xm8": "M8A1",
}
# The existing slot uses the player-facing M27 id.  Keep the source weapon id
# in the input lookup, but emit the runtime id already used by the game.
RUNTIME_IDS = {"hk416": "m27"}

CLIPS = (
    ("idle", "idleAnim"),
    ("fire", "fireAnim"),
    ("adsFire", "adsFireAnim"),
    ("introFire", "fireIntroAnim"),
    ("introAdsFire", "adsFireIntroAnim"),
    ("reload", "reloadAnim"),
    ("reloadEmpty", "reloadEmptyAnim"),
)


def parse_weapon_file(path: Path) -> dict[str, str]:
    """Parse the same ``\\key\\value`` record format used by the exporter."""

    parts = path.read_text(encoding="utf-8").split("\\")
    values: dict[str, str] = {}
    for index in range(1, len(parts) - 1, 2):
        values[parts[index]] = parts[index + 1]
    return values


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def number(value: str, *, integer: bool = False) -> str:
    parsed = float(value)
    if integer:
        return str(int(round(parsed)))
    if parsed.is_integer():
        return str(int(parsed))
    return f"{parsed:.6f}".rstrip("0").rstrip(".")


def find_magazine(weapon: dict[str, str]) -> tuple[int, str]:
    for index in range(1, 17):
        model = weapon.get(f"attachViewModel{index}", "")
        if model.startswith("t6_attach_mag_"):
            return index, model
    raise ValueError("weapon has no authored t6_attach_mag_* viewmodel attachment")


def clip_entries(weapon: dict[str, str]) -> list[tuple[str, str]]:
    entries = []
    for key, field in CLIPS:
        name = weapon.get(field, "")
        if name:
            entries.append((key, name))
    required = {"idle", "fire", "adsFire", "reload", "reloadEmpty"}
    missing = required - {key for key, _ in entries}
    if missing:
        raise ValueError(f"missing required clips: {', '.join(sorted(missing))}")
    return entries


def emit_definition(source_id: str, slot: int) -> str:
    path = WEAPON_DIR / f"{source_id}_mp"
    weapon = parse_weapon_file(path)
    runtime_id = RUNTIME_IDS.get(source_id, source_id)
    gun_model = weapon["gunModel"]
    attachment_index, magazine_model = find_magazine(weapon)
    clip_values = clip_entries(weapon)

    fire_time = float(weapon["fireTime"])
    rpm = int(round(60 / fire_time))
    offset = [
        number(weapon[f"attachViewModelOffset{axis}{attachment_index}"])
        for axis in ("X", "Y", "Z")
    ]
    roll = number(weapon.get(f"attachViewModelOffsetRoll{attachment_index}", "0"))

    lines = [
        f"  {runtime_id}: Object.freeze({{",
        f"    id: {js_string(runtime_id)},",
        f"    name: {js_string(DISPLAY_NAMES[source_id])},",
        f"    slot: {slot},",
        "    magazineSize: " + number(weapon["clipSize"], integer=True) + ",",
        "    reserveAmmo: 240,",
        f"    roundsPerMinute: {rpm},",
        "    damage: " + number(weapon["damage"], integer=True) + ",",
        f"    fireTypeIcon: {js_string(weapon['fireTypeIcon'])},",
        f"    viewmodelUrl: 'viewmodel/{gun_model}_lod0.glb',",
        f"    magazineUrl: 'viewmodel/{magazine_model}_lod0.glb',",
        f"    // Authored attachment offset from the shipped {source_id}_mp weapon file.",
        f"    magazineOffset: Object.freeze([{', '.join(offset)}]),",
        "    magazineRotation: Object.freeze([THREE.MathUtils.degToRad(" + roll + "), 0, 0]),",
    ]

    # AN-94's hyperburst behavior is not represented by the generic weapon
    # fields, so preserve the tuned values from the shipped reference entry.
    if source_id == "an94":
        lines.extend([
            "    initialRoundsPerMinute: 937.5,",
            "    initialShotCount: 2,",
        ])

    lines.append("    // Agent A ADS sight-anchor override can be added here when a rig needs one.")
    lines.append("    clips: Object.freeze({")
    for key, name in clip_values:
        lines.append(f"      {key}: 'viewmodel/anims/{name}.json',")
    lines.extend(["    }),", "  }),"])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ids", nargs="*", help="weapon-file ids to emit")
    parser.add_argument("--all", action="store_true", help="emit the complete nine-rifle roster")
    args = parser.parse_args()
    unknown = sorted(set(args.ids) - set(ROSTER))
    if unknown:
        parser.error(f"unknown weapon id(s): {', '.join(unknown)}")
    ids = ROSTER if args.all or not args.ids else tuple(args.ids)
    for source_id in ids:
        print(emit_definition(source_id, ROSTER.index(source_id) + 1))


if __name__ == "__main__":
    main()
