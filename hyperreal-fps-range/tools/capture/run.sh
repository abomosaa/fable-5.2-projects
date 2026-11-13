#!/usr/bin/env bash
# Run the game on the virtual output with a scripted input sequence.
#   tools/capture/run.sh <script.json> <out_dir> [--record] [--no-vsync] [extra game args...]
# --record : capture the virtual output + the game's audio (null-sink monitor) with wf-recorder into <out_dir>/capture.mkv
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"
cap_setup
SCRIPT="$(realpath "$1")"; OUT="$(realpath -m "$2")"; shift 2
RECORD=0; EXTRA=()
for a in "$@"; do
  if [ "$a" = "--record" ]; then RECORD=1; else EXTRA+=("$a"); fi
done
mkdir -p "$OUT"
REC_PID=""
if [ "$RECORD" = 1 ]; then
  rm -f "$OUT/capture.mkv"
  "$WFREC" -o FPSRANGE -f "$OUT/capture.mkv" -c libx264 -p preset=veryfast -p crf=18 -r 60 -D \
     --audio="$CAP_SINK.monitor" -C flac >"$OUT/wf-recorder.log" 2>&1 &
  REC_PID=$!
  sleep 0.8
fi
# captures never touch the real user profile: settings/bindings live in a scratch data dir
# (a fresh one per run unless FPSR_DATA_HOME names a directory to keep, e.g. for the persistence check)
export XDG_DATA_HOME="${FPSR_DATA_HOME:-$(mktemp -d /tmp/fpsr_userdata.XXXXXX)}"
mkdir -p "$XDG_DATA_HOME"
PULSE_SINK=$CAP_SINK timeout "${FPSR_TIMEOUT:-600}" "$GODOT" --path "$FPSR_ROOT/game" --display-driver wayland \
   -- --autoplay="$SCRIPT" --capture-dir="$OUT" --windowed "${EXTRA[@]}" >"$OUT/game.log" 2>&1 &
GAME_PID=$!
# compositor-side fullscreen on the virtual output (above the desktop bar), without moving the user's focus
for i in 1 2 3 4 5 6 7 8; do
  sleep 0.5
  if hyprctl clients | grep -q "class: fpsr-range"; then
    hyprctl eval 'local w; for _,x in ipairs(hl.get_windows()) do if x.class=="fpsr-range" then w=x end end; if w then hl.dispatch(hl.dsp.window.fullscreen({ window = w, mode = "fullscreen", action = "set" })) end' >/dev/null 2>&1
    break
  fi
done
wait $GAME_PID
RC=$?
if [ -n "$REC_PID" ]; then sleep 1.0; kill -INT "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null; fi
grep -E "ERROR|SCRIPT ERROR|WARNING" "$OUT/game.log" | sort | uniq -c | sort -rn | head -${FPSR_LOGLINES:-15}
echo "exit=$RC out=$OUT"
