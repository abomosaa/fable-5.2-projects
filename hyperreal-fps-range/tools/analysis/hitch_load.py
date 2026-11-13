#!/usr/bin/env python3
"""Line up the game's long frames ("hitch" events, > 34 ms) with the machine-load log written by tools/capture/loadlog.sh.
usage: hitch_load.py <events.jsonl> <load.csv>
For each hitch: how much stall time the kernel charged in the 0.75 s around it (cgroup memory / cgroup cpu / system cpu),
against the run's median for windows of the same length."""
import sys, json, csv, bisect, statistics
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
hit = [e for e in ev if e.get('ev') == 'hitch']
rows = list(csv.DictReader(open(sys.argv[2])))
T = [float(r['unix']) for r in rows]
def col(name): return [float(r[name] or 0) for r in rows]
C = {k: col(k) for k in ('cg_mem_stall_us', 'cg_cpu_stall_us', 'sys_cpu_stall_us', 'sys_mem_stall_us', 'sys_io_stall_us', 'cg_mem_high_events', 'load1', 'cg_mem_bytes')}
def delta(k, t0, t1):
    i = max(0, bisect.bisect_left(T, t0) - 1); j = min(len(T) - 1, bisect.bisect_right(T, t1))
    return C[k][j] - C[k][i]
play = [e for e in ev if 'unix' in e]
t_first = min(float(e['unix']) for e in play) if play else T[0]
states = [e for e in ev if e.get('ev') in ('state', 'bench')]
t_start, t_end = T[0], T[-1]
W = 0.75
base = {k: [] for k in ('cg_mem_stall_us', 'cg_cpu_stall_us', 'sys_cpu_stall_us')}
t = t_start + 1
while t < t_end - 1:
    for k in base: base[k].append(delta(k, t - W / 2, t + W / 2) / 1000.0)
    t += W
print(f'load log: {t_end - t_start:.0f} s, load average {min(C["load1"]):.1f}-{max(C["load1"]):.1f}, cgroup memory {min(C["cg_mem_bytes"]) / 2**30:.2f}-{max(C["cg_mem_bytes"]) / 2**30:.2f} GiB, '
      f'memory.high events during the log: {C["cg_mem_high_events"][-1] - C["cg_mem_high_events"][0]:.0f}')
for k in base:
    b = sorted(base[k]); print(f'  background {k} per {W} s window: median {statistics.median(b):.1f} ms, p90 {b[int(len(b) * 0.9)]:.1f} ms, max {b[-1]:.1f} ms')
print(f'hitches (> 34 ms): {len(hit)}')
# How loaded was the machine in each second of the run, and where do the hitches fall?
t0 = min(float(e['unix']) for e in ev if 'unix' in e) if hit else T[0]
secs = {}
t = T[0] + 1
while t < T[-1] - 1:
    secs[int(t - T[0])] = delta('sys_cpu_stall_us', t - 0.5, t + 0.5) / 1000.0
    t += 1.0
vals = sorted(secs.values())
def q(p): return vals[min(len(vals) - 1, int(len(vals) * p))]
med, p75, p90 = q(0.5), q(0.75), q(0.9)
print(f'system CPU stall per second of the run: median {med:.0f} ms, p75 {p75:.0f} ms, p90 {p90:.0f} ms, max {vals[-1]:.0f} ms')
bins = {'below median': 0, 'median-p75': 0, 'p75-p90': 0, 'above p90': 0}
nsec = {'below median': sum(v < med for v in vals), 'median-p75': sum(med <= v < p75 for v in vals), 'p75-p90': sum(p75 <= v < p90 for v in vals), 'above p90': sum(v >= p90 for v in vals)}
mem_hits = 0
for h in hit:
    u = float(h['unix'])
    v = delta('sys_cpu_stall_us', u - 0.5, u + 0.5) / 1000.0
    k = 'below median' if v < med else 'median-p75' if v < p75 else 'p75-p90' if v < p90 else 'above p90'
    bins[k] += 1
    mem = delta('cg_mem_stall_us', u - 0.5, u + 0.5) / 1000.0
    hi = delta('cg_mem_high_events', u - 0.5, u + 0.5)
    mem_hits += (mem > 1.0 or hi > 0)
    print(f'  t={u - T[0]:7.1f}s  {h["ms"]:6.1f} ms   system cpu stall in that second {v:6.0f} ms ({k})   cgroup memory stall {mem:5.1f} ms, memory.high +{hi:.0f}')
print('hitches by how loaded the machine was in that second (seconds of the run in each class):')
for k in bins:
    rate = bins[k] / max(nsec[k], 1)
    print(f'  {k:13s}: {bins[k]:3d} hitches in {nsec[k]:3d} s  ({rate:.2f} per second)')
print(f'hitches during cgroup memory throttling: {mem_hits}')
