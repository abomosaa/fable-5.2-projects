#!/usr/bin/env python3
"""Line up the game's long frames (> 34 ms "hitch" events) with tools/capture/procwatch.py samples.
usage: hitch_procs.py <events.jsonl> <procwatch.csv>
Answers: in the intervals that contain long frames, was the game's main thread kept waiting for a CPU, and who was
using the CPU - the game itself, this session's other processes, or outside processes?"""
import sys, json, csv, bisect, statistics as S
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows = list(csv.DictReader(open(sys.argv[2])))
T = [float(r['unix']) for r in rows]
hit = [e for e in ev if e.get('ev') == 'hitch']
play = [e['unix'] for e in hit]
u0 = min(e['usec'] for e in ev); un = max(e['usec'] for e in ev)
bench = [e for e in ev if e.get('ev') == 'bench']
# rows that belong to the game's running time: game_cpu_ms > 0
live = [i for i, r in enumerate(rows) if float(r['game_cpu_ms']) > 0]
dt = (T[-1] - T[0]) / max(len(T) - 1, 1)
cnt = [0] * len(rows); worst = [0.0] * len(rows)
for h in hit:
    i = min(len(T) - 1, bisect.bisect_left(T, h['unix']))
    cnt[i] += 1; worst[i] = max(worst[i], h['ms'])
F = lambda r, k: float(r[k] or 0)
cols = [c for c in ('game_cpu_ms', 'game_main_wait_ms', 'game_all_wait_ms', 'session_cpu_ms', 'outside_cpu_ms', 'sys_cpu_stall_ms',
        'game_majflt', 'comp_majflt', 'sys_majflt', 'sys_swapin_pages', 'sys_swapout_pages', 'sys_mem_stall_ms', 'kswapd_cpu_ms') if rows and c in rows[0]]
A = [i for i in live if cnt[i] > 0]; B = [i for i in live if cnt[i] == 0]
print(f'samples every {dt:.2f} s; {len(live)} intervals with the game running, {len(A)} of them contain a long frame ({len(hit)} long frames)')
if bench:
    b = bench[-1]; print('run: ' + ', '.join(f'{k} {b[k]:.1f}' for k in ('avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms') if k in b) + f', frames {b.get("frames")}')
print(f'memory soft-limit events during the log: {sum(int(r["mem_high_events"] or 0) for r in rows)}')
print(f'{"per interval (ms)":22s} {"with long frame":>28s} {"without":>28s}')
for k in cols:
    a = [F(rows[i], k) for i in A] or [0.0]; b = [F(rows[i], k) for i in B] or [0.0]
    q = lambda v, p: sorted(v)[min(len(v) - 1, int(len(v) * p))]
    print(f'{k:22s} median {S.median(a):7.1f}  p90 {q(a, .9):7.1f}     median {S.median(b):7.1f}  p90 {q(b, .9):7.1f}')
thr_w = 5.0
aw = sum(1 for i in A if F(rows[i], 'game_main_wait_ms') >= thr_w); bw = sum(1 for i in B if F(rows[i], 'game_main_wait_ms') >= thr_w)
print(f'intervals where the game main thread waited >= {thr_w:.0f} ms for a CPU: {aw} of {len(A)} with a long frame, {bw} of {len(B)} without')
ob = sorted(F(rows[i], 'outside_cpu_ms') for i in live); med_o = S.median(ob) if ob else 0
ao = sum(1 for i in A if F(rows[i], 'outside_cpu_ms') > 2 * max(med_o, 50)); bo = sum(1 for i in B if F(rows[i], 'outside_cpu_ms') > 2 * max(med_o, 50))
print(f'intervals with outside CPU use above {2 * max(med_o, 50):.0f} ms (run median {med_o:.0f}): {ao} of {len(A)} with a long frame, {bo} of {len(B)} without')
if rows and 'kswapd_cpu_ms' in rows[0]:
    def near(i, k, w=1):   # the quantity summed over the interval and its neighbours (events are not sample-aligned)
        return sum(F(rows[j], k) for j in range(max(0, i - w), min(len(rows), i + w + 1)))
    for k, thr, label in (('kswapd_cpu_ms', 20.0, 'page reclaim (kswapd) active'), ('game_majflt', 1.0, 'the game took major page faults'),
                          ('comp_majflt', 1.0, 'the compositor took major page faults'), ('sys_swapin_pages', 50.0, 'the machine was reading from swap'),
                          ('sys_mem_stall_ms', 5.0, 'memory-pressure stall on the machine')):
        a = sum(1 for i in A if near(i, k) >= thr); b = sum(1 for i in B if near(i, k) >= thr)
        print(f'{label} within +-1 interval: {a} of {len(A)} intervals with a long frame, {b} of {len(B)} without')
print('timeline, 10 s bins: game time, long frames, outside CPU (cores), session CPU (cores), game CPU (cores), game main-thread wait (ms)')
t0 = T[live[0]] if live else T[0]
for b0 in range(0, int(T[live[-1]] - t0) + 1 if live else 0, 10):
    idx = [i for i in live if t0 + b0 <= T[i] < t0 + b0 + 10]
    if not idx: continue
    sec = len(idx) * dt * 1000.0
    n = sum(cnt[i] for i in idx)
    print(f'  {b0:4d}s  {n:3d}  outside {sum(F(rows[i], "outside_cpu_ms") for i in idx) / sec:5.2f}  session {sum(F(rows[i], "session_cpu_ms") for i in idx) / sec:5.2f}  game {sum(F(rows[i], "game_cpu_ms") for i in idx) / sec:5.2f}  main wait {sum(F(rows[i], "game_main_wait_ms") for i in idx):7.1f}  ' + '#' * n)
print('long frames:')
for i in A:
    r = rows[i]
    print(f'  t={T[i] - t0:6.1f}s  n={cnt[i]} worst {worst[i]:5.1f} ms  main wait {F(r, "game_main_wait_ms"):6.1f}  all-thread wait {F(r, "game_all_wait_ms"):7.1f}  game cpu {F(r, "game_cpu_ms"):5.0f}  session {F(r, "session_cpu_ms"):5.0f}  outside {F(r, "outside_cpu_ms"):6.0f}  [{r["top_outside"]}]' + (f'  game majflt {F(r, "game_majflt"):.0f} comp majflt {F(r, "comp_majflt"):.0f} swapin {F(r, "sys_swapin_pages"):.0f} kswapd {F(r, "kswapd_cpu_ms"):.0f} ms memstall {F(r, "sys_mem_stall_ms"):.0f} ms' if 'kswapd_cpu_ms' in r else ''))
# --- the game's own account of each long frame (builds that log it)
if hit and 'main_blocked_ms' in hit[0]:
    sims = [(e['usec'], e.get('name')) for e in ev if e.get('ev') == 'sim']
    def nearest(u):
        b = min(sims, key=lambda x: abs(x[0] - u)) if sims else (u, '-')
        return f'{b[1]} {((b[0] - u) / 1e6):+.2f}s'
    print('long frames, from inside the game: frame ms = main thread on CPU + waiting for a CPU + blocked; process major page faults in that frame;')
    print('engine script/scene step (proc) and physics step of the frame; nearest weapon event')
    for h in hit:
        print(f'  game t={(h["usec"] - u0) / 1e6:6.1f}s  {h["ms"]:6.1f} ms = cpu {h["main_cpu_ms"]:5.1f} + wait {h["main_wait_ms"]:5.1f} + blocked {h["main_blocked_ms"]:6.1f}   majflt {h["majflt"]:3d}   proc {h["proc_ms"]:6.1f}  phys {h["phys_ms"]:5.1f}   [{nearest(h["usec"])}]')
    n = len(hit)
    blk = sum(1 for h in hit if h['main_blocked_ms'] > 0.5 * h['ms']); wt = sum(1 for h in hit if h['main_wait_ms'] > 0.5 * h['ms']); cp = sum(1 for h in hit if h['main_cpu_ms'] > 0.5 * h['ms'])
    print(f'of {n} long frames: mostly blocked {blk}, mostly waiting for a CPU {wt}, mostly computing {cp}; with major page faults {sum(1 for h in hit if h["majflt"] > 0)}; '
          f'script/scene step over 20 ms in {sum(1 for h in hit if h["proc_ms"] > 20)}')
    slow = [e for e in ev if e.get('ev') == 'sim' and e.get('name') == 'slow_handler']
    print(f'weapon-event handlers that took over 3 ms: {len(slow)}' + ''.join(f'\n  {e.get("of")} {e.get("ms"):.1f} ms at game t={(e["usec"] - u0) / 1e6:.1f}s' for e in slow))
