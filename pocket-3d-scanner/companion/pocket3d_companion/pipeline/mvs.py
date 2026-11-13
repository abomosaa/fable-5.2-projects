"""Stages `undistort`, `dense`, `mesh`, `refine`, `texture`: OpenMVS on undistorted images.

All tools run on the CPU of the companion computer. Progress is parsed from the tools' own log
messages (depth maps finished, meshing phases completed, texture phases) — never from a timer.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from .errors import Cancelled, PipelineError
from .procutil import run_tool


def openmvs_bin() -> Path:
    p = Path(os.environ.get("POCKET3D_OPENMVS_BIN", "/opt/openmvs/bin/OpenMVS"))
    if not (p / "DensifyPointCloud").exists():
        raise PipelineError("tool_missing", f"OpenMVS binaries not found in {p} (set POCKET3D_OPENMVS_BIN).")
    return p


def _common(work_mvs: Path, threads: int) -> list[str]:
    return ["-w", str(work_mvs), "--max-threads", str(threads), "-v", "2", "--process-priority", "-1"]


def run_undistort(work: Path, model_dir: str, settings: dict, threads: int, progress, cancel) -> dict:
    """Removes lens distortion with the calibration estimated by SfM, producing ideal pinhole
    images for multi-view stereo and texturing."""
    import pycolmap
    dense = work / "dense"
    if dense.exists():
        shutil.rmtree(dense)
    uo = pycolmap.UndistortCameraOptions()
    uo.max_image_size = int(settings["work_image_max_side"])
    progress(0.02, "Undistorting photos")
    pycolmap.undistort_images(dense, model_dir, work / "images", output_type="COLMAP", undistort_options=uo,
                              num_threads=threads)
    if cancel.is_set():
        raise Cancelled()
    n = len(list((dense / "images").glob("*")))
    mvs = work / "mvs"
    if mvs.exists():
        shutil.rmtree(mvs)
    mvs.mkdir()
    progress(0.8, "Building multi-view scene")
    run_tool([str(openmvs_bin() / "InterfaceCOLMAP"), "-i", str(dense), "-o", "scene.mvs",
              "--image-folder", str(dense / "images")] + _common(mvs, threads),
             cwd=mvs, log_path=work / "tools.log", cancel=cancel, timeout_s=900)
    if not (mvs / "scene.mvs").exists():
        raise PipelineError("tool_failed", "InterfaceCOLMAP did not produce a scene.")
    return {"undistorted_images": n}


# Console progress lines printed by OpenMVS, e.g. "Estimated depth-maps 44 (65.67%, 2m46s, ETA 1m)..."
_RE_PROGRESS = re.compile(r"^(?P<label>[A-Za-z][A-Za-z \-]*?)\s+(?P<n>\d+) \((?P<pct>\d+(?:\.\d+)?)%")
_RE_FUSED = re.compile(r"Depth-maps fused and filtered: (\d+) depth-maps, (\d+) depths, (\d+) points")
_RE_DENSE_DONE = re.compile(r"Densifying point-cloud completed: (\d+) points")


def max_dense_points(memory_mb: int) -> float:
    """Dense points that can be meshed within `memory_mb`.

    Measured peaks of the meshing stage at the default insertion density, as
    (peak − 1.2 GB) / million points: 0.83 (tumbler), 0.95 (plaster head), 1.05 and 1.2
    (well-head, two runs). The budget uses 1.25 GB per million — the worst case plus a margin —
    because exceeding the limit is fatal (the companion kills a job above its memory limit),
    while a slightly smaller point cloud only costs a little detail."""
    return max(0.3e6, (memory_mb - 1200) / 1.25 * 1e3)


def dense_side_for_memory(requested_side: int, n_images: int, frames: list[dict], memory_mb: int) -> tuple[int, bool]:
    """Largest depth-map size (long side, px) whose fused point cloud can still be meshed within
    the job's memory limit.

    Measured on the example datasets: fusion keeps roughly 2–13 % of all depth pixels as points
    (10 % is assumed here), and Delaunay meshing needs up to ~1.2 GB per million points plus ~1.2 GB
    for the worker itself (see `max_dense_points`). It only ever lowers the preset's resolution;
    if a scene still yields more points than predicted, `run_mesh` thins the point insertion."""
    if not frames:
        return requested_side, False
    aspect = sorted(min(f["work_w"], f["work_h"]) / max(f["work_w"], f["work_h"]) for f in frames)[len(frames) // 2]
    max_points = max_dense_points(memory_mb)
    predicted = 0.10 * n_images * requested_side * requested_side * aspect
    if predicted <= max_points:
        return requested_side, False
    side = int(requested_side * (max_points / predicted) ** 0.5)
    side = max(480, side - side % 16)
    return (side, True) if side < requested_side else (requested_side, False)


def run_dense(work: Path, n_images: int, settings: dict, threads: int, progress, cancel) -> dict:
    mvs = work / "mvs"
    for p in list(mvs.glob("*.dmap")) + [mvs / "scene_dense.mvs", mvs / "scene_dense.ply"]:
        if p.exists():
            p.unlink()
    geometric_iters = 2
    # share of the stage per phase, from measured phase durations
    span_est, span_geo, span_filter, span_fuse = (0.0, 0.30), (0.30, 0.86), (0.86, 0.90), (0.90, 0.98)
    state = {"points": 0, "geo_pass": 0, "geo_last": -1.0}

    def on_line(line: str):
        m = _RE_PROGRESS.match(line)
        if m:
            label, pct = m.group("label").strip(), float(m.group("pct")) / 100.0
            if label == "Estimated depth-maps":
                progress(span_est[0] + (span_est[1] - span_est[0]) * pct,
                         f"Depth maps: first pass {m.group('n')}/{n_images}")
            elif label.startswith("Geometric-consistent"):
                if pct < state["geo_last"] - 0.2:
                    state["geo_pass"] = min(geometric_iters - 1, state["geo_pass"] + 1)
                state["geo_last"] = pct
                frac = (state["geo_pass"] + pct) / geometric_iters
                progress(span_geo[0] + (span_geo[1] - span_geo[0]) * frac,
                         f"Depth maps: consistency pass {state['geo_pass'] + 1}/{geometric_iters}, "
                         f"{m.group('n')}/{n_images}")
            elif label == "Filtered depth-maps":
                progress(span_filter[0] + (span_filter[1] - span_filter[0]) * pct, "Filtering depth maps")
            elif label == "Fused depth-maps":
                progress(span_fuse[0] + (span_fuse[1] - span_fuse[0]) * pct, "Fusing depth maps into points")
            return
        m = _RE_DENSE_DONE.search(line) or _RE_FUSED.search(line)
        if m:
            state["points"] = int(m.group(m.lastindex))
            progress(0.99, f"Fused {state['points']:,} dense points")

    side = int(settings["dense_max_side"])
    run_tool([str(openmvs_bin() / "DensifyPointCloud"), "scene.mvs", "-o", "scene_dense.mvs",
              "--resolution-level", "0", "--max-resolution", str(side), "--min-resolution", str(min(320, side)),
              "--number-views", str(int(settings["dense_views"])), "--number-views-fuse", "3",
              "--geometric-iters", str(geometric_iters), "--estimate-colors", "2", "--estimate-normals", "2",
              "--remove-dmaps", "1"] + _common(mvs, threads),
             cwd=mvs, log_path=work / "tools.log", cancel=cancel, on_line=on_line)
    ply = mvs / "scene_dense.ply"
    if not ply.exists() or ply.stat().st_size < 1000 or state["points"] < 500:
        raise PipelineError(
            "dense_failed",
            "Dense stereo found too few consistent surface points. The object is probably too plain, "
            "glossy or transparent for photogrammetry, or the photos overlap too little.",
            ["Photograph matte, textured objects; dust glossy surfaces with removable matte spray or powder "
             "if that is acceptable.",
             "Use soft, even lighting and avoid specular highlights that move with the camera.",
             "Take more photos with smaller steps between views."])
    return {"dense_points": state["points"], "depth_maps": n_images, "depth_map_max_side": side}


_MESH_MILESTONES = [("loaded:", 0.05, "Dense points loaded"),
                    ("Delaunay tetrahedralization completed", 0.30, "Tetrahedralisation done"),
                    ("Delaunay tetrahedras weighting completed", 0.65, "Extracting surface (graph cut)"),
                    ("Delaunay tetrahedras graph-cut completed", 0.82, "Surface extracted"),
                    ("Mesh reconstruction completed", 0.84, "Cleaning mesh"),
                    ("Cleaned mesh", 0.92, "Cleaning mesh"),
                    ("Mesh saved", 0.99, "Mesh saved")]
_RE_MESH = re.compile(r"Mesh (?:saved|reconstruction completed): (\d+) vertices, (\d+) faces")


def run_mesh(work: Path, settings: dict, threads: int, progress, cancel, dense_points: int = 0,
             memory_mb: int = 0) -> dict:
    mvs = work / "mvs"
    # Minimum distance (in pixels) between projected points for both to become mesh vertices.
    # 2.5 is the default; if the cloud is larger than the memory limit allows, fewer points are
    # inserted (the delivered mesh is decimated to the triangle budget afterwards anyway).
    min_dist = 2.5
    if dense_points and memory_mb:
        over = dense_points / max_dense_points(memory_mb)
        if over > 1.0:
            min_dist = round(min(8.0, 2.5 * over ** 0.5), 2)
    out = mvs / "scene_mesh.ply"
    if out.exists():
        out.unlink()
    state = {"v": 0, "f": 0}

    def on_line(line: str):
        pm = _RE_PROGRESS.match(line)
        if pm:
            pct = float(pm.group("pct")) / 100.0
            if pm.group("label").strip() == "Points inserted":
                progress(0.05 + 0.25 * pct, "Tetrahedralising dense points")
            elif pm.group("label").strip() == "Points weighted":
                progress(0.30 + 0.35 * pct, "Weighting visibility")
            return
        for key, frac, msg in _MESH_MILESTONES:
            if key in line:
                progress(frac, msg)
                break
        m = _RE_MESH.search(line)
        if m:
            state["v"], state["f"] = int(m.group(1)), int(m.group(2))

    # --close-holes 0: holes are evidence of missing observations and are never filled here.
    run_tool([str(openmvs_bin() / "ReconstructMesh"), "scene_dense.mvs", "-p", "scene_dense.ply",
              "-o", "scene_mesh.ply", "--close-holes", "0", "--smooth", "2", "--remove-spikes", "1",
              "--remove-spurious", "20", "--min-point-distance", str(min_dist)] + _common(mvs, threads),
             cwd=mvs, log_path=work / "tools.log", cancel=cancel, on_line=on_line)
    if not out.exists() or state["f"] < 50:
        raise PipelineError("mesh_failed", "Surface reconstruction produced no usable mesh.",
                            ["Capture more overlapping photos of a matte, textured object."])
    return {"raw_vertices": state["v"], "raw_faces": state["f"], "min_point_distance_px": min_dist}




def refine_level_for_memory(n_images: int, frames: list[dict], memory_mb: int) -> int | None:
    """Image down-scaling level (1 = half size, 2 = quarter …) at which photometric refinement
    fits into the job's memory limit, or None if it does not fit even at 1/8 size.

    Measured (50 photos of 8.6 MP at half size, 400 k triangles): the whole job peaks at 6.0 GB
    during refinement — modelled as ~45 MB per megapixel of all images together at the chosen
    level plus ~1.2 GB for mesh and worker."""
    if not frames:
        return 1
    mp = sorted(f["work_w"] * f["work_h"] / 1e6 for f in frames)[len(frames) // 2]
    for level in (1, 2, 3):
        if 1200 + 45.0 * n_images * mp / (4 ** level) <= memory_mb:
            return level
    return None


def run_refine(work: Path, mesh_in: str, settings: dict, threads: int, progress, cancel, level: int = 1) -> dict:
    mvs = work / "mvs"
    out = mvs / "mesh_refined.ply"
    if out.exists():
        out.unlink()
    state = {"n": 0}

    def on_line(line: str):
        # RefineMesh reports per-iteration lines; the count of lines is only used to keep the
        # indicator moving within the stage — the stage's share of the job is measured separately.
        if "Iteration" in line or "iteration" in line or "scale" in line.lower():
            state["n"] += 1
            progress(min(0.95, 0.05 + 0.03 * state["n"]), "Photometric mesh refinement")

    progress(0.02, "Photometric mesh refinement")
    # --decimate 1: keep the triangle budget chosen by the preset (0 would let OpenMVS decimate
    # the input automatically, to roughly one sixth in our measurements).
    run_tool([str(openmvs_bin() / "RefineMesh"), "scene.mvs", "-m", mesh_in, "-o", "mesh_refined.ply",
              "--resolution-level", str(int(level)), "--scales", "2", "--close-holes", "0", "--decimate", "1",
              "--max-face-area", "32"] + _common(mvs, threads),
             cwd=mvs, log_path=work / "tools.log", cancel=cancel, on_line=on_line)
    if not out.exists():
        raise PipelineError("refine_failed", "Mesh refinement produced no output.")
    return {"refined": True, "resolution_level": int(level)}


_TEX_MILESTONES = [("Mesh loaded", 0.03, "Mesh loaded"),
                   ("Assigning the best view to each face completed", 0.80, "Building texture atlas"),
                   ("Generating texture atlas and image completed", 0.95, "Texture atlas built"),
                   ("Mesh texturing completed", 0.97, "Texture done"),
                   ("Mesh saved", 0.99, "Textured mesh saved")]


def run_texture(work: Path, mesh_in: str, settings: dict, threads: int, progress, cancel) -> dict:
    mvs = work / "mvs"
    for p in mvs.glob("textured*"):
        p.unlink()

    def on_line(line: str):
        pm = _RE_PROGRESS.match(line)
        if pm:
            if pm.group("label").strip() == "Initialized views":
                progress(0.03 + 0.22 * float(pm.group("pct")) / 100.0, "Projecting photos onto the surface")
            return
        for key, frac, msg in _TEX_MILESTONES:
            if key in line:
                progress(frac, msg)
                break

    progress(0.01, "Texturing")
    # Seam levelling (global + local) equalises per-photo exposure differences instead of leaving
    # visible brightness seams. Faces no photo sees get a neutral grey and are flagged later.
    run_tool([str(openmvs_bin() / "TextureMesh"), "scene.mvs", "-m", mesh_in, "-o", "textured.obj",
              "--export-type", "obj", "--resolution-level", "0", "--close-holes", "0", "--decimate", "1",
              "--global-seam-leveling", "1", "--local-seam-leveling", "1",
              "--max-texture-size", str(int(settings["texture_max_size"])),
              "--empty-color", str(0x808080)] + _common(mvs, threads),
             cwd=mvs, log_path=work / "tools.log", cancel=cancel, on_line=on_line)
    obj = mvs / "textured.obj"
    if not obj.exists():
        raise PipelineError("texture_failed", "Texturing produced no output.")
    return {"obj": str(obj)}
