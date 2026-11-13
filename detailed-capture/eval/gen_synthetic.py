#!/usr/bin/env python3
"""Synthetic ground-truth capture simulator for Detailed Capture.

Independent of the app's C++ core: this script renders what a hand-held camera would record of a known
high-resolution planar (or relief) subject from different 3-D viewpoints and distances. It models

  * a pinhole camera at an arbitrary pose (position, pan/tilt/roll) -> true perspective homography,
  * optional radial lens distortion,
  * optical blur (Gaussian PSF) + pixel-aperture integration (super-sampled rendering, box down-sampling),
  * exposure / white-balance differences, vignetting, sensor noise, JPEG compression (4:2:0),
  * EXIF orientation variants (pixels stored rotated + orientation tag).

The frames are NOT tiles of the source and the evaluated pipeline never sees the poses; the poses are stored
in gt.json only for scoring.

Usage: gen_synthetic.py <out_dir> [--sets wave,document,repetitive,relief,wave_distorted] [--seed 7]
"""
import argparse
import json
import math
import os
import sys

import cv2
import numpy as np
import piexif
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, "..", "datasets", "synthetic", "sources")
CAM_W, CAM_H = 1600, 1200
SS = 3  # super-sampling factor

FONT_SERIF = "/usr/share/fonts/liberation/LiberationSerif-Regular.ttf"
FONT_SANS = "/usr/share/fonts/liberation/LiberationSans-Bold.ttf"
FONT_MONO = "/usr/share/fonts/liberation/LiberationMono-Bold.ttf"

WORDS = ("survey detail overlap capture mosaic plane register texture margin quarter pigment varnish canvas "
         "thread engraving ledger harbour copper meridian latitude compass anchor granite parchment "
         "column figure eleven thirty amber cobalt umber sienna vermilion indigo ochre charcoal gesso "
         "lattice mortar plinth cornice frieze rosette quatrefoil trefoil arcade cloister transept "
         "seventeen ninety hundred thousand measure record witness archive folio verso recto binding").split()


# ------------------------------------------------------------------------------------------------ sources
def srgb_to_lin(x):
    x = x.astype(np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055).astype(np.float32)


def paper(w, h, rng, base=(236, 231, 220)):
    """Slightly textured paper so that even blank regions are not perfectly flat."""
    img = np.empty((h, w, 3), np.float32)
    img[:] = np.array(base, np.float32)
    lo = rng.normal(0, 1, (h // 64 + 2, w // 64 + 2)).astype(np.float32)
    lo = cv2.resize(lo, (w, h), interpolation=cv2.INTER_CUBIC) * 3.0
    fine = rng.normal(0, 2.2, (h, w)).astype(np.float32)
    fine = cv2.GaussianBlur(fine, (0, 0), 1.2) * 2.0
    img += (lo + fine)[..., None]
    return np.clip(img, 0, 255).astype(np.uint8)


def make_document(path, meta_path, rng):
    W, H = 8400, 6000
    img = Image.fromarray(paper(W, H, rng))
    d = ImageDraw.Draw(img)
    ink = (28, 26, 30)
    meta = {"glyphs": [], "bars": [], "size": [W, H]}
    d.text((300, 180), "REGISTER OF THE HARBOUR SURVEY", font=ImageFont.truetype(FONT_SANS, 190), fill=ink)
    d.line((300, 440, W - 300, 440), fill=ink, width=10)
    # body text columns, decreasing font size
    col_w, y0 = 1820, 520
    sizes = [72, 56, 44, 34]
    for ci, fs in enumerate(sizes):
        f = ImageFont.truetype(FONT_SERIF, fs)
        x = 300 + ci * (col_w + 180)
        y = y0
        while y < 3300:
            line = ""
            while True:
                w = WORDS[rng.integers(len(WORDS))]
                if rng.random() < 0.12:
                    w = str(rng.integers(10, 99999))
                t = (line + " " + w).strip()
                if d.textlength(t, font=f) > col_w:
                    break
                line = t
            d.text((x, y), line, font=f, fill=ink)
            y += int(fs * 1.28)
    # readability strip: random glyph rows at known positions (ground truth for the glyph classifier)
    alphabet = "ABCDEFGHKLMNPRSTUVXYZ23456789"
    y = 3480
    d.text((300, y - 110), "READABILITY ROWS", font=ImageFont.truetype(FONT_SANS, 80), fill=ink)
    for cap in [64, 44, 32, 24, 18, 14]:
        f = ImageFont.truetype(FONT_MONO, int(cap / 0.66))
        adv = d.textlength("M", font=f)
        x = 300
        row = []
        while x + adv < W - 300:
            ch = alphabet[rng.integers(len(alphabet))]
            bb = d.textbbox((x, y), ch, font=f)
            d.text((x, y), ch, font=f, fill=ink)
            row.append({"c": ch, "box": [int(x), int(y), int(math.ceil(adv)), int(cap / 0.66 * 1.2)], "cap": cap, "ink": [bb[0], bb[1], bb[2], bb[3]]})
            x += adv * 1.25
        meta["glyphs"].extend(row)
        y += int(cap / 0.66 * 1.5) + 20
    # resolution targets: line-pair groups with known period (source px), both orientations
    y = max(y + 60, 4380)
    x = 300
    for period in [64, 48, 32, 24, 16, 12, 8, 6]:
        n = 6
        gw = period * n
        for orient in (0, 1):
            ox = x + orient * (gw + 80)
            for k in range(n):
                if orient == 0:
                    d.rectangle((ox + k * period, y, ox + k * period + period // 2 - 1, y + 380), fill=ink)
                else:
                    d.rectangle((ox, y + k * period * 380 // gw, ox + gw - 1, y + k * period * 380 // gw + max(1, period * 380 // gw // 2) - 1), fill=ink)
            if orient == 0:
                meta["bars"].append({"period": period, "box": [ox, y, gw, 380], "orient": "v"})
        d.text((x, y + 400), f"{period}", font=ImageFont.truetype(FONT_SANS, 60), fill=ink)
        x += 2 * gw + 240
        if x > W - 1400:
            x = 300
            y += 560
    # siemens star + fine concentric rings
    cx, cy, r = W - 900, 5150, 520
    for k in range(72):
        if k % 2 == 0:
            a0, a1 = 2 * math.pi * k / 72, 2 * math.pi * (k + 1) / 72
            d.polygon([(cx, cy), (cx + r * math.cos(a0), cy + r * math.sin(a0)), (cx + r * math.cos(a1), cy + r * math.sin(a1))], fill=ink)
    # small-print footer paragraphs (dense unique text for matching at fine scale)
    f = ImageFont.truetype(FONT_SERIF, 26)
    yy = 5560
    while yy < H - 120:
        line = " ".join(WORDS[rng.integers(len(WORDS))] for _ in range(60))
        d.text((300, yy), line[: int((W - 2100) / 12)], font=f, fill=ink)
        yy += 36
    img.save(path, quality=97, subsampling=0)
    json.dump(meta, open(meta_path, "w"))


def make_repetitive(path, rng):
    """Strictly periodic wallpaper with two unique landmarks."""
    W, H, P = 8000, 6000, 500
    tile = np.zeros((P, P, 3), np.uint8)
    tile[:] = (205, 214, 196)
    c = (P // 2, P // 2)
    for k in range(8):
        a = 2 * math.pi * k / 8
        cv2.ellipse(tile, (int(c[0] + 110 * math.cos(a)), int(c[1] + 110 * math.sin(a))), (70, 28), math.degrees(a), 0, 360, (96, 120, 60), -1, cv2.LINE_AA)
    cv2.circle(tile, c, 46, (40, 60, 150), -1, cv2.LINE_AA)
    cv2.circle(tile, c, 18, (220, 220, 240), -1, cv2.LINE_AA)
    for (x, y) in [(0, 0), (P, 0), (0, P), (P, P)]:
        cv2.circle(tile, (x, y), 60, (60, 70, 90), 6, cv2.LINE_AA)
        cv2.circle(tile, (x, y), 24, (150, 90, 60), -1, cv2.LINE_AA)
    cv2.line(tile, (0, P // 2), (P // 2 - 190, P // 2), (120, 130, 110), 5, cv2.LINE_AA)
    cv2.line(tile, (P // 2 + 190, P // 2), (P, P // 2), (120, 130, 110), 5, cv2.LINE_AA)
    cv2.line(tile, (P // 2, 0), (P // 2, P // 2 - 190), (120, 130, 110), 5, cv2.LINE_AA)
    cv2.line(tile, (P // 2, P // 2 + 190), (P // 2, P), (120, 130, 110), 5, cv2.LINE_AA)
    # identical print grain in every repeat (a printed pattern repeats its grain too)
    grain = cv2.GaussianBlur(rng.normal(0, 9, (P, P)).astype(np.float32), (0, 0), 1.0)
    tile = np.clip(tile.astype(np.float32) + grain[..., None], 0, 255).astype(np.uint8)
    img = np.tile(tile, (H // P, W // P, 1))
    # two unique landmarks (a stain and a label)
    cv2.ellipse(img, (5650, 1480), (330, 210), 20, 0, 360, (70, 90, 120), -1, cv2.LINE_AA)
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    d = ImageDraw.Draw(pil)
    d.rectangle((1700, 4100, 2700, 4420), fill=(245, 240, 225), outline=(30, 30, 30), width=8)
    d.text((1740, 4160), "LOT 4471-B", font=ImageFont.truetype(FONT_SANS, 150), fill=(30, 30, 30))
    pil.save(path, quality=97, subsampling=0)


# ------------------------------------------------------------------------------------------------ camera
def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Rz @ Rx @ Ry


def plane_H(K, R, C, height=0.0):
    """Homography from plane coords (x, y) at z = -height (towards the camera) to image coords."""
    t = -R @ C + R[:, 2] * (-height)
    return K @ np.column_stack([R[:, 0], R[:, 1], t])


def make_pose(rng, src_w, src_h, centre, cover_w, jitter=True, max_tilt=5.0, max_roll=4.0):
    f = 0.82 * CAM_W
    d = cover_w * src_w * f / CAM_W
    K = np.array([[f, 0, CAM_W / 2], [0, f, CAM_H / 2], [0, 0, 1.0]])
    if jitter:
        yaw, pitch = np.radians(rng.uniform(-max_tilt, max_tilt, 2))
        roll = np.radians(rng.uniform(-max_roll, max_roll))
        d *= rng.uniform(0.95, 1.05)
    else:
        yaw = pitch = roll = 0.0
    R = rot(yaw, pitch, roll)
    # place the camera so that the optical axis hits `centre` on the plane
    axis = R.T @ np.array([0, 0, 1.0])  # viewing direction in world coords
    C = np.array([centre[0], centre[1], 0.0]) - axis * (d / axis[2])
    return K, R, C


def undistort_pts(x, y, k1):
    cx, cy = CAM_W / 2, CAM_H / 2
    Rn = 0.5 * math.hypot(CAM_W, CAM_H)
    dx, dy = (x - cx) / Rn, (y - cy) / Rn
    fct = 1 + k1 * (dx * dx + dy * dy)
    return cx + (x - cx) * fct, cy + (y - cy) * fct


class Source:
    def __init__(self, bgr):
        self.levels = [bgr]
        while min(self.levels[-1].shape[:2]) > 256:
            self.levels.append(cv2.resize(self.levels[-1], None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA))
        self.h, self.w = bgr.shape[:2]

    def sample(self, sx, sy, minif):
        """Sample at continuous source coords with a mip level matched to the minification (anti-aliasing)."""
        lvl = int(np.clip(math.floor(math.log2(max(minif, 1.0)) + 0.35), 0, len(self.levels) - 1))
        s = 0.5 ** lvl
        img = self.levels[lvl]
        mx = (sx * s - 0.5).astype(np.float32)
        my = (sy * s - 0.5).astype(np.float32)
        return cv2.remap(img, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(92, 96, 100))


def render_planes(planes, k1, rng, exposure=1.0, wb=(1, 1, 1), vignette=0.0, psf=0.7, noise=1.6, extra_blur=0.0, walls=None):
    """planes: list of (Source, H_src2img (3x3), mask_rect_or_None) drawn back to front."""
    Wss, Hss = CAM_W * SS, CAM_H * SS
    xs = (np.arange(Wss, dtype=np.float64) + 0.5) / SS
    ys = (np.arange(Hss, dtype=np.float64) + 0.5) / SS
    X, Y = np.meshgrid(xs, ys)
    Xu, Yu = undistort_pts(X, Y, k1)
    out = np.full((Hss, Wss, 3), (92, 96, 100), np.uint8)
    for idx, (src, H, rect) in enumerate(planes):
        Hi = np.linalg.inv(H)
        den = Hi[2, 0] * Xu + Hi[2, 1] * Yu + Hi[2, 2]
        sx = (Hi[0, 0] * Xu + Hi[0, 1] * Yu + Hi[0, 2]) / den
        sy = (Hi[1, 0] * Xu + Hi[1, 1] * Yu + Hi[1, 2]) / den
        c = (Hss // 2, Wss // 2)
        minif = math.hypot(sx[c[0], c[1] + 1] - sx[c], sy[c[0], c[1] + 1] - sy[c])
        img = src.sample(sx, sy, minif)
        if rect is None:
            m = (sx >= 0) & (sy >= 0) & (sx < src.w) & (sy < src.h)
        else:
            m = (sx >= rect[0]) & (sy >= rect[1]) & (sx < rect[2]) & (sy < rect[3])
        if walls and idx in walls:
            for poly, col in walls[idx]:
                cv2.fillConvexPoly(out, np.round(poly * SS).astype(np.int32), col, cv2.LINE_AA)
        out[m] = img[m]
    lin = srgb_to_lin(out)
    sig = math.hypot(psf, extra_blur) * SS
    lin = cv2.GaussianBlur(lin, (0, 0), sig)
    lin = cv2.resize(lin, (CAM_W, CAM_H), interpolation=cv2.INTER_AREA)  # pixel aperture integration
    yy, xx = np.mgrid[0:CAM_H, 0:CAM_W].astype(np.float32)
    r2 = ((xx + 0.5 - CAM_W / 2) ** 2 + (yy + 0.5 - CAM_H / 2) ** 2) / (0.25 * (CAM_W ** 2 + CAM_H ** 2))
    lin *= (1 - vignette * r2)[..., None] * exposure
    lin *= np.array([wb[2], wb[1], wb[0]], np.float32)  # BGR
    enc = lin_to_srgb(lin) * 255.0
    enc += rng.normal(0, noise, enc.shape).astype(np.float32) * (0.6 + 0.8 * np.sqrt(np.clip(enc / 255.0, 0, 1)))
    return np.clip(np.round(enc), 0, 255).astype(np.uint8)


def save_jpeg(bgr, path, orientation=1, quality=93, focal=5.6):
    """Stores the displayed image `bgr` with the given EXIF orientation (pixels are stored rotated)."""
    img = bgr
    if orientation == 6:
        img = cv2.rotate(bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    elif orientation == 8:
        img = cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    elif orientation == 3:
        img = cv2.rotate(bgr, cv2.ROTATE_180)
    exif = {"0th": {piexif.ImageIFD.Make: b"SynthCam", piexif.ImageIFD.Model: b"DC-Sim 1", piexif.ImageIFD.Orientation: orientation},
            "Exif": {piexif.ExifIFD.FocalLength: (int(focal * 100), 100), piexif.ExifIFD.FNumber: (18, 10), piexif.ExifIFD.ISOSpeedRatings: 100,
                     piexif.ExifIFD.ExposureTime: (1, 120), piexif.ExifIFD.ColorSpace: 1}}
    Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(path, quality=quality, exif=piexif.dump(exif))


# ------------------------------------------------------------------------------------------------ sets
def grid_centres(src_w, src_h, cover_w, nx, ny, region=None):
    fw = cover_w * src_w
    fh = fw * CAM_H / CAM_W
    x0, y0, x1, y1 = region if region else (0, 0, src_w, src_h)
    xs = np.linspace(x0 + fw * 0.46, x1 - fw * 0.46, nx) if nx > 1 else [(x0 + x1) / 2]
    ys = np.linspace(y0 + fh * 0.46, y1 - fh * 0.46, ny) if ny > 1 else [(y0 + y1) / 2]
    return [(float(x), float(y)) for y in ys for x in xs]


def gen_planar_set(out_dir, name, src_bgr, rng, tiers, k1=0.0, extras=True, foreign=None, description=""):
    os.makedirs(out_dir, exist_ok=True)
    src = Source(src_bgr)
    frames = []
    orient_cycle = [1, 1, 6, 1, 8, 1, 3, 1]

    def shoot(fname, role, centre, cover, jitter=True, expect="accept", extra_blur=0.0, source=None, tier=""):
        s = source or src
        K, R, C = make_pose(rng, s.w, s.h, centre, cover, jitter=jitter, max_tilt=5.0 if role != "overview" else 2.0, max_roll=4.0 if role != "overview" else 1.0)
        H = plane_H(K, R, C)
        exp = 1.0 if role == "overview" else float(rng.uniform(0.88, 1.13))
        wb = (1, 1, 1) if role == "overview" else tuple(float(v) for v in rng.uniform(0.96, 1.04, 3))
        img = render_planes([(s, H, None)], k1, rng, exposure=exp, wb=wb, vignette=0.12, extra_blur=extra_blur)
        o = 1 if role == "overview" else orient_cycle[len(frames) % len(orient_cycle)]
        save_jpeg(img, os.path.join(out_dir, fname), orientation=o)
        frames.append({"file": fname, "role": role, "H_src2img": H.tolist(), "k1": k1, "orientation": o, "cover": cover, "expect": expect,
                       "exposure": exp, "wb": wb, "tier": tier, "centre": list(centre)})
        print(f"  {name}/{fname} ({role}, cover {cover:.2f}, expect {expect})", flush=True)

    shoot("overview.jpg", "overview", (src.w / 2, src.h / 2), 1.07, jitter=True)
    n = 0
    for tier in tiers:
        for c in grid_centres(src.w, src.h, tier["cover"], tier["nx"], tier["ny"], tier.get("region")):
            jit = tier["cover"] * src.w * 0.03
            cc = (c[0] + rng.uniform(-jit, jit), c[1] + rng.uniform(-jit, jit))
            n += 1
            shoot(f"closeup_{n:02d}.jpg", "closeup", cc, tier["cover"], tier=tier.get("name", ""))
    if extras:
        t0 = tiers[0]
        shoot("x_blurred.jpg", "closeup", (src.w * 0.5, src.h * 0.5), t0["cover"], expect="reject_blur", extra_blur=7.0)
        shoot("x_same_scale.jpg", "closeup", (src.w * 0.5, src.h * 0.5), 1.02, expect="reject_no_gain")
        if foreign is not None:
            fs = Source(foreign)
            shoot("x_foreign.jpg", "closeup", (fs.w * 0.4, fs.h * 0.45), 0.3, expect="reject_foreign", source=fs)
    json.dump({"name": name, "description": description, "source_size": [src.w, src.h], "camera": [CAM_W, CAM_H], "frames": frames, "k1": k1,
               "tiers": tiers}, open(os.path.join(out_dir, "gt.json"), "w"), indent=1)


def gen_relief_set(out_dir, src_bgr, rng):
    """Non-planar scene: raised boxes on the plane. Close-ups are taken from laterally shifted, tilted viewpoints,
    so the box tops show true parallax and occlusion relative to the base plane."""
    os.makedirs(out_dir, exist_ok=True)
    src = Source(src_bgr)
    boxes = [(1500, 1200, 3300, 2700, 520.0), (4700, 2500, 6500, 4300, 700.0), (2600, 3600, 3900, 4800, 380.0)]
    frames = []

    def shoot(fname, role, centre, cover, tilt, expect):
        K, R, C = make_pose(rng, src.w, src.h, centre, cover, jitter=False)
        yaw, pitch = math.radians(tilt[0]), math.radians(tilt[1])
        R = rot(yaw, pitch, math.radians(rng.uniform(-2, 2)))
        f = K[0, 0]
        d = cover * src.w * f / CAM_W
        axis = R.T @ np.array([0, 0, 1.0])
        C = np.array([centre[0], centre[1], 0.0]) - axis * (d / axis[2])
        H0 = plane_H(K, R, C)
        planes = [(src, H0, None)]
        walls = {}
        for (x0, y0, x1, y1, h) in boxes:
            Hh = plane_H(K, R, C, h)
            polys = []
            corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            for i in range(4):
                a, b = corners[i], corners[(i + 1) % 4]
                quad = []
                for (p, HH) in [(a, H0), (b, H0), (b, Hh), (a, Hh)]:
                    v = HH @ np.array([p[0], p[1], 1.0])
                    quad.append(v[:2] / v[2])
                polys.append((np.array(quad), (58 + 12 * i, 60 + 10 * i, 66 + 8 * i)))
            walls[len(planes)] = polys
            planes.append((src, Hh, (x0, y0, x1, y1)))
        img = render_planes(planes, 0.0, rng, exposure=float(rng.uniform(0.94, 1.06)), vignette=0.1, walls=walls)
        save_jpeg(img, os.path.join(out_dir, fname))
        frames.append({"file": fname, "role": role, "H_src2img": H0.tolist(), "k1": 0.0, "orientation": 1, "cover": cover, "expect": expect, "tilt": tilt})
        print(f"  relief/{fname} ({role})", flush=True)

    shoot("overview.jpg", "overview", (src.w / 2, src.h / 2), 1.07, (0, 0), "accept")
    n = 0
    tilts = [(-14, -9), (12, -10), (-13, 10), (14, 9), (0, -14), (15, 0), (-15, 2), (2, 14), (-10, -12)]
    for i, c in enumerate(grid_centres(src.w, src.h, 0.40, 3, 3)):
        n += 1
        shoot(f"closeup_{n:02d}.jpg", "closeup", c, 0.40, tilts[i % len(tilts)], "nonplanar")
    json.dump({"name": "relief", "description": "Raised boxes (heights 380-700 source px) on a plane; oblique close-ups show parallax and occlusion.",
               "source_size": [src.w, src.h], "camera": [CAM_W, CAM_H], "frames": frames, "boxes": boxes, "k1": 0.0}, open(os.path.join(out_dir, "gt.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--sets", default="wave,document,repetitive,relief,wave_distorted")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    sets = a.sets.split(",")
    os.makedirs(SRC_DIR, exist_ok=True)
    doc_path, doc_meta = os.path.join(SRC_DIR, "document.jpg"), os.path.join(SRC_DIR, "document_meta.json")
    rep_path = os.path.join(SRC_DIR, "repetitive.jpg")
    if not os.path.exists(doc_path):
        print("generating document source"); make_document(doc_path, doc_meta, np.random.default_rng(101))
    if not os.path.exists(rep_path):
        print("generating repetitive source"); make_repetitive(rep_path, np.random.default_rng(102))
    wave = cv2.imread(os.path.join(SRC_DIR, "great_wave.jpg"))
    doc = cv2.imread(doc_path)
    three = [{"name": "3x", "cover": 0.36, "nx": 4, "ny": 3}]
    if "wave" in sets:
        gen_planar_set(os.path.join(a.out, "wave"), "wave", wave, np.random.default_rng(a.seed), three, foreign=doc,
                       description="Woodblock print (public domain scan), 12 hand-held style close-ups at ~3x, plus invalid frames.")
    if "wave_distorted" in sets:
        gen_planar_set(os.path.join(a.out, "wave_distorted"), "wave_distorted", wave, np.random.default_rng(a.seed + 1), three, k1=-0.035, extras=False,
                       description="Same subject with radial lens distortion (k1 = -0.035) on every frame including the overview.")
    if "document" in sets:
        tiers = [{"name": "3x", "cover": 0.36, "nx": 4, "ny": 3},
                 {"name": "6.5x", "cover": 0.165, "nx": 4, "ny": 2, "region": (200, 3300, 8200, 5300)}]
        gen_planar_set(os.path.join(a.out, "document"), "document", doc, np.random.default_rng(a.seed + 2), tiers, foreign=wave,
                       description="Printed text page with readability rows and line-pair targets; 3x layer plus a 6.5x layer over the fine-print rows.")
    if "repetitive" in sets:
        rep = cv2.imread(rep_path)
        gen_planar_set(os.path.join(a.out, "repetitive"), "repetitive", rep, np.random.default_rng(a.seed + 3), [{"name": "3x", "cover": 0.34, "nx": 3, "ny": 3}], extras=False,
                       description="Strictly periodic wallpaper (period 500 px) with two unique landmarks. Most close-ups have several equally good placements.")
    if "relief" in sets:
        gen_relief_set(os.path.join(a.out, "relief"), wave, np.random.default_rng(a.seed + 4))


if __name__ == "__main__":
    main()
