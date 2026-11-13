"""Quality presets and settings validation.

Every number here is a real pipeline parameter. Presets trade time/memory for detail; the
measured cost of each preset on the reference hardware is in docs/MEASURED-RESULTS.md.
"""
from __future__ import annotations

from copy import deepcopy

# Parameter meaning:
#   work_image_max_side   longest side (px) of the working copies used for SfM, MVS and texturing.
#                         Originals are never modified; smaller originals are not upscaled.
#   feature_max_side      longest side (px) used for SIFT extraction.
#   max_features          SIFT features per image.
#   dense_max_side        longest side (px) of images used for depth-map estimation.
#   dense_views           neighbour views per depth map.
#   mesh_target_faces     triangle budget of the delivered mesh (after object-region cropping).
#   refine                run OpenMVS photometric mesh refinement (slow, CPU).
#   texture_max_size      largest texture atlas page (px); more pages are added as needed.
#   texture_format        "jpeg" (quality 95, 4:4:4) or "png" (lossless).
PRESETS: dict[str, dict] = {
    "preview": {
        "label": "Preview",
        "description": "Fast, coarse check that the capture registers and roughly reconstructs. "
                       "Low detail; not for export.",
        "settings": {
            "work_image_max_side": 1600, "feature_max_side": 1600, "max_features": 6000,
            "dense_max_side": 800, "dense_views": 4, "mesh_target_faces": 60_000,
            "refine": False, "texture_max_size": 2048, "texture_format": "jpeg",
        },
    },
    "standard": {
        "label": "Standard",
        "description": "Balanced detail and time. Recommended for most objects.",
        "settings": {
            "work_image_max_side": 2400, "feature_max_side": 2400, "max_features": 8192,
            "dense_max_side": 1200, "dense_views": 5, "mesh_target_faces": 200_000,
            "refine": False, "texture_max_size": 4096, "texture_format": "jpeg",
        },
    },
    "high": {
        "label": "High",
        "description": "Maximum detail: larger depth maps, twice the triangles and photometric mesh "
                       "refinement. About twice as slow and needs more companion memory; the gain "
                       "over Standard is modest on well-captured objects.",
        "settings": {
            "work_image_max_side": 3600, "feature_max_side": 3200, "max_features": 12000,
            "dense_max_side": 2000, "dense_views": 6, "mesh_target_faces": 400_000,
            # 4096² pages: an 8192² page is 256 MB of RGBA on the phone for no visible gain here
            "refine": True, "texture_max_size": 4096, "texture_format": "jpeg",
        },
    },
}

# Settings shared by all presets (overridable per job).
COMMON: dict = {
    "camera_model": "SIMPLE_RADIAL",   # COLMAP camera model used when no calibration is supplied
    "matcher": "auto",                 # auto | exhaustive | sequential
    "exhaustive_max_images": 150,      # above this, ordered captures use sequential matching
    "roi_margin": 0.35,                # generous margin kept around the estimated object box
    "min_registered": 3,               # fewer registered cameras => job fails (insufficient evidence)
    "min_registered_fraction": 0.3,    # ... or fewer than this fraction of the input
    "unsupported_distance_factor": 4.0,  # faces farther than this x dense spacing from any dense
                                         # point are removed (kept as holes, never invented)
    "seed": 1,
}

_TYPES = {
    "work_image_max_side": (int, 640, 8000), "feature_max_side": (int, 640, 8000),
    "max_features": (int, 1000, 30000), "dense_max_side": (int, 400, 6000),
    "dense_views": (int, 2, 12), "mesh_target_faces": (int, 5_000, 2_000_000),
    "refine": (bool,), "texture_max_size": (int, 512, 16384),
    "texture_format": (str, ("jpeg", "png")), "camera_model": (str, ("SIMPLE_RADIAL", "RADIAL", "OPENCV", "SIMPLE_PINHOLE", "PINHOLE")),
    "matcher": (str, ("auto", "exhaustive", "sequential")), "exhaustive_max_images": (int, 10, 400),
    "roi_margin": (float, 0.05, 2.0), "min_registered": (int, 3, 1000),
    "min_registered_fraction": (float, 0.0, 1.0), "unsupported_distance_factor": (float, 1.5, 50.0),
    "seed": (int, 0, 2**31 - 1),
}


class SettingsError(ValueError):
    pass


def resolve_settings(preset: str, overrides: dict | None = None) -> dict:
    """Return the full, validated settings for a job. Unknown keys are rejected, except keys
    starting with '_' which are passed through untouched (reserved for tests/tools)."""
    if preset not in PRESETS:
        raise SettingsError(f"unknown preset {preset!r}")
    s = deepcopy(COMMON)
    s.update(PRESETS[preset]["settings"])
    for k, v in (overrides or {}).items():
        if k.startswith("_"):
            s[k] = v
            continue
        if k not in _TYPES:
            raise SettingsError(f"unknown setting {k!r}")
        spec = _TYPES[k]
        if spec[0] is bool:
            if not isinstance(v, bool):
                raise SettingsError(f"setting {k!r} must be a boolean")
        elif spec[0] is str:
            if v not in spec[1]:
                raise SettingsError(f"setting {k!r} must be one of {spec[1]}")
        else:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise SettingsError(f"setting {k!r} must be a number")
            if spec[0] is int and int(v) != v:
                raise SettingsError(f"setting {k!r} must be an integer")
            v = spec[0](v)
            if not (spec[1] <= v <= spec[2]):
                raise SettingsError(f"setting {k!r} must be within [{spec[1]}, {spec[2]}]")
        s[k] = v
    return s


def settings_fingerprint(preset: str, settings: dict) -> str:
    """Stable short hash identifying the reconstruction settings a result was produced with."""
    import hashlib
    import json
    public = {k: v for k, v in settings.items() if not k.startswith("_")}
    blob = json.dumps({"preset": preset, "settings": public}, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]
