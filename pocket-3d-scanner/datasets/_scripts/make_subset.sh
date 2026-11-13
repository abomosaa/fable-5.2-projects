#!/usr/bin/env bash
# Build <dataset_dir>/images/ as an evenly spaced subset of <dataset_dir>/images_all/.
# Rule: sort file names (LC_ALL=C), keep indices 0, step, 2*step, ... (0-based).
# Files are hard-linked (falls back to a byte-identical copy), never re-encoded.
#
# usage: make_subset.sh <dataset_dir> <step>
set -euo pipefail
dir=${1:?usage: make_subset.sh <dataset_dir> <step>}
step=${2:?step}
src="$dir/images_all"
dst="$dir/images"
[ -d "$src" ] || { echo "missing $src" >&2; exit 1; }
mkdir -p "$dst"
i=0
n=0
while IFS= read -r f; do
  if [ $((i % step)) -eq 0 ]; then
    if [ ! -e "$dst/$f" ]; then
      ln "$src/$f" "$dst/$f" 2>/dev/null || cp -p "$src/$f" "$dst/$f"
    fi
    n=$((n + 1))
  fi
  i=$((i + 1))
done < <(cd "$src" && LC_ALL=C ls -1)
echo "subset: kept $n of $i files (every ${step}th) in $dst"
