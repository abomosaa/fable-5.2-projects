#!/usr/bin/env bash
# Download every entry of <dataset_dir>/urls.tsv (format: relative/path<TAB>url)
# into <dataset_dir>, skipping files that already exist and are non-empty.
# Downloads are data only: nothing fetched here is ever executed.
#
# usage: fetch_urls.sh <dataset_dir> [parallel_jobs]
set -euo pipefail

dir=${1:?usage: fetch_urls.sh <dataset_dir> [jobs]}
jobs=${2:-6}
tsv="$dir/urls.tsv"
[ -f "$tsv" ] || { echo "missing $tsv" >&2; exit 1; }

# Wikimedia requires a descriptive User-Agent; harmless for other hosts.
UA=${FETCH_USER_AGENT:-"pocket-3d-scanner-dataset-fetch/1.0 (reproducible research download; curl)"}
export UA dir

fetch_one() {
  local rel=$1 url=$2 out="$dir/$1"
  case "$rel" in /*|*..*) echo "refusing suspicious path: $rel" >&2; return 1 ;; esac
  if [ -s "$out" ]; then return 0; fi
  mkdir -p "$(dirname "$out")"
  local tmp="$out.part"
  if curl -sS -L --fail --retry 5 --retry-delay 3 --retry-all-errors -A "$UA" -o "$tmp" "$url"; then
    mv "$tmp" "$out"
    echo "ok   $rel"
  else
    rm -f "$tmp"
    echo "FAIL $rel <- $url" >&2
    return 1
  fi
}
export -f fetch_one

fail=0
# shellcheck disable=SC2016
grep -v '^#' "$tsv" | grep -v '^[[:space:]]*$' \
  | tr '\t' '\n' \
  | xargs -d '\n' -n 2 -P "$jobs" bash -c 'fetch_one "$1" "$2"' _ || fail=1

exit $fail
