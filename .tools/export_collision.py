#!/usr/bin/env python3
"""Export a lightweight collision/navmesh source for mp_hijacked.

The render composer intentionally keeps all of the original BSP surfaces and
render materials.  This module emits a separate, untextured glTF containing
only walkable-world collision candidates and xmodel collision LOD instances.
It also writes the pathnode/negotiation/spawn hints consumed by a navmesh
baker or the browser runtime.

Coordinate convention
---------------------
The extracted T6 map is z-up.  All positions written here are converted to
Three.js coordinates with ``(x, y, z) -> (x, z, -y)``.  Model instance
matrices are the same conjugated matrices used by compose_scene.py.
"""

from __future__ import annotations

import json
import math
import os
import re
import struct
from collections import Counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


Vec3 = Tuple[float, float, float]
Tri = Tuple[int, int, int]


_ENTITY_BLOCK_RE = re.compile(r"\{([^{}]*)\}", re.S)
_ENTITY_KV_RE = re.compile(r'"([^"]+)"\s+"([^"]*)"')


def _path(root: str, *parts: str) -> str:
    return os.path.join(root, *parts)


def _game_to_three(value: Sequence[float]) -> Vec3:
    """Convert a T6 z-up point into the Three.js y-up basis."""

    return (float(value[0]), float(value[2]), -float(value[1]))


def _point_fields(position: Vec3, game_position: Optional[Sequence[float]] = None) -> Dict:
    """Return both array and named forms for convenient JS/baker consumption."""

    p = [float(position[0]), float(position[1]), float(position[2])]
    out = {
        "position": p,
        "positionObject": {"x": p[0], "y": p[1], "z": p[2]},
    }
    if game_position is not None:
        g = [float(game_position[0]), float(game_position[1]), float(game_position[2])]
        out["originGame"] = g
    return out


def _parse_float_vector(text: str, count: int = 3) -> Optional[List[float]]:
    try:
        values = [float(part) for part in text.replace(",", " ").split()]
    except (TypeError, ValueError):
        return None
    if len(values) < count:
        return None
    return values[:count]


def _parse_int(text: Optional[str], default: Optional[int] = None) -> Optional[int]:
    if text is None:
        return default
    try:
        return int(text, 0)
    except ValueError:
        try:
            return int(float(text))
        except ValueError:
            return default


def _parse_entities(path: str) -> List[Dict[str, str]]:
    """Parse the block/key/value entity format emitted by the T6 exporter."""

    with open(path, "r", encoding="utf-8", errors="replace") as stream:
        raw = stream.read()
    entities: List[Dict[str, str]] = []
    for match in _ENTITY_BLOCK_RE.finditer(raw):
        entity = {key: value for key, value in _ENTITY_KV_RE.findall(match.group(1))}
        if entity:
            entities.append(entity)
    return entities


def _obj_index(token: str, vertex_count: int) -> Optional[int]:
    """Read the vertex part of an OBJ face token, including negative indices."""

    try:
        value = int(token.split("/", 1)[0])
    except (TypeError, ValueError):
        return None
    index = value - 1 if value > 0 else vertex_count + value
    if index < 0 or index >= vertex_count:
        return None
    return index


def _parse_collision_obj(path: str) -> Tuple[List[Vec3], List[Tri]]:
    """Read only positions and triangulated faces from an OBJ collision LOD."""

    vertices: List[Vec3] = []
    faces: List[Tri] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as stream:
        for raw_line in stream:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("v "):
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
                    except ValueError:
                        pass
                continue
            if not line.startswith("f "):
                continue
            tokens = line.split()[1:]
            polygon = [_obj_index(token, len(vertices)) for token in tokens]
            if len(polygon) < 3 or any(index is None for index in polygon):
                continue
            first = polygon[0]
            for offset in range(1, len(polygon) - 1):
                # The Optional check above makes these ints to type checkers;
                # keeping the tuple explicit also avoids leaking None values.
                a, b, c = first, polygon[offset], polygon[offset + 1]
                if a != b and b != c and a != c:
                    faces.append((int(a), int(b), int(c)))
    return vertices, faces


def _tokenize_material(name: str) -> List[str]:
    # Composite BSP material names look like:
    # *5n_83n(wpc/fiberglass_boat_white:wpc/decal_trim_seam_clean)
    tokens = [token.strip().lower() for token in re.findall(r"wpc/([^:)]+)", name.lower())]
    return tokens or [name.lower()]


def _is_glass_token(token: str) -> bool:
    # Keep fiberglass hulls; skip actual glass, broken glass, windows, etc.
    return not token.startswith("fiberglass") and (
        token.startswith("glass")
        or "_glass" in token
        or token.startswith("glass_")
        or token.startswith("dec_glass")
    )


def _is_water_token(token: str) -> bool:
    return (
        "water" in token
        or "ocean" in token
        or token.startswith("pool")
        or "_pool" in token
    )


def _is_non_solid_token(token: str) -> bool:
    """Conservative material-name heuristic for render-only surfaces."""

    return (
        token.startswith(("decal", "ao_", "fx", "effect", "light_", "shadow", "fog", "sky"))
        or token in {"ao", "shadowcaster", "light_white_02_unlit_no_offset"}
        or "decal" in token
        or "particle" in token
    )


def _collision_material_reason(material: Dict) -> Tuple[bool, str]:
    name = str(material.get("name", ""))
    color_map = str(material.get("colorMap", ""))
    lower_name = name.lower()
    lower_color = color_map.lower()
    tokens = _tokenize_material(name)

    if "distant" in lower_name:
        return False, "distant"

    has_water = any(_is_water_token(token) for token in tokens) or "water" in lower_color
    # ``fiberglass`` is a solid hull material, despite containing the word
    # ``glass``; only reject color maps that identify actual glass surfaces.
    has_glass = any(_is_glass_token(token) for token in tokens) or (
        "glass" in lower_color and "fiberglass" not in lower_color
    )
    # Composite BSP materials commonly layer a puddle/decal/glass token over
    # a real deck or wall token.  Keep such a surface when it still has a
    # genuinely solid component; reject only pure water/glass composites.
    solid_tokens = [
        token for token in tokens
        if not _is_water_token(token)
        and not _is_glass_token(token)
        and not _is_non_solid_token(token)
    ]
    if not solid_tokens:
        if has_water:
            return False, "water"
        if has_glass:
            return False, "glass"
        if all(_is_non_solid_token(token) for token in tokens):
            return False, "non_solid"
    return True, "included"


class _CollisionGltf:
    """Small glTF writer with position-only meshes and unsigned int indices."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.accessors: List[Dict] = []
        self.buffer_views: List[Dict] = []
        self.meshes: List[Dict] = []

    def _align4(self) -> None:
        while len(self.data) % 4:
            self.data.append(0)

    def _floats(self, values: Sequence[float]) -> Tuple[int, int]:
        self._align4()
        offset = len(self.data)
        self.data.extend(struct.pack("<%df" % len(values), *values))
        return offset, len(values) * 4

    def _uints(self, values: Sequence[int]) -> Tuple[int, int]:
        self._align4()
        offset = len(self.data)
        self.data.extend(struct.pack("<%dI" % len(values), *values))
        return offset, len(values) * 4

    def _position_accessor(self, positions: Sequence[float]) -> int:
        offset, length = self._floats(positions)
        self.buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": length})
        count = len(positions) // 3
        mins = [min(positions[i::3]) for i in range(3)] if count else [0.0, 0.0, 0.0]
        maxs = [max(positions[i::3]) for i in range(3)] if count else [0.0, 0.0, 0.0]
        self.accessors.append({
            "bufferView": len(self.buffer_views) - 1,
            "componentType": 5126,
            "count": count,
            "type": "VEC3",
            "min": mins,
            "max": maxs,
        })
        return len(self.accessors) - 1

    def _index_accessor(self, indices: Sequence[int]) -> int:
        offset, length = self._uints(indices)
        self.buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": length})
        self.accessors.append({
            "bufferView": len(self.buffer_views) - 1,
            "componentType": 5125,
            "count": len(indices),
            "type": "SCALAR",
        })
        return len(self.accessors) - 1

    def add_mesh(self, name: str, positions: Sequence[float], indices: Sequence[int]) -> int:
        if not positions or not indices:
            raise ValueError("cannot add an empty collision mesh")
        position_accessor = self._position_accessor(positions)
        index_accessor = self._index_accessor(indices)
        self.meshes.append({
            "name": name[:60],
            "primitives": [{
                "attributes": {"POSITION": position_accessor},
                "indices": index_accessor,
                "mode": 4,
            }],
        })
        return len(self.meshes) - 1

    def document(self, nodes: List[Dict], extras: Dict) -> Dict:
        return {
            "asset": {"version": "2.0", "generator": "hijacked-collision-export"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(nodes)))}],
            "nodes": nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"uri": "hijacked_collision.bin", "byteLength": len(self.data)}],
            "extras": extras,
        }


def _model_matrix(instance: Dict) -> List[float]:
    """Conjugated T6 model transform, matching compose_scene.py exactly."""

    origin = instance.get("origin", [0.0, 0.0, 0.0])
    axis0 = instance.get("axis0", [1.0, 0.0, 0.0])
    axis1 = instance.get("axis1", [0.0, 1.0, 0.0])
    axis2 = instance.get("axis2", [0.0, 0.0, 1.0])
    scale = float(instance.get("scale", 1.0))

    def rotate(value: Sequence[float]) -> List[float]:
        return [float(value[0]), float(value[2]), -float(value[1])]

    columns = [
        rotate(axis0),
        rotate(axis2),
        [-component for component in rotate(axis1)],
        rotate(origin),
    ]
    matrix: List[float] = []
    for column in columns[:3]:
        matrix.extend([component * scale for component in column])
        matrix.append(0.0)
    matrix.extend(columns[3])
    matrix.append(1.0)
    return matrix


def _model_mesh_data(obj_path: str) -> Optional[Tuple[List[float], List[int], int, int]]:
    vertices, faces = _parse_collision_obj(obj_path)
    if not vertices or not faces:
        return None
    positions: List[float] = []
    indices: List[int] = []
    used: Dict[int, int] = {}

    def local_index(game_index: int) -> int:
        existing = used.get(game_index)
        if existing is not None:
            return existing
        # model_export OBJ vertices are already converted to the viewer's
        # Three.js Y-up basis.  Applying _game_to_three() here rotates every
        # collision xmodel a second time and leaves it lying on its side.
        p = vertices[game_index]
        index = len(positions) // 3
        positions.extend(p)
        used[game_index] = index
        return index

    for a, b, c in faces:
        # The OBJ export already has the viewer basis and winding.
        indices.extend([local_index(a), local_index(b), local_index(c)])
    return positions, indices, len(positions) // 3, len(indices) // 3


def _read_world_collision(root: str, gltf: _CollisionGltf) -> Tuple[int, Dict, List[float], List[int]]:
    world_json_path = _path(root, "export", "maps", "mp", "mp_hijacked.d3dbsp.gfxworld.json")
    vertex_path = _path(root, "export", "maps", "mp", "mp_hijacked.d3dbsp.gfxworld.vd0")
    index_path = _path(root, "export", "maps", "mp", "mp_hijacked.d3dbsp.gfxworld.idx")
    with open(world_json_path, "r", encoding="utf-8") as stream:
        world = json.load(stream)
    with open(vertex_path, "rb") as stream:
        raw_vertices = stream.read()
    with open(index_path, "rb") as stream:
        raw_indices = stream.read()
    indices = struct.unpack("<%dH" % int(world["indexCount"]), raw_indices[: int(world["indexCount"]) * 2])

    positions: List[float] = []
    output_indices: List[int] = []
    vertex_cache: Dict[int, int] = {}
    material_reasons: Counter = Counter()
    material_ids_by_reason: Dict[str, set] = {}
    included_material_ids = set()
    included_surfaces = 0
    skipped_surfaces = 0
    included_triangles = 0
    skipped_triangles = 0

    def world_vertex(offset: int) -> Optional[int]:
        existing = vertex_cache.get(offset)
        if existing is not None:
            return existing
        if offset < 0 or offset + 12 > len(raw_vertices):
            return None
        game_position = struct.unpack_from("<3f", raw_vertices, offset)
        position = _game_to_three(game_position)
        index = len(positions) // 3
        positions.extend(position)
        vertex_cache[offset] = index
        return index

    materials = world.get("materials", [])
    for surface in world.get("surfaces", []):
        material_index = int(surface.get("m", -1))
        material = materials[material_index] if 0 <= material_index < len(materials) else {}
        keep, reason = _collision_material_reason(material)
        material_reasons[reason] += 1
        material_ids_by_reason.setdefault(reason, set()).add(material_index)
        if not keep:
            skipped_surfaces += 1
            skipped_triangles += int(surface.get("tc", 0))
            continue
        included_surfaces += 1
        included_material_ids.add(material_index)
        first_index = int(surface.get("bi", 0))
        triangle_count = int(surface.get("tc", 0))
        base_offset = int(surface.get("o0", 0))
        surface_has_triangle = False
        for triangle in range(triangle_count):
            index_offset = first_index + triangle * 3
            if index_offset + 2 >= len(indices):
                skipped_triangles += 1
                continue
            a = world_vertex(base_offset + int(indices[index_offset]) * 36)
            b = world_vertex(base_offset + int(indices[index_offset + 1]) * 36)
            c = world_vertex(base_offset + int(indices[index_offset + 2]) * 36)
            if a is None or b is None or c is None or a == b or b == c or a == c:
                skipped_triangles += 1
                continue
            # Reflection of the T6 basis reverses winding.
            output_indices.extend([a, c, b])
            included_triangles += 1
            surface_has_triangle = True
        if not surface_has_triangle:
            # Keep included_surfaces as a source-material count; the detail is
            # exposed separately so malformed source data remains diagnosable.
            pass

    mesh_index = gltf.add_mesh("world_collision", positions, output_indices)
    stats = {
        "sourceSurfaces": len(world.get("surfaces", [])),
        "includedSurfaces": included_surfaces,
        "skippedSurfaces": skipped_surfaces,
        "includedTriangles": included_triangles,
        "skippedTriangles": skipped_triangles,
        "vertices": len(positions) // 3,
        "materialsIncluded": len(included_material_ids),
        "materialsSkipped": {
            reason: len(material_ids_by_reason.get(reason, set()))
            for reason in sorted(material_ids_by_reason)
            if reason != "included"
        },
        "surfaceSkipReasons": {
            reason: count for reason, count in sorted(material_reasons.items()) if reason != "included"
        },
        "materialFilter": (
            "skip distant/water/ocean/pool, actual glass, and materials made only "
            "from decal/ao/fx/light/shadow/sky-like tokens; retain solid composites"
        ),
    }
    return mesh_index, stats, positions, output_indices


def _entity_hints(root: str) -> Dict:
    entity_path = _path(root, "export", "maps", "mp", "mp_hijacked.d3dbsp.ents")
    entities = _parse_entities(entity_path)
    pathnodes: List[Dict] = []
    negotiation_nodes: List[Dict] = []
    begins: List[Dict] = []
    ends_by_target: Dict[str, Dict] = {}
    spawns: List[Dict] = []

    for ordinal, entity in enumerate(entities):
        classname = entity.get("classname", "")
        lower_classname = classname.lower()
        game_origin = _parse_float_vector(entity.get("origin", ""))
        if game_origin is None:
            continue
        position = _game_to_three(game_origin)
        guid = entity.get("guid")
        base = {"ordinal": ordinal, "guid": guid, "classname": classname}

        if lower_classname == "node_pathnode":
            record = dict(base)
            record.update(_point_fields(position, game_origin))
            if "script_noteworthy" in entity:
                record["note"] = entity["script_noteworthy"]
            pathnodes.append(record)

        if lower_classname in {"node_negotiation_begin", "node_negotiation_end"}:
            record = dict(base)
            record.update(_point_fields(position, game_origin))
            record["target"] = entity.get("target")
            record["targetname"] = entity.get("targetname")
            record["spawnflags"] = _parse_int(entity.get("spawnflags"), 0)
            record["role"] = "begin" if lower_classname.endswith("_begin") else "end"
            negotiation_nodes.append(record)
            if record["role"] == "begin":
                begins.append({"entity": entity, "record": record})
            elif entity.get("targetname"):
                ends_by_target[entity["targetname"]] = record

        # Objective flag entities are not playable spawn points.  Include all
        # mode/team starts and ordinary DM/TDM points, including *_OT_start.
        if (
            lower_classname.startswith("mp_")
            and "_spawn" in lower_classname
            and "flag" not in lower_classname
        ):
            angles = _parse_float_vector(entity.get("angles", "0 0 0")) or [0.0, 0.0, 0.0]
            game_yaw = float(angles[1])
            yaw_radians = math.radians(game_yaw) - math.pi / 2.0
            record = dict(base)
            record.update(_point_fields(position, game_origin))
            record.update({
                "anglesGame": angles,
                # yaw is Three Object3D rotation.y (radians), with a -Z
                # forward convention.  Keep the source yaw and heading too.
                "yaw": yaw_radians,
                "yawDegrees": math.degrees(yaw_radians),
                "yawGameDegrees": game_yaw,
                "forward": [math.cos(math.radians(game_yaw)), 0.0, -math.sin(math.radians(game_yaw))],
            })
            if "spawnflags" in entity:
                record["spawnflags"] = _parse_int(entity.get("spawnflags"), 0)
            spawns.append(record)

    off_mesh: List[Dict] = []
    missing_end_targets: List[str] = []
    for begin in begins:
        source = begin["record"]
        target = begin["entity"].get("target")
        end = ends_by_target.get(target or "")
        if end is None:
            missing_end_targets.append(target or "")
        record = {
            "guid": source.get("guid"),
            "target": target,
            "start": source.get("position"),
            "startObject": source.get("positionObject"),
            "end": end.get("position") if end else None,
            "endObject": end.get("positionObject") if end else None,
            "spawnflags": source.get("spawnflags", 0),
            "bidirectional": False,
            "radius": 20.0,
            "area": 0,
            "flags": 1,
            "candidate": True,
        }
        off_mesh.append(record)

    return {
        "format": "hijacked-nav-hints-v1",
        "map": "mp_hijacked",
        "coordinateSystem": {
            "source": "T6 z-up coordinates",
            "target": "Three.js y-up coordinates",
            "position": "(x, y, z) -> (x, z, -y)",
            "spawnYaw": "yaw is Three Object3D rotation.y in radians; T6 yaw is degrees around +Z",
        },
        "pathnodes": pathnodes,
        "negotiationNodes": negotiation_nodes,
        "offMeshConnections": off_mesh,
        "spawns": spawns,
        "counts": {
            "entities": len(entities),
            "pathnodes": len(pathnodes),
            "negotiationNodes": len(negotiation_nodes),
            "negotiationBegins": len(begins),
            "offMeshConnections": len(off_mesh),
            "spawns": len(spawns),
            "missingNegotiationEnds": len(missing_end_targets),
        },
        "missingNegotiationTargets": missing_end_targets,
        "notes": [
            "offMeshConnections are candidates from node_negotiation_begin -> node_negotiation_end; validate landing and direction during baking",
            "spawns excludes mp_*_spawn_flag_* objective entities",
        ],
    }


def export_collision(root: str, out_dir: Optional[str] = None) -> Dict:
    """Write collision glTF, nav hints, and documentation; return summary stats."""

    if out_dir is None:
        out_dir = _path(root, "export", "web")
    os.makedirs(out_dir, exist_ok=True)

    gltf = _CollisionGltf()
    world_mesh, world_stats, _world_positions, _world_indices = _read_world_collision(root, gltf)
    nodes: List[Dict] = [{"mesh": world_mesh, "name": "world_collision"}]

    world_json_path = _path(root, "export", "maps", "mp", "mp_hijacked.d3dbsp.gfxworld.json")
    with open(world_json_path, "r", encoding="utf-8") as stream:
        world = json.load(stream)
    static_models = world.get("staticModels", [])
    model_json_dir = _path(root, "export", "xmodel")
    obj_dir = _path(root, "export", "model_export")
    model_mesh_indices: Dict[str, int] = {}
    model_records: Dict[str, Dict] = {}
    model_missing_json: List[str] = []
    model_missing_obj: List[str] = []
    model_empty_obj: List[str] = []
    model_no_coll_lod: List[str] = []
    model_unique_names = sorted({str(instance.get("model", "")) for instance in static_models})

    for name in model_unique_names:
        json_path = _path(model_json_dir, name + ".json")
        if not os.path.exists(json_path):
            model_missing_json.append(name)
            continue
        try:
            with open(json_path, "r", encoding="utf-8") as stream:
                xmodel = json.load(stream)
        except (OSError, ValueError):
            model_missing_json.append(name)
            continue
        coll_lod_value = xmodel.get("collLod")
        if not isinstance(coll_lod_value, (int, float)) or int(coll_lod_value) != coll_lod_value:
            model_no_coll_lod.append(name)
            continue
        coll_lod = int(coll_lod_value)
        obj_path = _path(obj_dir, "%s_lod%d.obj" % (name, coll_lod))
        record = {
            "xmodel": "export/xmodel/%s.json" % name,
            "collLod": coll_lod,
            "obj": "export/model_export/%s_lod%d.obj" % (name, coll_lod),
        }
        if not os.path.exists(obj_path):
            model_missing_obj.append(name)
            model_records[name] = record
            continue
        mesh_data = _model_mesh_data(obj_path)
        if mesh_data is None:
            model_empty_obj.append(name)
            model_records[name] = record
            continue
        positions, indices, vertex_count, triangle_count = mesh_data
        mesh_index = gltf.add_mesh("collision_%s_lod%d" % (name, coll_lod), positions, indices)
        model_mesh_indices[name] = mesh_index
        record.update({"vertices": vertex_count, "triangles": triangle_count})
        model_records[name] = record

    included_instances = 0
    skipped_instances = Counter()
    for instance in static_models:
        name = str(instance.get("model", ""))
        mesh_index = model_mesh_indices.get(name)
        if mesh_index is None:
            if name in model_no_coll_lod:
                skipped_instances["no_collLod"] += 1
            elif name in model_records:
                if name in model_missing_obj:
                    skipped_instances["missing_collision_obj"] += 1
                elif name in model_empty_obj:
                    skipped_instances["empty_collision_obj"] += 1
            elif name in model_missing_json:
                skipped_instances["missing_xmodel"] += 1
            else:
                skipped_instances["missing_xmodel"] += 1
            continue
        nodes.append({
            "mesh": mesh_index,
            "matrix": _model_matrix(instance),
            "name": "i_%s" % name[:56],
        })
        included_instances += 1

    hints = _entity_hints(root)
    gltf_extras = {
        "format": "hijacked-collision-source-v1",
        # The mesh has already been converted to Three.js coordinates.  Keep
        # this token canonical because the Node baker validates it strictly.
        "coordinateSystem": "three-y-up",
        "sourceCoordinateSystem": "t6-z-up",
        "world": world_stats,
        "models": {
            "uniqueInstancesSource": len(static_models),
            "uniqueModelsSource": len(model_unique_names),
            "modelsWithCollisionLod": len(model_records),
            "collisionMeshes": len(model_mesh_indices),
            "instancesIncluded": included_instances,
            "instancesSkipped": sum(skipped_instances.values()),
        },
        # The baker can consume these directly without a second hints-file
        # argument; the full records remain in hijacked_nav_hints.json.
        "pathnodes": [record["position"] for record in hints["pathnodes"]],
        "offMeshConnections": [
            {
                "start": record["start"],
                "end": record["end"],
                "radius": record["radius"],
                "bidirectional": record["bidirectional"],
                "area": record["area"],
                "flags": record["flags"],
            }
            for record in hints["offMeshConnections"]
            if record["start"] is not None and record["end"] is not None
        ],
    }
    document = gltf.document(nodes, gltf_extras)
    gltf_path = _path(out_dir, "hijacked_collision.gltf")
    bin_path = _path(out_dir, "hijacked_collision.bin")
    with open(gltf_path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(document, stream, separators=(",", ":"))
        stream.write("\n")
    with open(bin_path, "wb") as stream:
        stream.write(gltf.data)

    hints_path = _path(out_dir, "hijacked_nav_hints.json")
    with open(hints_path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(hints, stream, separators=(",", ":"))
        stream.write("\n")

    source_doc = {
        "format": "hijacked-collision-source-v1",
        "map": "mp_hijacked",
        "files": {
            "collisionGltf": "hijacked_collision.gltf",
            "collisionBin": "hijacked_collision.bin",
            "navHints": "hijacked_nav_hints.json",
        },
        "coordinateSystem": {
            "source": "T6 z-up",
            "target": "Three.js y-up",
            "position": "(x, y, z) -> (x, z, -y)",
            "modelInstances": "matrix is the R * M * R^-1 conjugation used by compose_scene.py",
        },
        "agent": {
            "radius": 16.0,
            "height": 72.0,
            "maxClimb": 18.0,
            "walkableSlopeAngle": 45.0,
            "cellSize": 4.0,
            "cellHeight": 2.0,
            "units": "T6 world units",
        },
        "mesh": {
            "nodes": len(nodes),
            "meshes": len(gltf.meshes),
            "binBytes": len(gltf.data),
            "world": world_stats,
            "models": {
                "sourceInstances": len(static_models),
                "sourceUniqueModels": len(model_unique_names),
                "withCollLod": len(model_records),
                "collisionMeshes": len(model_mesh_indices),
                "includedInstances": included_instances,
                "skippedInstances": sum(skipped_instances.values()),
                "skippedByReason": dict(sorted(skipped_instances.items())),
                "missingXmodelJson": model_missing_json,
                "withoutCollLod": model_no_coll_lod,
                "missingCollisionObj": model_missing_obj,
                "emptyCollisionObj": model_empty_obj,
                "records": model_records,
            },
        },
        "hints": hints["counts"],
        "notes": [
            "This is a source mesh, not a baked Recast navmesh. Feed it to a Node/Recast baker and serialize the result for runtime use.",
            "BSP clipmap/physics data is not available in the extracted files; world geometry plus xmodel collLod is therefore an approximation.",
            "Render-only materials (distant/water/glass/decal/FX/light-like) are excluded using material-name heuristics; inspect the debug navmesh and adjust filters if needed.",
            "The browser still needs a capsule collision controller; a navmesh only constrains AI/path queries.",
        ],
    }
    source_path = _path(out_dir, "hijacked_collision_source.json")
    with open(source_path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(source_doc, stream, indent=2)
        stream.write("\n")

    stats = {
        "gltf": gltf_path,
        "bin": bin_path,
        "hints": hints_path,
        "source": source_path,
        "world": world_stats,
        "models": source_doc["mesh"]["models"],
        "hintsCounts": hints["counts"],
        "nodes": len(nodes),
        "meshes": len(gltf.meshes),
        "binBytes": len(gltf.data),
    }
    print(
        "collision: %d world tris, %d world verts, %d/%d model instances, %d collision meshes"
        % (
            world_stats["includedTriangles"],
            world_stats["vertices"],
            included_instances,
            len(static_models),
            len(model_mesh_indices),
        )
    )
    print(
        "hints: %d pathnodes, %d off-mesh candidates, %d playable spawns"
        % (
            hints["counts"]["pathnodes"],
            hints["counts"]["offMeshConnections"],
            hints["counts"]["spawns"],
        )
    )
    print(
        "written: hijacked_collision.gltf (%d KB), hijacked_collision.bin (%d KB), "
        "hijacked_nav_hints.json, hijacked_collision_source.json"
        % (os.path.getsize(gltf_path) // 1024, os.path.getsize(bin_path) // 1024)
    )
    return stats


if __name__ == "__main__":
    _root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    export_collision(_root)
