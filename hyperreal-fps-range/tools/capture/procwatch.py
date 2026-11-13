#!/usr/bin/env python3
"""Who is using the CPU while the game runs, and how long did the game's threads wait for one?

  procwatch.py <out.csv> [interval_s=0.5] [game_name_regex='Godot_v4|RangeDay']

Every interval, until killed, one CSV row:
  unix                 wall clock at the end of the interval
  load1                1-minute load average
  game_cpu_ms          CPU time used by the game process (all threads) in the interval
  game_main_wait_ms    time the game's main thread was runnable but waiting for a CPU (kernel schedstat run_delay)
  game_all_wait_ms     the same, summed over all of the game's threads
  session_cpu_ms       CPU time of the other processes in this session's cgroup (capture tools, shells, agents)
  outside_cpu_ms       CPU time of every other process on the machine
  top_outside          the three biggest outside consumers in the interval, name:ms
  sys_cpu_stall_ms     kernel pressure-stall "some" CPU time for the whole machine
  mem_high_events      times this session's cgroup was pushed over its memory soft limit
  game_majflt          major page faults of the game process (pages it had to wait for from disk or swap)
  comp_majflt          major page faults of the Wayland compositor the game presents through
  sys_majflt           major page faults on the whole machine
  sys_swapin_pages     pages read back from swap on the whole machine
  sys_swapout_pages    pages written to swap on the whole machine
  sys_mem_stall_ms     kernel pressure-stall "some" memory time for the whole machine
  kswapd_cpu_ms        CPU time of the kernel's page-reclaim threads
"session" means: the other processes in the same cgroup as this sampler. If another project runs in that cgroup its
jobs are counted there, not under "outside".
Reads /proc only; changes nothing."""
import os, re, sys, time
out = sys.argv[1]
dt = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
pat = re.compile(sys.argv[3] if len(sys.argv) > 3 else r'Godot_v4|RangeDay')
TICK = os.sysconf('SC_CLK_TCK')
CG = '/sys/fs/cgroup' + open('/proc/self/cgroup').read().strip().split(':', 2)[2]
ME = os.getpid()

def rd(p):
    try:
        with open(p) as f: return f.read()
    except OSError: return ''
def cpu_all():
    r = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        s = rd(f'/proc/{d}/stat')
        if not s: continue
        k = s.rfind(')'); name = s[s.find('(') + 1:k]; f = s[k + 2:].split()
        r[int(d)] = (name, (int(f[11]) + int(f[12])) * 1000.0 / TICK, int(f[9]))
    return r
def vm():
    d = {}
    for l in rd('/proc/vmstat').splitlines():
        k, _, v = l.partition(' ')
        if k in ('pgmajfault', 'pswpin', 'pswpout'): d[k] = int(v)
    m = re.search(r'some .*total=(\d+)', rd('/proc/pressure/memory'))
    d['memstall'] = int(m.group(1)) / 1000.0 if m else 0.0
    return d
COMP = re.compile(r'^(Hyprland|sway|kwin_wayland|gnome-shell|weston|river|niri)$')
def game_pid(procs):
    for pid, (name, _, _) in procs.items():
        if pat.search(name) and pid != ME:
            cmd = rd(f'/proc/{pid}/cmdline')
            if '--headless' not in cmd: return pid
    return None
def waits(pid):
    main = tot = 0.0
    try: tids = os.listdir(f'/proc/{pid}/task')
    except OSError: return 0.0, 0.0
    for t in tids:
        s = rd(f'/proc/{pid}/task/{t}/schedstat').split()
        if len(s) >= 2:
            w = int(s[1]) / 1e6; tot += w
            if int(t) == pid: main = w
    return main, tot
def psi():
    m = re.search(r'some .*total=(\d+)', rd('/proc/pressure/cpu')); return int(m.group(1)) / 1000.0 if m else 0.0
def memhigh():
    m = re.search(r'^high (\d+)', rd(CG + '/memory.events'), re.M); return int(m.group(1)) if m else 0

prev = cpu_all(); gp = game_pid(prev); pw = waits(gp) if gp else (0.0, 0.0); pp = psi(); pm = memhigh(); pv = vm()
with open(out, 'w') as f:
    f.write('unix,load1,game_cpu_ms,game_main_wait_ms,game_all_wait_ms,session_cpu_ms,outside_cpu_ms,top_outside,sys_cpu_stall_ms,mem_high_events,game_majflt,comp_majflt,sys_majflt,sys_swapin_pages,sys_swapout_pages,sys_mem_stall_ms,kswapd_cpu_ms\n')
    nxt = time.time() + dt
    while True:
        time.sleep(max(0.0, nxt - time.time())); nxt += dt
        cur = cpu_all()
        mine = set(int(x) for x in rd(CG + '/cgroup.procs').split())
        if gp is None or gp not in cur:
            gp = game_pid(cur); pw = waits(gp) if gp else (0.0, 0.0)
        g = s = o = 0.0; top = {}; gmf = cmf = 0; ks = 0.0
        for pid, (name, c, mf) in cur.items():
            pr = prev.get(pid, (name, c, mf))
            d = c - pr[1]
            if pid == gp: gmf += mf - pr[2]
            elif COMP.match(name): cmf += mf - pr[2]
            if name.startswith('kswapd') or name.startswith('kcompactd'): ks += max(d, 0.0)
            if d <= 0 or pid == ME: continue
            if pid == gp: g += d
            elif pid in mine: s += d
            else: o += d; top[name] = top.get(name, 0.0) + d
        w = waits(gp) if gp else (0.0, 0.0); p = psi(); m = memhigh(); v = vm()
        tops = ';'.join(f'{n}:{v:.0f}' for n, v in sorted(top.items(), key=lambda kv: -kv[1])[:3])
        f.write(f'{time.time():.3f},{rd("/proc/loadavg").split()[0]},{g:.0f},{max(0.0, w[0] - pw[0]):.1f},{max(0.0, w[1] - pw[1]):.1f},{s:.0f},{o:.0f},{tops},{p - pp:.1f},{m - pm},{gmf},{cmf},{v.get('pgmajfault', 0) - pv.get('pgmajfault', 0)},{v.get('pswpin', 0) - pv.get('pswpin', 0)},{v.get('pswpout', 0) - pv.get('pswpout', 0)},{v['memstall'] - pv['memstall']:.1f},{ks:.0f}\n')
        f.flush(); prev = cur; pw = w; pp = p; pm = m; pv = v
