#!/usr/bin/env python3
"""Objective evaluation of Detailed Capture results (independent of the C++ core).

Synthetic sets (known poses in gt.json):
  * acceptance / rejection table against expectations,
  * registration error of every accepted frame against ground truth (absolute, and relative between
    overlapping frames = what produces seams/ghosting),
  * reconstruction vs. the pristine source re-sampled on the output grid, compared with the overview enlarged
    to identical dimensions (bicubic) in matched windows: PSNR, SSIM, high-frequency correlation and the spatial
    frequency up to which the image is coherent with the reference (cannot be raised by sharpening),
  * glyph readability (template classifier on known glyph positions) and line-pair contrast for the document set.

Real sets (no ground truth): leave-one-out — a close-up that was NOT given to the pipeline is used as an
independent high-resolution reference.

  evaluate.py synthetic <set_dir> <project_dir> <out_dir>
  evaluate.py holdout   <set_dir> <work_dir> <out_dir> [--holdout closeup_03.jpg ...]
"""
import argparse
import glob
import json
import math
import os
import sys

import cv2
import numpy as np
from skimage.metrics import structural_similarity

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcrun  # noqa: E402

cv2.setNumThreads(4)


# ------------------------------------------------------------------------------------------------ geometry
def apply_h(H, pts):
    pts = np.asarray(pts, np.float64)
    v = np.c_[pts, np.ones(len(pts))] @ np.asarray(H, np.float64).T
    return v[:, :2] / v[:, 2:3]


def radial_undistort(pts, w, h, k1):
    pts = np.asarray(pts, np.float64)
    if k1 == 0:
        return pts.copy()
    c = np.array([w / 2, h / 2])
    R = 0.5 * math.hypot(w, h)
    d = (pts - c) / R
    f = 1 + k1 * (d ** 2).sum(1, keepdims=True)
    return c + (pts - c) * f


def radial_distort(pts, w, h, k1):
    pts = np.asarray(pts, np.float64)
    if k1 == 0:
        return pts.copy()
    c = np.array([w / 2, h / 2])
    R = 0.5 * math.hypot(w, h)
    d = (pts - c) / R
    ru = np.sqrt((d ** 2).sum(1))
    rd = ru.copy()
    for _ in range(15):
        rd = rd - (rd * (1 + k1 * rd * rd) - ru) / (1 + 3 * k1 * rd * rd)
    s = np.where(ru > 1e-12, rd / np.maximum(ru, 1e-12), 1.0)
    return c + (pts - c) * s[:, None]


class Est:
    """Estimated transforms read from project.json (frame -> canvas -> overview raster)."""

    def __init__(self, project):
        self.p = project
        self.ov = next(f for f in project["frames"] if f["role"] == "overview")
        self.ovw, self.ovh = self.ov["meta"]["width"], self.ov["meta"]["height"]
        reg = project.get("registration") or {}
        self.ovk1 = reg.get("overviewK1", 0.0)

    def frame_to_canvas(self, f, pts):
        w, h = f["meta"]["width"], f["meta"]["height"]
        H = np.array(f["reg"]["H"]).reshape(3, 3)
        return apply_h(H, radial_undistort(pts, w, h, f["reg"].get("k1", 0.0)))

    def canvas_to_ovraster(self, pts):
        return radial_distort(pts, self.ovw, self.ovh, self.ovk1)

    def ovraster_to_canvas(self, pts):
        return radial_undistort(pts, self.ovw, self.ovh, self.ovk1)


class GT:
    def __init__(self, gt):
        self.gt = gt
        self.by_file = {f["file"]: f for f in gt["frames"]}
        self.cw, self.ch = gt["camera"]
        self.ovf = next(f for f in gt["frames"] if f["role"] == "overview")

    def img_to_src(self, f, pts):
        """oriented image px of frame f -> source px (ground truth)."""
        H = np.array(f["H_src2img"])
        return apply_h(np.linalg.inv(H), radial_undistort(pts, self.cw, self.ch, f["k1"]))

    def src_to_img(self, f, pts):
        H = np.array(f["H_src2img"])
        return radial_distort(apply_h(H, pts), self.cw, self.ch, f["k1"])


# ------------------------------------------------------------------------------------------------ result IO
class Result:
    def __init__(self, proj_dir, project):
        self.dir = os.path.join(proj_dir, "results", project["result"]["runId"])
        self.m = json.load(open(os.path.join(self.dir, "manifest.json")))
        self.w, self.h, self.ts, self.maxl = self.m["width"], self.m["height"], self.m["tileSize"], self.m["maxLevel"]
        self.labels = cv2.imread(os.path.join(self.dir, "labels.png"), cv2.IMREAD_UNCHANGED)
        self.q = self.m["seamScale"]
        self._cache = {}

    def tile(self, c, r):
        k = (c, r)
        if k not in self._cache:
            if len(self._cache) > 64:
                self._cache.pop(next(iter(self._cache)))
            self._cache[k] = cv2.imread(os.path.join(self.dir, "tiles", str(self.maxl), f"{c}_{r}.png"))
        return self._cache[k]

    def level_image(self, max_dim=2400):
        """Whole image from the coarsest pyramid level whose larger side is still >= max_dim/2 (bounded memory)."""
        L = self.maxl
        while max(self.w, self.h) / (2 ** (self.maxl - L)) > max_dim and L > 0:
            L -= 1
        lw = -(-self.w // (2 ** (self.maxl - L))); lh = -(-self.h // (2 ** (self.maxl - L)))
        out = np.zeros((lh, lw, 3), np.uint8)
        for r in range((lh + self.ts - 1) // self.ts):
            for c in range((lw + self.ts - 1) // self.ts):
                t = cv2.imread(os.path.join(self.dir, "tiles", str(L), f"{c}_{r}.png"))
                if t is not None:
                    out[r * self.ts:r * self.ts + t.shape[0], c * self.ts:c * self.ts + t.shape[1]] = t
        return out, lw / self.w

    def crop(self, x, y, w, h):
        out = np.zeros((h, w, 3), np.uint8)
        for r in range(y // self.ts, (y + h - 1) // self.ts + 1):
            for c in range(x // self.ts, (x + w - 1) // self.ts + 1):
                t = self.tile(c, r)
                if t is None:
                    continue
                tx, ty = c * self.ts, r * self.ts
                x0, y0, x1, y1 = max(x, tx), max(y, ty), min(x + w, tx + t.shape[1]), min(y + h, ty + t.shape[0])
                if x1 > x0 and y1 > y0:
                    out[y0 - y:y1 - y, x0 - x:x1 - x] = t[y0 - ty:y1 - ty, x0 - tx:x1 - tx]
        return out

    def label_crop(self, x, y, w, h):
        ys = np.clip((np.arange(y, y + h) / self.q).astype(int), 0, self.labels.shape[0] - 1)
        xs = np.clip((np.arange(x, x + w) / self.q).astype(int), 0, self.labels.shape[1] - 1)
        return self.labels[np.ix_(ys, xs)]


# ------------------------------------------------------------------------------------------------ metrics
def fit_affine_color(a, ref):
    """Per-channel gain+offset mapping a -> ref (removes exposure/white-balance differences for a fair comparison)."""
    out = np.empty_like(a, dtype=np.float32)
    for c in range(3):
        x = a[..., c].astype(np.float32).ravel()
        y = ref[..., c].astype(np.float32).ravel()
        A = np.c_[x, np.ones_like(x)]
        g, o = np.linalg.lstsq(A, y, rcond=None)[0]
        out[..., c] = a[..., c].astype(np.float32) * g + o
    return np.clip(out, 0, 255)


def gray(a):
    return cv2.cvtColor(np.clip(a, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)


def psnr(a, b):
    mse = float(np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2))
    return 99.0 if mse < 1e-9 else 10 * math.log10(255.0 ** 2 / mse)


def hf_ncc(a, b, sigma=1.5):
    """Correlation of the detail band (image minus its Gaussian blur): phase-sensitive, insensitive to gain."""
    ha = a - cv2.GaussianBlur(a, (0, 0), sigma)
    hb = b - cv2.GaussianBlur(b, (0, 0), sigma)
    ha -= ha.mean(); hb -= hb.mean()
    d = math.sqrt(float((ha ** 2).sum() * (hb ** 2).sum()))
    return float((ha * hb).sum() / d) if d > 0 else 0.0


def coherence_curve(a, b, nb=24):
    """Magnitude-squared coherence between a and b per radial frequency band (Welch over 64x64 blocks).
    Returns (freqs in cycles/px, coherence). Sharpening or invented texture cannot raise coherence."""
    B = 64
    win = np.outer(np.hanning(B), np.hanning(B)).astype(np.float32)
    saa = sbb = None
    sab = None
    for y in range(0, a.shape[0] - B + 1, B // 2):
        for x in range(0, a.shape[1] - B + 1, B // 2):
            pa = a[y:y + B, x:x + B]; pb = b[y:y + B, x:x + B]
            fa = np.fft.fft2((pa - pa.mean()) * win); fb = np.fft.fft2((pb - pb.mean()) * win)
            if saa is None:
                saa = np.abs(fa) ** 2; sbb = np.abs(fb) ** 2; sab = fa * np.conj(fb)
            else:
                saa += np.abs(fa) ** 2; sbb += np.abs(fb) ** 2; sab += fa * np.conj(fb)
    fy = np.fft.fftfreq(B)[:, None]; fx = np.fft.fftfreq(B)[None, :]
    fr = np.sqrt(fx ** 2 + fy ** 2)
    edges = np.linspace(0, 0.5, nb + 1)
    freqs, coh = [], []
    for i in range(nb):
        m = (fr >= edges[i]) & (fr < edges[i + 1])
        if i == 0:
            m &= fr > 0
        num = np.abs(sab[m].sum()) ** 2
        den = saa[m].sum() * sbb[m].sum()
        freqs.append((edges[i] + edges[i + 1]) / 2)
        coh.append(float(num / den) if den > 0 else 0.0)
    return np.array(freqs), np.array(coh)


def f50(freqs, coh, thr=0.5):
    """Highest frequency below which coherence stays above thr (linear interpolation)."""
    last = 0.0
    for i in range(len(coh)):
        if coh[i] >= thr:
            last = freqs[i]
        else:
            if i > 0 and coh[i - 1] >= thr:
                t = (coh[i - 1] - thr) / max(1e-9, coh[i - 1] - coh[i])
                last = freqs[i - 1] + t * (freqs[i] - freqs[i - 1])
            break
    return float(last)


def block_shifts(a, b, B=128):
    """Local translation of b relative to a per block (phase correlation). Returns array of (dx, dy, response)."""
    out = []
    win = cv2.createHanningWindow((B, B), cv2.CV_32F)
    for y in range(0, a.shape[0] - B + 1, B):
        for x in range(0, a.shape[1] - B + 1, B):
            pa = a[y:y + B, x:x + B]; pb = b[y:y + B, x:x + B]
            if pa.std() < 4 or pb.std() < 4:
                continue
            (dx, dy), resp = cv2.phaseCorrelate(pa, pb, win)
            out.append((dx, dy, resp))
    return np.array(out) if out else np.zeros((0, 3))


def window_metrics(recon, base, ref):
    r = fit_affine_color(recon, ref); b = fit_affine_color(base, ref)
    gr, gb, gf = gray(r), gray(b), gray(ref)
    fr, cr = coherence_curve(gr, gf)
    _, cb = coherence_curve(gb, gf)
    sh = block_shifts(gf, gr)
    good = sh[sh[:, 2] > 0.15] if len(sh) else sh
    return {
        "psnr_recon": psnr(r, ref), "psnr_base": psnr(b, ref),
        "ssim_recon": float(structural_similarity(gr, gf, data_range=255)), "ssim_base": float(structural_similarity(gb, gf, data_range=255)),
        "hfncc_recon": hf_ncc(gr, gf), "hfncc_base": hf_ncc(gb, gf),
        "f50_recon": f50(fr, cr), "f50_base": f50(fr, cb),
        "shift_med_px": float(np.median(np.hypot(good[:, 0], good[:, 1]))) if len(good) else None,
        "shift_max_px": float(np.max(np.hypot(good[:, 0], good[:, 1]))) if len(good) else None,
        "coh_recon": [round(float(v), 3) for v in cr], "coh_base": [round(float(v), 3) for v in cb],
    }


def agg(rows, key):
    v = [r[key] for r in rows if r.get(key) is not None]
    return float(np.mean(v)) if v else None


# ------------------------------------------------------------------------------------------------ synthetic
def reference_window(src, gt, est, res, x, y, w, h):
    """Pristine source re-sampled onto an output-grid window through the ground-truth overview pose."""
    xs, ys = np.meshgrid(np.arange(x, x + w) + 0.5, np.arange(y, y + h) + 0.5)
    out_pts = np.c_[xs.ravel(), ys.ravel()]
    canvas = out_pts / np.array([res.m["scaleX"], res.m["scaleY"]])
    ovr = est.canvas_to_ovraster(canvas)
    sp = gt.img_to_src(gt.ovf, ovr)
    # anti-aliasing: source px per output px
    ratio = float(np.linalg.norm(sp[1] - sp[0]))
    x0, y0 = np.floor(sp.min(0)).astype(int) - 8
    x1, y1 = np.ceil(sp.max(0)).astype(int) + 8
    x0c, y0c, x1c, y1c = max(0, x0), max(0, y0), min(src.shape[1], x1), min(src.shape[0], y1)
    if x1c <= x0c or y1c <= y0c:
        return None, None
    patch = src[y0c:y1c, x0c:x1c]
    if ratio > 1.1:
        patch = cv2.GaussianBlur(patch, (0, 0), 0.42 * ratio)
    mx = (sp[:, 0] - 0.5 - x0c).reshape(h, w).astype(np.float32)
    my = (sp[:, 1] - 0.5 - y0c).reshape(h, w).astype(np.float32)
    ref = cv2.remap(patch, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    inside = (sp[:, 0] >= 2) & (sp[:, 1] >= 2) & (sp[:, 0] < src.shape[1] - 2) & (sp[:, 1] < src.shape[0] - 2)
    return ref, inside.reshape(h, w)


def src_to_output(gt, est, res, pts):
    ovr = gt.src_to_img(gt.ovf, pts)
    return est.ovraster_to_canvas(ovr) * np.array([res.m["scaleX"], res.m["scaleY"]])


def baseline_window(proj_dir, x, y, w, h, tmp):
    dcrun.call("debug.crops", {"dir": proj_dir, "x": int(x), "y": int(y), "w": int(w), "h": int(h), "prefix": tmp})
    return cv2.imread(tmp + "_overview.png")


def eval_synthetic(set_dir, proj_dir, out_dir, windows=12, win=768):
    os.makedirs(out_dir, exist_ok=True)
    gtj = json.load(open(os.path.join(set_dir, "gt.json")))
    gt = GT(gtj)
    project = dcrun.call("project.load", {"dir": proj_dir})
    est = Est(project)
    report = {"set": gtj["name"], "description": gtj.get("description", "")}
    names = {f["id"]: f.get("originalName", "") for f in project["frames"]}
    S = project["result"]["scale"] if project.get("result") else 1.0

    # ---- acceptance table ----------------------------------------------------------------------------
    table, n_expected_ok, n_ok, false_accepts = [], 0, 0, []
    for f in project["frames"]:
        if f["role"] != "closeup":
            continue
        g = gt.by_file.get(f["originalName"])
        st = f["reg"].get("status")
        expect = g["expect"] if g else "?"
        row = {"file": f["originalName"], "expect": expect, "status": st, "reasons": f["reg"].get("reasons", []), "scale": f["reg"].get("scale"),
               "inliers": f["reg"].get("nInliers"), "zncc": f["reg"].get("zncc"), "via": f["reg"].get("via")}
        table.append(row)
    report["frames"] = table

    # ---- registration error vs ground truth ----------------------------------------------------------
    k_ov = np.linalg.norm(apply_h(np.array(gt.ovf["H_src2img"]), [[4000, 3000], [4001, 3000]])[1] - apply_h(np.array(gt.ovf["H_src2img"]), [[4000, 3000], [4001, 3000]])[0])
    out_per_src = k_ov * S  # output px per source px (approx., overview is nearly fronto-parallel)
    reg_rows = []
    placed = {}
    for f in project["frames"]:
        g = gt.by_file.get(f.get("originalName", ""))
        if f["role"] != "closeup" or not g or "H" not in f["reg"]:
            continue
        w, h = f["meta"]["width"], f["meta"]["height"]
        gx, gy = np.meshgrid(np.linspace(0.05 * w, 0.95 * w, 9), np.linspace(0.05 * h, 0.95 * h, 7))
        pts = np.c_[gx.ravel(), gy.ravel()]
        src_est = gt.img_to_src(gt.ovf, est.canvas_to_ovraster(est.frame_to_canvas(f, pts)))
        src_gt = gt.img_to_src(g, pts)
        e = np.linalg.norm(src_est - src_gt, axis=1) * out_per_src
        row = next(r for r in table if r["file"] == f["originalName"])
        row["abs_err_out_px_mean"] = float(e.mean()); row["abs_err_out_px_max"] = float(e.max())
        row["abs_err_overview_px_mean"] = float(e.mean() / S)
        if f["reg"]["status"] == "accepted" and f["user"].get("included", True):
            reg_rows.append(row)
            placed[f["originalName"]] = (f, g)
            if g["expect"] != "accept" and g["expect"] != "nonplanar":
                false_accepts.append(f["originalName"])
    # a wrong placement that was accepted is the worst failure: count frames accepted with a large error
    wrong = [r["file"] for r in reg_rows if r["abs_err_overview_px_mean"] > 3.0]
    # relative error between overlapping accepted frames (seam misalignment)
    rel = []
    keys = list(placed)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            fi, gi = placed[keys[i]]; fj, gj = placed[keys[j]]
            # source points inside both ground-truth footprints
            ci = gt.img_to_src(gi, [[0, 0], [gt.cw, 0], [gt.cw, gt.ch], [0, gt.ch]]).astype(np.float32)
            cj = gt.img_to_src(gj, [[0, 0], [gt.cw, 0], [gt.cw, gt.ch], [0, gt.ch]]).astype(np.float32)
            area, inter = cv2.intersectConvexConvex(ci, cj)
            if area < 0.03 * cv2.contourArea(ci) or inter is None or len(inter) < 3:
                continue
            inter = inter.reshape(-1, 2)
            cen = inter.mean(0)
            sp = np.array([cen + 0.7 * (p - cen) for p in inter] + [cen])
            # orientation stored in EXIF does not matter here: GT poses are in oriented coordinates
            pi_, pj_ = gt.src_to_img(gi, sp), gt.src_to_img(gj, sp)
            d = (est.frame_to_canvas(fi, pi_) - est.frame_to_canvas(fj, pj_)) * np.array([project["result"]["width"] / est.ovw, project["result"]["height"] / est.ovh]) if project.get("result") else (est.frame_to_canvas(fi, pi_) - est.frame_to_canvas(fj, pj_)) * S
            rel.append(float(np.linalg.norm(d, axis=1).mean()))
    report["registration"] = {
        "accepted": len(reg_rows),
        "abs_err_out_px_mean": float(np.mean([r["abs_err_out_px_mean"] for r in reg_rows])) if reg_rows else None,
        "abs_err_out_px_max": float(np.max([r["abs_err_out_px_max"] for r in reg_rows])) if reg_rows else None,
        "abs_err_overview_px_mean": float(np.mean([r["abs_err_overview_px_mean"] for r in reg_rows])) if reg_rows else None,
        "pairwise_err_out_px_mean": float(np.mean(rel)) if rel else None, "pairwise_err_out_px_max": float(np.max(rel)) if rel else None, "pairs": len(rel),
        "accepted_but_wrong_gt3ovpx": wrong, "accepted_but_expected_invalid": false_accepts,
        "expected_accept": sum(1 for r in table if r["expect"] == "accept"), "expected_accept_accepted": sum(1 for r in table if r["expect"] == "accept" and r["status"] == "accepted"),
        "expected_reject": sum(1 for r in table if r["expect"].startswith("reject")), "expected_reject_not_accepted": sum(1 for r in table if r["expect"].startswith("reject") and r["status"] != "accepted"),
        "k1_true": gtj.get("k1", 0.0), "k1_estimated_overview": est.ovk1, "output_scale": S,
    }
    if not project.get("result"):
        json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
        return report

    # ---- reconstruction quality in matched windows ----------------------------------------------------
    res = Result(proj_dir, project)
    src = cv2.imread(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "datasets", "synthetic", "sources",
                                  {"wave": "great_wave.jpg", "wave_distorted": "great_wave.jpg", "document": "document.jpg", "repetitive": "repetitive.jpg", "relief": "great_wave.jpg"}[gtj["name"]]))
    rng = np.random.default_rng(5)
    rows = []
    cand = []
    nx = max(1, (res.w - win) // (win // 2)); ny = max(1, (res.h - win) // (win // 2))
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            cand.append((min(res.w - win, ix * (win // 2)), min(res.h - win, iy * (win // 2))))
    rng.shuffle(cand)
    sup, unsup = [], []
    for (x, y) in cand:
        lab = res.label_crop(x, y, win, win)
        frac = float((lab > 0).mean())
        if frac > 0.97 and len(sup) < windows:
            sup.append((x, y, frac))
        elif frac < 0.03 and len(unsup) < max(2, windows // 4):
            unsup.append((x, y, frac))
    tmp = os.path.join(out_dir, "tmp")
    saved = 0
    for kind, lst in (("supported", sup), ("overview_only", unsup)):
        for (x, y, frac) in lst:
            ref, inside = reference_window(src, gt, est, res, x, y, win, win)
            if ref is None or inside.mean() < 0.98:
                continue
            recon = res.crop(x, y, win, win)
            base = baseline_window(proj_dir, x, y, win, win, tmp)
            if gray(ref).std() < 6:  # featureless window: metrics meaningless
                continue
            m = window_metrics(recon, base, ref)
            m.update({"x": x, "y": y, "kind": kind, "closeup_frac": frac})
            rows.append(m)
            if kind == "supported" and saved < 4:
                c = 384
                trip = np.hstack([fit_affine_color(base, ref)[:c, :c], fit_affine_color(recon, ref)[:c, :c], ref[:c, :c].astype(np.float32)]).astype(np.uint8)
                cv2.imwrite(os.path.join(out_dir, f"crop_{saved}_overview_fused_reference.png"), trip)
                saved += 1
    for ext in ("_overview.png", "_result.png", "_source.png"):
        if os.path.exists(tmp + ext):
            os.remove(tmp + ext)
    s_rows = [r for r in rows if r["kind"] == "supported"]
    u_rows = [r for r in rows if r["kind"] == "overview_only"]
    report["windows"] = rows
    report["quality_supported"] = {k: agg(s_rows, k) for k in ("psnr_recon", "psnr_base", "ssim_recon", "ssim_base", "hfncc_recon", "hfncc_base", "f50_recon", "f50_base", "shift_med_px", "shift_max_px")}
    report["quality_supported"]["windows"] = len(s_rows)
    if s_rows and report["quality_supported"]["f50_base"]:
        report["quality_supported"]["resolution_gain_f50"] = report["quality_supported"]["f50_recon"] / report["quality_supported"]["f50_base"]
    report["quality_overview_only"] = {k: agg(u_rows, k) for k in ("psnr_recon", "psnr_base", "ssim_recon", "ssim_base", "f50_recon", "f50_base")}
    report["quality_overview_only"]["windows"] = len(u_rows)
    report["result"] = {"width": res.w, "height": res.h, "scale": res.m["scale"], "stats": res.m["stats"]}
    report["overview_consistency"] = overview_consistency(proj_dir, project)

    # ---- document: glyph readability and line-pair contrast -------------------------------------------
    meta_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "datasets", "synthetic", "sources", "document_meta.json")
    if gtj["name"] == "document" and os.path.exists(meta_path):
        meta = json.load(open(meta_path))
        report["glyphs"] = eval_glyphs(meta, src, gt, est, res, proj_dir, tmp)
        report["bars"] = eval_bars(meta, src, gt, est, res, proj_dir, tmp)
    json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
    return report


def patch_at(res_or_img, box_out, size):
    x0, y0, x1, y1 = box_out
    if isinstance(res_or_img, Result):
        c = res_or_img.crop(int(x0), int(y0), max(2, int(x1 - x0)), max(2, int(y1 - y0)))
    else:
        c = res_or_img[int(y0):int(y1), int(x0):int(x1)]
    if c.size == 0:
        return None
    g = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return cv2.resize(g, size, interpolation=cv2.INTER_AREA)


def ncc(a, b):
    a = a - a.mean(); b = b - b.mean()
    d = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 0 else -1.0


def eval_glyphs(meta, src, gt, est, res, proj_dir, tmp):
    """Template-matching readability: can each known glyph be identified from the image?
    Templates are the mean appearance of each character taken from the pristine source at the same size."""
    out = {}
    by_cap = {}
    for g in meta["glyphs"]:
        by_cap.setdefault(g["cap"], []).append(g)
    for cap, glyphs in sorted(by_cap.items(), reverse=True):
        size = (24, 32)
        # templates from the source
        tmpl = {}
        for g in glyphs:
            x, y, w, h = g["box"]
            p = cv2.resize(cv2.cvtColor(src[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY).astype(np.float32), size, interpolation=cv2.INTER_AREA)
            tmpl.setdefault(g["c"], []).append(p)
        tmpl = {c: np.mean(v, 0) for c, v in tmpl.items()}
        # region of the whole row on the output grid -> one baseline crop
        xs = [g["box"][0] for g in glyphs]; ys = [g["box"][1] for g in glyphs]
        row_src = np.array([[min(xs) - 40, min(ys) - 20], [max(xs) + glyphs[0]["box"][2] + 40, max(ys) + glyphs[0]["box"][3] + 20]], np.float64)
        ro = src_to_output(gt, est, res, [row_src[0], [row_src[1][0], row_src[0][1]], row_src[1], [row_src[0][0], row_src[1][1]]])
        rx0, ry0 = np.floor(ro.min(0)).astype(int) - 4
        rx1, ry1 = np.ceil(ro.max(0)).astype(int) + 4
        rx0, ry0 = max(0, rx0), max(0, ry0); rx1, ry1 = min(res.w, rx1), min(res.h, ry1)
        base = baseline_window(proj_dir, rx0, ry0, rx1 - rx0, ry1 - ry0, tmp)
        recon = res.crop(rx0, ry0, rx1 - rx0, ry1 - ry0)
        lab = res.label_crop(rx0, ry0, rx1 - rx0, ry1 - ry0)
        ok_r = ok_b = n = n_sup = 0
        for g in glyphs:
            x, y, w, h = g["box"]
            co = src_to_output(gt, est, res, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
            bx0, by0 = co.min(0) - [rx0, ry0]; bx1, by1 = co.max(0) - [rx0, ry0]
            if bx0 < 0 or by0 < 0 or bx1 > recon.shape[1] or by1 > recon.shape[0]:
                continue
            pr = patch_at(recon, (bx0, by0, bx1, by1), size); pb = patch_at(base, (bx0, by0, bx1, by1), size)
            if pr is None or pb is None:
                continue
            n += 1
            if lab[int((by0 + by1) / 2), int((bx0 + bx1) / 2)] > 0:
                n_sup += 1
            ok_r += max(tmpl, key=lambda c: ncc(pr, tmpl[c])) == g["c"]
            ok_b += max(tmpl, key=lambda c: ncc(pb, tmpl[c])) == g["c"]
        out[str(cap)] = {"cap_height_source_px": cap, "cap_height_overview_px": round(cap * 1600 / (1.07 * 8400), 2), "glyphs": n, "from_closeups": n_sup,
                         "accuracy_fused": round(ok_r / max(1, n), 3), "accuracy_overview_enlarged": round(ok_b / max(1, n), 3), "chance": round(1 / len(tmpl), 3)}
    return out


def eval_bars(meta, src, gt, est, res, proj_dir, tmp):
    """Modulation of vertical line-pair groups relative to the pristine source (1.0 = fully resolved)."""
    out = []
    for b in meta["bars"]:
        x, y, w, h = b["box"]
        co = src_to_output(gt, est, res, [[x, y + h * 0.25], [x + w, y + h * 0.25], [x + w, y + h * 0.75], [x, y + h * 0.75]])
        x0, y0 = np.floor(co.min(0)).astype(int); x1, y1 = np.ceil(co.max(0)).astype(int)
        if x0 < 0 or y0 < 0 or x1 > res.w or y1 > res.h or x1 - x0 < 8:
            continue
        recon = cv2.cvtColor(res.crop(x0, y0, x1 - x0, y1 - y0), cv2.COLOR_BGR2GRAY).astype(np.float32)
        base = cv2.cvtColor(baseline_window(proj_dir, x0, y0, x1 - x0, y1 - y0, tmp), cv2.COLOR_BGR2GRAY).astype(np.float32)
        ref, _ = reference_window(src, gt, est, res, x0, y0, x1 - x0, y1 - y0)
        ref = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY).astype(np.float32)
        period_out = b["period"] * (x1 - x0) / w

        def modulation(img):
            prof = img.mean(0)
            n = len(prof)
            k = np.arange(n)
            f = 1.0 / period_out
            amp = abs(np.sum((prof - prof.mean()) * np.exp(-2j * np.pi * f * k))) * 2 / n
            return amp / max(1.0, prof.mean())
        mr, mb, mf = modulation(recon), modulation(base), modulation(ref)
        lab = res.label_crop(x0, y0, x1 - x0, y1 - y0)
        out.append({"period_source_px": b["period"], "period_overview_px": round(b["period"] * 1600 / (1.07 * 8400), 2), "period_output_px": round(period_out, 2),
                    "from_closeups": bool((lab > 0).mean() > 0.9), "contrast_fused_rel": round(mr / mf, 3) if mf > 0 else None, "contrast_overview_rel": round(mb / mf, 3) if mf > 0 else None})
    return out


# ------------------------------------------------------------------------------------------------ consistency
def overview_consistency(proj_dir, project, thr=20.0):
    """Structural agreement of the fused result with the overview at OVERVIEW resolution.
    The overview is the anchor: reduced to its resolution, a correct result must show the same content at the same
    place everywhere. Misplaced content (false alignment, parallax leaking through) shows up as large differences.
    Returns the fraction of pixels whose low-pass difference exceeds `thr` grey levels (after a global per-channel
    tone fit), overall and inside the area taken from close-ups."""
    if not project.get("result"):
        return None
    est = Est(project)
    res = Result(proj_dir, project)
    if est.ov["meta"].get("orientation", 1) != 1 and not est.ov.get("working"):
        return None
    ov = cv2.imread(os.path.join(proj_dir, est.ov.get("working") or est.ov["file"]))
    W = min(est.ovw, 1600); sc = W / est.ovw; H = int(round(est.ovh * sc))
    xs, ys = np.meshgrid((np.arange(W) + 0.5) / sc, (np.arange(H) + 0.5) / sc)
    pts = est.canvas_to_ovraster(np.c_[xs.ravel(), ys.ravel()])
    src = cv2.GaussianBlur(ov, (0, 0), 0.45 / sc) if sc < 0.8 else ov
    ov_s = cv2.remap(src, (pts[:, 0] - 0.5).reshape(H, W).astype(np.float32), (pts[:, 1] - 0.5).reshape(H, W).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    lvl, _ = res.level_image(max_dim=2 * max(W, H))
    fused = cv2.resize(lvl, (W, H), interpolation=cv2.INTER_AREA)
    lab = cv2.resize(res.labels, (W, H), interpolation=cv2.INTER_NEAREST)
    fused = fit_affine_color(fused, ov_s)
    a = cv2.GaussianBlur(gray(fused), (0, 0), 2.0); b = cv2.GaussianBlur(gray(ov_s), (0, 0), 2.0)
    d = np.abs(a - b)
    close = lab > 0
    out = {"threshold_grey": thr, "frac_all": float((d > thr).mean()), "mean_abs_diff": float(d.mean()),
           "frac_in_closeup_area": float((d[close] > thr).mean()) if close.any() else 0.0, "closeup_area": float(close.mean())}
    return out


# ------------------------------------------------------------------------------------------------ hold-out
def eval_holdout(set_dir, work_dir, out_dir, holdouts, threads=4):
    """Leave-one-out on a real set: the held-out close-up is never shown to the pipeline and serves as an
    independent high-resolution reference for the area it covers."""
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(set_dir, "closeup_*")))
    files = [f for f in files if os.path.splitext(f)[1].lower() in (".jpg", ".jpeg", ".png")]
    report = {"set": os.path.basename(set_dir.rstrip("/")), "holdouts": []}
    for hold in holdouts:
        proj = os.path.join(work_dir, "holdout_" + os.path.splitext(hold)[0])
        only = [os.path.basename(f) for f in files if os.path.basename(f) != hold]
        out = dcrun.run_set(set_dir, proj, threads=threads, only=only)
        project = out["project"]
        entry = {"holdout": hold, "frames_used": sum(1 for f in project["frames"] if f["role"] == "closeup" and f["reg"].get("status") == "accepted"), "summary": dcrun.summarize(out)}
        if not project.get("result"):
            entry["error"] = "no result"; report["holdouts"].append(entry); continue
        res = Result(proj, project)
        ho = cv2.imread(os.path.join(set_dir, hold))
        # register the held-out photo to the fused result with an independent implementation (OpenCV-Python SIFT)
        small, scale_small = res.level_image(2400)
        hs = min(1.0, 1600.0 / max(ho.shape[:2]))
        ho_s = cv2.resize(ho, None, fx=hs, fy=hs, interpolation=cv2.INTER_AREA)
        sift = cv2.SIFT_create(8000)
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(ho_s, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), None)
        m = cv2.BFMatcher().knnMatch(d1, d2, k=2)
        good = [a for a, b in m if a.distance < 0.75 * b.distance]
        if len(good) < 20:
            entry["error"] = f"held-out frame could not be located independently ({len(good)} matches)"; report["holdouts"].append(entry); continue
        p1 = np.float32([k1[g.queryIdx].pt for g in good]) / hs
        p2 = np.float32([k2[g.trainIdx].pt for g in good]) / scale_small
        Hh, mask = cv2.findHomography(p1, p2, cv2.USAC_MAGSAC, 4.0 / scale_small)
        entry["independent_inliers"] = int(mask.sum())
        if Hh is None or mask.sum() < 15:
            entry["error"] = "independent registration failed"; report["holdouts"].append(entry); continue
        # refine at full resolution inside the footprint, then compare in the held-out frame's pixel grid
        hh, hw = ho.shape[:2]
        corners = cv2.perspectiveTransform(np.float32([[[0, 0], [hw, 0], [hw, hh], [0, hh]]]), Hh)[0]
        x0, y0 = np.floor(corners.min(0)).astype(int); x1, y1 = np.ceil(corners.max(0)).astype(int)
        x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(res.w, x1), min(res.h, y1)
        dcrun.call("debug.crops", {"dir": proj, "x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0), "prefix": os.path.join(out_dir, "tmp")})
        base_full = cv2.imread(os.path.join(out_dir, "tmp_overview.png"))
        if (x1 - x0) * (y1 - y0) > 60e6:  # bound memory: evaluate the central part of very large footprints
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
            x0, x1, y0, y1 = max(x0, cx - 3500), min(x1, cx + 3500), max(y0, cy - 3500), min(y1, cy + 3500)
            dcrun.call("debug.crops", {"dir": proj, "x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0), "prefix": os.path.join(out_dir, "tmp")})
            base_full = cv2.imread(os.path.join(out_dir, "tmp_overview.png"))
        recon_full = res.crop(int(x0), int(y0), int(x1 - x0), int(y1 - y0))
        lab = res.label_crop(x0, y0, x1 - x0, y1 - y0)
        # scale of the held-out photo relative to the output grid decides the comparison grid: compare on the OUTPUT grid
        T = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1.0]]) @ Hh
        ho_scale = math.sqrt(abs(np.linalg.det(Hh[:2, :2])))  # output px per held-out px
        src_blur = cv2.GaussianBlur(ho, (0, 0), 0.42 / ho_scale) if ho_scale < 0.9 else ho
        ref_full = cv2.warpPerspective(src_blur, T, (x1 - x0, y1 - y0), flags=cv2.INTER_CUBIC)
        valid = cv2.warpPerspective(np.full((hh, hw), 255, np.uint8), T, (x1 - x0, y1 - y0), flags=cv2.INTER_NEAREST) > 0
        # ECC-free local refinement: one global sub-pixel shift per window is estimated inside window_metrics' shift stats
        win = 512
        rows = []
        saved = 0
        for yy in range(0, recon_full.shape[0] - win + 1, win):
            for xx in range(0, recon_full.shape[1] - win + 1, win):
                if valid[yy:yy + win, xx:xx + win].mean() < 0.999:
                    continue
                frac = float((lab[yy:yy + win, xx:xx + win] > 0).mean())
                r_ = recon_full[yy:yy + win, xx:xx + win]; b_ = base_full[yy:yy + win, xx:xx + win]; f_ = ref_full[yy:yy + win, xx:xx + win]
                if gray(f_).std() < 6:
                    continue
                # remove the residual sub-pixel shift between the independent reference and the result grid
                (dx, dy), _ = cv2.phaseCorrelate(gray(r_), gray(f_), cv2.createHanningWindow((win, win), cv2.CV_32F))
                M = np.float32([[1, 0, -dx], [0, 1, -dy]])
                f_al = cv2.warpAffine(f_, M, (win, win), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
                mtr = window_metrics(r_[16:-16, 16:-16], b_[16:-16, 16:-16], f_al[16:-16, 16:-16])
                mtr.update({"x": int(x0 + xx), "y": int(y0 + yy), "closeup_frac": frac, "kind": "supported" if frac > 0.97 else ("overview_only" if frac < 0.03 else "mixed"), "ref_shift_px": float(math.hypot(dx, dy))})
                rows.append(mtr)
                if frac > 0.97 and saved < 3:
                    c = 384
                    cv2.imwrite(os.path.join(out_dir, f"{os.path.splitext(hold)[0]}_crop{saved}_overview_fused_heldout.png"),
                                np.hstack([fit_affine_color(b_, f_al)[:c, :c], fit_affine_color(r_, f_al)[:c, :c], f_al[:c, :c].astype(np.float32)]).astype(np.uint8))
                    saved += 1
        s_rows = [r for r in rows if r["kind"] == "supported"]
        entry["heldout_scale_vs_output"] = 1.0 / ho_scale
        entry["output_scale"] = project["result"]["scale"]
        entry["windows_supported"] = len(s_rows)
        entry["quality_supported"] = {k: agg(s_rows, k) for k in ("psnr_recon", "psnr_base", "ssim_recon", "ssim_base", "hfncc_recon", "hfncc_base", "f50_recon", "f50_base", "shift_med_px", "shift_max_px")}
        entry["windows"] = [{k: v for k, v in r.items() if not k.startswith("coh_")} for r in rows]
        report["holdouts"].append(entry)
        for ext in ("_overview.png", "_result.png", "_source.png"):
            pth = os.path.join(out_dir, "tmp" + ext)
            if os.path.exists(pth):
                os.remove(pth)
    json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["synthetic", "holdout"])
    ap.add_argument("set_dir")
    ap.add_argument("project")
    ap.add_argument("out")
    ap.add_argument("--holdout", nargs="*", default=[])
    a = ap.parse_args()
    if a.mode == "synthetic":
        r = eval_synthetic(a.set_dir, a.project, a.out)
        print(json.dumps({k: r[k] for k in r if k not in ("windows", "frames")}, indent=1))
        for row in r["frames"]:
            print(row)
    else:
        r = eval_holdout(a.set_dir, a.project, a.out, a.holdout)
        for h in r["holdouts"]:
            print(json.dumps({k: v for k, v in h.items() if k not in ("windows", "summary")}, indent=1))
