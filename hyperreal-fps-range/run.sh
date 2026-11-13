#!/usr/bin/env bash
# Range Day — launch. Uses the exported standalone build if present, otherwise the vendored engine + project.
# Extra arguments are passed to the game (e.g. ./run.sh -- --no-vsync).
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$ROOT/build/RangeDay/RangeDay.x86_64" ]; then
  exec "$ROOT/build/RangeDay/RangeDay.x86_64" "$@"
fi
GODOT="$ROOT/tools/vendor/godot/Godot_v4.7.2-stable_linux.x86_64"
if [ ! -x "$GODOT" ]; then
  echo "Engine not found. Run ./setup.sh first (downloads the pinned Godot 4.7.2 build once)." >&2
  exit 1
fi
exec "$GODOT" --path "$ROOT/game" "$@"
