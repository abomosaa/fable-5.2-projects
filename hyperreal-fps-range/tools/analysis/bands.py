#!/usr/bin/env python3
"""Octave-band energy (dB re total) of the first N ms of audio files: bands.py <ms> files..."""
import sys, numpy as np, soundfile as sf
ms = float(sys.argv[1])
cent = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
print('%-52s' % 'file' + ''.join('%7d' % c for c in cent) + '   peak  crest')
for f in sys.argv[2:]:
    x, sr = sf.read(f, always_2d=True); m = x.mean(axis=1)[:int(sr * ms / 1000)]
    sp = np.abs(np.fft.rfft(m * np.hanning(len(m)))) ** 2; fq = np.fft.rfftfreq(len(m), 1 / sr)
    tot = sp.sum() + 1e-20
    row = [10 * np.log10(sp[(fq >= c / 2 ** .5) & (fq < c * 2 ** .5)].sum() / tot + 1e-12) for c in cent]
    pk = np.abs(m).max(); rms = np.sqrt((m ** 2).mean())
    print('%-52s' % f.split('/')[-1][:52] + ''.join('%7.1f' % r for r in row) + '  %5.1f  %5.1f' % (20 * np.log10(pk + 1e-12), 20 * np.log10(pk / (rms + 1e-12))))
