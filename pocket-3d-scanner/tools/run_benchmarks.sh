#!/usr/bin/env bash
# Reproducible benchmark: runs the real reconstruction pipeline (companion container image) on
# the example datasets and collects outputs + diagnostics into results/<run>/.
#
#   tools/run_benchmarks.sh                # all default runs
#   tools/run_benchmarks.sh textured:standard difficult:preview   # selected dataset:preset pairs
#
# Env: P3D_IMAGE (default pocket3d-companion:latest), P3D_CPUS (8), P3D_MEM_GB (5)
#      P3D_LIMIT_ARGS  container resource flags. Default: "--cpus $P3D_CPUS --memory ${P3D_MEM_GB}g".
#                      On a host where this shell already runs inside a memory-limited service
#                      and the container must stay inside that limit, use "--cgroups=disabled"
#                      (the pipeline then bounds itself through --threads/--memory-mb only).
#      P3D_SUFFIX      appended to the run name (e.g. "_8t5g")
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${P3D_IMAGE:-pocket3d-companion:latest}"
CPUS="${P3D_CPUS:-8}"
MEM="${P3D_MEM_GB:-5}"
LIMIT_ARGS="${P3D_LIMIT_ARGS:---cpus $CPUS --memory ${MEM}g}"
SUFFIX="${P3D_SUFFIX:-}"
RUNTIME="$(command -v podman || command -v docker)"
RUNS=("$@")
if [ ${#RUNS[@]} -eq 0 ]; then
  RUNS=(smoke:preview textured:standard groundtruth:standard difficult:standard concave:standard)
fi
mkdir -p "$ROOT/.work/runs" "$ROOT/results"
for spec in "${RUNS[@]}"; do
  ds="${spec%%:*}"; preset="${spec##*:}"; name="${ds}_${preset}${SUFFIX}"
  img="$ROOT/datasets/$ds/images"
  [ -d "$img" ] || { echo "missing $img (run datasets/fetch.sh)"; exit 1; }
  run="$ROOT/.work/runs/$name"
  [ -n "$name" ] && rm -rf "$run"
  mkdir -p "$run"
  echo "=== $name ($(ls "$img" | wc -l) images, preset $preset, $CPUS threads, ${MEM} GB budget, limits: $LIMIT_ARGS)"
  load_before="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '? ? ?')"
  set +e
  # shellcheck disable=SC2086
  "$RUNTIME" run --rm $LIMIT_ARGS \
    -v "$img":/in:ro -v "$ROOT/.work/runs":/runs \
    -v "$ROOT/companion/pocket3d_companion":/opt/pocket3d/pocket3d_companion:ro \
    --entrypoint python3 "$IMAGE" -m pocket3d_companion.pipeline.localjob \
    --images /in --job-dir "/runs/$name" --preset "$preset" --threads "$CPUS" \
    --memory-mb $((MEM * 1024)) > "$run.log" 2>&1
  code=$?
  set -e
  echo "exit code $code" | tee -a "$run.log"
  out="$ROOT/results/$name"
  [ -n "$name" ] && rm -rf "$out"
  mkdir -p "$out"
  cp "$run/job.json" "$run/events.jsonl" "$out/" 2>/dev/null || true
  grep -v -E '^[IWE][0-9]{8} ' "$run.log" > "$out/pipeline.log" || true
  [ -f "$run/work/tools.log" ] && tr '\r' '\n' < "$run/work/tools.log" | grep -v -E '^(Estimated|Geometric-consistent|Filtered|Fused|Points inserted|Points weighted|Initialized views) ' > "$out/tools.log" || true
  if [ -d "$run/out" ]; then cp "$run/out/"* "$out/" 2>/dev/null || true; fi
  echo "$code" > "$out/exit_code"
  # Other work on the same machine distorts timings: record the load average around the run.
  printf '{"loadavg_1_5_15_before":"%s","loadavg_1_5_15_after":"%s","cpu_threads":%s,"threads_given":%s}\n' \
    "$load_before" "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '? ? ?')" "$(nproc)" "$CPUS" > "$out/host_load.json"
done
