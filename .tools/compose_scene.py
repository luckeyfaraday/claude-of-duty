#!/usr/bin/env python3
"""Compose Hijacked world shell + static model instances into a glTF scene."""
import json, os, re, struct, sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = f"{ROOT}/export/web"

# ---------- binary buffer helpers ----------
class Buf:
    def __init__(self):
        self.data = bytearray()
    def f32(self, arr):
        self.data += struct.pack(f"<{len(arr)}f", *arr)
        return len(arr) * 4
    def u32(self, arr):
        self.data += struct.pack(f"<{len(arr)}I", *arr)
        return len(arr) * 4
    def view(self, byteOffset, byteLength, count, ctype, comps):
        comp_size = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[comps]
        return {
            "buffer": 0, "byteOffset": byteOffset, "byteLength": byteLength,
            "componentType": ctype, "count": count, "type": comps,
            "min": None, "max": None,
        }

buf = Buf()
accessors = []
bufferViews = []
materials = []
textures = []
images = []
samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
tex_cache = {}
meshes = []

def add_accessor_f32(flat, comps, minmax=True):
    off = len(buf.data)
    n = buf.f32(flat)
    acc = {"bufferView": len(bufferViews), "componentType": 5126, "count": len(flat)//{"VEC3":3,"VEC2":2}[comps], "type": comps}
    bv = {"buffer": 0, "byteOffset": off, "byteLength": n}
    if minmax:
        c = {"VEC3":3,"VEC2":2}[comps]
        mn = [min(flat[i::c]) for i in range(c)]
        mx = [max(flat[i::c]) for i in range(c)]
        acc["min"], acc["max"] = mn, mx
    bufferViews.append(bv)
    accessors.append(acc)
    return len(accessors) - 1

def add_accessor_u32(flat):
    off = len(buf.data)
    n = buf.u32(flat)
    bufferViews.append({"buffer": 0, "byteOffset": off, "byteLength": n})
    accessors.append({"bufferView": len(bufferViews)-1, "componentType": 5125, "count": len(flat), "type": "SCALAR"})
    return len(accessors) - 1

def add_texture(png_name):
    if png_name in tex_cache:
        return tex_cache[png_name]
    images.append({"uri": "textures/" + quote(png_name)})
    textures.append({"sampler": 0, "source": len(images)-1})
    tex_cache[png_name] = len(textures)-1
    return tex_cache[png_name]

def add_material(mat_name, tex_png):
    key = (mat_name, tex_png)
    for i, m in enumerate(materials):
        if m.get("_key") == key:
            return i
    mat = {
        "_key": key, "name": mat_name[:60],
        "pbrMetallicRoughness": {"baseColorFactor": [1,1,1,1], "metallicFactor": 0.0, "roughnessFactor": 0.9},
        "doubleSided": True,
    }
    if tex_png:
        mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": add_texture(tex_png)}
    materials.append(mat)
    return len(materials)-1

def add_mesh(name, prims):
    """prims: list of (positions, uvs, normals, indices, mat_idx)"""
    P = []
    for pos, uv, nrm, idx, mi in prims:
        vertex_count = len(pos) // 3
        assert len(pos) % 3 == 0, f"{name}: malformed position data"
        assert len(uv) == vertex_count * 2, f"{name}: UV count does not match positions"
        assert len(nrm) == vertex_count * 3, f"{name}: normal count does not match positions"
        assert not idx or max(idx) < vertex_count, f"{name}: index exceeds vertex count"
        P.append({
            "attributes": {
                "POSITION": add_accessor_f32(pos, "VEC3"),
                "TEXCOORD_0": add_accessor_f32(uv, "VEC2"),
                "NORMAL": add_accessor_f32(nrm, "VEC3"),
            },
            "indices": add_accessor_u32(idx),
            "material": mi,
            "mode": 4,
        })
    meshes.append({"name": name[:60], "primitives": P})
    return len(meshes)-1

# ---------- world shell ----------
print("loading world shell...")
d = json.load(open(f"{ROOT}/export/maps/mp/mp_hijacked.d3dbsp.gfxworld.json"))
raw0 = open(f"{ROOT}/export/maps/mp/mp_hijacked.d3dbsp.gfxworld.vd0","rb").read()
idx = struct.unpack(f"<{d['indexCount']}H", open(f"{ROOT}/export/maps/mp/mp_hijacked.d3dbsp.gfxworld.idx","rb").read())
S = d["surfaces"]; M = d["materials"]

vcache = {}      # byte offset -> (vert tuple)
world_by_mat = {}  # mat key -> list of faces

for s in S:
    mname = M[s["m"]]["name"]
    if "distant" in mname:
        continue
    tex = M[s["m"]]["colorMap"]
    tex_png = (tex + ".png") if tex else None
    mi = add_material(mname, tex_png)
    faces = world_by_mat.setdefault(mi, [])
    for t in range(0, s["tc"]*3, 3):
        tri = idx[s["bi"]+t : s["bi"]+t+3]
        pts = []
        for i in tri:
            off = s["o0"] + i*36
            e = vcache.get(off)
            if e is None:
                x, y, z = struct.unpack_from("<3f", raw0, off)
                u, v = struct.unpack_from("<2e", raw0, off+20)   # f16 texcoords
                e = ((x, z, -y), (u, v))                          # game z-up -> glTF y-up; UV already top-left
                vcache[off] = e
            pts.append(e)
        faces.append(pts)

# flat normals + primitive build
def build_prim(faces):
    pos, uv, nrm, ind = [], [], [], []
    vmap = {}
    for pts in faces:
        (ax,ay,az),(bx,by,bz),(cx,cy,cz) = (p[0] for p in pts)
        ux,uy,uz = bx-ax, by-ay, bz-az
        vx,vy,vz = cx-ax, cy-ay, cz-az
        nx,ny,nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
        l = (nx*nx+ny*ny+nz*nz) ** 0.5 or 1.0
        nx,ny,nz = nx/l, ny/l, nz/l
        base = len(pos) // 3
        for (p, t) in pts:
            pos += [p[0], p[1], p[2]]
            uv += [t[0], t[1]]
            nrm += [nx, ny, nz]
        ind += [base, base+1, base+2]
    return pos, uv, nrm, ind

prims = []
for mi, faces in world_by_mat.items():
    pos, uv, nrm, ind = build_prim(faces)
    prims.append((pos, uv, nrm, ind, mi))
world_mesh = add_mesh("world_shell", prims)
print(f"world: {len(prims)} primitives, {sum(len(f) for f in world_by_mat.values())} tris")

# ---------- static models ----------
print("loading models...")
model_meshes = {}   # model name -> mesh idx
obj_dir = f"{ROOT}/export/model_export"

def parse_obj(path):
    V, VT, VN = [], [], []
    groups = {}   # mtl -> list of (a,b,c) index triples (1-based tuples)
    cur = None
    for line in open(path, errors="ignore"):
        if line.startswith("v "):
            V.append(tuple(float(x) for x in line.split()[1:4]))
        elif line.startswith("vt "):
            t = line.split()[1:3]
            VT.append(tuple(float(x) for x in t))
        elif line.startswith("vn "):
            VN.append(tuple(float(x) for x in line.split()[1:4]))
        elif line.startswith("usemtl "):
            cur = line.split(None, 1)[1].strip()
            groups.setdefault(cur, [])
        elif line.startswith("f "):
            vs = []
            for tok in line.split()[1:]:
                seg = tok.split("/")
                vi = int(seg[0]); vi = vi-1 if vi > 0 else len(V)+vi
                ti = int(seg[1])-1 if len(seg) > 1 and seg[1] else 0
                ni = int(seg[2])-1 if len(seg) > 2 and seg[2] else 0
                vs.append((vi, ti, ni))
            for k in range(1, len(vs)-1):
                groups[cur].append((vs[0], vs[k], vs[k+1]))
    return V, VT, VN, groups

def model_to_mesh(name):
    obj = f"{obj_dir}/{name}_lod0.obj"
    V, VT, VN, groups = parse_obj(obj)
    mtl_map = {}
    mtl_path = f"{obj_dir}/{name}.mtl"
    if os.path.exists(mtl_path):
        cur = None
        for line in open(mtl_path, errors="ignore"):
            if line.startswith("newmtl "):
                cur = line.split(None, 1)[1].strip()
            elif line.startswith("map_Kd ") and cur:
                raw = line.split(None, 1)[1].strip()
                base = os.path.basename(raw)
                if base.lower().endswith(".dds"):
                    mtl_map[cur] = base[:-4] + ".png"
    prims = []
    for mtl, faces in groups.items():
        if not faces:
            continue
        tex_png = mtl_map.get(mtl)
        mi = add_material(f"{name}:{mtl}", tex_png)
        pos, uv, nrm, ind = [], [], [], []
        vmap = {}
        for (a, b, c) in faces:
            base = len(pos) // 3
            for (vi, ti, ni) in (a, b, c):
                x, y, z = V[vi]
                pos += [x, y, z]
                if VT: u, v = VT[ti]; uv += [u, 1.0-v]
                else: uv += [0, 0]
                if VN and ni < len(VN): nx, ny, nz = VN[ni]; nrm += [nx, ny, nz]
                else: nrm += [0, 1, 0]
            ind += [base, base+1, base+2]
        prims.append((pos, uv, nrm, ind, mi))
    if not prims:
        return None
    return add_mesh(name, prims)

dj = json.load(open(f"{ROOT}/export/maps/mp/mp_hijacked.d3dbsp.gfxworld.json"))
sm = dj["staticModels"]

nodes = [{"mesh": world_mesh, "name": "world_shell"}]
missing = set()
for inst in sm:
    name = inst["model"]
    if name not in model_meshes:
        if not os.path.exists(f"{obj_dir}/{name}_lod0.obj"):
            missing.add(name); model_meshes[name] = None
        else:
            model_meshes[name] = model_to_mesh(name)
    mi = model_meshes[name]
    if mi is None:
        continue
    o = inst["origin"]; scale = inst["scale"]
    # game z-up -> glTF y-up: R(x,y,z)=(x,z,-y); conjugate placement: T = R*M*R^-1
    # => linear columns [R*A0, R*A2, -R*A1], translation R*O
    def rot(v): return [v[0], v[2], -v[1]]
    cols = [rot(inst["axis0"]), rot(inst["axis2"]), [-c for c in rot(inst["axis1"])], rot(o)]
    mat = []
    for k in range(3):
        mat += [c * scale for c in cols[k]] + [0.0]
    mat += cols[3] + [1.0]
    nodes.append({"mesh": mi, "matrix": mat, "name": f"i_{name}"[:60]})

print(f"instances: {len(sm)}, unique models: {len(model_meshes)}, missing obj: {len(missing)}")

# ---------- write gltf ----------
gltf = {
    "asset": {"version": "2.0", "generator": "hijacked-compose"},
    "scene": 0,
    "scenes": [{"nodes": list(range(len(nodes)))}],
    "nodes": nodes,
    "meshes": meshes,
    "materials": [{k: v for k, v in m.items() if k != "_key"} for m in materials],
    "textures": textures,
    "images": images,
    "samplers": samplers,
    "accessors": accessors,
    "bufferViews": bufferViews,
    "buffers": [{"uri": "hijacked.bin", "byteLength": len(buf.data)}],
}
os.makedirs(OUT, exist_ok=True)
with open(f"{OUT}/hijacked.gltf", "w") as f:
    json.dump(gltf, f, separators=(",", ":"))
with open(f"{OUT}/hijacked.bin", "wb") as f:
    f.write(buf.data)
print(f"written: hijacked.gltf ({os.path.getsize(f'{OUT}/hijacked.gltf')//1024} KB), hijacked.bin ({len(buf.data)//1024//1024} MB)")
print(f"materials: {len(materials)}, textures used: {len(textures)}, meshes: {len(meshes)}")
