#!/usr/bin/env bash
# Downloads the third-party pieces that are not kept in the repository (one-time, needs internet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/third_party/dl"
mkdir -p "$DL"
cd "$DL"
fetch() { [ -f "$2" ] || curl -fL --retry 3 -o "$2" "$1"; }
fetch https://github.com/opencv/opencv/releases/download/4.12.0/opencv-4.12.0-android-sdk.zip opencv-4.12.0-android-sdk.zip
fetch https://github.com/opencv/opencv/archive/refs/tags/4.12.0.tar.gz opencv-4.12.0.tar.gz
[ -d "$ROOT/third_party/opencv-android/OpenCV-android-sdk" ] || { mkdir -p "$ROOT/third_party/opencv-android"; unzip -q opencv-4.12.0-android-sdk.zip -d "$ROOT/third_party/opencv-android"; }
[ -d "$ROOT/third_party/opencv-src/opencv-4.12.0" ] || { mkdir -p "$ROOT/third_party/opencv-src"; tar xzf opencv-4.12.0.tar.gz -C "$ROOT/third_party/opencv-src"; }
sha256sum opencv-4.12.0-android-sdk.zip opencv-4.12.0.tar.gz
echo "Dependencies ready. Host tools: scripts/build_opencv_host.sh ; Android: cd android && ./gradlew :app:assembleRelease"
