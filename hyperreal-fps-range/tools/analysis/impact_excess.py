#!/usr/bin/env python3
"""For each shot that struck a ringing target: level of the recording in 50 ms steps after the shot, next to the
median level of plain shots (same acoustic context) at the same offsets.  impact_excess.py <capture_dir>"""
import json, sys, subprocess, numpy as np, soundfile as sf
d0 = sys.argv[1]
d = json.load(open(d0 + '/analysis.json'))
x, sr = sf.read(d0 + '/capture_audio.wav'); m = x.mean(axis=1)
ast = float(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', d0 + '/capture.mkv'], capture_output=True).stdout.decode().strip() or 0)
steps = np.arange(0, 1.0, 0.05)
def prof(s):
    i0 = int((s['audio_onset_s'] - ast) * sr)
    return np.array([10 * np.log10((m[i0 + int(t * sr): i0 + int((t + 0.05) * sr)] ** 2).mean() + 1e-12) for t in steps])
shots = [s for s in d['shots'] if s.get('matched')]
imp_idx = {}
for i in d.get('impacts', []): imp_idx.setdefault(i['shot'], i)
# shots are listed in log order; a restart re-uses indices, so match impacts by order of appearance
plain = {True: [], False: []}; ring = []
seen = set()
for s in shots:
    key = (s['index'], round(s['audio_onset_s'], 2))
    if s['index'] in imp_idx and abs(prof(s)[0]) < 200:
        ring.append(s)
    else:
        plain[(s['enclosure'] or 0) > 0.5].append(prof(s))
tm = {k: np.median(np.stack(v), axis=0) for k, v in plain.items() if v}
print('offset ms      ' + ''.join('%6d' % (t * 1000) for t in steps))
for k, v in tm.items(): print('plain %-8s ' % ('bay' if k else 'open') + ''.join('%6.1f' % a for a in v))
for s in ring:
    i = imp_idx[s['index']]; ctx = (s['enclosure'] or 0) > 0.5
    if ctx not in tm: continue
    p = prof(s)
    print('shot %2d %-7s%5.1fm' % (s['index'], i['surface'], i['distance_m']) + ''.join('%6.1f' % a for a in (p - tm[ctx])) + '   (excess dB; arrival %.0f ms)' % i['expected_delay_after_shot_ms'])
