#!/usr/bin/env python3
"""List sound events in a recording: bursts.py file.wav [threshold_db]"""
import sys, numpy as np, soundfile as sf
x, sr = sf.read(sys.argv[1], always_2d=True); th = 10 ** (float(sys.argv[2]) / 20) if len(sys.argv) > 2 else 10 ** (-70 / 20)
win = int(0.02 * sr); env = np.array([np.abs(x[i:i + win]).max(axis=0) for i in range(0, len(x) - win, win)])
m = env.max(axis=1); on = False
for i, v in enumerate(m):
    if v > th and not on: on = True; st = i
    if on and v <= th and all(m[i:i + 15] <= th):
        on = False; seg = env[st:i]
        print('t=%6.2fs dur %.2fs peak L %6.1f R %6.1f dBFS' % (st * 0.02, (i - st) * 0.02, 20 * np.log10(seg[:, 0].max() + 1e-9), 20 * np.log10(seg[:, 1].max() + 1e-9)))
