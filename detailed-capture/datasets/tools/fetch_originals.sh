#!/bin/sh
# usage: fetch_originals.sh <urls.tsv> <real_dir> [gap_seconds]
# Sequential download of Commons originals with curl. Skips files already complete, waits <gap> seconds between
# requests and honours HTTP 429 Retry-After (upload.wikimedia.org allows only a handful of originals per window).
UA="DetailedCaptureEval/0.2 (one-off research dataset collection for an image registration benchmark; sequential, low volume)"
tsv="$1"; real="$2"; gap="${3:-100}"
tab="$(printf '\t')"
while IFS="$tab" read -r set local bytes url; do
  dst="$real/$set/$local"; mkdir -p "$real/$set"
  if [ -f "$dst" ] && [ "$(stat -c %s "$dst")" = "$bytes" ]; then echo "have $set/$local"; continue; fi
  tries=0
  while :; do
    tries=$((tries+1))
    code=$(curl -s -A "$UA" -D "$dst.hdr" -o "$dst.part" -w '%{http_code}' "$url")
    if [ "$code" = "200" ] && [ "$(stat -c %s "$dst.part")" = "$bytes" ]; then
      mv "$dst.part" "$dst"; rm -f "$dst.hdr"; echo "got  $set/$local $bytes"; sleep "$gap"; break
    fi
    ra=$(grep -i '^retry-after:' "$dst.hdr" | tr -dc '0-9'); rm -f "$dst.part" "$dst.hdr"
    [ -z "$ra" ] && ra=120
    echo "HTTP $code for $set/$local, waiting $((ra+5))s (try $tries)"
    if [ "$tries" -ge 8 ]; then echo "FAILED $set/$local"; break; fi
    sleep $((ra+5))
  done
done < "$tsv"
echo ALL-DONE
