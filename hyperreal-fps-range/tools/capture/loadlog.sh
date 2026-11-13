#!/usr/bin/env bash
# Samples what the machine and this session's cgroup are doing, 4 times a second, until killed.
#   tools/capture/loadlog.sh <out.csv>
# Columns: unix time, 1-min load average, cgroup memory in use (bytes), cgroup memory.events "high" count (times the
# cgroup was pushed over its soft limit and throttled), cumulative stall time in microseconds from the kernel's
# pressure-stall accounting: cgroup memory "some", cgroup cpu "some", system cpu "some", system memory "some",
# system io "some". A frame-time stall that coincides with a jump in one of the stall columns was the process being
# held up from outside; one that does not is the game's own.
OUT="$1"
CG="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
tot() { sed -n 's/^some .*total=\([0-9]*\)$/\1/p' "$1" 2>/dev/null | head -1; }
echo "unix,load1,cg_mem_bytes,cg_mem_high_events,cg_mem_stall_us,cg_cpu_stall_us,sys_cpu_stall_us,sys_mem_stall_us,sys_io_stall_us" > "$OUT"
while :; do
  echo "$(date +%s.%N | cut -c1-14),$(cut -d' ' -f1 /proc/loadavg),$(cat "$CG/memory.current" 2>/dev/null),$(sed -n 's/^high //p' "$CG/memory.events" 2>/dev/null),$(tot "$CG/memory.pressure"),$(tot "$CG/cpu.pressure"),$(tot /proc/pressure/cpu),$(tot /proc/pressure/memory),$(tot /proc/pressure/io)" >> "$OUT"
  sleep 0.25
done
