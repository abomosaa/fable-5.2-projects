"""Pipeline orchestration for one job attempt (see docs/companion-protocol.md §4)."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import signal
import sys
import threading
import time
import traceback
from pathlib import Path

import numpy as np

from . import geom
from .errors import Cancelled, PipelineError
from .events import STAGES, EventWriter
from .presets import resolve_settings, settings_fingerprint
from .procutil import PeakRss, kill_children

PIPELINE_VERSION = "1.0.0"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"), default=_json_default)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _json_default(o):
    if isinstance(o, geom.Sim3):
        return {"__sim3__": o.to_json()}
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    raise TypeError(type(o).__name__)


def _json_hook(d):
    if "__sim3__" in d:
        return geom.Sim3.from_json(d["__sim3__"])
    return d


def release_memory() -> None:
    """Return freed heap pages to the OS between stages (the SfM stage leaves >1 GB of freed
    but still resident memory in this process, which would otherwise be counted on top of the
    external tools that run next)."""
    import ctypes
    import gc
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def tool_versions() -> dict:
    v = {"pipeline": PIPELINE_VERSION, "python": platform.python_version()}
    try:
        import pycolmap
        v["colmap"] = getattr(pycolmap, "COLMAP_version", getattr(pycolmap, "__version__", "?"))
        v["pycolmap"] = pycolmap.__version__
    except Exception:
        pass
    v["openmvs"] = "2.3.0 (+formatTime fortify patch)"
    try:
        import open3d
        v["open3d"] = open3d.__version__
    except Exception:
        pass
    return v


class Run:
    def __init__(self, job_dir: Path):
        self.job_dir = job_dir
        self.job = json.loads((job_dir / "job.json").read_text())
        self.settings = resolve_settings(self.job["preset"], self.job.get("settings") or {})
        limits = self.job.get("limits") or {}
        self.threads = int(limits.get("threads") or os.cpu_count() or 4)
        self.memory_mb = int(limits.get("memory_mb") or 8192)
        self.work = job_dir / "work"
        self.out = job_dir / "out"
        self.work.mkdir(exist_ok=True)
        self.out.mkdir(exist_ok=True)
        (self.work / "checkpoints").mkdir(exist_ok=True)
        self.active = [s for s in STAGES if s != "refine" or self.settings["refine"]]
        self.events = EventWriter(job_dir, self.active)
        self.cancel = threading.Event()
        self.rss = PeakRss().start()
        self.diag: dict = {"format": 1, "warnings": [], "timings_s": {}, "peak_rss_mb_by_stage": {}, "reused_stages": []}
        files_blob = json.dumps([[f["id"], f.get("sha256"), f.get("size")] for f in self.job["files"]]).encode()
        self.fingerprint = hashlib.sha256(
            files_blob + settings_fingerprint(self.job["preset"], self.settings).encode()
            + PIPELINE_VERSION.encode()).hexdigest()[:20]
        self.artifacts: list[dict] = []

    # -- helpers -----------------------------------------------------------------------------
    def check_cancel(self):
        if self.cancel.is_set():
            raise Cancelled()

    def stage(self, name: str, fn, outputs_exist=lambda: True):
        """Run a stage, or reuse its checkpoint from a previous attempt with identical inputs."""
        self.check_cancel()
        cp = self.work / "checkpoints" / f"{name}.json"
        self.events.stage_start(name)
        print(f"[stage] {name} start", flush=True)
        if cp.exists():
            try:
                saved = json.loads(cp.read_text(), object_hook=_json_hook)
                if saved.get("fingerprint") == self.fingerprint and outputs_exist():
                    self.diag["reused_stages"].append(name)
                    self.events.stage_end("Reused result of a previous attempt", data={"reused": True})
                    print(f"[stage] {name} reused", flush=True)
                    return saved["result"]
            except (ValueError, KeyError):
                pass
        t0 = time.time()
        result = fn(self.events.progress)
        release_memory()
        self.check_cancel()
        _atomic_json(cp, {"fingerprint": self.fingerprint, "result": result})
        dt = round(time.time() - t0, 2)
        self.diag["timings_s"][name] = dt
        self.diag["peak_rss_mb_by_stage"][name] = round(self.rss.reset_stage(), 1)
        self.events.stage_end(data={"reused": False})
        print(f"[stage] {name} done in {dt}s", flush=True)
        return json.loads(json.dumps(result, default=_json_default), object_hook=_json_hook)

    def warn(self, code: str, message: str):
        self.diag["warnings"].append({"code": code, "message": message})
        self.events.warning(code, message)

    def publish(self, name: str, kind: str):
        p = self.out / name
        entry = {"name": name, "size": p.stat().st_size, "sha256": _sha256(p), "kind": kind}
        self.artifacts = [a for a in self.artifacts if a["name"] != name] + [entry]
        self.events.artifact(**entry)

    # -- pipeline ----------------------------------------------------------------------------
    def run(self):
        from . import ingest as ingest_mod
        from . import meshpost, mvs, package, scene as scene_mod, sfm

        job, st, work = self.job, self.settings, self.work
        self.diag["job"] = {"job_id": job.get("job_id"), "session_id": job.get("session_id"),
                            "preset": job["preset"], "attempt": job.get("attempt", 1),
                            "settings": {k: v for k, v in st.items() if not k.startswith("_")},
                            "settings_fingerprint": settings_fingerprint(job["preset"], st)}
        self.diag["environment"] = {"threads": self.threads, "memory_limit_mb": self.memory_mb,
                                    "cpu": platform.processor() or platform.machine(),
                                    "gpu": None, "tools": tool_versions(),
                                    "where": "companion computer (not on the phone)"}

        ing = self.stage("ingest", lambda pr: ingest_mod.run_ingest(job, st, work, self.threads, pr),
                         lambda: (work / "images").is_dir())
        usable = [f for f in ing["frames"] if not f["rejected"]]
        self.diag["input"] = {
            "frames": len(ing["frames"]), "usable": len(usable), "rejected": ing["rejected"],
            "capture_source": ing.get("capture_source"), "tracking_mode": ing.get("tracking_mode"),
            "camera_groups": [{"frames": len(g["frames"]), "width": g["width"], "height": g["height"],
                               "focal_px_prior": round(g["focal_px"], 2), "focal_source": g["focal_source"]}
                              for g in ing["groups"]],
            "recompressed_working_copies": sum(1 for f in usable if f["recompressed"]),
            "frames_with_ar_pose": sum(1 for f in usable if f["ar_center"] is not None),
        }
        self.events.diagnostics({"input": self.diag["input"]})
        if any(g["focal_source"] == "default" for g in ing["groups"]):
            self.warn("no_focal_prior", "Some photos have no usable focal-length metadata (missing, or present but "
                                        "not trusted because the file may have been resized after capture); the "
                                        "focal length is estimated from the images alone, which is less reliable.")

        feat = self.stage("features", lambda pr: sfm.run_features(ing, work, st, self.threads, self.memory_mb, pr, self.cancel),
                          lambda: (work / "colmap" / "database.db").exists())
        self.diag["features"] = {"median_per_image": feat["median_features"], "extract_threads": feat["extract_threads"]}
        if feat["median_features"] < 1200:
            self.warn("low_texture", f"Photos contain few distinctive details (median {feat['median_features']} "
                                     "features per photo). Plain, glossy or blurred subjects reconstruct poorly.")
        match = self.stage("matching", lambda pr: sfm.run_matching(ing, work, st, self.threads, pr, self.cancel),
                           lambda: (work / "colmap" / "database.db").exists())
        self.diag["matching"] = match
        self.events.diagnostics({"features": self.diag["features"], "matching": match})

        sf = self.stage("sfm", lambda pr: sfm.run_mapping(ing, work, st, self.threads, pr, self.cancel, match),
                        lambda: (work / "colmap" / "best").is_dir())
        release_memory()
        model = sfm.load_model(sf["model_dir"], ing)
        ratio = scene_mod.parallax_ratio(model)
        self.diag["parallax_ratio"] = round(ratio, 4)
        if ratio < 0.03:
            # COLMAP can "solve" a set of photos taken while turning on the spot, but with all
            # cameras at (numerically) one place there is no depth information in it.
            raise PipelineError(
                "no_parallax",
                "The photos match each other well, but they contain no parallax: the camera seems to have "
                "turned on the spot (or only zoomed) instead of moving around the object, so depth cannot be recovered.",
                sfm.GUIDANCE_PARALLAX)
        scn = scene_mod.build_scene(model, ing, st, bool(sf.get("focal_length_fixed_from_device_calibration")))
        cams_prev = scene_mod.cameras_in_model(model, scn)
        self.diag["sfm"] = {k: v for k, v in sf.items() if k not in ("model_dir", "registered_ids")}
        self.diag["sfm"]["registered_ids"] = sf["registered_ids"]
        self.diag["scale"] = scn["scale"]
        self.diag["viewpoint_coverage"] = scn["coverage"]
        self.diag["ar_alignment"] = scn["ar_alignment"]
        self.diag["focal"] = scn["focal"]
        drift = scn["focal"]["max_drift"]
        if drift is not None and drift > 0.05:
            self.warn("focal_length_drift",
                      f"The focal length solved from the photos differs from the camera's metadata by "
                      f"{drift * 100:.0f}%. With few photos or little parallax, focal length and camera distance are "
                      "hard to tell apart: the shape is not affected, but sizes derived from camera positions are "
                      "uncertain by about that much. Calibrate the scale with a known distance.")
        for w in scn["warnings"]:
            self.warn(w["code"], w["message"])
        n_in, n_reg = sf["input_frames"], sf["registered"]
        if n_reg < n_in:
            self.warn("unregistered_frames", f"{n_in - n_reg} of {n_in} photos could not be registered and do "
                                             "not contribute to the model.")
        if n_reg < 25:
            self.warn("few_photos", f"Only {n_reg} photos are registered. Small sets leave gaps and make the camera "
                                    "solution fragile; 30–80 overlapping photos are recommended.")
        if sf["mean_reprojection_error_px"] > 1.0:
            self.warn("inconsistent_camera_solution",
                      f"The camera solution fits the photos poorly (mean reprojection error "
                      f"{sf['mean_reprojection_error_px']:.2f} px). This is typical for glossy or plain objects, moving "
                      "highlights or blur. Expect noisier surface and texture patches from mismatched views; check "
                      "the model against the object before relying on it.")
        cov = scn["coverage"]
        if scn["converging"] and cov["largest_azimuth_gap_deg"] > 60:
            self.warn("coverage_gap", f"No registered photo covers a {cov['largest_azimuth_gap_deg']:.0f}° sector "
                                      "around the object; the surface facing that side is likely missing.")
        if scn["converging"] and cov["bands_covered"] < 2:
            self.warn("single_elevation", "All photos were taken from about the same height. Add a higher (and "
                                          "lower) ring of photos to capture tops and undercuts.")
        preview = scene_mod.sparse_preview(model, scn, cams_prev, sf["unregistered"], seed=int(st["seed"]))
        _atomic_json(self.out / "sparse_preview.json", preview)
        self.publish("sparse_preview.json", "preview")
        self.events.diagnostics({"sfm": {k: v for k, v in self.diag["sfm"].items() if k != "registered_ids"},
                                 "scale": scn["scale"], "viewpoint_coverage": cov})

        und = self.stage("undistort", lambda pr: mvs.run_undistort(work, sf["model_dir"], st, self.threads, pr, self.cancel),
                         lambda: (work / "mvs" / "scene.mvs").exists())
        dense_side, reduced = mvs.dense_side_for_memory(int(st["dense_max_side"]), n_reg, usable, self.memory_mb)
        if reduced:
            self.warn("reduced_dense_resolution",
                      f"Depth maps are computed at {dense_side} px instead of {st['dense_max_side']} px so that "
                      f"{n_reg} photos fit in the companion's memory limit ({self.memory_mb} MB). Raise the limit "
                      "for full detail.")
        st = dict(st, dense_max_side=dense_side)
        dense = self.stage("dense", lambda pr: mvs.run_dense(work, n_reg, st, self.threads, pr, self.cancel),
                           lambda: (work / "mvs" / "scene_dense.ply").exists())
        self.diag["dense"] = dense
        self.events.diagnostics({"dense": dense})

        def mesh_stage(pr):
            raw = mvs.run_mesh(work, st, self.threads, lambda f, m="": pr(0.75 * f, m), self.cancel,
                               dense_points=int(dense["dense_points"]), memory_mb=self.memory_mb)
            self.check_cancel()
            post = meshpost.crop_and_clean(work, scn, st, self.threads, lambda f, m="": pr(0.75 + 0.25 * f, m))
            post["raw"] = raw
            return post

        post = self.stage("mesh", mesh_stage, lambda: (work / "mvs" / "mesh_roi.ply").exists()
                          and (work / "dense_roi_sfm.npy").exists())
        self.diag["mesh_cleanup"] = dict(post["stats"], min_point_distance_px=post["raw"].get("min_point_distance_px"))
        mesh_in = "mesh_roi.ply"
        if st["refine"]:
            level = mvs.refine_level_for_memory(n_reg, usable, self.memory_mb)
            if level is None:
                # the stage is part of this job's stage list: report it as skipped, honestly
                self.events.stage_start("refine")
                self.events.stage_end("Skipped: not enough memory", skipped=True)
                self.warn("refine_skipped", f"Photometric mesh refinement was skipped: {n_reg} photos do not fit "
                                            f"into the companion's memory limit ({self.memory_mb} MB) even at 1/8 size.")
                self.diag["refine"] = {"refined": False}
            else:
                if level > 1:
                    self.warn("reduced_refine_resolution",
                              f"Mesh refinement used photos at 1/{2 ** level} size to fit the companion's memory "
                              f"limit ({self.memory_mb} MB).")
                self.diag["refine"] = self.stage(
                    "refine", lambda pr: mvs.run_refine(work, mesh_in, st, self.threads, pr, self.cancel, level),
                    lambda: (work / "mvs" / "mesh_refined.ply").exists())
                mesh_in = "mesh_refined.ply"
        tex = self.stage("texture", lambda pr: mvs.run_texture(work, mesh_in, st, self.threads, pr, self.cancel),
                         lambda: (work / "mvs" / "textured.obj").exists())

        # ---- package (always recomputed: cheap, and it owns the output directory) --------------
        self.check_cancel()
        self.events.stage_start("package")
        t0 = time.time()
        scn_final = dict(scn)
        scn_final["model_from_sfm"] = post["model_from_sfm"]
        cams = scene_mod.cameras_in_model(model, scn_final)
        meta = {"job_id": job.get("job_id"), "session_id": job.get("session_id"), "preset": job["preset"],
                "settings_fingerprint": settings_fingerprint(job["preset"], st), "tools": tool_versions(),
                "created_unix": int(time.time())}
        pk = package.build_package(work, self.out, Path(tex["obj"]), scn_final, post, model, cams, st, meta,
                                   self.events.progress)
        self.check_cancel()
        self.diag["mesh"] = pk["mesh"]
        self.diag["texture"] = pk["texture"]
        self.diag["surface_coverage"] = pk["surface_coverage"]
        self.diag["suggested_crop"] = post["suggested_crop"]
        self.diag["ground"] = post["ground"]
        obj_reg = pk["mesh"]["object_region"]
        if obj_reg["weak_area_fraction"] + obj_reg["unsupported_area_fraction"] > 0.35:
            self.warn("weak_surface_support",
                      "A large part of the object surface is weakly supported by the photos (few views or sparse "
                      "depth evidence). Geometry there is unreliable — typical for plain, glossy or thin parts.")
        final_cov = geom.viewpoint_bins(np.array([c["position"] for c in cams]), np.zeros(3), np.array([0.0, 1.0, 0.0]))
        final_cov["kind"] = "registered_viewpoints"
        final_cov["note"] = cov["note"]
        self.diag["viewpoint_coverage"] = final_cov
        cameras_doc = {
            "format": 1, "frame": "model", "units": scn["scale"]["units"],
            "convention": "position + quaternion q (x,y,z,w) rotate camera axes into the model frame; camera "
                          "axes are GL-style (+X right, +Y up, −Z forward) for the upright photo. Intrinsics are "
                          "pixels of the upright working image (width x height).",
            "distortion": "removed: fx, fy, cx, cy describe the UNDISTORTED (ideal pinhole) version of the upright "
                          "working image, as used for dense stereo and texturing. To project onto the original "
                          "photo, apply the lens model in `calibration` first.",
            "calibration": sf["cameras"],
            "cameras": cams, "unregistered": sf["unregistered"],
            "rejected": ing["rejected"],
        }
        _atomic_json(self.out / "cameras.json", cameras_doc)
        self.diag["timings_s"]["package"] = round(time.time() - t0, 2)
        self.diag["peak_rss_mb_by_stage"]["package"] = round(self.rss.reset_stage(), 1)
        self.diag["timings_s"]["total"] = round(sum(v for k, v in self.diag["timings_s"].items() if k != "total"), 2)
        self.diag["peak_rss_mb"] = round(self.rss.peak_mb, 1)
        self.diag["limitations"] = [
            "Geometry exists only where at least a few photos saw the surface; holes mark missing evidence.",
            "Underside/contact area with the support is not observed unless the capture included it.",
            "Units are arbitrary unless the scale section says otherwise.",
        ]
        _atomic_json(self.out / "diagnostics.json", self.diag)
        self.events.stage_end()
        self.publish("model.glb", "model")
        self.publish("cameras.json", "cameras")
        self.publish("diagnostics.json", "diagnostics")
        self.events.diagnostics({k: self.diag[k] for k in ("mesh", "texture", "surface_coverage", "timings_s",
                                                           "peak_rss_mb_by_stage", "mesh_cleanup", "warnings")})
        result = {"ok": True, "artifacts": self.artifacts, "diagnostics": self.diag}
        _atomic_json(self.out / "result.json", result)
        print("[done] success", flush=True)


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="pocket3d_companion.pipeline")
    ap.add_argument("--job-dir", required=True)
    args = ap.parse_args(argv)
    job_dir = Path(args.job_dir).resolve()
    try:
        run = Run(job_dir)
    except PipelineError as e:
        EventWriter(job_dir).error(e.code, e.message, e.guidance)
        return e.exit_code
    except Exception as e:  # malformed job description
        EventWriter(job_dir).error("invalid_job", f"Invalid job description: {e}")
        traceback.print_exc()
        return 3
    result = {"code": 1}

    def body():
        try:
            run.run()
            result["code"] = 0
        except Cancelled:
            print("[cancelled]", flush=True)
            result["code"] = 130
        except PipelineError as e:
            print(f"[error] {e.code}: {e.message}", flush=True)
            run.events.error(e.code, e.message, e.guidance)
            result["code"] = e.exit_code
        except MemoryError:
            run.events.error("out_of_memory", "The reconstruction ran out of memory.",
                             ["Use a lower quality preset or raise the companion memory limit."])
            result["code"] = 2
        except Exception as e:
            if run.cancel.is_set():
                result["code"] = 130
            else:
                traceback.print_exc()
                run.events.error("internal_error", f"Unexpected pipeline error: {type(e).__name__}: {e}")
                result["code"] = 1

    worker = threading.Thread(target=body, name="pipeline", daemon=True)

    def on_signal(signum, frame):
        # The main thread only supervises, so signals are handled promptly even while the worker
        # thread is inside a long native call.
        run.cancel.set()
        kill_children()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    worker.start()
    cancelled_at = None
    while worker.is_alive():
        worker.join(timeout=0.2)
        if run.cancel.is_set():
            cancelled_at = cancelled_at or time.time()
            if time.time() - cancelled_at > 4.0:
                # still inside a native call that cannot be interrupted: leave without a result
                kill_children()
                sys.stdout.flush()
                os._exit(130)
    run.rss.stop()
    if run.cancel.is_set() and result["code"] != 0:
        return 130
    return result["code"]
