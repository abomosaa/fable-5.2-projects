#!/usr/bin/env python3
"""Independent, reader-based verification of Mechanism Workshop exports.

This script never imports or executes any of the project's TypeScript. It only
reads the exported files with third-party readers (trimesh, ezdxf, lxml) and
the Python standard library, and compares what it measures against the
EXPECTED values recorded in each project's manifest.json (which the exporter
computed from the parametric model, not from the exported bytes).

Setup:
    uv venv .venv && uv pip install --python .venv/bin/python -r scripts/requirements-verify.txt
Usage:
    .venv/bin/python -I scripts/verify_exports.py <outDir> [--report docs/verification/exports.md]

Exit code 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

import ezdxf
import networkx as nx
import numpy as np
import trimesh
from ezdxf import bbox as dxf_bbox
from lxml import etree as LET
from lxml import html as LHTML

# --------------------------------------------------------------------------- tolerances

TOL_VOLUME_REL = 0.005      # 0.5 % on volume
TOL_BBOX_MM = 0.02          # mm on bounding-box extents (STL, 3MF, DXF, SVG paths)
TOL_HOLE_POS_MM = 0.001     # mm on hole centres (DXF CIRCLE / POINT, SVG marks)
TOL_HOLE_RAD_MM = 0.001     # mm on hole radius / diameter in DXF and SVG
TOL_HOLE_MESH_MM = 0.005    # mm on hole radius measured on the float32 STL mesh
TOL_Z0_MM = 1e-4            # mm: part must rest on z = 0
TOL_DIM_MM = 0.001          # mm on dimension values embedded in drawings
TOL_NORMAL = 1e-3           # 1 - cos(angle) between stored and computed facet normals
TOL_DXF_AREA_REL = 0.005    # 0.5 % on (profile area x thickness) vs expected volume

TOLERANCES = [
    ("volume (STL, 3MF objects)", f"{TOL_VOLUME_REL * 100:g} % relative"),
    ("bounding-box extents (STL, 3MF, DXF, SVG)", f"{TOL_BBOX_MM:g} mm"),
    ("hole centre (DXF CIRCLE/POINT, SVG marks)", f"{TOL_HOLE_POS_MM:g} mm"),
    ("hole radius / diameter (DXF, SVG)", f"{TOL_HOLE_RAD_MM:g} mm"),
    ("hole radius measured on the STL mesh", f"{TOL_HOLE_MESH_MM:g} mm"),
    ("lowest point of an exported part (must be z = 0)", f"{TOL_Z0_MM:g} mm"),
    ("drawing dimension values (data-value)", f"{TOL_DIM_MM:g} mm"),
    ("stored vs computed STL facet normal (1 - cos)", f"{TOL_NORMAL:g}"),
    ("DXF profile area x thickness vs expected volume", f"{TOL_DXF_AREA_REL * 100:g} % relative"),
]

SVG_NS = "http://www.w3.org/2000/svg"
CORE_3MF_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
ALLOWED_SCALES = {"5:1": 5.0, "2:1": 2.0, "1:1": 1.0, "1:2": 0.5, "1:5": 0.2,
                  "1:10": 0.1, "1:20": 0.05, "1:50": 0.02, "1:100": 0.01}


# --------------------------------------------------------------------------- bookkeeping

@dataclass
class Check:
    project: str
    item: str
    kind: str
    name: str
    ok: bool
    measured: str
    expected: str
    tol: str


class Recorder:
    def __init__(self) -> None:
        self.checks: list[Check] = []
        self.project = ""

    def add(self, item: str, kind: str, name: str, ok: bool, measured="", expected="", tol="") -> bool:
        c = Check(self.project, item, kind, name, bool(ok), str(measured), str(expected), str(tol))
        self.checks.append(c)
        detail = []
        if c.measured != "":
            detail.append(f"measured {c.measured}")
        if c.expected != "":
            detail.append(f"expected {c.expected}")
        if c.tol != "":
            detail.append(f"tol {c.tol}")
        print(f"{'PASS' if c.ok else 'FAIL'} [{c.project}] {item} | {kind}: {name}" + (" | " + " | ".join(detail) if detail else ""))
        return c.ok

    def guard(self, item: str, kind: str, name: str, fn):
        """Run fn(); an exception is recorded as a failed check instead of aborting the run."""
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - any reader error is a verification failure
            self.add(item, kind, name, False, f"{type(exc).__name__}: {exc}", "no error")
            return None


def fnum(v: float, digits: int = 4) -> str:
    return f"{v:.{digits}f}".rstrip("0").rstrip(".") if abs(v) < 1e15 else str(v)


def fvec(v, digits: int = 4) -> str:
    return "[" + ", ".join(fnum(float(x), digits) for x in v) + "]"


def match_points(measured: list[tuple], expected: list[tuple], tols: tuple) -> tuple[bool, float]:
    """One-to-one matching of tuples (greedy nearest); returns (ok, worst deviation of the first two fields)."""
    if len(measured) != len(expected):
        return False, float("inf")
    remaining = list(measured)
    worst = 0.0
    for e in expected:
        best_i, best_d = -1, float("inf")
        for i, m in enumerate(remaining):
            if all(abs(m[k] - e[k]) <= tols[k] for k in range(len(e))):
                d = max(abs(m[k] - e[k]) for k in range(len(e)))
                if d < best_d:
                    best_i, best_d = i, d
        if best_i < 0:
            return False, float("inf")
        worst = max(worst, best_d)
        remaining.pop(best_i)
    return True, worst


# --------------------------------------------------------------------------- STL

def read_stl_raw(path: Path):
    """Parse binary STL with the standard library + numpy only."""
    data = path.read_bytes()
    if len(data) < 84:
        raise ValueError("file shorter than the 84-byte binary STL preamble")
    header = data[:80]
    (count,) = struct.unpack_from("<I", data, 80)
    rec = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    if len(data) != 84 + 50 * count:
        raise ValueError(f"size {len(data)} != 84 + 50*{count}")
    tris = np.frombuffer(data, dtype=rec, count=count, offset=84)
    return header, count, tris


def body_count(mesh: trimesh.Trimesh) -> int:
    g = nx.Graph()
    g.add_nodes_from(range(len(mesh.faces)))
    g.add_edges_from(np.asarray(mesh.face_adjacency).tolist())
    return nx.number_connected_components(g)


def edge_manifold_stats(faces: np.ndarray) -> tuple[int, int]:
    """(open edges, non-manifold or inconsistently wound edges) from directed-edge counting."""
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    nv = int(faces.max()) + 1 if len(faces) else 0
    key = e[:, 0].astype(np.int64) * nv + e[:, 1].astype(np.int64)
    rkey = e[:, 1].astype(np.int64) * nv + e[:, 0].astype(np.int64)
    uniq, counts = np.unique(key, return_counts=True)
    dup = int(np.sum(counts > 1))
    has_opposite = np.isin(uniq, rkey)
    return int(np.sum(~has_opposite & (counts == 1))), dup


def check_mesh_common(rec: Recorder, item: str, kind: str, mesh: trimesh.Trimesh, exp_volume, exp_size, exp_genus, exp_bodies) -> None:
    rec.add(item, kind, "watertight (trimesh.is_watertight)", mesh.is_watertight, mesh.is_watertight, True)
    rec.add(item, kind, "winding consistent (trimesh.is_winding_consistent)", mesh.is_winding_consistent, mesh.is_winding_consistent, True)
    open_e, bad_e = edge_manifold_stats(np.asarray(mesh.faces))
    rec.add(item, kind, "every edge shared by exactly two oppositely wound faces (numpy)", open_e == 0 and bad_e == 0,
            f"{open_e} open, {bad_e} non-manifold", "0 open, 0 non-manifold")
    areas = mesh.area_faces
    rec.add(item, kind, "no degenerate (zero-area) faces", int(np.sum(areas <= 1e-12)) == 0, int(np.sum(areas <= 1e-12)), 0)
    vol = float(mesh.volume)
    if exp_volume is not None:
        rel = abs(vol - exp_volume) / exp_volume if exp_volume else float("inf")
        rec.add(item, kind, "volume mm^3 (positive, outward normals)", vol > 0 and rel <= TOL_VOLUME_REL,
                f"{fnum(vol, 3)} (dev {rel * 100:.4f} %)", fnum(exp_volume, 3), f"{TOL_VOLUME_REL * 100:g} %")
    if exp_size is not None:
        ext = np.asarray(mesh.extents, dtype=float)
        dev = float(np.max(np.abs(ext - np.asarray(exp_size, dtype=float))))
        rec.add(item, kind, "bounding-box extents mm", dev <= TOL_BBOX_MM, f"{fvec(ext)} (dev {dev:.5f})", fvec(exp_size), f"{TOL_BBOX_MM:g} mm")
    bodies = body_count(mesh)
    want_bodies = exp_bodies if exp_bodies is not None else 1
    rec.add(item, kind, "body count (connected components)", bodies == want_bodies, bodies, want_bodies)
    if exp_genus is not None:
        want_euler = 2 * want_bodies - 2 * exp_genus
        rec.add(item, kind, f"Euler number V-E+F (genus {exp_genus})", int(mesh.euler_number) == want_euler, int(mesh.euler_number), want_euler)


def verify_stl(rec: Recorder, item: str, path: Path, exp: dict) -> dict:
    kind = "STL"
    measured: dict = {}
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return measured
    raw = rec.guard(item, kind, "binary STL structure", lambda: read_stl_raw(path))
    if raw is None:
        return measured
    header, count, tris = raw
    rec.add(item, kind, "size = 84 + 50 x triangles", True, f"{path.stat().st_size} bytes, {count} triangles", f"{84 + 50 * count} bytes")
    rec.add(item, kind, "header states units=mm and is not ASCII-STL 'solid'", b"units=mm" in header and not header.lstrip().lower().startswith(b"solid"),
            header.rstrip(b"\x00 ").decode("ascii", "replace"), "contains 'units=mm'")
    if exp.get("triangles") is not None:
        rec.add(item, kind, "triangle count", count == exp["triangles"], count, exp["triangles"])
    # stored normals vs normals computed from the winding
    v = tris["v"].astype(np.float64)
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    ln = np.linalg.norm(n, axis=1)
    stored = tris["n"].astype(np.float64)
    ls = np.linalg.norm(stored, axis=1)
    good = ln > 0
    cosang = np.ones(len(n))
    cosang[good] = np.einsum("ij,ij->i", n[good] / ln[good][:, None], stored[good]) / np.where(ls[good] > 0, ls[good], 1)
    worst = float(np.max(1 - cosang)) if len(cosang) else 0.0
    unit = float(np.max(np.abs(ls[good] - 1))) if np.any(good) else 0.0
    rec.add(item, kind, "facet normals are unit length and match the right-hand winding", worst <= TOL_NORMAL and unit <= 1e-4,
            f"max(1-cos) {worst:.2e}, max |len-1| {unit:.2e}", "0", f"{TOL_NORMAL:g}")

    def load():
        m = trimesh.load(str(path), file_type="stl", process=False)  # no repair, no hidden processing
        if not isinstance(m, trimesh.Trimesh):
            raise TypeError(f"expected a single mesh, got {type(m).__name__}")
        return m

    mesh = rec.guard(item, kind, "trimesh.load(process=False)", load)
    if mesh is None:
        return measured
    soup_vertices = len(mesh.vertices)
    mesh.merge_vertices()  # explicit weld of coincident STL corners; nothing else is altered
    rec.add(item, kind, "loaded without processing, vertices welded explicitly", len(mesh.faces) == count,
            f"{soup_vertices} -> {len(mesh.vertices)} vertices, {len(mesh.faces)} faces", f"{count} faces")
    check_mesh_common(rec, item, kind, mesh, exp.get("volume"), exp.get("bboxSize"), exp.get("genus"), exp.get("bodies"))
    zmin = float(mesh.bounds[0][2])
    rec.add(item, kind, "part rests on z = 0", abs(zmin) <= TOL_Z0_MM, fnum(zmin, 6), 0, f"{TOL_Z0_MM:g} mm")
    if exp.get("bboxXY") is not None:
        b = mesh.bounds
        got = [b[0][0], b[0][1], b[1][0], b[1][1]]
        dev = max(abs(a - e) for a, e in zip(got, exp["bboxXY"]))
        rec.add(item, kind, "XY bounds in part-local coordinates", dev <= TOL_BBOX_MM, f"{fvec(got)} (dev {dev:.5f})", fvec(exp["bboxXY"]), f"{TOL_BBOX_MM:g} mm")
    xy = np.asarray(mesh.vertices)[:, :2]
    if exp.get("maxRadiusXY") is not None:
        rmax = float(np.max(np.hypot(xy[:, 0], xy[:, 1])))
        rec.add(item, kind, "largest radius about the part axis (tip / flange / disc radius)", abs(rmax - exp["maxRadiusXY"]) <= TOL_BBOX_MM,
                fnum(rmax, 5), fnum(exp["maxRadiusXY"], 5), f"{TOL_BBOX_MM:g} mm")
    holes = exp.get("holes") or []
    if holes:
        worst_h = 0.0
        for h in holes:
            rmin = float(np.min(np.hypot(xy[:, 0] - h["x"], xy[:, 1] - h["y"])))
            worst_h = max(worst_h, abs(rmin - h["d"] / 2))
        rec.add(item, kind, f"{len(holes)} hole(s): nearest mesh vertex to each hole axis is at d/2", worst_h <= TOL_HOLE_MESH_MM,
                f"worst radius dev {worst_h:.6f}", "0", f"{TOL_HOLE_MESH_MM:g} mm")
    measured.update(volume=float(mesh.volume), extents=[float(x) for x in mesh.extents], triangles=count,
                    watertight=bool(mesh.is_watertight), euler=int(mesh.euler_number))
    return measured


# --------------------------------------------------------------------------- 3MF

def verify_3mf(rec: Recorder, path: Path, exp: dict) -> None:
    item, kind = path.name, "3MF"
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return
    objects_exp = exp.get("objects", [])

    def read_xml():
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                raise ValueError(f"corrupt zip member {bad}")
            names = z.namelist()
            lower = {n.lower(): n for n in names}
            need = ["[content_types].xml", "_rels/.rels", "3d/3dmodel.model"]
            missing = [n for n in need if n not in lower]
            ct = z.read(lower["[content_types].xml"]).decode("utf-8") if "[content_types].xml" in lower else ""
            rels = z.read(lower["_rels/.rels"]).decode("utf-8") if "_rels/.rels" in lower else ""
            model = z.read(lower["3d/3dmodel.model"]) if "3d/3dmodel.model" in lower else b""
        return names, missing, ct, rels, model

    got = rec.guard(item, kind, "zip package readable", read_xml)
    if got is None:
        return
    names, missing, ct, rels, model = got
    rec.add(item, kind, "package parts [Content_Types].xml, _rels/.rels, 3D/3dmodel.model", not missing, ", ".join(names), "all three present")
    rec.add(item, kind, "content types declare the 3dmodel part", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" in ct, "declared" if "3dmanufacturing-3dmodel+xml" in ct else "missing", "declared")
    rel_ok = False
    try:
        for r in ET.fromstring(rels):
            if r.attrib.get("Type", "").endswith("/3dmodel") and r.attrib.get("Target", "").lstrip("/").lower() == "3d/3dmodel.model":
                rel_ok = True
    except ET.ParseError:
        rel_ok = False
    rec.add(item, kind, "root relationship points at /3D/3dmodel.model", rel_ok, rel_ok, True)
    if not model:
        return
    root = rec.guard(item, kind, "model XML well-formed (xml.etree)", lambda: ET.fromstring(model))
    if root is None:
        return
    ns = {"m": CORE_3MF_NS}
    rec.add(item, kind, "root element is core-namespace <model>", root.tag == f"{{{CORE_3MF_NS}}}model", root.tag, f"{{{CORE_3MF_NS}}}model")
    rec.add(item, kind, "unit attribute (stdlib XML parse)", root.attrib.get("unit") == "millimeter", root.attrib.get("unit"), "millimeter")
    objs = root.findall("m:resources/m:object", ns)
    rec.add(item, kind, "object count", len(objs) == len(objects_exp), len(objs), len(objects_exp))
    got_names = [(o.attrib.get("name"), o.attrib.get("partnumber")) for o in objs]
    want_names = [(o["name"], o["partNumber"]) for o in objects_exp]
    rec.add(item, kind, "object names / part numbers (in order)", got_names == want_names,
            "; ".join(f"{p}={n}" for n, p in got_names), "; ".join(f"{p}={n}" for n, p in want_names))
    rec.add(item, kind, "every object is type=model", all(o.attrib.get("type") == "model" for o in objs), sorted({o.attrib.get("type") for o in objs}), ["model"])
    idx_ok, tri_ok = True, True
    for o, e in zip(objs, objects_exp):
        nv = len(o.findall("m:mesh/m:vertices/m:vertex", ns))
        tris = o.findall("m:mesh/m:triangles/m:triangle", ns)
        if e.get("triangles") is not None and len(tris) != e["triangles"]:
            tri_ok = False
        for t in tris:
            if not all(0 <= int(t.attrib[k]) < nv for k in ("v1", "v2", "v3")):
                idx_ok = False
                break
    rec.add(item, kind, "triangle counts per object", tri_ok, tri_ok, True)
    rec.add(item, kind, "all triangle indices reference existing vertices", idx_ok, idx_ok, True)
    ids = {o.attrib.get("id") for o in objs}
    items = root.findall("m:build/m:item", ns)
    rec.add(item, kind, "build items reference each object once", sorted(i.attrib.get("objectid") for i in items) == sorted(ids), len(items), len(ids))
    rec.add(item, kind, "build item part numbers", [i.attrib.get("partnumber") for i in items] == [o["partNumber"] for o in objects_exp],
            " ".join(str(i.attrib.get("partnumber")) for i in items), " ".join(o["partNumber"] for o in objects_exp))

    def load_scene():
        s = trimesh.load(str(path), file_type="3mf", process=False)
        if not isinstance(s, trimesh.Scene):
            s = trimesh.Scene(s)
        return s

    scene = rec.guard(item, kind, "trimesh.load as scene (process=False)", load_scene)
    if scene is None:
        return
    rec.add(item, kind, "scene geometry count (trimesh)", len(scene.geometry) == len(objects_exp), len(scene.geometry), len(objects_exp))
    units = {str(g.metadata.get("units")) for g in scene.geometry.values()}
    rec.add(item, kind, "units reported by trimesh", units == {"millimeter"}, sorted(units), ["millimeter"])
    by_pn: dict[str, trimesh.Trimesh] = {}
    for node in scene.graph.nodes_geometry:
        _tf, gname = scene.graph[node]
        by_pn[str(node)] = scene.geometry[gname]
    rec.add(item, kind, "scene nodes carry the part numbers", sorted(by_pn) == sorted(o["partNumber"] for o in objects_exp),
            " ".join(sorted(by_pn)), " ".join(sorted(o["partNumber"] for o in objects_exp)))
    for e in objects_exp:
        g = by_pn.get(e["partNumber"])
        sub = f"{path.name} / {e['partNumber']} {e['name']}"
        if g is None:
            rec.add(sub, kind, "geometry present", False, "missing", "present")
            continue
        check_mesh_common(rec, sub, kind, g, e.get("volume"), e.get("bboxSize"), None, None)


# --------------------------------------------------------------------------- DXF

def poly_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return a / 2


def verify_dxf(rec: Recorder, item: str, path: Path, exp: dict) -> dict:
    kind = "DXF"
    measured: dict = {}
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return measured
    doc = rec.guard(item, kind, "ezdxf.readfile (no recovery mode)", lambda: ezdxf.readfile(str(path)))
    if doc is None:
        return measured
    rec.add(item, kind, "ezdxf.readfile (no recovery mode)", True, doc.dxfversion, "loads")
    auditor = doc.audit()
    rec.add(item, kind, "ezdxf audit: no errors", len(auditor.errors) == 0, f"{len(auditor.errors)} errors, {len(auditor.fixes)} fixes", "0 errors")
    insunits = doc.header.get("$INSUNITS", None)
    rec.add(item, kind, "$INSUNITS == 4 (millimetres)", insunits == 4, insunits, 4)
    layers = {l.dxf.name for l in doc.layers}
    want_layers = exp.get("dxfLayers") or ["CUT_OUTER", "CUT_INNER", "HOLE_CENTRES"]
    missing = [l for l in want_layers if l not in layers]
    rec.add(item, kind, "required layers present", not missing, ", ".join(sorted(layers - {"0", "Defpoints"})), ", ".join(want_layers))
    msp = doc.modelspace()
    types = sorted({e.dxftype() for e in msp})
    rec.add(item, kind, "entity types limited to POLYLINE / LWPOLYLINE / CIRCLE / POINT", set(types) <= {"POLYLINE", "LWPOLYLINE", "CIRCLE", "POINT"}, types, "subset")
    stray = sorted({e.dxf.layer for e in msp} - set(want_layers))
    rec.add(item, kind, "all entities on the declared layers", not stray, stray or "none", "none")
    polys = [e for e in msp if e.dxftype() in ("POLYLINE", "LWPOLYLINE")]
    closed = [bool(e.is_closed) if e.dxftype() == "POLYLINE" else bool(e.closed) for e in polys]
    rec.add(item, kind, "all polylines closed", all(closed), f"{sum(closed)}/{len(closed)} closed", "all")

    def pts_of(e):
        if e.dxftype() == "POLYLINE":
            return [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        return [(p[0], p[1]) for p in e.get_points("xy")]

    outer = [pts_of(e) for e in polys if e.dxf.layer == "CUT_OUTER"]
    inner = [pts_of(e) for e in polys if e.dxf.layer == "CUT_INNER"]
    rec.add(item, kind, "at least 3 vertices in every polyline", all(len(pts_of(e)) >= 3 for e in polys), min((len(pts_of(e)) for e in polys), default=0), ">= 3")
    if exp.get("dxfPrimaryOuterLoops") is not None:
        rec.add(item, kind, "outer loops on CUT_OUTER", len(outer) == exp["dxfPrimaryOuterLoops"], len(outer), exp["dxfPrimaryOuterLoops"])
        rec.add(item, kind, "non-circular inner loops on CUT_INNER", len(inner) == exp["dxfPrimaryInnerLoops"], len(inner), exp["dxfPrimaryInnerLoops"])
    holes = exp.get("holes") or []
    circles = [(c.dxf.center.x, c.dxf.center.y, c.dxf.radius) for c in msp if c.dxftype() == "CIRCLE" and c.dxf.layer == "CUT_INNER"]
    ok, worst = match_points(circles, [(h["x"], h["y"], h["d"] / 2) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM, TOL_HOLE_RAD_MM))
    rec.add(item, kind, "CIRCLE entities on CUT_INNER = expected holes (centre, radius)", ok,
            f"{len(circles)} circles" + (f", worst dev {worst:.2e}" if ok else ""), f"{len(holes)} holes", f"{TOL_HOLE_POS_MM:g} mm")
    points = [(p.dxf.location.x, p.dxf.location.y) for p in msp if p.dxftype() == "POINT" and p.dxf.layer == "HOLE_CENTRES"]
    ok, worst = match_points(points, [(h["x"], h["y"]) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM))
    rec.add(item, kind, "POINT entities on HOLE_CENTRES = expected hole centres", ok,
            f"{len(points)} points" + (f", worst dev {worst:.2e}" if ok else ""), f"{len(holes)} holes", f"{TOL_HOLE_POS_MM:g} mm")
    want = exp.get("bboxXY")
    if want is not None:
        ext = dxf_bbox.extents(msp)
        if ext.has_data:
            got = [ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y]
            dev = max(abs(a - b) for a, b in zip(got, want))
            rec.add(item, kind, "drawing extents (entities) = expected XY bbox", dev <= TOL_BBOX_MM, f"{fvec(got)} (dev {dev:.5f})", fvec(want), f"{TOL_BBOX_MM:g} mm")
            measured["extents"] = got
        else:
            rec.add(item, kind, "drawing extents (entities) = expected XY bbox", False, "no entities", fvec(want))
        hmin, hmax = doc.header.get("$EXTMIN"), doc.header.get("$EXTMAX")
        got_h = [hmin[0], hmin[1], hmax[0], hmax[1]]
        dev = max(abs(a - b) for a, b in zip(got_h, want))
        rec.add(item, kind, "$EXTMIN/$EXTMAX header = expected XY bbox", dev <= TOL_BBOX_MM, f"{fvec(got_h)} (dev {dev:.5f})", fvec(want), f"{TOL_BBOX_MM:g} mm")
    # orientation-independent area cross-check for single-layer parts
    single_layer = set(want_layers) <= {"CUT_OUTER", "CUT_INNER", "HOLE_CENTRES"}
    if single_layer and exp.get("volume") and exp.get("bboxSize"):
        area = sum(abs(poly_area(p)) for p in outer) - sum(abs(poly_area(p)) for p in inner) - sum(math.pi * r * r for _, _, r in circles)
        vol = area * exp["bboxSize"][2]
        rel = abs(vol - exp["volume"]) / exp["volume"]
        rec.add(item, kind, "profile area x thickness = expected volume", rel <= TOL_DXF_AREA_REL,
                f"{fnum(vol, 3)} (dev {rel * 100:.4f} %)", fnum(exp["volume"], 3), f"{TOL_DXF_AREA_REL * 100:g} %")
        measured["area"] = area
    measured["circles"] = len(circles)
    return measured


# --------------------------------------------------------------------------- SVG helpers

def parse_svg(rec: Recorder, item: str, kind: str, path: Path):
    def load():
        parser = LET.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
        return LET.parse(str(path), parser).getroot()

    root = rec.guard(item, kind, "well-formed XML (lxml)", load)
    if root is None:
        return None
    rec.add(item, kind, "well-formed XML with <svg> root in the SVG namespace", root.tag == f"{{{SVG_NS}}}svg", LET.QName(root).localname, "svg")
    return root


def has_class(el, cls: str) -> bool:
    return cls in (el.get("class") or "").split()


def by_class(root, tag: str, cls: str):
    return [e for e in root.iter(f"{{{SVG_NS}}}{tag}") if has_class(e, cls)]


def mm_attr(v: str | None) -> float | None:
    m = re.fullmatch(r"\s*([-+0-9.eE]+)mm\s*", v or "")
    return float(m.group(1)) if m else None


def path_points(d: str) -> tuple[list[tuple[float, float]], bool]:
    """Points of a path that uses only absolute M/L/Z; second value: every subpath is closed."""
    if re.search(r"[^MLZ0-9eE+\-.,\s]", d):
        raise ValueError("path uses commands other than absolute M/L/Z")
    nums = [float(x) for x in re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d)]
    pts = list(zip(nums[0::2], nums[1::2]))
    closed = d.count("M") == d.count("Z") and d.count("M") > 0
    return pts, closed


def no_external_refs(text: str) -> list[str]:
    bad = []
    for pat in (r"<image\b", r"\bhref\s*=", r"url\(\s*['\"]?(?:https?:|//|data:)", r"@import", r"<script\b", r"<link\b", r"\bsrc\s*=", r"<iframe\b", r"<object\b"):
        if re.search(pat, text, flags=re.I):
            bad.append(pat)
    return bad


def verify_profile_svg(rec: Recorder, item: str, path: Path, exp: dict) -> None:
    kind = "profile SVG"
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return
    root = parse_svg(rec, item, kind, path)
    if root is None:
        return
    w, h = mm_attr(root.get("width")), mm_attr(root.get("height"))
    rec.add(item, kind, "width / height given in mm", w is not None and h is not None, f"{root.get('width')} x {root.get('height')}", "<n>mm")
    vb = [float(x) for x in (root.get("viewBox") or "").split()]
    ok_vb = len(vb) == 4 and w is not None and h is not None and abs(vb[2] - w) <= 1e-6 and abs(vb[3] - h) <= 1e-6
    rec.add(item, kind, "viewBox size = physical size (1 user unit = 1 mm)", ok_vb, root.get("viewBox"), f"w {w} h {h}")
    want = exp.get("bboxXY")
    got = [float(x) for x in (root.get("data-bbox-mm") or "").split()]
    if want is not None:
        dev = max((abs(a - b) for a, b in zip(got, want)), default=float("inf")) if len(got) == 4 else float("inf")
        rec.add(item, kind, "data-bbox-mm = expected XY bbox", dev <= TOL_BBOX_MM, fvec(got), fvec(want), f"{TOL_BBOX_MM:g} mm")
    desc = " ".join((d.text or "") for d in root.iter(f"{{{SVG_NS}}}desc"))
    rec.add(item, kind, "<desc> states the Y-axis flip", "flip" in desc.lower() and "y" in desc.lower(), "stated" if "flip" in desc.lower() else "missing", "stated")
    outer = by_class(root, "path", "cut-outer")
    pts: list[tuple[float, float]] = []
    all_closed = True
    try:
        for p in outer + by_class(root, "path", "cut-inner"):
            pp, closed = path_points(p.get("d") or "")
            all_closed &= closed
            if has_class(p, "cut-outer"):
                pts += pp
    except ValueError as exc:
        rec.add(item, kind, "cut paths use absolute M/L/Z only", False, str(exc), "M/L/Z")
        return
    rec.add(item, kind, "cut paths are closed (every subpath ends with Z)", all_closed and len(outer) > 0, f"{len(outer)} outer path(s)", "closed")
    if exp.get("dxfPrimaryOuterLoops") is not None:
        rec.add(item, kind, "outer loop count", len(outer) == exp["dxfPrimaryOuterLoops"], len(outer), exp["dxfPrimaryOuterLoops"])
    if want is not None and pts:
        xs, ys = [p[0] for p in pts], [-p[1] for p in pts]  # undo the stated flip
        got_b = [min(xs), min(ys), max(xs), max(ys)]
        dev = max(abs(a - b) for a, b in zip(got_b, want))
        rec.add(item, kind, "outer path extents (Y un-flipped) = expected XY bbox", dev <= TOL_BBOX_MM, f"{fvec(got_b)} (dev {dev:.5f})", fvec(want), f"{TOL_BBOX_MM:g} mm")
        inside = len(vb) == 4 and vb[0] <= min(xs) and vb[1] <= min(p[1] for p in pts) and vb[0] + vb[2] >= max(xs) and vb[1] + vb[3] >= max(p[1] for p in pts)
        rec.add(item, kind, "geometry lies inside the viewBox", inside, root.get("viewBox"), "encloses the profile")
    holes = exp.get("holes") or []
    circ = [(float(c.get("cx")), -float(c.get("cy")), float(c.get("r"))) for c in by_class(root, "circle", "hole")]
    ok, worst = match_points(circ, [(h["x"], h["y"], h["d"] / 2) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM, TOL_HOLE_RAD_MM))
    rec.add(item, kind, "<circle class=hole> = expected holes (Y un-flipped)", ok, f"{len(circ)} circles" + (f", worst dev {worst:.2e}" if ok else ""), f"{len(holes)} holes", f"{TOL_HOLE_POS_MM:g} mm")
    marks = [(float(g.get("data-x")), float(g.get("data-y")), float(g.get("data-d"))) for g in by_class(root, "g", "hole-centre")]
    ok, worst = match_points(marks, [(h["x"], h["y"], h["d"]) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM, 2 * TOL_HOLE_RAD_MM))
    rec.add(item, kind, "hole-centre marks = expected holes", ok, f"{len(marks)} marks" + (f", worst dev {worst:.2e}" if ok else ""), f"{len(holes)} holes", f"{TOL_HOLE_POS_MM:g} mm")
    widths = {g.get("stroke-width") for g in root.iter(f"{{{SVG_NS}}}g") if g.get("stroke-width")}
    rec.add(item, kind, "hairline stroke width 0.1", widths == {"0.1"}, sorted(widths), ["0.1"])
    bad = no_external_refs(path.read_text(encoding="utf-8"))
    rec.add(item, kind, "no external resources", not bad, bad or "none", "none")


def verify_drawing_svg(rec: Recorder, item: str, path: Path, part: dict) -> None:
    kind = "drawing SVG"
    exp = part["expected"]
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return
    root = parse_svg(rec, item, kind, path)
    if root is None:
        return
    w, h = mm_attr(root.get("width")), mm_attr(root.get("height"))
    rec.add(item, kind, "width / height given in mm", w is not None and h is not None, f"{root.get('width')} x {root.get('height')}", "<n>mm")
    vb = [float(x) for x in (root.get("viewBox") or "").split()]
    rec.add(item, kind, "viewBox size = sheet size (1 user unit = 1 mm of paper)", len(vb) == 4 and w is not None and abs(vb[2] - w) <= 1e-6 and abs(vb[3] - (h or 0)) <= 1e-6,
            root.get("viewBox"), f"0 0 {w} {h}")
    rec.add(item, kind, "data-part-number", root.get("data-part-number") == part["partNumber"], root.get("data-part-number"), part["partNumber"])
    scale_label = root.get("data-scale") or ""
    scale = ALLOWED_SCALES.get(scale_label)
    rec.add(item, kind, "data-scale is a standard scale", scale is not None, scale_label, "one of " + " ".join(list(ALLOWED_SCALES)[:5]))
    got = [float(x) for x in (root.get("data-bbox-mm") or "").split()]
    want = exp.get("bboxXY")
    if want is not None:
        dev = max((abs(a - b) for a, b in zip(got, want)), default=float("inf")) if len(got) == 4 else float("inf")
        rec.add(item, kind, "data-bbox-mm = expected XY bbox", dev <= TOL_BBOX_MM, fvec(got), fvec(want), f"{TOL_BBOX_MM:g} mm")
    holes = exp.get("holes") or []
    marks = [(float(g.get("data-x")), float(g.get("data-y")), float(g.get("data-d"))) for g in by_class(root, "g", "hole-centre")]
    ok, worst = match_points(marks, [(h["x"], h["y"], h["d"]) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM, 2 * TOL_HOLE_RAD_MM))
    rec.add(item, kind, "hole-centre marks = expected holes", ok, f"{len(marks)} marks" + (f", worst dev {worst:.2e}" if ok else ""), f"{len(holes)} holes", f"{TOL_HOLE_POS_MM:g} mm")
    rows = by_class(root, "g", "hole-row")
    if holes:
        table = [(float(g.get("data-x")), float(g.get("data-y")), float(g.get("data-d"))) for g in rows]
        ok, _ = match_points(table, [(h["x"], h["y"], h["d"]) for h in holes], (TOL_HOLE_POS_MM, TOL_HOLE_POS_MM, 2 * TOL_HOLE_RAD_MM))
        text = " ".join(t.text or "" for t in root.iter(f"{{{SVG_NS}}}text"))
        rec.add(item, kind, "hole table lists every hole", ok and "HOLE TABLE" in text, f"{len(rows)} rows", f"{len(holes)} rows")
    lin = [float(g.get("data-value")) for g in by_class(root, "g", "dim-linear")]
    want_lin = exp.get("drawingLinearDims") or []
    missing = [v for v in want_lin if not any(abs(v - m) <= TOL_DIM_MM for m in lin)]
    rec.add(item, kind, "linear dimensions carry the key parametric values", len(lin) >= 1 and not missing,
            fvec(sorted(lin)), fvec(sorted(want_lin)) if want_lin else ">= 1 linear dimension", f"{TOL_DIM_MM:g} mm")
    dia = [float(g.get("data-value")) for g in by_class(root, "g", "dim-diameter")]
    want_dia = exp.get("drawingDiameterDims") or []
    if want_dia:
        missing = [v for v in want_dia if not any(abs(v - m) <= TOL_DIM_MM for m in dia)]
        rec.add(item, kind, "diameter dimensions carry the key parametric values", not missing, fvec(sorted(dia)), fvec(sorted(want_dia)), f"{TOL_DIM_MM:g} mm")
    # every dimension group really is drawn: extension/dimension lines, arrowheads, a text
    drawn = True
    for g in by_class(root, "g", "dim-linear"):
        lines = [l for l in g.iter(f"{{{SVG_NS}}}line")]
        drawn &= sum(has_class(l, "ext") for l in lines) == 2 and sum(has_class(l, "dimline") for l in lines) >= 1
        drawn &= len(by_class(g, "polygon", "arrow")) == 2 and len(list(g.iter(f"{{{SVG_NS}}}text"))) == 1
    rec.add(item, kind, "each linear dimension has 2 extension lines, a dimension line, 2 arrowheads and a text", drawn, drawn, True)
    # the front view is drawn at the stated scale
    front = [g for g in by_class(root, "g", "front-view")]
    if front and scale and want is not None:
        xs: list[float] = []
        ys: list[float] = []
        for p in front[0].iter(f"{{{SVG_NS}}}path"):
            if has_class(p, "outline") or has_class(p, "hidden"):
                pp, _ = path_points(p.get("d") or "")
                xs += [q[0] for q in pp]
                ys += [q[1] for q in pp]
        for c in front[0].iter(f"{{{SVG_NS}}}circle"):
            if has_class(c, "outline") or has_class(c, "hidden"):
                cx, cy, r = float(c.get("cx")), float(c.get("cy")), float(c.get("r"))
                xs += [cx - r, cx + r]
                ys += [cy - r, cy + r]
        if xs:
            got_size = [(max(xs) - min(xs)) / scale, (max(ys) - min(ys)) / scale]
            want_size = [want[2] - want[0], want[3] - want[1]]
            dev = max(abs(a - b) for a, b in zip(got_size, want_size))
            rec.add(item, kind, f"front view drawn at the stated scale {scale_label} (paper size / scale)", dev <= TOL_BBOX_MM + 0.002 / scale,
                    f"{fvec(got_size)} (dev {dev:.5f})", fvec(want_size), f"{TOL_BBOX_MM:g} mm")
    text = " ".join("".join(t.itertext()) for t in root.iter(f"{{{SVG_NS}}}text"))
    tb = [g for g in by_class(root, "g", "title-block")]
    tb_text = " ".join("".join(t.itertext()) for t in tb[0].iter(f"{{{SVG_NS}}}text")) if tb else ""
    need = {"part number": part["partNumber"], "scale": scale_label, "general note": "Dimensions in mm", "material": part.get("material", "")[:12], "quantity": str(part.get("qty", ""))}
    miss = [k for k, v in need.items() if v and v not in tb_text]
    rec.add(item, kind, "title block: part number, scale, material, quantity, general note", bool(tb) and not miss, "missing " + ", ".join(miss) if miss else "all present", "all present")
    rec.add(item, kind, "side view with thickness dimension", bool(by_class(root, "g", "side-view")) and any(abs(m - exp["bboxSize"][2]) <= TOL_DIM_MM for m in lin),
            fvec(sorted(lin)), f"includes {fnum(exp['bboxSize'][2])}", f"{TOL_DIM_MM:g} mm")
    fonts = set(re.findall(r"font-family\s*[:=]\s*\"?([^;\"}]+)", path.read_text(encoding="utf-8")))
    rec.add(item, kind, "basic fonts only (sans-serif)", fonts <= {"sans-serif"}, sorted(fonts), ["sans-serif"])
    bad = no_external_refs(path.read_text(encoding="utf-8"))
    rec.add(item, kind, "no external resources", not bad, bad or "none", "none")
    del text


# --------------------------------------------------------------------------- BOM / guide

def verify_bom(rec: Recorder, path: Path, exp: dict) -> None:
    item, kind = path.name, "BOM CSV"
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return
    raw = path.read_bytes().decode("utf-8")
    rows = rec.guard(item, kind, "parses as RFC 4180 CSV", lambda: list(csv.reader(io.StringIO(raw, newline=""), strict=True)))
    if rows is None or not rows:
        return
    header, body = rows[0], rows[1:]
    need = ["item", "part_numbers", "name", "qty", "category", "kind", "spec", "material", "process", "mass_each_g"]
    rec.add(item, kind, "header row with unit-suffixed columns", all(c in header for c in need), ",".join(header), ",".join(need))
    rec.add(item, kind, "every row has as many fields as the header", all(len(r) == len(header) for r in body), sorted({len(r) for r in body}), len(header))
    rec.add(item, kind, "row count", len(body) == exp.get("rows"), len(body), exp.get("rows"))
    col = {c: i for i, c in enumerate(header)}
    try:
        items = [int(r[col["item"]]) for r in body]
        rec.add(item, kind, "item numbers are 1..n", items == list(range(1, len(body) + 1)), f"{items[0]}..{items[-1]} ({len(items)} rows)" if items else "none", f"1..{len(body)}")
        cats = [r[col["category"]] for r in body]
        rec.add(item, kind, "categories custom / purchased", set(cats) <= {"custom", "purchased"} and cats.count("custom") == exp.get("customRows") and cats.count("purchased") == exp.get("purchasedRows"),
                f"{cats.count('custom')} custom, {cats.count('purchased')} purchased", f"{exp.get('customRows')} custom, {exp.get('purchasedRows')} purchased")
        rec.add(item, kind, "total quantity", sum(int(r[col["qty"]]) for r in body) == exp.get("totalQty"), sum(int(r[col["qty"]]) for r in body), exp.get("totalQty"))
        pns = [p for r in body for p in r[col["part_numbers"]].split()]
        rec.add(item, kind, "every part number listed exactly once", sorted(pns) == sorted(exp.get("partNumbers", [])), " ".join(pns), " ".join(exp.get("partNumbers", [])))
        consistent = all(int(r[col["qty"]]) == len(r[col["part_numbers"]].split()) for r in body if r[col["part_numbers"]].strip())
        rec.add(item, kind, "qty = number of part numbers in each part row", consistent, consistent, True)
        masses_ok = all((r[col["mass_each_g"]] == "" or float(r[col["mass_each_g"]]) > 0) for r in body)
        rec.add(item, kind, "masses are positive numbers (g) or blank", masses_ok, masses_ok, True)
    except (KeyError, ValueError) as exc:
        rec.add(item, kind, "column values parse", False, f"{type(exc).__name__}: {exc}", "numeric")


def verify_guide(rec: Recorder, path: Path, exp: dict) -> None:
    item, kind = path.name, "guide HTML"
    if not rec.add(item, kind, "file exists", path.is_file(), path.name if path.is_file() else "missing", path.name):
        return
    text = path.read_text(encoding="utf-8")
    rec.add(item, kind, "HTML5 doctype", text.lstrip().lower().startswith("<!doctype html>"), text.lstrip()[:15], "<!DOCTYPE html>")
    doc = rec.guard(item, kind, "parses (lxml.html)", lambda: LHTML.document_fromstring(text))
    if doc is None:
        return
    svgs = doc.xpath("//svg")
    rec.add(item, kind, "inline exploded-view SVGs present", len(svgs) >= 1, len(svgs), ">= 1")
    body_text = doc.text_content()
    pns = exp.get("partNumbers", [])
    balloon_text = {t.strip() for t in doc.xpath("//svg//text/text()")}
    missing = [p for p in pns if not re.search(rf"(?<![A-Za-z0-9]){re.escape(p)}(?![0-9])", body_text)]
    rec.add(item, kind, "every part number appears in the document", not missing, "missing " + " ".join(missing) if missing else f"{len(pns)} found", f"{len(pns)} part numbers")
    with_geometry = exp.get("balloonPartNumbers", pns)
    miss_b = [p for p in with_geometry if p not in balloon_text]
    rec.add(item, kind, "every part with geometry has a balloon in the exploded view", not miss_b,
            "missing " + " ".join(miss_b) if miss_b else f"{len(with_geometry)} balloons", f"{len(with_geometry)} balloons")
    jn = exp.get("jointNames", [])
    missing = [j for j in jn if j not in body_text]
    rec.add(item, kind, "every joint name appears (mating table)", not missing, "missing " + ", ".join(missing) if missing else f"{len(jn)} found", f"{len(jn)} joints")
    steps = doc.xpath("//section[contains(@class,'step')]")
    rec.add(item, kind, "one assembly step per part, each with its own SVG", len(steps) == len(pns) and all(s.xpath(".//svg") for s in steps), len(steps), len(pns))
    tables = doc.xpath("//table[contains(@class,'bom')]")
    rec.add(item, kind, "BOM table(s) and mating table present", len(tables) >= 1 and (not jn or bool(doc.xpath("//table[contains(@class,'mates')]"))), f"{len(tables)} BOM table(s)", ">= 1")
    bad = [e.tag for e in doc.xpath("//script | //link | //img | //iframe | //object | //embed")]
    bad += [a for a in doc.xpath("//@src | //@href")]
    bad += re.findall(r"url\(\s*['\"]?(?:https?:|//)[^)]*\)|@import[^;]*;", text, flags=re.I)
    rec.add(item, kind, "self-contained: no scripts, links, images or external URLs", not bad, bad[:5] or "none", "none")
    rec.add(item, kind, "disclaimer present", "must be checked" in body_text or "verify" in body_text.lower(), "present" if "must be checked" in body_text else "see text", "present")


# --------------------------------------------------------------------------- driver

def verify_project(rec: Recorder, pdir: Path, summary_rows: list) -> None:
    manifest = json.loads((pdir / "manifest.json").read_text(encoding="utf-8"))
    rec.project = manifest.get("project", {}).get("slug") or pdir.name
    for part in manifest.get("parts", []):
        item = f"{part['partNumber']} {part['name']}"
        exp, files = part["expected"], part["files"]
        row = {"project": rec.project, "item": item, "kind": part.get("kind", ""), "exp": exp, "stl": {}, "dxf": {}}
        if part.get("exportable") and files.get("stl"):
            row["stl"] = verify_stl(rec, item, pdir / files["stl"], exp)
        else:
            # a part that failed the solid check must NOT have been written
            leftovers = [p.name for p in pdir.glob(f"*_{part['partNumber']}_*.stl")]
            rec.add(item, "STL", "non-exportable part was refused (no STL written)", not leftovers and not files.get("stl"), leftovers or "none", "none")
        if files.get("dxf"):
            row["dxf"] = verify_dxf(rec, item, pdir / files["dxf"], exp)
        if files.get("profileSvg"):
            verify_profile_svg(rec, item, pdir / files["profileSvg"], exp)
        if files.get("drawing"):
            verify_drawing_svg(rec, item, pdir / files["drawing"], part)
        summary_rows.append(row)
    if manifest.get("threemf"):
        verify_3mf(rec, pdir / manifest["threemf"]["file"], manifest["threemf"])
    elif any(p.get("exportable") for p in manifest.get("parts", [])):
        rec.add("3MF", "3MF", "combined package listed in the manifest", False, "missing", "present")
    if manifest.get("bom"):
        verify_bom(rec, pdir / manifest["bom"]["file"], manifest["bom"])
    if manifest.get("guide"):
        verify_guide(rec, pdir / manifest["guide"]["file"], manifest["guide"])


def write_report(path: Path, rec: Recorder, rows: list, projects: list[str], out_dir: Path) -> None:
    total, failed = len(rec.checks), [c for c in rec.checks if not c.ok]
    lines = ["# Export verification report", ""]
    lines += [f"Verified directory: `{out_dir}`", "",
              "Produced by `scripts/verify_exports.py`, which only reads the exported files (trimesh, ezdxf, lxml, Python stdlib) "
              "and compares them with the expected values of each `manifest.json`. It does not use the application's TypeScript code.", ""]
    lines += [f"**Result: {'PASS' if not failed else 'FAIL'}** — {total - len(failed)} of {total} checks passed "
              f"across {len(projects)} project(s) and {len(rows)} part(s).", ""]
    lines += [f"Reader versions: trimesh {trimesh.__version__}, ezdxf {ezdxf.__version__}, numpy {np.__version__}, "
              f"lxml {LET.__version__}, networkx {nx.__version__}, Python {sys.version.split()[0]}.", ""]
    lines += ["## Tolerances", "", "| Quantity | Tolerance |", "|---|---|"]
    lines += [f"| {q} | {t} |" for q, t in TOLERANCES]
    lines += ["", "## Measured vs expected (per part)", "",
              "| Project | Part | Kind | Volume measured (mm³) | Volume expected (mm³) | Dev. | BBox measured (mm) | BBox expected (mm) | Triangles | Euler | Holes (DXF circles / expected) |",
              "|---|---|---|---:|---:|---:|---|---|---:|---:|---:|"]
    for r in rows:
        s, e = r["stl"], r["exp"]
        if s:
            dev = abs(s["volume"] - e["volume"]) / e["volume"] * 100 if e.get("volume") else float("nan")
            lines.append(f"| {r['project']} | {r['item']} | {r['kind']} | {s['volume']:.2f} | {e['volume']:.2f} | {dev:.4f} % | {fvec(s['extents'], 3)} | {fvec(e['bboxSize'], 3)} | "
                         f"{s['triangles']} | {s['euler']} | {r['dxf'].get('circles', '–')} / {len(e.get('holes') or [])} |")
        else:
            lines.append(f"| {r['project']} | {r['item']} | {r['kind']} | – | {e.get('volume', 0):.2f} | – | not exported | {fvec(e['bboxSize'], 3)} | – | – | {r['dxf'].get('circles', '–')} / {len(e.get('holes') or [])} |")
    lines += ["", "## Checks by file type", "", "| Project | File type | Passed | Failed |", "|---|---|---:|---:|"]
    agg: dict[tuple[str, str], list[int]] = {}
    for c in rec.checks:
        a = agg.setdefault((c.project, c.kind), [0, 0])
        a[0 if c.ok else 1] += 1
    for (proj, kind), (p, f) in sorted(agg.items()):
        lines.append(f"| {proj} | {kind} | {p} | {f} |")
    lines += ["", "## Failed checks", ""]
    if failed:
        lines += ["| Project | Item | Check | Measured | Expected | Tolerance |", "|---|---|---|---|---|---|"]
        lines += [f"| {c.project} | {c.item} | {c.kind}: {c.name} | {c.measured} | {c.expected} | {c.tol} |" for c in failed]
    else:
        lines.append("None.")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify exported STL / 3MF / DXF / SVG / CSV / HTML files against their manifest.")
    ap.add_argument("out_dir", type=Path, help="directory written by scripts/export-samples.ts (contains <project>/manifest.json)")
    ap.add_argument("--report", type=Path, default=None, help="optional Markdown report path")
    args = ap.parse_args()
    out_dir: Path = args.out_dir
    if not out_dir.is_dir():
        print(f"FAIL: {out_dir} is not a directory")
        return 2
    pdirs = [out_dir] if (out_dir / "manifest.json").is_file() else sorted(d for d in out_dir.iterdir() if (d / "manifest.json").is_file())
    if not pdirs:
        print(f"FAIL: no manifest.json found in {out_dir} or its sub-directories")
        return 2
    print("Tolerances:")
    for q, t in TOLERANCES:
        print(f"  {q}: {t}")
    print()
    rec = Recorder()
    rows: list = []
    projects: list[str] = []
    for pdir in pdirs:
        try:
            verify_project(rec, pdir, rows)
        except Exception as exc:  # noqa: BLE001 - a broken manifest is a failure, not a crash
            rec.project = pdir.name
            rec.add(pdir.name, "manifest", "manifest readable and complete", False, f"{type(exc).__name__}: {exc}", "valid manifest")
        projects.append(rec.project)
    total = len(rec.checks)
    failed = [c for c in rec.checks if not c.ok]
    print()
    print(f"SUMMARY: {total - len(failed)} passed, {len(failed)} failed, {total} checks; {len(projects)} project(s), {len(rows)} part(s)")
    kinds: dict[str, list[int]] = {}
    for c in rec.checks:
        k = kinds.setdefault(c.kind, [0, 0])
        k[0 if c.ok else 1] += 1
    for kind, (p, f) in kinds.items():
        print(f"  {kind}: {p} passed, {f} failed")
    if failed:
        print("FAILED CHECKS:")
        for c in failed:
            print(f"  [{c.project}] {c.item} | {c.kind}: {c.name} | measured {c.measured} | expected {c.expected}")
    if args.report is not None:
        write_report(args.report, rec, rows, projects, out_dir)
        print(f"report written to {args.report}")
    print("RESULT: " + ("PASS" if not failed else "FAIL"))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
