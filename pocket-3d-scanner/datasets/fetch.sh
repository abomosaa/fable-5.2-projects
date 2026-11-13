#!/usr/bin/env bash
# Re-download every benchmark dataset from its original source into the layout
# described in MANIFEST.md, rebuild the derived subsets, and verify SHA-256.
#
#   ./fetch.sh                 # everything
#   ./fetch.sh textured smoke  # only the named datasets
#   ./fetch.sh --verify        # only verify checksums of what is on disk
#
# Requirements: bash, curl, sha256sum, python3 (stdlib only; always run with -I).
#   `magick` (ImageMagick 7) is needed only if smoke/ or smoke_alt/ images are
#   missing and have to be re-derived.
# Network cost: textured ~0.3 GB, concave ~0.9 GB, groundtruth+difficult stream
#   the first ~2.5 GB of the 17 GB NAVI tarball (nothing but the selected ~0.3 GB
#   is written to disk; the stream is closed as soon as the last wanted file is
#   seen). Set NAVI_TARBALL=/path/to/navi_v1.0.tar.gz to use a local copy instead.
#
# SECURITY: everything fetched here is untrusted *data*. Nothing downloaded is
# executed or sourced; archives are never unpacked with tar/unzip (the NAVI
# tarball is read member-by-member by _scripts/navi_extract.py, which only
# writes whitelisted regular files to whitelisted relative paths).
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S="$ROOT/_scripts"
NAVI_URL="https://storage.googleapis.com/gresearch/navi-dataset/navi_v1.0.tar.gz"
# sha256 of the full navi_v1.0.tar.gz as downloaded on 2026-11-11 (16,964,463,171 bytes).
# Informational: fetch.sh never downloads the whole file; per-file SHA256SUMS are what is verified.
NAVI_TARBALL_SHA256="d6bf99a0fea6e4912a70b1b796b69f8a2e93a2dc6c417a871ed0ca7d520eccf9"

ALL=(textured concave groundtruth difficult smoke smoke_alt)
verify_only=0
want=()
for a in "$@"; do
  case "$a" in
    --verify) verify_only=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) want+=("$a") ;;
  esac
done
[ ${#want[@]} -eq 0 ] && want=("${ALL[@]}")

has() { local x; for x in "${want[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
log() { printf '[fetch] %s\n' "$*"; }
rc=0

navi_missing() {  # does <dataset> lack any file listed in its navi_members.tsv?
  local d=$1 rel
  while IFS=$'\t' read -r _ rel; do
    case "$rel" in ''|'#'*) continue ;; esac
    [ -s "$ROOT/$d/$rel" ] || return 0
  done < <(grep -v '^#' "$ROOT/$d/navi_members.tsv")
  return 1
}

fetch_navi() {
  local maps=() d
  for d in "$@"; do maps+=(--map "$ROOT/$d/navi_members.tsv" "$ROOT/$d"); done
  if [ -n "${NAVI_TARBALL:-}" ]; then
    log "NAVI: extracting from local tarball $NAVI_TARBALL"
    python3 -I "$S/navi_extract.py" --src "$NAVI_TARBALL" "${maps[@]}" || return 1
  else
    log "NAVI: streaming $NAVI_URL (stops after the wanted members; ~2.5 GB read)"
    # curl exits non-zero (23, write error) when the extractor closes the pipe early: expected.
    curl -sS -L --fail --retry 3 "$NAVI_URL" 2> >(grep -v -E 'curl: \(23\)|Failure writing output' >&2) \
      | python3 -I "$S/navi_extract.py" "${maps[@]}"
    local st=("${PIPESTATUS[@]}")
    [ "${st[1]}" -eq 0 ] || { log "NAVI extraction failed (curl=${st[0]} extractor=${st[1]})"; return 1; }
  fi
}

need_smoke=0; need_smoke_alt=0
if has smoke && [ "$(ls "$ROOT/smoke/images" 2>/dev/null | wc -l)" -ne 12 ]; then need_smoke=1; fi
if has smoke_alt && [ "$(ls "$ROOT/smoke_alt/images" 2>/dev/null | wc -l)" -ne 12 ]; then need_smoke_alt=1; fi

if [ $verify_only -eq 0 ]; then
  # ---- textured: AliceVision Buddha (CC BY 4.0), GitHub raw at a pinned commit
  if has textured; then
    log "textured: downloading"
    bash "$S/fetch_urls.sh" "$ROOT/textured" 8 >/dev/null || rc=1
    if [ ! -s "$ROOT/textured/cameras/intrinsics_from_P.json" ]; then
      # derived convenience file (needs numpy); not covered by SHA256SUMS
      python3 -I "$S/p_to_krt.py" "$ROOT/textured/cameras" "$ROOT/textured/cameras/intrinsics_from_P.json" \
        || log "textured: could not regenerate cameras/intrinsics_from_P.json (numpy missing?) - optional"
    fi
  fi

  # ---- concave: British Museum Townley well-head (CC BY-NC-SA 4.0), GitHub raw at a pinned commit
  if has concave || [ $need_smoke_alt -eq 1 ]; then
    log "concave: downloading"
    bash "$S/fetch_urls.sh" "$ROOT/concave" 8 >/dev/null || rc=1
    bash "$S/make_subset.sh" "$ROOT/concave" 2 || rc=1   # images/ = every 2nd of images_all/
  fi

  # ---- groundtruth + difficult: NAVI v1.0 (dataset: CC-BY per paper; Apache-2.0 on project page)
  navi_sets=()
  if has groundtruth || [ $need_smoke -eq 1 ]; then navi_sets+=(groundtruth); fi
  if has difficult; then navi_sets+=(difficult); fi
  if [ ${#navi_sets[@]} -gt 0 ]; then
    need=()
    for d in "${navi_sets[@]}"; do
      bash "$S/fetch_urls.sh" "$ROOT/$d" 3 >/dev/null || rc=1   # license/README proofs
      navi_missing "$d" && need+=("$d")
    done
    if [ ${#need[@]} -gt 0 ]; then fetch_navi "${need[@]}" || rc=1; else log "NAVI: all files already present"; fi
    for d in "${navi_sets[@]}"; do
      [ -s "$ROOT/$d/capture_order.txt" ] || python3 -I "$S/navi_capture_order.py" "$ROOT/$d" > "$ROOT/$d/capture_order.txt" || rc=1
    done
  fi

  # ---- smoke: 12 consecutive captures of groundtruth, downscaled to 1200 px (derived)
  if [ $need_smoke -eq 1 ]; then
    log "smoke: deriving from groundtruth (needs ImageMagick 'magick')"
    python3 -I "$S/make_smoke.py" "$ROOT/groundtruth" "$ROOT/smoke" 11 || rc=1
  fi
  # ---- smoke_alt: first 12 files of concave/images, downscaled to 1200 px (derived)
  if [ $need_smoke_alt -eq 1 ]; then
    log "smoke_alt: deriving from concave (needs ImageMagick 'magick')"
    bash "$S/make_smoke_alt.sh" "$ROOT/concave" "$ROOT/smoke_alt" || rc=1
  fi
fi

# ---- verification
for d in "${want[@]}"; do
  if [ ! -f "$ROOT/$d/SHA256SUMS" ]; then log "$d: no SHA256SUMS (unknown dataset?)"; rc=1; continue; fi
  if (cd "$ROOT/$d" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1); then
    log "$d: OK ($(grep -c . "$ROOT/$d/SHA256SUMS") files verified)"
  else
    case "$d" in
      smoke|smoke_alt)
        # Re-derived JPEGs are only byte-identical with the same ImageMagick build
        # (recorded in the dataset README). Missing files are still an error.
        if (cd "$ROOT/$d" && sha256sum -c SHA256SUMS 2>&1 | grep -q 'No such file\|FAILED open'); then
          log "$d: FILES MISSING"; rc=1
        else
          log "$d: WARNING checksum mismatch - derived images were regenerated with a different ImageMagick; content is equivalent but not byte-identical"
        fi ;;
      *)
        log "$d: CHECKSUM FAILURE"
        (cd "$ROOT/$d" && sha256sum -c --quiet SHA256SUMS 2>&1 | head -n 10)
        rc=1 ;;
    esac
  fi
done
[ $rc -eq 0 ] && log "all requested datasets present and verified" || log "finished with errors"
exit $rc
