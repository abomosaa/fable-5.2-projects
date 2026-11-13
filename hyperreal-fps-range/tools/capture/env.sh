#!/usr/bin/env bash
# Capture environment for automated verification on a Hyprland desktop WITHOUT
# disturbing the user's screens or speakers:
#   * a virtual 1920x1080 output "FPSRANGE" (hyprctl output create headless)
#   * a runtime window rule sending class "fpsrange-capture" there, unfocused
#   * a PipeWire null sink "fpsrange_capture" whose monitor is the loopback tap
# Nothing here is persistent; `tools/capture/env.sh teardown` removes all of it.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export HYPRLAND_INSTANCE_SIGNATURE=${HYPRLAND_INSTANCE_SIGNATURE:-$(ls "$XDG_RUNTIME_DIR/hypr/" 2>/dev/null | head -1)}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-1}
FPSR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
export FPSR_ROOT
export GODOT="$FPSR_ROOT/tools/vendor/godot/Godot_v4.7.2-stable_linux.x86_64"
export WFREC="$FPSR_ROOT/tools/vendor/wf-src/build/wf-recorder"
export PY="$FPSR_ROOT/tools/vendor/pyenv/bin/python"
export CAP_SINK=fpsrange_capture

cap_setup() {
  if ! hyprctl monitors | grep -q 'Monitor FPSRANGE'; then
    hyprctl output create headless FPSRANGE >/dev/null
    sleep 0.4
  fi
  hyprctl eval 'hl.monitor({ output = "FPSRANGE", mode = "1920x1080@60", position = "5760x0", scale = 1 })' >/dev/null
  local ws; ws=$(hyprctl monitors | grep -A8 'Monitor FPSRANGE' | grep 'active workspace' | sed -E 's/.*workspace: ([^ ]+).*/\1/')
  hyprctl eval "hl.window_rule({ name = 'fpsrange-capture-ws', match = { class = '^(fpsrange-capture)\$' }, workspace = '$ws silent', no_initial_focus = true })" >/dev/null
  # any Godot project whose application/config/name starts with "fpsr-" floats at 1920x1080 on the virtual output
  hyprctl eval "hl.window_rule({ name = 'fpsr-float', match = { class = '^(fpsr-.*)\$' }, workspace = '$ws silent', no_initial_focus = true, float = true, size = '1920 1080', move = '5760 0' })" >/dev/null
  if ! pactl list short sinks | grep -q "$CAP_SINK"; then
    pactl load-module module-null-sink sink_name=$CAP_SINK sink_properties=device.description=FPSRangeCapture rate=48000 channels=2 >/dev/null
  fi
}
# make the capture window fullscreen on the virtual output (no focus change)
cap_fullscreen() {
  hyprctl eval 'local w; for _,x in ipairs(hl.get_windows()) do if x.class=="fpsrange-capture" then w=x end end; if w then hl.dispatch(hl.dsp.window.fullscreen({ window = w, mode = "fullscreen", action = "set" })) end' >/dev/null
}
cap_teardown() {
  hyprctl output remove FPSRANGE >/dev/null 2>&1
  for m in $(pactl list short modules | grep "sink_name=$CAP_SINK" | cut -f1); do pactl unload-module "$m"; done
}
case "${1:-}" in
  setup) cap_setup ;;
  teardown) cap_teardown ;;
esac
