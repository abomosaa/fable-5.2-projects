#!/usr/bin/env python3
"""Track the pistol's rear sight on screen after each shot in a capture (aimed shots).
usage: sight_track.py capture.mkv t_shot_video [t_shot_video ...]
Prints the offset (px) of the sight block from its pre-shot position, per frame, by template matching."""
import sys, subprocess, numpy as np
def frames(path, t0, dur, crop):
    w, h, x, y = crop
    cmd = ['ffmpeg', '-v', 'error', '-ss', f'{t0:.3f}', '-i', path, '-t', f'{dur:.3f}', '-vf', f'crop={w}:{h}:{x}:{y},format=gray',
           '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
def match(img, tpl, cx, cy, r):
    th, tw = tpl.shape; best = (1e18, 0, 0); t0 = tpl - tpl.mean()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            p = img[cy + dy:cy + dy + th, cx + dx:cx + dx + tw]
            d = float(((p - p.mean() - t0) ** 2).sum())
            if d < best[0]: best = (d, dx, dy)
    return best[1], best[2]
path = sys.argv[1]
W, H, X, Y = 400, 400, 760, 340          # search area around the screen centre
for ts in map(float, sys.argv[2:]):
    f = frames(path, ts - 0.15, 1.45, (W, H, X, Y))
    ref = f[2]
    tw, th = 90, 70; cx, cy = (W - tw) // 2, (H - th) // 2 + 10
    tpl = ref[cy:cy + th, cx:cx + tw]
    out = []
    for i in range(len(f)):
        dx, dy = match(f[i], tpl, cx, cy, 60)
        out.append((i - 9, dx, dy))
    print(f'shot at {ts:.3f}s  (frame, dx, dy) px; frame 0 = shot')
    print('  ' + ' '.join(f'{i}:{dx:+d},{dy:+d}' for i, dx, dy in out if i >= -2 and (i <= 30 or i % 4 == 0)))
