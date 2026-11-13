#!/usr/bin/env bash
# Range Day — one-time setup (needs network once; everything afterwards runs offline).
#   1. downloads the pinned Godot 4.7.2 editor binary and Linux export template (sha256-verified)
#   2. imports the project's assets (textures, audio, models are bundled in game/assets)
#   3. exports the standalone build to build/RangeDay/
# Nothing is installed outside this directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$ROOT/tools/vendor"; mkdir -p "$V/dl" "$V/godot" "$V/templates"
GODOT_URL="https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip"
GODOT_SHA="cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4"
TPL_URL="https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz"
TPL_SHA="f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011"
fetch() { # url sha out
  if [ ! -f "$3" ] || ! echo "$2  $3" | sha256sum -c --status; then
    echo "downloading $(basename "$3")"; curl -fL --retry 3 -o "$3" "$1"
  fi
  echo "$2  $3" | sha256sum -c --status || { echo "checksum mismatch: $3" >&2; exit 1; }
}
GODOT="$V/godot/Godot_v4.7.2-stable_linux.x86_64"
if [ ! -x "$GODOT" ]; then
  fetch "$GODOT_URL" "$GODOT_SHA" "$V/dl/godot.zip"
  unzip -q -o "$V/dl/godot.zip" -d "$V/godot"
fi
if [ ! -x "$V/templates/linux_release.x86_64" ]; then
  fetch "$TPL_URL" "$TPL_SHA" "$V/dl/templates.tpz"
  unzip -q -o -j "$V/dl/templates.tpz" 'templates/linux_release.x86_64' -d "$V/templates"
  chmod +x "$V/templates/linux_release.x86_64"
fi
echo "checking bundled assets"
"$ROOT/tools/check_assets.sh"
echo "importing assets (first run takes a few minutes)"
"$GODOT" --headless --path "$ROOT/game" --import >/dev/null 2>&1 || true
"$GODOT" --headless --path "$ROOT/game" --import >/dev/null 2>&1 || true
echo "exporting standalone build"
mkdir -p "$ROOT/build/RangeDay"
"$GODOT" --headless --path "$ROOT/game" --export-release "Linux" "$ROOT/build/RangeDay/RangeDay.x86_64" 2>&1 | grep -E "ERROR|error" | grep -v "xdg" || true
test -x "$ROOT/build/RangeDay/RangeDay.x86_64" && echo "done: ./run.sh" || { echo "export failed; ./run.sh will use the engine + project instead" >&2; }
