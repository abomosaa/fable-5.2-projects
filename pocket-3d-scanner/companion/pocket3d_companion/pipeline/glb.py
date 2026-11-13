"""Minimal, strict glTF 2.0 binary (GLB) writer/reader for textured scan meshes.

Coordinate system: glTF — right-handed, +Y up, counter-clockwise front faces, UV origin at the
top-left of the image. One mesh, one primitive per texture page. A custom per-vertex attribute
`_CONFIDENCE` (FLOAT scalar, 0..1) carries the reconstruction evidence so the phone can show
weakly supported surface instead of hiding it.
"""
from __future__ import annotations

import json
import struct

import numpy as np

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
FLOAT, UINT32 = 5126, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def _pad4(b: bytes, fill: bytes = b"\x00") -> bytes:
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(path, positions: np.ndarray, normals: np.ndarray, uvs: np.ndarray | None,
              confidence: np.ndarray | None, primitives: list[dict], extras: dict,
              generator: str = "Pocket 3D Scanner companion") -> None:
    """primitives: [{"indices": (M,3) uint32 array, "image": encoded bytes | None,
    "mime": "image/jpeg" | "image/png", "name": str}] — all primitives index the shared vertex
    arrays."""
    positions = np.ascontiguousarray(positions, dtype="<f4")
    normals = np.ascontiguousarray(normals, dtype="<f4")
    n = len(positions)
    assert normals.shape == (n, 3)
    blob = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int | None) -> int:
        while len(blob) % 4:
            blob.append(0)
        v = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            v["target"] = target
        blob.extend(data)
        views.append(v)
        return len(views) - 1

    def add_accessor(arr: np.ndarray, comp: int, type_: str, target: int | None, minmax: bool = False) -> int:
        acc = {"bufferView": add_view(arr.tobytes(), target), "componentType": comp, "count": int(len(arr)),
               "type": type_}
        if minmax:
            acc["min"] = [float(v) for v in arr.min(0)]
            acc["max"] = [float(v) for v in arr.max(0)]
        accessors.append(acc)
        return len(accessors) - 1

    attrs = {"POSITION": add_accessor(positions, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True),
             "NORMAL": add_accessor(normals, FLOAT, "VEC3", ARRAY_BUFFER)}
    if uvs is not None:
        attrs["TEXCOORD_0"] = add_accessor(np.ascontiguousarray(uvs, dtype="<f4"), FLOAT, "VEC2", ARRAY_BUFFER)
    if confidence is not None:
        attrs["_CONFIDENCE"] = add_accessor(np.ascontiguousarray(confidence, dtype="<f4"), FLOAT, "SCALAR", ARRAY_BUFFER)

    images, textures, materials, prims = [], [], [], []
    for p in primitives:
        idx = np.ascontiguousarray(p["indices"], dtype="<u4").reshape(-1)
        if len(idx) == 0:
            continue
        mat: dict = {"name": p.get("name", "scan"), "doubleSided": True,
                     "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0}}
        if p.get("image") is not None and uvs is not None:
            images.append({"bufferView": add_view(p["image"], None), "mimeType": p["mime"],
                           "name": p.get("name", "texture")})
            textures.append({"source": len(images) - 1, "sampler": 0})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
        else:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [0.6, 0.6, 0.6, 1.0]
        materials.append(mat)
        prims.append({"attributes": attrs, "indices": add_accessor(idx, UINT32, "SCALAR", ELEMENT_ARRAY_BUFFER),
                      "material": len(materials) - 1, "mode": 4})
    if not prims:
        raise ValueError("mesh has no faces")
    gltf = {
        "asset": {"version": "2.0", "generator": generator, "extras": extras},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "scan"}],
        "meshes": [{"name": "scan", "primitives": prims}],
        "materials": materials,
        "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    if textures:
        gltf["textures"] = textures
        gltf["images"] = images
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    js = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bin_ = _pad4(bytes(blob))
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), CHUNK_JSON))
        f.write(js)
        f.write(struct.pack("<II", len(bin_), CHUNK_BIN))
        f.write(bin_)


def read_glb(path) -> dict:
    """Small reader used by tests/evaluation for files written by write_glb (and other simple
    GLBs): returns positions, normals, uvs, confidence, faces (all primitives merged), images,
    extras and the raw JSON."""
    data = open(path, "rb").read()
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or total != len(data):
        raise ValueError("not a GLB 2.0 file")
    off = 12
    js = None
    bin_ = b""
    while off < len(data):
        ln, typ = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + ln]
        if typ == CHUNK_JSON:
            js = json.loads(chunk.decode("utf-8"))
        elif typ == CHUNK_BIN:
            bin_ = chunk
        off += 8 + ln
    if js is None:
        raise ValueError("GLB without JSON chunk")

    comp = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

    def acc(i):
        a = js["accessors"][i]
        v = js["bufferViews"][a["bufferView"]]
        dt = np.dtype(comp[a["componentType"]])
        k = ncomp[a["type"]]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride", dt.itemsize * k)
        if stride == dt.itemsize * k:
            arr = np.frombuffer(bin_, dtype=dt, count=a["count"] * k, offset=start).reshape(a["count"], k)
        else:
            arr = np.stack([np.frombuffer(bin_, dtype=dt, count=k, offset=start + j * stride) for j in range(a["count"])])
        return arr[:, 0] if k == 1 else arr

    out = {"json": js, "extras": js.get("asset", {}).get("extras", {}), "primitives": []}
    faces = []
    for mesh in js["meshes"]:
        for p in mesh["primitives"]:
            at = p["attributes"]
            if "positions" not in out:
                out["positions"] = acc(at["POSITION"]).astype(np.float64)
                out["normals"] = acc(at["NORMAL"]).astype(np.float64) if "NORMAL" in at else None
                out["uvs"] = acc(at["TEXCOORD_0"]).astype(np.float64) if "TEXCOORD_0" in at else None
                out["confidence"] = acc(at["_CONFIDENCE"]).astype(np.float64) if "_CONFIDENCE" in at else None
            f = acc(p["indices"]).astype(np.int64).reshape(-1, 3)
            faces.append(f)
            out["primitives"].append({"faces": f, "material": p.get("material")})
    out["faces"] = np.concatenate(faces) if faces else np.zeros((0, 3), dtype=np.int64)
    out["images"] = []
    for im in js.get("images", []):
        v = js["bufferViews"][im["bufferView"]]
        out["images"].append({"mime": im["mimeType"],
                              "bytes": bin_[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]]})
    return out
