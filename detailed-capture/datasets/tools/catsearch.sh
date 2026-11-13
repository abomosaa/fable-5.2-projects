#!/bin/sh
# usage: catsearch.sh "search words" -> matching category names
UA="DetailedCaptureEval/0.1 (research dataset collection)"
curl -s -A "$UA" -G "https://commons.wikimedia.org/w/api.php" \
  --data-urlencode "action=query" --data-urlencode "list=search" --data-urlencode "srsearch=$1" \
  --data-urlencode "srnamespace=${2:-14}" --data-urlencode "srlimit=${3:-30}" --data-urlencode "format=json" | jq -r '.query.search[].title'
