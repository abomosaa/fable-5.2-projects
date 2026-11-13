#!/usr/bin/env bash
# Renders every results/<run>/model.glb through the independent loader (tools/render_glb.py):
# three rows per sheet — whole delivered scene, suggested object crop, evidence (confidence).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/tools/.venv/bin/python"
TMP="$(mktemp -d)"
mkdir -p "$ROOT/results/_renders"
for d in "$ROOT"/results/*/; do
  r="$(basename "$d")"; g="$d/model.glb"
  case "$r" in _*) continue;; esac
  [ -f "$g" ] || { echo "no model: $r"; continue; }
  "$PY" "$ROOT/tools/render_glb.py" "$g" "$TMP/a.png" --views 4 --size 400 >/dev/null
  "$PY" "$ROOT/tools/render_glb.py" "$g" "$TMP/b.png" --views 4 --size 400 --crop >/dev/null
  "$PY" "$ROOT/tools/render_glb.py" "$g" "$TMP/c.png" --views 4 --size 400 --crop --mode confidence >/dev/null
  magick "$TMP/a.png" "$TMP/b.png" "$TMP/c.png" -append -quality 88 "$ROOT/results/_renders/${r}_sheet.jpg"
  echo "rendered $r"
done
