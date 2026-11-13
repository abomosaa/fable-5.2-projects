"""Sanity-check close-ups against an overview (data QA only, not product code).

  sanity.py <set_dir> <out_json> [<footprints.jpg>]

For every closeup_*.{jpg,png,...} in <set_dir>, one pair at a time:
  * SIFT (images capped at 4000 px on the long side) + Lowe ratio test + findHomography(USAC_MAGSAC)
  * the close-up is tried at several extra downscale factors (1, 1/2, 1/4, 1/8) and the best kept
  * scale factor = close-up ORIGINAL pixels per overview ORIGINAL pixel
                 = sqrt(|det J|), J = 2x2 Jacobian of the overview->close-up mapping at the
                   overview point that lands on the close-up centre
  * footprint of the close-up in overview pixels, reprojection RMS, a plausibility flag
  * NCC between the overview patch and the close-up warped to overview resolution
    (close to 1.0 together with scale <= ~1 would indicate a crop of the same file)
  * EXIF camera / time / focal length of both files (evidence of separate exposures)
  * fundamental-matrix inliers on the same matches: H inliers / F inliers well below 1 indicates parallax
    (non-planar subject or large viewpoint change), i.e. a single homography cannot explain the pair
"""
import glob
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ExifTags

MAX_SIDE = 4000
RATIO = 0.75
cv2.setNumThreads(4)
Image.MAX_IMAGE_PIXELS = 120_000_000


def exif_summary(path):
    out = {}
    try:
        with Image.open(path) as im:
            out["size"] = list(im.size)
            ex = im.getexif()
            base = {ExifTags.TAGS.get(k, k): v for k, v in ex.items()}
            sub = {ExifTags.TAGS.get(k, k): v for k, v in ex.get_ifd(0x8769).items()}
        for k in ("Make", "Model", "DateTime", "Software"):
            if k in base:
                out[k] = str(base[k]).strip("\x00 ")
        for k in ("DateTimeOriginal", "FocalLength", "FocalLengthIn35mmFilm", "ExposureTime", "FNumber",
                  "ISOSpeedRatings", "SubSecTimeOriginal"):
            if k in sub:
                v = sub[k]
                out[k] = float(v) if not isinstance(v, (str, int)) else v
    except Exception as e:  # untrusted input: never fatal
        out["exif_error"] = repr(e)
    return out


def load_gray(path):
    """Returns (gray uint8 image capped at MAX_SIDE, original (w, h), work/original scale)."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("cannot read " + path)
    h, w = img.shape[:2]
    s = min(1.0, MAX_SIDE / float(max(h, w)))
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    del img
    if s < 1.0:
        g = cv2.resize(g, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    return g, (w, h), g.shape[1] / float(w)


def sift_features(gray, nfeatures):
    sift = cv2.SIFT_create(nfeatures=nfeatures, contrastThreshold=0.03)
    kp, des = sift.detectAndCompute(gray, None)
    pts = np.float32([k.pt for k in kp]) if kp else np.zeros((0, 2), np.float32)
    return pts, des


def match(des_q, des_t, flann):
    if des_q is None or des_t is None or len(des_q) < 8 or len(des_t) < 8:
        return np.zeros((0, 2), int)
    knn = flann.knnMatch(des_q, des_t, k=2)
    good = [(m.queryIdx, m.trainIdx) for m, n in (p for p in knn if len(p) == 2) if m.distance < RATIO * n.distance]
    return np.array(good, int).reshape(-1, 2)


def jac_scale(H, x, y):
    """sqrt(|det J|) of the projective map H at (x, y)."""
    eps = 0.5
    p = np.float64([[x - eps, y], [x + eps, y], [x, y - eps], [x, y + eps]]).reshape(-1, 1, 2)
    q = cv2.perspectiveTransform(p, H).reshape(-1, 2)
    J = np.column_stack([(q[1] - q[0]) / (2 * eps), (q[3] - q[2]) / (2 * eps)])
    return float(np.sqrt(abs(np.linalg.det(J)))), J


def check_pair(ov_gray, ov_size, ov_s, ov_pts, ov_des, flann_ov, path):
    res = {"file": os.path.basename(path), "exif": exif_summary(path)}
    cg, (cw, ch), cs = load_gray(path)
    res["original_size"] = [cw, ch]
    best = None
    for f in (1.0, 0.5, 0.25, 0.125):
        g = cg if f == 1.0 else cv2.resize(cg, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        if min(g.shape[:2]) < 160:
            break
        pts, des = sift_features(g, 12000)
        m = match(des, ov_des, flann_ov)  # query = close-up, train = overview
        n_inl, H, rms = 0, None, None
        if len(m) >= 8:
            src = ov_pts[m[:, 1]].reshape(-1, 1, 2)
            dst = pts[m[:, 0]].reshape(-1, 1, 2)
            H, mask = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, 3.0, maxIters=20000, confidence=0.999)
            if H is not None and mask is not None:
                inl = mask.ravel().astype(bool)
                n_inl = int(inl.sum())
                if n_inl:
                    pr = cv2.perspectiveTransform(src[inl], H).reshape(-1, 2)
                    rms = float(np.sqrt(np.mean(np.sum((pr - dst[inl].reshape(-1, 2)) ** 2, axis=1))))
        trial = {"closeup_downscale": cs * f, "keypoints": int(len(pts)), "ratio_matches": int(len(m)),
                 "inliers": n_inl, "rms_px_work": rms}
        res.setdefault("trials", []).append(trial)
        if H is not None and (best is None or n_inl > best[0]):
            best = (n_inl, H.copy(), cs * f, trial, g.shape)
            best_pairs = (src.copy(), dst.copy())
        del g, pts, des
    del cg
    if best is None or best[0] < 8:
        res.update({"inliers": best[0] if best else 0, "registers": False, "verdict": "no homography found"})
        return res
    n_inl, H, cfac, trial, gshape = best
    # Planarity indicator: matches consistent with SOME rigid 2-view geometry (fundamental matrix) versus
    # matches consistent with ONE plane (homography). ~1.0 = planar subject / pure zoom; clearly < 1 = parallax.
    f_inl = None
    try:
        Fm, fmask = cv2.findFundamentalMat(best_pairs[0], best_pairs[1], cv2.USAC_MAGSAC, 3.0, 0.999, 20000)
        if fmask is not None:
            f_inl = int(fmask.sum())
    except cv2.error:
        pass
    res["fundamental_inliers"] = f_inl
    res["h_over_f_inliers"] = None if not f_inl else round(n_inl / float(f_inl), 3)
    res["h_inlier_ratio"] = round(n_inl / float(max(trial["ratio_matches"], 1)), 3)
    # work coords -> original coords:  H_orig = diag(1/cfac) * H * diag(ov_s)
    So = np.diag([ov_s, ov_s, 1.0])
    Sc_inv = np.diag([1.0 / cfac, 1.0 / cfac, 1.0])
    Ho = Sc_inv @ H @ So            # overview original px -> close-up original px
    Hinv = np.linalg.inv(Ho)
    corners = np.float64([[0, 0], [cw, 0], [cw, ch], [0, ch]]).reshape(-1, 1, 2)
    foot = cv2.perspectiveTransform(corners, Hinv).reshape(-1, 2)
    centre = cv2.perspectiveTransform(np.float64([[[cw / 2.0, ch / 2.0]]]), Hinv).reshape(2)
    scale, J = jac_scale(Ho, centre[0], centre[1])
    corner_scales = [jac_scale(Ho, x, y)[0] for x, y in foot]
    convex = bool(cv2.isContourConvex(foot.astype(np.float32).reshape(-1, 1, 2)))
    area = float(cv2.contourArea(foot.astype(np.float32)))
    ow, oh = ov_size
    sv = np.linalg.svd(J, compute_uv=False)
    # NCC at overview resolution inside the footprint (crop detector)
    ncc = None
    try:
        x0, y0 = np.floor(foot.min(0)).astype(int)
        x1, y1 = np.ceil(foot.max(0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, ow), min(y1, oh)
        if x1 - x0 > 32 and y1 - y0 > 32:
            wx0, wy0, wx1, wy1 = [int(round(v * ov_s)) for v in (x0, y0, x1, y1)]
            patch = ov_gray[wy0:wy1, wx0:wx1]
            T = np.float64([[1, 0, -wx0], [0, 1, -wy0], [0, 0, 1]])
            cgray = cv2.imread(path, cv2.IMREAD_REDUCED_GRAYSCALE_2 if max(cw, ch) > 3000 else cv2.IMREAD_GRAYSCALE)
            rs = cgray.shape[1] / float(cw)
            # close-up(reduced) -> overview(work) patch
            M = T @ So @ Hinv @ np.diag([1.0 / rs, 1.0 / rs, 1.0])
            warped = cv2.warpPerspective(cgray, M, (patch.shape[1], patch.shape[0]), flags=cv2.INTER_AREA)
            valid = cv2.warpPerspective(np.full(cgray.shape, 255, np.uint8), M, (patch.shape[1], patch.shape[0])) > 250
            del cgray
            if valid.sum() > 1000:
                a = patch[valid].astype(np.float64)
                b = warped[valid].astype(np.float64)
                a -= a.mean(); b -= b.mean()
                ncc = float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))
    except Exception as e:
        res["ncc_error"] = repr(e)
    plausible = convex and 0.2 < sv[1] / sv[0] and max(corner_scales) / max(min(corner_scales), 1e-9) < 3.0 \
        and area > 0 and scale < 40
    res.update({
        "inliers": n_inl, "ratio_matches": trial["ratio_matches"], "best_closeup_downscale": round(cfac, 4),
        "rms_px_work": trial["rms_px_work"],
        "scale_factor": round(scale, 3),
        "scale_at_corners": [round(c, 3) for c in corner_scales],
        "anisotropy": round(float(sv[0] / sv[1]), 3),
        "footprint_overview_px": [[round(float(x), 1), round(float(y), 1)] for x, y in foot],
        "footprint_fraction_of_overview": round(area / float(ow * oh), 4),
        "footprint_convex": convex,
        "ncc_vs_overview": None if ncc is None else round(ncc, 3),
        "H_overview_to_closeup_original_px": [[float(v) for v in row] for row in (Ho / Ho[2, 2])],
        "registers": bool(plausible and n_inl >= 25),
    })
    return res


def main():
    set_dir, out_json = sys.argv[1], sys.argv[2]
    viz = sys.argv[3] if len(sys.argv) > 3 else None
    ov = sorted(glob.glob(os.path.join(set_dir, "overview.*")))[0]
    ov_gray, ov_size, ov_s = load_gray(ov)
    ov_pts, ov_des = sift_features(ov_gray, 60000)
    flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=96))
    flann.add([ov_des]); flann.train()
    report = {"set": os.path.basename(os.path.normpath(set_dir)),
              "overview": {"file": os.path.basename(ov), "original_size": list(ov_size), "exif": exif_summary(ov),
                           "work_scale": ov_s, "keypoints": int(len(ov_pts))},
              "params": {"max_side": MAX_SIDE, "ratio": RATIO, "ransac": "USAC_MAGSAC thr 3 px (work px)"},
              "closeups": []}
    for p in sorted(glob.glob(os.path.join(set_dir, "closeup_*"))):
        r = check_pair(ov_gray, ov_size, ov_s, ov_pts, ov_des, flann, p)
        report["closeups"].append(r)
        print("%-16s inliers=%-5s matches=%-5s Finl=%-5s H/F=%-6s scale=%-7s aniso=%-6s frac=%-7s ncc=%-6s reg=%s  [best ds %s]" % (
            r["file"], r.get("inliers"), r.get("ratio_matches"), r.get("fundamental_inliers"), r.get("h_over_f_inliers"),
            r.get("scale_factor"), r.get("anisotropy"),
            r.get("footprint_fraction_of_overview"), r.get("ncc_vs_overview"), r.get("registers"),
            r.get("best_closeup_downscale")), flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(out_json)), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    if viz:
        img = cv2.imread(ov, cv2.IMREAD_COLOR)
        s = min(1.0, 2000.0 / max(img.shape[:2]))
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        for i, r in enumerate(report["closeups"]):
            if "footprint_overview_px" not in r:
                continue
            poly = (np.float32(r["footprint_overview_px"]) * s)
            if np.abs(poly).max() > 20000:
                continue
            col = (0, 255, 0) if r["registers"] else (0, 0, 255)
            cv2.polylines(img, [poly.astype(np.int32).reshape(-1, 1, 2)], True, col, 3)
            c = poly.mean(0)
            cv2.putText(img, r["file"].split(".")[0].replace("closeup_", ""), (int(c[0]) - 20, int(c[1])),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, col, 3)
        cv2.imwrite(viz, img, [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    main()
