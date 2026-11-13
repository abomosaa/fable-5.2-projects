#!/usr/bin/env bash
# Verifies that every essential asset is present (fails loudly instead of letting the game fall back to stand-ins).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; G="$ROOT/game"; rc=0
need() { [ -e "$G/$1" ] || { echo "MISSING: game/$1"; rc=1; }; }
need assets/weapon/service_pistol.gltf; need assets/weapon/service_pistol.bin; need assets/weapon/casing.gltf
need assets/weapon/textures/service_pistol_diff_4k.jpg; need assets/weapon/textures/service_pistol_nor_gl_4k.jpg; need assets/weapon/textures/service_pistol_arm_4k.jpg
need assets/arms/fp_arms.gltf; need assets/arms/anim_events.json
need assets/audio/manifest.json
need scenes/range_env.tscn; need scenes/targets/targets.tscn; need scenes/fx/fx_world.tscn; need scenes/ui/ui.tscn
need addons/godot-steam-audio/bin/libphonon.so
if [ -f "$G/assets/audio/manifest.json" ]; then
  python3 - "$G" <<'PY' || rc=1
import json, os, sys
g = sys.argv[1]; m = json.load(open(os.path.join(g, 'assets/audio/manifest.json'))); missing = 0; n = 0
for grp, v in m['groups'].items():
    for f in v['files']:
        n += 1
        if not os.path.exists(os.path.join(g, 'assets/audio', f['file'])):
            print('MISSING audio:', f['file']); missing += 1
ess = ['shot_p38_onset', 'shot_p38_tail', 'shot_bay_late', 'shot_distant_100m', 'mech_hammer_fall', 'mech_slide_release', 'mech_mag_in', 'mech_mag_out',
       'casing_concrete', 'impact_steel', 'impact_dirt', 'impact_paper', 'break_glass_bottle', 'break_ceramic', 'step_concrete', 'step_gravel', 'amb_field_day']
for e in ess:
    if e not in m['groups'] or not m['groups'][e]['files']:
        print('MISSING essential sound group:', e); missing += 1
print('audio: %d files in %d groups, %d missing' % (n, len(m['groups']), missing))
sys.exit(1 if missing else 0)
PY
fi
[ $rc = 0 ] && echo "assets OK" || echo "assets INCOMPLETE"
exit $rc
