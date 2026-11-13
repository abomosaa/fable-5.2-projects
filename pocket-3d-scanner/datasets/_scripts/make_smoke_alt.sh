#!/usr/bin/env bash
# Derive `smoke_alt` from `concave` (Townley well-head, CC BY-NC-SA 4.0).
# Rule: take the first 12 files (LC_ALL=C sorted) of concave/images/ -- i.e. every
# 2nd original capture DSC_0486 ... DSC_0508, a 12-view arc of the first orbit --
# and downscale each to a 1200 px long side:
#   magick <src> -resize 1200x1200 -quality 90 <dst>     (EXIF kept, no auto-orient)
# usage: make_smoke_alt.sh <concave_dir> <smoke_alt_dir>
set -euo pipefail
src=${1:?concave dir}; dst=${2:?smoke_alt dir}
mkdir -p "$dst/images"
(cd "$src/images" && LC_ALL=C ls -1 | head -n 12) | while IFS= read -r f; do
  magick "$src/images/$f" -resize 1200x1200 -quality 90 "$dst/images/${f%.*}.jpg"
done
echo "smoke_alt: wrote $(ls "$dst/images" | wc -l) images to $dst/images"
