#!/usr/bin/env python3
"""Measure a gameplay capture (video + loopback audio) against the game's own event log.

  analyze_capture.py <capture_dir> [--plots]

Reads <dir>/capture.mkv (wf-recorder: virtual output + null-sink monitor) and <dir>/events.jsonl.
Writes <dir>/analysis.json and, with --plots, <dir>/audio_overview.png and per-shot PNGs.

Reported (all measured from the recording, nothing inferred from source code):
  * audio: sample peak, count of full-scale samples, clipped runs, integrated level, noise floor
  * per shot: audio onset time, peak, decay (time to -20 / -40 dB), early/late energy, L/R balance,
    spectral centroid; grouped by the enclosure value the game logged (covered bay vs open pad)
  * A/V sync: for each shot, the first video frame whose weapon region changes vs the audio onset
  * inter-shot regularity vs the event log (drift between logged shot times and audio onsets)
"""
import json, os, subprocess, sys
import numpy as np
import soundfile as sf

def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True)

def load_events(d):
    ev = []
    p = os.path.join(d, 'events.jsonl')
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line:
                ev.append(json.loads(line))
    return ev

def envelope(x, sr, win_ms=1.0):
    n = max(1, int(sr * win_ms / 1000))
    a = np.abs(x)
    k = np.ones(n) / n
    return np.convolve(a, k, mode='same')

def find_onsets(mono, sr, min_gap=0.09, thresh_db=-24.0):
    """transients: envelope rises above thresh (relative to file peak) after being 12 dB lower"""
    env = envelope(mono, sr, 0.5)
    peak = env.max() + 1e-12
    th = peak * 10 ** (thresh_db / 20)
    above = env > th
    idx = np.flatnonzero(above[1:] & ~above[:-1]) + 1
    out = []
    last = -1e9
    for i in idx:
        t = i / sr
        if t - last < min_gap:
            continue
        pre = env[max(0, i - int(0.03 * sr)):max(1, i - int(0.004 * sr))]
        if pre.size and pre.max() > th * 0.7:
            continue
        # refine to the steepest rise within 3 ms
        j0 = max(0, i - int(0.003 * sr)); j1 = min(len(env) - 1, i + int(0.003 * sr))
        seg = np.diff(env[j0:j1])
        if seg.size:
            i = j0 + int(np.argmax(seg))
        out.append(i)
        last = t
    return out

def decay_time(env, i0, sr, db, max_s=3.0):
    seg = env[i0:i0 + int(max_s * sr)]
    if seg.size == 0:
        return None
    pk_i = int(np.argmax(seg[:int(0.02 * sr)])) if seg.size > 10 else 0
    pk = seg[pk_i] + 1e-12
    th = pk * 10 ** (db / 20)
    # smooth for the decay search
    n = int(0.01 * sr)
    sm = np.convolve(seg, np.ones(n) / n, mode='same')
    below = np.flatnonzero(sm[pk_i:] < th)
    if below.size == 0:
        return None
    # require it to stay below for 30 ms
    for b in below:
        e = sm[pk_i + b: pk_i + b + int(0.03 * sr)]
        if e.size and e.max() < th * 1.05:
            return float(b / sr)
    return None

def main():
    d = sys.argv[1]
    plots = '--plots' in sys.argv
    mkv = os.path.join(d, 'capture.mkv')
    wav = os.path.join(d, 'capture_audio.wav')
    res = {'dir': d}
    ev = load_events(d)
    run(['ffmpeg', '-y', '-v', 'error', '-i', mkv, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le', wav])
    x, sr = sf.read(wav, always_2d=True)
    mono = x.mean(axis=1)
    dur = len(x) / sr
    peak = float(np.abs(x).max())
    full = int((np.abs(x) >= 0.999).sum())
    # runs of >= 3 consecutive full-scale samples = clipping
    runs = 0
    for ch in range(x.shape[1]):
        m = (np.abs(x[:, ch]) >= 0.999).astype(np.int8)
        dd = np.diff(np.concatenate([[0], m, [0]]))
        starts = np.flatnonzero(dd == 1); ends = np.flatnonzero(dd == -1)
        runs += int(((ends - starts) >= 3).sum())
    env = envelope(mono, sr, 1.0)
    floor = float(np.percentile(env, 10))
    res['audio'] = {'duration_s': dur, 'peak_dbfs': 20 * np.log10(peak + 1e-12), 'full_scale_samples': full, 'clipped_runs': runs,
                    'rms_dbfs': 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12), 'noise_floor_dbfs': 20 * np.log10(floor + 1e-12),
                    'dc_offset': [float(v) for v in x.mean(axis=0)]}
    # ---- video frame times + weapon-region change signal
    probe = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', mkv]).stdout.decode().split()
    vt = np.array([float(t.strip(',')) for t in probe if t.strip(',')])
    astart = float(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', mkv]).stdout.decode().strip() or 0)
    W, H = 96, 54
    raw = run(['ffmpeg', '-v', 'error', '-i', mkv, '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-']).stdout
    fr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H, W).astype(np.float32)
    n = min(len(fr), len(vt)); fr = fr[:n]; vt = vt[:n]
    roi = fr[:, H // 3:, W // 4: 3 * W // 4]             # lower-centre: where the pistol and hands are
    diff = np.concatenate([[0], np.abs(np.diff(roi, axis=0)).mean(axis=(1, 2))])
    res['video'] = {'frames': int(n), 'duration_s': float(vt[-1] - vt[0]) if n > 1 else 0.0,
                    'fps_mean': float((n - 1) / (vt[-1] - vt[0])) if n > 1 else 0.0,
                    'frame_interval_ms_p50': float(np.median(np.diff(vt)) * 1000) if n > 2 else 0.0,
                    'frame_interval_ms_p99': float(np.percentile(np.diff(vt), 99) * 1000) if n > 2 else 0.0,
                    'frame_interval_ms_max': float(np.diff(vt).max() * 1000) if n > 2 else 0.0}
    # ---- shots
    shots_ev = [e for e in ev if e.get('ev') == 'shot']
    onsets = find_onsets(mono, sr)
    # keep onsets that look like gunshots: loud (within 14 dB of the loudest onset)
    pk = [np.abs(mono[i:i + int(0.02 * sr)]).max() for i in onsets]
    if pk:
        mx = max(pk)
        shot_on = [i for i, p in zip(onsets, pk) if p > mx * 10 ** (-14 / 20)]
    else:
        shot_on = []
    res['shots_logged'] = len(shots_ev)
    res['shot_onsets_detected'] = len(shot_on)
    shots = []
    # map logged shots to audio onsets by fitting a single clock offset (game usec -> audio time)
    if shots_ev and shot_on:
        t_log = np.array([e['usec'] / 1e6 for e in shots_ev])
        t_aud = np.array([i / sr for i in shot_on]) + astart
        best = None
        for a in t_aud[:6]:
            for b in t_log[:6]:
                off = a - b
                m = [np.abs(t_aud - (t + off)).min() for t in t_log]
                score = sum(1 for v in m if v < 0.06)
                if best is None or score > best[0]:
                    best = (score, off)
        off = best[1]
        res['clock_offset_s'] = float(off)
        for e in shots_ev:
            tl = e['usec'] / 1e6 + off
            j = int(np.argmin(np.abs(t_aud - tl)))
            if abs(t_aud[j] - tl) > 0.08:
                shots.append({'index': e['index'], 'matched': False})
                continue
            i0 = shot_on[j]
            seg = x[i0:i0 + int(2.0 * sr)]
            sm = mono[i0:i0 + int(2.0 * sr)]
            e_env = envelope(sm, sr, 1.0)
            early = float((sm[:int(0.05 * sr)] ** 2).sum()); mid = float((sm[int(0.05 * sr):int(0.3 * sr)] ** 2).sum()); late = float((sm[int(0.3 * sr):int(1.5 * sr)] ** 2).sum())
            spec = np.abs(np.fft.rfft(sm[:int(0.25 * sr)] * np.hanning(int(0.25 * sr)))) if len(sm) >= int(0.25 * sr) else np.zeros(2)
            fq = np.fft.rfftfreq(int(0.25 * sr), 1 / sr) if len(sm) >= int(0.25 * sr) else np.zeros(2)
            cent = float((spec * fq).sum() / (spec.sum() + 1e-12))
            # video: first frame after (onset - 80 ms) where the weapon ROI changes sharply
            ta = t_aud[j]
            k0 = int(np.searchsorted(vt, ta - 0.10)); k1 = int(np.searchsorted(vt, ta + 0.15))
            base = np.median(diff[max(0, k0 - 30):k0]) if k0 > 5 else 0.0
            vf = None
            for k in range(k0, min(k1, n)):
                if diff[k] > max(base * 3.0, base + 0.6):
                    vf = k; break
            shots.append({'index': e['index'], 'matched': True, 'audio_onset_s': float(ta), 'da': e.get('da'), 'enclosure': e.get('enclosure'),
                          'refl_taps': e.get('refl_taps'), 'layers': e.get('layers'),
                          'peak_dbfs': float(20 * np.log10(np.abs(seg).max() + 1e-12)),
                          'rms_50ms_dbfs': float(10 * np.log10(early / (0.05 * sr) + 1e-12)),
                          't_minus20_s': decay_time(envelope(mono, sr, 1.0), i0, sr, -20), 't_minus40_s': decay_time(envelope(mono, sr, 1.0), i0, sr, -40),
                          'energy_50_300ms_rel_db': float(10 * np.log10((mid + 1e-12) / (early + 1e-12))),
                          'energy_300_1500ms_rel_db': float(10 * np.log10((late + 1e-12) / (early + 1e-12))),
                          'lr_balance_db': float(10 * np.log10(((seg[:, 0] ** 2).sum() + 1e-12) / ((seg[:, 1] ** 2).sum() + 1e-12))),
                          'lr_corr_50ms': float(np.corrcoef(seg[:int(0.05 * sr), 0], seg[:int(0.05 * sr), 1])[0, 1]) if len(seg) > int(0.05 * sr) else None,
                          'centroid_hz': cent,
                          'video_change_s': float(vt[vf]) if vf is not None else None,
                          'av_offset_ms': float((vt[vf] - ta) * 1000) if vf is not None else None,
                          'log_vs_audio_ms': float((ta - tl) * 1000)})
    res['shots'] = shots
    m = [s for s in shots if s.get('matched')]
    if m:
        av = [s['av_offset_ms'] for s in m if s['av_offset_ms'] is not None]
        res['summary'] = {'matched': len(m),
                          'av_offset_ms_median': float(np.median(av)) if av else None, 'av_offset_ms_min': float(min(av)) if av else None, 'av_offset_ms_max': float(max(av)) if av else None,
                          'log_vs_audio_jitter_ms_sd': float(np.std([s['log_vs_audio_ms'] for s in m])),
                          'peak_dbfs_max': float(max(s['peak_dbfs'] for s in m)), 'peak_dbfs_sd': float(np.std([s['peak_dbfs'] for s in m]))}
        def grp(sel):
            g = [s for s in m if sel(s)]
            if not g: return None
            def med(k):
                v = [s[k] for s in g if s.get(k) is not None]
                return float(np.median(v)) if v else None
            return {'n': len(g), 'peak_dbfs': med('peak_dbfs'), 'rms_50ms_dbfs': med('rms_50ms_dbfs'), 't_minus20_s': med('t_minus20_s'), 't_minus40_s': med('t_minus40_s'),
                    'energy_50_300ms_rel_db': med('energy_50_300ms_rel_db'), 'energy_300_1500ms_rel_db': med('energy_300_1500ms_rel_db'), 'centroid_hz': med('centroid_hz'),
                    'lr_corr_50ms': med('lr_corr_50ms'), 'refl_taps': med('refl_taps')}
        # context comparison uses only shots whose bullet did not strike a ringing target (their ring would be
        # counted as "tail"); `plain` is filled in from the bullet log below
        ringing = set()
        last = None
        for e in ev:
            if e.get('ev') == 'shot': last = e
            if e.get('ev') == 'bullet' and any(h['surface'] in ('steel', 'glass', 'ceramic', 'can') for h in e['hits']):
                for e2 in shots_ev:
                    if e2['index'] == e['index'] and e2['usec'] <= e['usec']: last = e2
                ringing.add(last['usec'])
        ring_idx = set(i for i, e2 in enumerate(shots_ev) if e2['usec'] in ringing)
        plain = [s2 for i, s2 in enumerate(shots) if s2.get('matched') and i not in ring_idx]
        mm = m; m = plain
        res['context_covered_bay'] = grp(lambda s: (s.get('enclosure') or 0) > 0.8)
        res['context_open_pad'] = grp(lambda s: (s.get('enclosure') or 0) < 0.25)
        m = mm
    # ---- impact sounds: does the steel ring arrive when physics says it should? (bullet flight + sound return)
    if shots and 'clock_offset_s' in res:
        from scipy.signal import butter, sosfilt
        sos = butter(4, [1500, 9000], btype='bandpass', fs=sr, output='sos')
        _b = np.abs(sosfilt(sos, mono)); _n = int(0.002 * sr)
        hp = np.max(np.stack([np.roll(_b, k) for k in range(0, _n, 8)]), axis=0)      # 2 ms peak-hold envelope
        # hits per logged shot (a session restart re-uses shot indices: pair each bullet with the latest earlier shot)
        hits_of = {}
        for e in ev:
            if e.get('ev') == 'bullet':
                sh = None
                for e2 in shots_ev:
                    if e2['index'] == e['index'] and e2['usec'] <= e['usec']:
                        sh = e2
                if sh is not None:
                    hits_of[sh['usec']] = e['hits']
        L = int(0.6 * sr)
        def shot_env(e2):
            i0 = int((e2['usec'] / 1e6 + res['clock_offset_s'] - astart) * sr)
            return hp[i0:i0 + L] if i0 >= 0 and i0 + L < len(hp) else None
        ring = ('steel', 'glass', 'ceramic', 'can')
        # template: what a shot without a ringing impact looks like in this band, per acoustic context
        tmpl = {}
        for ctx in (0, 1):
            envs = [shot_env(e2) for e2 in shots_ev if (e2.get('enclosure', 0) > 0.5) == bool(ctx)
                    and not any(h['surface'] in ring for h in hits_of.get(e2['usec'], []))]
            envs = [x for x in envs if x is not None]
            if envs: tmpl[ctx] = np.median(np.stack(envs), axis=0)
        impacts = []
        for e2 in shots_ev:
            for h in hits_of.get(e2['usec'], []):
                if h['surface'] not in ring: continue
                dist = float(np.linalg.norm(np.array(h['pos']) - np.array(e2['muzzle'])))
                delay = h['tof_ms'] / 1000.0 + dist / 343.0
                env = shot_env(e2); ctx = int(e2.get('enclosure', 0) > 0.5)
                rec = {'shot': e2['index'], 'surface': h['surface'], 'collider': h['collider'], 'distance_m': dist, 'tof_ms': h['tof_ms'],
                       'expected_delay_after_shot_ms': delay * 1000, 'measured_minus_expected_ms': None, 'rise_db_at_arrival': None}
                if env is not None:
                    # local-rise detector: band envelope against its own median over the preceding 20..5 ms
                    lo = int(max(delay - 0.04, 0.02) * sr); hi = int(min(delay + 0.10, 0.58) * sr)
                    pre0, pre1 = int(0.020 * sr), int(0.005 * sr)
                    best = 0.0; first = None
                    for k2 in range(lo, hi, 24):
                        base = np.median(env[k2 - pre0:k2 - pre1]) + 1e-7
                        r = env[k2] / base
                        best = max(best, r)
                        if first is None and r > 2.5:
                            first = k2
                    rec['rise_db_at_arrival'] = float(20 * np.log10(best + 1e-9))
                    if first is not None:
                        rec['measured_minus_expected_ms'] = float(first / sr * 1000 - delay * 1000)
                    k = int(delay * sr)
                    rec['level_at_arrival_dbfs_1k5_9k'] = float(20 * np.log10(env[k:k + int(0.05 * sr)].max() + 1e-12)) if k + 10 < len(env) else None
                impacts.append(rec)
        res['impacts'] = impacts
        v = [i['measured_minus_expected_ms'] for i in impacts if i['measured_minus_expected_ms'] is not None]
        if v: res['impact_timing_error_ms'] = {'n': len(v), 'median': float(np.median(v)), 'min': float(min(v)), 'max': float(max(v))}
        # ---- quiet events: level of mechanism sounds relative to the shots
        ml = {}
        for e in ev:
            if e.get('ev') == 'sim' and e.get('name') in ('mag_in', 'mag_out', 'mag_release', 'slide_release', 'dry_fire', 'safety_on', 'safety_off', 'decock', 'hammer_cocked'):
                t = e['usec'] / 1e6 + res['clock_offset_s'] - astart
                i0 = int(t * sr); seg = mono[max(0, i0 - int(0.01 * sr)): i0 + int(0.2 * sr)]
                if seg.size: ml.setdefault(e['name'], []).append(float(20 * np.log10(np.abs(seg).max() + 1e-12)))
        res['mechanism_peak_dbfs'] = {k: {'n': len(v2), 'median': float(np.median(v2))} for k, v2 in ml.items()}
    json.dump(res, open(os.path.join(d, 'analysis.json'), 'w'), indent=1)
    print(json.dumps({k: res[k] for k in res if k not in ('shots', 'impacts')}, indent=1))
    if plots:
        import matplotlib; matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(3, 1, figsize=(16, 9), sharex=True)
        t = np.arange(len(mono)) / sr + astart
        step = max(1, len(mono) // 200000)
        ax[0].plot(t[::step], x[::step, 0], lw=0.4); ax[0].plot(t[::step], x[::step, 1], lw=0.4, alpha=0.6); ax[0].set_ylabel('L / R'); ax[0].set_ylim(-1, 1)
        ax[1].specgram(mono, NFFT=2048, Fs=sr, noverlap=1536, cmap='magma', vmin=-140, vmax=-30, xextent=(astart, astart + dur)); ax[1].set_yscale('symlog', linthresh=200); ax[1].set_ylim(40, 20000); ax[1].set_ylabel('Hz')
        ax[2].plot(vt, diff, lw=0.6); ax[2].set_ylabel('video ROI change'); ax[2].set_xlabel('s')
        for s in m:
            ax[0].axvline(s['audio_onset_s'], color='r', lw=0.4, alpha=0.6)
            if s['video_change_s'] is not None: ax[2].axvline(s['video_change_s'], color='g', lw=0.4, alpha=0.6)
        fig.tight_layout(); fig.savefig(os.path.join(d, 'audio_overview.png'), dpi=110); plt.close(fig)
        for s in m[:40:max(1, len(m) // 8)]:
            i0 = int((s['audio_onset_s'] - astart) * sr)
            seg = x[max(0, i0 - int(0.02 * sr)): i0 + int(1.2 * sr)]
            fig, ax = plt.subplots(2, 1, figsize=(12, 6))
            tt = (np.arange(len(seg)) / sr - 0.02) * 1000
            ax[0].plot(tt, seg[:, 0], lw=0.5); ax[0].plot(tt, seg[:, 1], lw=0.5, alpha=0.6); ax[0].set_xlim(-20, 300); ax[0].set_title(f"shot {s['index']} enclosure={s['enclosure']} peak={s['peak_dbfs']:.1f} dBFS")
            e = 20 * np.log10(envelope(seg.mean(axis=1), sr, 2.0) + 1e-9); ax[1].plot(tt, e, lw=0.6); ax[1].set_ylim(-90, 0); ax[1].set_xlim(-20, 1200); ax[1].set_ylabel('dBFS'); ax[1].set_xlabel('ms')
            fig.tight_layout(); fig.savefig(os.path.join(d, f"shot_{s['index']:03d}.png"), dpi=100); plt.close(fig)

if __name__ == '__main__':
    main()
