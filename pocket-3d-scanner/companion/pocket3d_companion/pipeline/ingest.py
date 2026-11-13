"""Stage `ingest`: validate the uploaded photographs and derive upright working copies.

The originals in the session are never modified. Working copies (in the job's work dir) are:
* upright — the EXIF orientation is applied to the pixels, because neither COLMAP nor OpenMVS
  honours the EXIF orientation flag; intrinsics / AR pose priors are rotated to match
  (see geom.rotate_intrinsics / geom.ar_pose_to_cv_upright);
* at most `work_image_max_side` pixels on the long side (never upscaled);
* byte-identical hard links/copies of the original when no pixel change is needed, otherwise
  re-encoded once as JPEG quality 97 with 4:4:4 chroma.
"""
from __future__ import annotations

import json
import math
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import geom
from .errors import InputError

try:  # HEIC/HEIF support (phones frequently store HEIC)
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover - optional
    pillow_heif = None

MAX_PIXELS = 120_000_000  # decompression-bomb guard (the server enforces its own, lower limit)
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

SUPPORTED_FORMATS = {"JPEG": "jpeg", "MPO": "jpeg", "PNG": "png", "WEBP": "webp", "HEIF": "heic", "HEIC": "heic"}
FULL_FRAME_DIAGONAL_MM = 43.2666


@dataclass
class Frame:
    id: str
    name: str
    index: int
    fmt: str = ""
    stored_w: int = 0
    stored_h: int = 0
    orientation: int = 1
    quarter_turns: int = 0
    mirrored: bool = False
    work_name: str = ""          # file name inside work/images
    work_w: int = 0
    work_h: int = 0
    scale: float = 1.0           # work pixels per upright-original pixel
    recompressed: bool = False
    focal_px: float | None = None        # prior, in work pixels
    focal_source: str = "default"        # capture | exif35 | exif | default
    cx: float | None = None
    cy: float | None = None
    distortion: list[float] | None = None  # opencv5 for the upright image, or None
    camera_key: str = ""
    timestamp_ms: int | None = None
    ar_R: list | None = None             # R_world_from_cam (CV, upright), AR world
    ar_center: list | None = None
    ar_segment: int | None = None
    capture_flags: list[str] = field(default_factory=list)
    rejected: str | None = None          # reason code if the frame cannot be used


def _exif_info(img: Image.Image) -> dict:
    out: dict = {}
    try:
        exif = img.getexif()
    except Exception:
        return out
    if not exif:
        return out
    out["orientation"] = int(exif.get(0x0112, 1) or 1)
    out["make"] = str(exif.get(0x010F, "") or "").strip()
    out["model"] = str(exif.get(0x0110, "") or "").strip()
    try:
        ifd = exif.get_ifd(0x8769)
    except Exception:
        ifd = {}

    def num(v):
        try:
            f = float(v)
            return f if math.isfinite(f) and f > 0 else None
        except Exception:
            return None

    out["focal_mm"] = num(ifd.get(0x920A))
    out["focal_35mm"] = num(ifd.get(0xA405))
    fpx, unit = num(ifd.get(0xA20E)), ifd.get(0xA210)
    if fpx and unit in (2, 3, 4):
        mm_per_unit = {2: 25.4, 3: 10.0, 4: 1.0}[unit]
        out["focal_plane_px_per_mm"] = fpx / mm_per_unit
    out["pixel_x_dimension"] = num(ifd.get(0xA002))
    out["pixel_y_dimension"] = num(ifd.get(0xA003))
    return out


def focal_prior_px(exif: dict, stored_w: int, stored_h: int) -> tuple[float | None, str]:
    """Focal length prior in pixels of the stored image, from EXIF.

    * FocalLengthIn35mmFilm relates the focal length to the 43.27 mm full-frame diagonal, so it
      scales with the image diagonal and survives resizing (but not cropping).
    * FocalLength + FocalPlaneXResolution give pixels per mm *of the sensor read-out*. If the
      file was resized afterwards (EXIF PixelXDimension differs from the stored size) the value
      is rescaled; if PixelXDimension is missing the value is not trusted at all.
    """
    long_side = max(stored_w, stored_h)
    f35 = exif.get("focal_35mm")
    if f35:
        f = f35 / FULL_FRAME_DIAGONAL_MM * math.hypot(stored_w, stored_h)
        if 0.3 * long_side < f < 8 * long_side:
            return f, "exif35"
    fmm, ppm = exif.get("focal_mm"), exif.get("focal_plane_px_per_mm")
    if fmm and ppm:
        f = fmm * ppm
        px, py = exif.get("pixel_x_dimension"), exif.get("pixel_y_dimension")
        if px and py:
            f *= long_side / max(px, py)
            if 0.3 * long_side < f < 8 * long_side:
                return f, "exif"
        # Without PixelXDimension we cannot tell whether the file was resized after capture, in
        # which case the focal-plane resolution no longer matches the pixels. A wrong "known"
        # focal length is worse than none (it corrupts calibrated two-view geometry), so fall
        # through to self-calibration.
    return None, "default"


def _to_rgb8(img: Image.Image) -> Image.Image:
    if img.mode in ("I;16", "I;16B", "I;16L", "I"):
        arr = np.asarray(img, dtype=np.float64)
        arr = (arr / max(1.0, arr.max()) * 255.0).clip(0, 255).astype(np.uint8)
        img = Image.fromarray(arr, "L")
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    if img.mode != "RGB":
        return img.convert("RGB")
    return img


def _process_one(frame: Frame, src: Path, out_dir: Path, max_side: int, cap: dict | None) -> Frame:
    try:
        with Image.open(src) as img:
            fmt = (img.format or "").upper()
            if fmt not in SUPPORTED_FORMATS:
                frame.rejected = "unsupported_format"
                return frame
            frame.fmt = SUPPORTED_FORMATS[fmt]
            frame.stored_w, frame.stored_h = img.size
            exif = _exif_info(img)
            frame.orientation = exif.get("orientation", 1)
            if frame.orientation not in range(1, 9):
                frame.orientation = 1
            frame.quarter_turns, frame.mirrored = geom.exif_quarter_turns(frame.orientation)
            up_w, up_h = geom.upright_size(frame.stored_w, frame.stored_h, frame.quarter_turns)
            long_side = max(up_w, up_h)
            frame.scale = min(1.0, max_side / long_side)
            frame.work_w = max(1, round(up_w * frame.scale))
            frame.work_h = max(1, round(up_h * frame.scale))
            frame.work_name = f"{frame.id}.jpg"
            dst = out_dir / frame.work_name
            lossless = (frame.fmt == "jpeg" and fmt == "JPEG" and frame.orientation == 1
                        and frame.scale == 1.0 and img.mode == "RGB")
            if lossless:
                try:
                    if dst.exists():
                        dst.unlink()
                    os.link(src, dst)
                except OSError:
                    shutil.copyfile(src, dst)
            else:
                img.load()
                up = ImageOps.exif_transpose(img) if frame.orientation != 1 else img
                up = _to_rgb8(up)
                if frame.scale < 1.0:
                    up = up.resize((frame.work_w, frame.work_h), Image.LANCZOS)
                frame.work_w, frame.work_h = up.size
                up.save(dst, "JPEG", quality=97, subsampling=0, optimize=False)
                frame.recompressed = True
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as e:
        frame.rejected = "unreadable"
        frame.capture_flags.append(type(e).__name__)
        return frame

    # --- priors ------------------------------------------------------------------------------
    intr = (cap or {}).get("intrinsics")
    if intr and not frame.mirrored and all(k in intr for k in ("fx", "fy", "cx", "cy")):
        fx, fy, cx, cy = geom.rotate_intrinsics(float(intr["fx"]), float(intr["fy"]), float(intr["cx"]),
                                                float(intr["cy"]), frame.stored_w, frame.stored_h,
                                                frame.quarter_turns)
        if fx > 0 and fy > 0:
            frame.focal_px = 0.5 * (fx + fy) * frame.scale
            frame.cx, frame.cy = cx * frame.scale, cy * frame.scale
            frame.focal_source = "capture"
    if frame.focal_px is None:
        f, source = focal_prior_px(exif, frame.stored_w, frame.stored_h)
        if f:
            frame.focal_px, frame.focal_source = f * frame.scale, source
    dist = (cap or {}).get("distortion")
    if dist and dist.get("model") == "opencv5" and not frame.mirrored:
        frame.distortion = geom.rotate_opencv_distortion([float(v) for v in dist.get("k", [])], frame.quarter_turns)
    pose = (cap or {}).get("pose")
    if pose and not frame.mirrored:
        try:
            R, c = geom.ar_pose_to_cv_upright(np.array(pose["t"], dtype=float), np.array(pose["q"], dtype=float),
                                              frame.quarter_turns)
            if np.isfinite(R).all() and np.isfinite(c).all():
                frame.ar_R, frame.ar_center = R.tolist(), c.tolist()
                frame.ar_segment = int(pose.get("segment", 0))
        except Exception:
            pass
    if cap:
        ts = cap.get("timestamp_ms")
        frame.timestamp_ms = int(ts) if isinstance(ts, (int, float)) else None
        frame.capture_flags += [str(f) for f in cap.get("flags", []) if isinstance(f, str)][:16]
    # Frames that share a camera body, zoom setting and pixel size share one calibrated camera.
    focal_tag = round(exif.get("focal_mm") or 0.0, 1)
    src_tag = "cap" if frame.focal_source == "capture" else "exif"
    frame.camera_key = (f"{exif.get('make', '')}|{exif.get('model', '')}|{focal_tag}|{src_tag}|"
                        f"{frame.work_w}x{frame.work_h}")
    return frame


def run_ingest(job: dict, settings: dict, work: Path, threads: int, progress) -> dict:
    """Returns {"frames": [Frame dicts], "groups": [...], "rejected": [...]} and writes working
    images to work/images."""
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS   # process-global in Pillow: (re)assert our own guard
    originals = Path(job["originals_dir"])
    out_dir = work / "images"
    out_dir.mkdir(parents=True, exist_ok=True)
    capture = {}
    cap_path = job.get("capture_path")
    if cap_path and Path(cap_path).is_file():
        try:
            capture = json.loads(Path(cap_path).read_text())
        except Exception:
            capture = {}
    cap_frames = {str(f.get("id")): f for f in capture.get("frames", []) if isinstance(f, dict)}

    files = job["files"]
    if len(files) < 3:
        raise InputError("too_few_images", "At least 3 photographs are required.",
                         ["Capture at least 20–30 overlapping photographs around the object."])
    frames = [Frame(id=str(f["id"]), name=str(f.get("name", "")), index=i) for i, f in enumerate(files)]
    max_side = int(settings["work_image_max_side"])
    done = 0

    def task(fr: Frame) -> Frame:
        return _process_one(fr, originals / f"{fr.id}.bin", out_dir, max_side, cap_frames.get(fr.id))

    results: list[Frame] = []
    with ThreadPoolExecutor(max_workers=max(1, min(threads, 8))) as pool:
        for fr in pool.map(task, frames):
            results.append(fr)
            done += 1
            progress(done / len(frames), f"Checked {done}/{len(frames)} photos")

    usable = [f for f in results if not f.rejected]
    rejected = [{"id": f.id, "reason": f.rejected} for f in results if f.rejected]
    if len(usable) < 3:
        raise InputError("too_few_images", f"Only {len(usable)} of {len(results)} photographs could be read.",
                         ["Re-import the photographs; supported formats are JPEG, PNG, WebP and HEIC."])

    # camera groups
    groups: dict[str, dict] = {}
    for f in usable:
        g = groups.setdefault(f.camera_key, {"key": f.camera_key, "width": f.work_w, "height": f.work_h,
                                             "frames": [], "focals": [], "sources": set(), "cx": [], "cy": [],
                                             "distortion": None})
        g["frames"].append(f.id)
        if f.focal_px:
            g["focals"].append(f.focal_px)
            g["sources"].add(f.focal_source)
        if f.cx is not None:
            g["cx"].append(f.cx)
            g["cy"].append(f.cy)
        if f.distortion and g["distortion"] is None:
            g["distortion"] = f.distortion
    group_list = []
    for i, g in enumerate(groups.values()):
        has_prior = len(g["focals"]) > 0
        focal = float(np.median(g["focals"])) if has_prior else 1.2 * max(g["width"], g["height"])
        group_list.append({
            "index": i, "width": g["width"], "height": g["height"], "frames": g["frames"],
            "focal_px": focal, "has_focal_prior": has_prior,
            "focal_source": sorted(g["sources"])[0] if has_prior else "default",
            "cx": float(np.median(g["cx"])) if g["cx"] else g["width"] / 2.0,
            "cy": float(np.median(g["cy"])) if g["cy"] else g["height"] / 2.0,
            "distortion": g["distortion"],
        })
    return {
        "frames": [asdict(f) for f in results],
        "groups": group_list,
        "rejected": rejected,
        "capture_source": capture.get("source"),
        "tracking_mode": (capture.get("tracking") or {}).get("mode"),
        "object_center_ar": capture.get("object_center_ar"),
    }
