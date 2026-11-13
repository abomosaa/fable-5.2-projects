"""Coordinate conventions and small geometric estimators (pure numpy; unit-tested).

Conventions used throughout the pipeline
----------------------------------------
* Image coordinates: COLMAP/OpenCV style, origin at the top-left corner of the top-left pixel,
  +x right, +y down (the centre of the first pixel is (0.5, 0.5)).
* "CV camera frame": +x right, +y down, +z forward (COLMAP, OpenMVS).
* "GL camera frame": +x right, +y up, −z forward (ARCore, OpenGL, glTF cameras).
  R_world_from_cam_cv = R_world_from_cam_gl @ diag(1, −1, −1).
* EXIF orientation: the working copies used for reconstruction are always *upright*
  (orientation applied to the pixels). Intrinsics and pose priors supplied for the stored
  (un-rotated) image are transformed with the functions below.
* SfM frame: arbitrary similarity gauge chosen by COLMAP. Model frame: right-handed, +Y up,
  origin at the estimated object focus point; `model = s * R @ sfm + t` (Sim3 below).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

GL_FROM_CV = np.diag([1.0, -1.0, -1.0])

# Number of clockwise quarter turns that make a stored image upright, per EXIF orientation.
# Mirrored orientations (2, 4, 5, 7) additionally need a horizontal flip *before* the turns.
_EXIF_QUARTER_TURNS_CW = {1: 0, 2: 0, 3: 2, 4: 2, 5: 3, 6: 1, 7: 1, 8: 3}
_EXIF_MIRRORED = {2, 4, 5, 7}


def exif_quarter_turns(orientation: int) -> tuple[int, bool]:
    """(clockwise quarter turns, mirrored) needed to display a stored image upright."""
    if orientation not in _EXIF_QUARTER_TURNS_CW:
        return 0, False
    return _EXIF_QUARTER_TURNS_CW[orientation], orientation in _EXIF_MIRRORED


def upright_size(width: int, height: int, quarter_turns_cw: int) -> tuple[int, int]:
    return (height, width) if quarter_turns_cw % 2 else (width, height)


def rotate_pixel(x: float, y: float, width: int, height: int, quarter_turns_cw: int) -> tuple[float, float]:
    """Map a continuous pixel coordinate of the stored image to the upright image."""
    k = quarter_turns_cw % 4
    if k == 0:
        return x, y
    if k == 1:
        return height - y, x
    if k == 2:
        return width - x, height - y
    return y, width - x


def rotate_intrinsics(fx: float, fy: float, cx: float, cy: float, width: int, height: int,
                      quarter_turns_cw: int) -> tuple[float, float, float, float]:
    """Pinhole intrinsics of the upright image given those of the stored image."""
    k = quarter_turns_cw % 4
    if k == 0:
        return fx, fy, cx, cy
    if k == 1:
        return fy, fx, height - cy, cx
    if k == 2:
        return fx, fy, width - cx, height - cy
    return fy, fx, cy, width - cx


def rotate_opencv_distortion(k: list[float], quarter_turns_cw: int) -> list[float]:
    """OpenCV 5-parameter distortion [k1, k2, p1, p2, k3] for the upright image. Radial terms are
    rotation invariant; the tangential pair rotates with the image axes."""
    k1, k2, p1, p2, k3 = (list(k) + [0.0] * 5)[:5]
    q = quarter_turns_cw % 4
    if q == 1:
        p1, p2 = p2, -p1
    elif q == 2:
        p1, p2 = -p1, -p2
    elif q == 3:
        p1, p2 = -p2, p1
    return [k1, k2, p1, p2, k3]


def upright_from_stored_rotation(quarter_turns_cw: int) -> np.ndarray:
    """3x3 rotation R with  p_upright_cam = R @ p_stored_cam  (CV camera frames)."""
    k = quarter_turns_cw % 4
    return [np.eye(3),
            np.array([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]]),
            np.diag([-1.0, -1, 1]),
            np.array([[0.0, 1, 0], [-1, 0, 0], [0, 0, 1]])][k]


def quat_to_rot(q: np.ndarray) -> np.ndarray:
    """Unit quaternion (x, y, z, w) to rotation matrix."""
    x, y, z, w = np.asarray(q, dtype=float) / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def rot_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix to unit quaternion (x, y, z, w), w >= 0."""
    m = np.asarray(R, dtype=float)
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = np.array([(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s])
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = np.array([0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s])
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = np.array([(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s])
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = np.array([(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s])
    q /= np.linalg.norm(q)
    return -q if q[3] < 0 else q


def ar_pose_to_cv_upright(t: np.ndarray, q: np.ndarray, quarter_turns_cw: int) -> tuple[np.ndarray, np.ndarray]:
    """Convert an AR tracking pose (camera-to-world, GL camera axes relative to the *stored*
    image) into (R_world_from_cam, centre) for the CV camera frame of the *upright* image."""
    R_wc_gl = quat_to_rot(q)
    R_wc_cv = R_wc_gl @ GL_FROM_CV
    R_up_from_stored = upright_from_stored_rotation(quarter_turns_cw)
    return R_wc_cv @ R_up_from_stored.T, np.asarray(t, dtype=float)


@dataclass
class Sim3:
    """y = s * R @ x + t"""
    s: float
    R: np.ndarray
    t: np.ndarray

    def apply(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=float)
        return self.s * x @ self.R.T + self.t

    def apply_dir(self, d: np.ndarray) -> np.ndarray:
        return np.asarray(d, dtype=float) @ self.R.T

    def inverse(self) -> "Sim3":
        Ri = self.R.T
        return Sim3(1.0 / self.s, Ri, -(Ri @ self.t) / self.s)

    def compose(self, other: "Sim3") -> "Sim3":
        """self ∘ other  (apply `other` first)."""
        return Sim3(self.s * other.s, self.R @ other.R, self.s * self.R @ other.t + self.t)

    def matrix(self) -> np.ndarray:
        m = np.eye(4)
        m[:3, :3] = self.s * self.R
        m[:3, 3] = self.t
        return m

    def to_json(self) -> dict:
        return {"s": float(self.s), "R": np.asarray(self.R).round(9).tolist(), "t": np.asarray(self.t).round(9).tolist()}

    @staticmethod
    def from_json(d: dict) -> "Sim3":
        return Sim3(float(d["s"]), np.array(d["R"], dtype=float), np.array(d["t"], dtype=float))

    @staticmethod
    def identity() -> "Sim3":
        return Sim3(1.0, np.eye(3), np.zeros(3))


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool = True) -> Sim3:
    """Least-squares similarity transform dst ≈ s R src + t (Umeyama 1991). Proper rotation
    (det = +1) is enforced, so a mirrored configuration can never be 'explained' by a flip."""
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    var_s = (xs ** 2).sum() / len(src)
    s = float(np.trace(np.diag(D) @ S) / var_s) if with_scale and var_s > 0 else 1.0
    t = mu_d - s * R @ mu_s
    return Sim3(s, R, t)


@dataclass
class Sim3Fit:
    sim3: Sim3
    inliers: np.ndarray          # boolean mask over the input pairs
    rms: float                   # RMS residual of inliers, in dst units
    extent: float                # RMS spread of dst inliers around their centroid, in dst units
    scale_rel_std: float         # bootstrap relative standard deviation of the scale


def fit_sim3_ransac(src: np.ndarray, dst: np.ndarray, threshold: float, iterations: int = 500,
                    seed: int = 1) -> Sim3Fit | None:
    """Robust similarity between corresponding point sets (e.g. SfM camera centres → AR camera
    centres). Returns None when no non-degenerate consensus of at least 4 pairs exists."""
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    n = len(src)
    if n < 4:
        return None
    rng = np.random.default_rng(seed)
    best_mask, best_count = None, 0
    for _ in range(iterations):
        idx = rng.choice(n, 3, replace=False)
        a = src[idx]
        # reject near-collinear samples
        if np.linalg.norm(np.cross(a[1] - a[0], a[2] - a[0])) < 1e-9:
            continue
        try:
            m = umeyama(src[idx], dst[idx])
        except np.linalg.LinAlgError:
            continue
        if not np.isfinite(m.s) or m.s <= 0:
            continue
        res = np.linalg.norm(m.apply(src) - dst, axis=1)
        mask = res < threshold
        c = int(mask.sum())
        if c > best_count:
            best_count, best_mask = c, mask
    if best_mask is None or best_count < 4:
        return None
    for _ in range(3):  # refine on consensus
        m = umeyama(src[best_mask], dst[best_mask])
        res = np.linalg.norm(m.apply(src) - dst, axis=1)
        new_mask = res < threshold
        if new_mask.sum() < 4:
            break
        if (new_mask == best_mask).all():
            break
        best_mask = new_mask
    m = umeyama(src[best_mask], dst[best_mask])
    res = np.linalg.norm(m.apply(src[best_mask]) - dst[best_mask], axis=1)
    d_in = dst[best_mask]
    extent = float(np.sqrt(((d_in - d_in.mean(0)) ** 2).sum(1).mean()))
    idx_in = np.flatnonzero(best_mask)
    scales = []
    for _ in range(200):
        b = rng.choice(idx_in, len(idx_in), replace=True)
        if len(np.unique(b)) < 4:
            continue
        try:
            scales.append(umeyama(src[b], dst[b]).s)
        except np.linalg.LinAlgError:
            pass
    rel_std = float(np.std(scales) / m.s) if len(scales) >= 20 else float("inf")
    return Sim3Fit(m, best_mask, float(np.sqrt((res ** 2).mean())), extent, rel_std)


def focus_point(centers: np.ndarray, directions: np.ndarray, iterations: int = 10) -> tuple[np.ndarray, float]:
    """Point closest (robustly) to all camera optical axes — the object centre for an orbit
    capture. Returns (point, conditioning) where conditioning in [0, 1] is the ratio of the
    smallest to the largest eigenvalue of the normal matrix (≈0 for parallel axes, i.e. the
    cameras do not converge on anything)."""
    c = np.asarray(centers, dtype=float)
    d = np.asarray(directions, dtype=float)
    d = d / np.linalg.norm(d, axis=1, keepdims=True)
    w = np.ones(len(c))
    x = c.mean(0)
    cond = 0.0
    for _ in range(iterations):
        A = np.zeros((3, 3))
        b = np.zeros(3)
        for ci, di, wi in zip(c, d, w):
            P = np.eye(3) - np.outer(di, di)
            A += wi * P
            b += wi * P @ ci
        ev = np.linalg.eigvalsh(A)
        cond = float(ev[0] / ev[-1]) if ev[-1] > 0 else 0.0
        if cond < 1e-6:
            return c.mean(0) + d.mean(0) * 1.0, cond
        x = np.linalg.solve(A, b)
        v = x - c
        dist = np.linalg.norm(v - (v * d).sum(1, keepdims=True) * d, axis=1)
        scale = np.median(dist) + 1e-12
        w = 1.0 / np.maximum(1.0, dist / (1.5 * scale))  # Huber weights
    return x, cond


def fit_plane_ransac(points: np.ndarray, threshold: float, iterations: int = 400, seed: int = 1,
                     normal_prior: np.ndarray | None = None, max_angle_deg: float = 35.0
                     ) -> tuple[np.ndarray, float, np.ndarray] | None:
    """RANSAC plane n·x + d = 0 with unit n. If `normal_prior` is given only planes whose normal
    is within `max_angle_deg` of ±prior are considered and n is oriented along the prior.
    Returns (n, d, inlier_mask) or None."""
    p = np.asarray(points, dtype=float)
    if len(p) < 3:
        return None
    rng = np.random.default_rng(seed)
    cos_max = np.cos(np.radians(max_angle_deg))
    best = None
    best_count = 0
    for _ in range(iterations):
        i = rng.choice(len(p), 3, replace=False)
        n = np.cross(p[i[1]] - p[i[0]], p[i[2]] - p[i[0]])
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            continue
        n = n / ln
        if normal_prior is not None:
            c = float(n @ normal_prior)
            if abs(c) < cos_max:
                continue
            if c < 0:
                n = -n
        d = -float(n @ p[i[0]])
        mask = np.abs(p @ n + d) < threshold
        cnt = int(mask.sum())
        if cnt > best_count:
            best_count, best = cnt, (n, d, mask)
    if best is None:
        return None
    n, d, mask = best
    q = p[mask]
    centroid = q.mean(0)
    _, _, vt = np.linalg.svd(q - centroid, full_matrices=False)
    n2 = vt[2]
    if n2 @ n < 0:
        n2 = -n2
    d2 = -float(n2 @ centroid)
    mask2 = np.abs(p @ n2 + d2) < threshold
    return n2, d2, mask2


def rotation_aligning(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Smallest rotation R with R @ a ∥ b (unit vectors)."""
    a = np.asarray(a, dtype=float) / np.linalg.norm(a)
    b = np.asarray(b, dtype=float) / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if c > 1 - 1e-12:
        return np.eye(3)
    if c < -1 + 1e-12:
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


AZIMUTH_BINS = 12
ELEVATION_EDGES_DEG = (-90.0, 20.0, 50.0, 90.0)   # low / mid / high bands


def viewpoint_bins(positions: np.ndarray, center: np.ndarray, up: np.ndarray) -> dict:
    """Bin camera positions by azimuth (12 x 30°) and elevation band (low/mid/high) around
    `center` with vertical `up`. This is *viewpoint* coverage — where photos were taken from —
    not proof that the surface facing those directions was reconstructed."""
    p = np.asarray(positions, dtype=float) - center
    up = np.asarray(up, dtype=float) / np.linalg.norm(up)
    ref = np.cross(up, [1.0, 0, 0])
    if np.linalg.norm(ref) < 0.2:
        ref = np.cross(up, [0, 0, 1.0])
    ref /= np.linalg.norm(ref)
    side = np.cross(up, ref)
    h = p @ up
    x, y = p @ ref, p @ side
    az = (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0
    el = np.degrees(np.arctan2(h, np.hypot(x, y)))
    grid = np.zeros((len(ELEVATION_EDGES_DEG) - 1, AZIMUTH_BINS), dtype=int)
    for a, e in zip(az, el):
        band = int(np.clip(np.searchsorted(ELEVATION_EDGES_DEG, e, side="right") - 1, 0, grid.shape[0] - 1))
        grid[band, int(a // (360 / AZIMUTH_BINS)) % AZIMUTH_BINS] += 1
    occupied_az = np.sort(az)
    if len(occupied_az) >= 2:
        gaps = np.diff(np.concatenate([occupied_az, [occupied_az[0] + 360.0]]))
        largest_gap = float(gaps.max())
    else:
        largest_gap = 360.0
    return {
        "azimuth_bins": AZIMUTH_BINS,
        "elevation_edges_deg": list(ELEVATION_EDGES_DEG),
        "counts": grid.tolist(),
        "azimuth_bins_covered": int((grid.sum(0) > 0).sum()),
        "bands_covered": int((grid.sum(1) > 0).sum()),
        "largest_azimuth_gap_deg": round(largest_gap, 1),
        "azimuth_deg": np.round(az, 1).tolist(),
        "elevation_deg": np.round(el, 1).tolist(),
    }
