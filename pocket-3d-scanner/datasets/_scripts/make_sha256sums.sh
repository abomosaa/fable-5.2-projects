#!/usr/bin/env bash
# (Re)generate <dataset_dir>/SHA256SUMS over every data file of a dataset:
# images/, images_all/, cameras/, reference/, upstream/, capture_order.txt, cameras.json.
# Excluded: docs and lists (README.md, LICENSE.source.txt, urls.tsv, navi_members.tsv)
# and cameras/intrinsics_from_P.json (numpy-derived convenience file).
# Maintainer tool - run once after a verified download; fetch.sh only *checks* the sums.
# usage: make_sha256sums.sh <dataset_dir>
set -euo pipefail
cd "${1:?dataset dir}"
paths=()
for p in images images_all cameras reference upstream capture_order.txt cameras.json; do
  [ -e "$p" ] && paths+=("$p")
done
find "${paths[@]}" -type f ! -name intrinsics_from_P.json ! -name '*.part' -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
echo "$(pwd): $(wc -l < SHA256SUMS) files"
