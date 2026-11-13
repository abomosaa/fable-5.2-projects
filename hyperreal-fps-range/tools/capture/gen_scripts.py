#!/usr/bin/env python3
"""Generates the scripted verification sessions (tools/capture/scripts/v_*.json, bench_fire.json, endurance.json)."""
import json, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts')
def W(name, steps):
    json.dump(steps, open(os.path.join(OUT, name), 'w'), indent=0)
    print(name, len(steps), 'steps')
def s(wait, do, **kw):
    d = {"wait": wait, "do": do}; d.update(kw); return d
def tap(wait, action, hold=0.06): return s(wait, "tap", action=action, hold=hold)
def shots(n, split, first_hold=0.06):
    return [tap(split if i else 0.3, "fire", first_hold if i == 0 else 0.05) for i in range(n)]

# ---------------------------------------------------------------- main recorded session
m = [s(2.0, "state", tag="launch"), s(0.1, "settings_dump", tag="launch"),
     s(0.5, "screenshot", name="01_spawn_ready"),
     s(0.3, "look", yaw=-25, pitch=-8, dur=0.7), s(0.4, "look", yaw=50, pitch=5, dur=0.9), s(0.4, "look", yaw=-25, pitch=3, dur=0.7),
     s(0.4, "press", action="aim"), s(0.5, "aim_node", path="Paper2/Paper", dur=0.5), s(0.6, "screenshot", name="02_sights_on_paper_10m"),
     tap(0.3, "fire", 0.3),                                   # double-action first shot
     tap(1.4, "fire"), tap(1.2, "fire"), s(1.0, "screenshot", name="03_paper_3_holes"),
     s(0.2, "aim_node", path="Gong0/Plate", dur=0.45)] + shots(4, 0.32) + [                # sustained string on steel
     s(0.9, "screenshot", name="04_gong_swinging"),
     s(0.3, "aim_node", path="Gong1/Plate", dur=0.4), tap(0.4, "fire"), tap(0.9, "fire"),  # 9 rounds gone: slide locks
     s(0.7, "screenshot", name="05_slide_locked_empty"), s(0.1, "state", tag="empty"),
     tap(0.3, "fire"), s(0.4, "release", action="aim"),                                    # dead trigger
     tap(0.4, "reload"), s(1.2, "screenshot", name="06_reload_mag_out"), s(1.3, "screenshot", name="07_reload_mag_in"),
     s(1.9, "state", tag="reloaded_empty"),
     tap(0.2, "inspect"), s(1.1, "screenshot", name="08_inspect_left"), s(1.3, "screenshot", name="09_inspect_right"), s(1.1, "screenshot", name="10_inspect_top"),
     s(1.4, "tap", action="safety", hold=0.06), s(0.7, "screenshot", name="11_safety_on"), s(0.1, "state", tag="safe"),
     tap(0.3, "fire", 0.25), s(0.5, "tap", action="safety", hold=0.06), s(0.7, "state", tag="safety_off_hammer_down"),
     tap(0.2, "cock_hammer"), s(0.7, "state", tag="hammer_cocked"),
     # walk out of the bay to the open pad, firing once on the way
     s(0.3, "goto", x=-1.6, z=1.5, tol=0.15), s(0.1, "look", yaw=-90, dur=0.5), s(0.1, "goto", x=1.2, z=1.5, tol=0.2),
     s(0.1, "look", yaw=90, dur=0.5), s(0.2, "press", action="aim"), s(0.5, "aim_at", x=1.3, y=0.4, z=-30.0, dur=0.3), tap(0.3, "fire"), s(0.3, "state", tag="shot_at_bay_edge"),
     s(0.8, "release", action="aim"), s(0.1, "look", yaw=-90, pitch=0, dur=0.4), s(0.1, "goto", x=3.6, z=1.2, tol=0.2),
     s(0.1, "look", yaw=90, dur=0.4), s(0.2, "press", action="aim"), s(0.5, "aim_at", x=3.6, y=0.4, z=-30.0, dur=0.3), tap(0.3, "fire"), s(0.3, "state", tag="shot_between"),
     s(0.8, "release", action="aim"), s(0.1, "look", yaw=-90, dur=0.4), s(0.1, "goto", x=6.4, z=0.75, tol=0.15), s(0.1, "look", yaw=90, dur=0.5),
     s(0.5, "screenshot", name="12_pad_ready"),
     s(0.2, "press", action="aim"), s(0.5, "aim_node", path="Paper4/Paper", dur=0.5), s(0.5, "screenshot", name="13_pad_sights_paper"),
     tap(0.3, "fire"), tap(1.5, "fire"), tap(1.5, "fire"),
     s(1.2, "aim_node", path="Gong2/Plate", dur=0.5), tap(0.6, "fire"), s(0.35, "screenshot", name="14_gong_25m_hit"),
     tap(1.2, "fire"),
     s(1.0, "release", action="aim"), tap(0.3, "reload"), s(4.2, "state", tag="reloaded_tactical"),
     s(0.1, "press", action="aim"), s(0.5, "aim_node", path="Gong3/Plate", dur=0.6), s(0.3, "press", action="steady"), tap(0.8, "fire"), tap(1.6, "fire"), s(0.3, "release", action="steady"),
     s(1.0, "aim_node", path="Breakables/bottle_wine_10", oy=0.12, dur=0.5), tap(0.5, "fire"), s(0.12, "screenshot", name="15_bottle_breaking"),
     s(0.8, "aim_node", path="Breakables/clay_8", dur=0.35), tap(0.4, "fire"),
     s(0.8, "aim_node", path="Breakables/can_c_2", oy=0.05, dur=0.35), tap(0.4, "fire"), s(0.5, "screenshot", name="16_can_hit"),
     s(0.6, "aim_node", path="Breakables/clay_9", dur=0.35), tap(0.4, "fire"),
     s(1.0, "release", action="aim"), s(0.5, "screenshot", name="17_pad_after"), s(0.2, "state", tag="end"),
     s(0.5, "quit")]
W('v_main.json', m)

# ---------------------------------------------------------------- edge cases
e = [s(2.0, "state", tag="start"),
     # --- obstruction: walk into the left block wall of lane 1, into a divider, and up to the bench while crouched
     s(0.1, "teleport", x=-5.2, z=1.2, yaw=90), s(0.6, "screenshot", name="e01_near_block_wall_before"), s(0.1, "goto", x=-6.5, z=1.2, tol=0.05, timeout=3.0),
     s(0.5, "state", tag="at_block_wall"), s(0.1, "screenshot", name="e02_at_block_wall"),
     s(0.1, "press", action="aim"), s(0.6, "state", tag="at_block_wall_aiming"), s(0.1, "screenshot", name="e03_at_block_wall_aim"), tap(0.2, "fire", 0.3), s(0.6, "release", action="aim"),
     s(0.2, "teleport", x=-1.6, z=0.2, yaw=-90), s(0.3, "goto", x=-0.3, z=0.2, tol=0.05, timeout=2.5), s(0.5, "state", tag="at_divider"), s(0.1, "screenshot", name="e04_at_divider"),
     s(0.2, "teleport", x=-1.6, z=0.9, yaw=0), tap(0.3, "crouch"), s(0.6, "goto", x=-1.6, z=-0.5, tol=0.05, timeout=3.0), s(0.5, "state", tag="crouched_at_bench"), s(0.1, "screenshot", name="e05_crouched_at_bench"),
     tap(0.2, "crouch"), s(0.6, "teleport", x=-1.6, z=0.55, yaw=0),
     # --- interrupted actions
     s(0.5, "press", action="aim"), s(0.5, "aim_node", path="Paper2/Paper", dur=0.3), tap(0.3, "fire", 0.3), tap(0.8, "fire"), s(0.6, "release", action="aim"),
     s(0.3, "state", tag="before_cancel"), tap(0.1, "reload"), tap(0.25, "reload"), s(0.4, "state", tag="reload_cancelled_by_second_press"),
     tap(0.2, "reload"), tap(0.2, "fire"), s(0.5, "state", tag="reload_cancelled_by_fire"),
     tap(0.3, "reload")] + [tap(0.12, "reload") for _ in range(20)] + [tap(0.05, "fire") for _ in range(6)] + [
     tap(0.1, "crouch"), s(0.2, "press", action="aim"), s(0.4, "release", action="aim"), tap(0.2, "crouch"),
     s(2.2, "state", tag="after_reload_spam"),
     tap(0.2, "inspect"), s(0.8, "press", action="aim"), s(0.5, "state", tag="inspect_interrupted_by_aim"), s(0.2, "release", action="aim"),
     tap(0.3, "inspect"), tap(0.7, "reload"), s(4.5, "state", tag="inspect_then_reload"),
     # --- pause in the middle of a double-action stroke and of a reload
     tap(0.2, "safety"), s(0.7, "tap", action="safety", hold=0.06), s(0.7, "state", tag="hammer_down"),
     s(0.2, "press", action="fire"), s(0.05, "pause", on=True), s(1.0, "state", tag="paused_mid_da"), s(0.2, "screenshot", name="e06_pause_menu"),
     s(0.3, "pause", on=False), s(0.8, "state", tag="resumed_after_pause_mid_da"), s(0.1, "release", action="fire"),
     s(0.3, "press", action="fire"), s(0.04, "focus_out"), s(1.0, "state", tag="focus_lost_mid_da"), s(0.2, "pause", on=False), s(0.6, "state", tag="after_focus_return"), s(0.1, "release", action="fire"),
     tap(0.4, "fire", 0.3), s(0.6, "state", tag="fires_normally_again"),
     tap(0.3, "reload"), s(1.2, "focus_out"), s(1.0, "state", tag="focus_lost_mid_reload"), s(0.2, "pause", on=False), s(3.5, "state", tag="reload_completed_after_focus"),
     # --- thin target edges: just inside / outside the paper edge of the 10 m stand (paper is 533 mm wide: half = 266.5)
     s(0.2, "press", action="aim"), s(0.5, "aim_node", path="Paper2/Paper", ox=0.255, dur=0.4), tap(0.4, "fire"),
     s(0.9, "aim_node", path="Paper2/Paper", ox=0.280, dur=0.3), tap(0.4, "fire"), s(0.6, "release", action="aim"), s(0.2, "state", tag="edge_shots"),
     # --- target distance, reset, restart
     s(0.2, "key", keycode=93), s(0.02, "key", keycode=93, down=False), s(1.5, "state", tag="target_farther"), s(0.1, "screenshot", name="e07_stand_at_15m"),
     s(0.2, "press", action="aim"), s(0.5, "aim_node", path="Paper2/Paper", dur=0.4), tap(0.4, "fire"), s(0.8, "release", action="aim"), s(0.2, "state", tag="hit_at_15m"),
     tap(0.2, "inspect_group"), s(1.0, "screenshot", name="e08_group_inspector"), tap(0.2, "pause"), s(0.5, "pause", on=False),
     tap(0.5, "reset_targets"), s(1.0, "state", tag="after_reset"), s(0.1, "screenshot", name="e09_after_reset"),
     s(0.2, "restart"), s(1.5, "state", tag="after_restart"), s(0.1, "screenshot", name="e10_after_restart"),
     # --- remap: reload on T-free key (H = 72), fire it through the raw key path
     s(0.2, "press", action="aim"), s(0.5, "aim_node", path="Paper2/Paper", dur=0.3), tap(0.3, "fire", 0.3), tap(0.6, "fire"), s(0.5, "release", action="aim"),
     s(0.2, "rebind_key", action="reload", keycode=72), s(0.2, "key", keycode=72), s(0.05, "key", keycode=72, down=False), s(1.0, "state", tag="reload_via_rebound_key"),
     s(3.5, "set", key="fov", value=80.0, persist=True), s(0.1, "set", key="master_volume", value=0.5, persist=True), s(0.1, "set", key="dynamic_range", value="headphones", persist=True),
     s(0.3, "settings_dump", tag="before_quit"), s(0.3, "quit")]
W('v_edge.json', e)
W('v_persist_check.json', [s(2.0, "settings_dump", tag="after_relaunch"), s(0.2, "state", tag="relaunch"), s(0.3, "quit")])

# ---------------------------------------------------------------- frame-time around firing
b = [s(2.5, "press", action="aim"), s(0.5, "aim_node", path="Gong0/Plate", dur=0.4), s(1.0, "bench_begin", tag="first_magazine_from_cold")]
b += [tap(0.5, "fire", 0.2)] + [tap(0.4, "fire") for _ in range(8)] + [s(1.0, "bench_end"), s(0.2, "release", action="aim"), tap(0.2, "reload"), s(4.3, "press", action="aim"),
      s(0.5, "aim_node", path="Paper2/Paper", dur=0.4), s(0.5, "bench_begin", tag="rapid_string")] + [tap(0.22, "fire") for _ in range(8)] + [s(1.5, "bench_end"),
      s(0.2, "release", action="aim"), s(0.5, "bench_begin", tag="idle_spawn"), s(5.0, "bench_end"), s(0.2, "quit")]
W('bench_fire.json', b)

# ---------------------------------------------------------------- endurance (about 9 minutes)
en = [s(2.5, "state", tag="t0"), s(0.1, "bench_begin", tag="endurance")]
targets = ["Gong0/Plate", "Paper2/Paper", "Gong1/Plate", "Paper1/Paper", "Paper0/Paper"]
for cyc in range(22):
    en += [s(0.2, "press", action="aim")]
    for i in range(9):
        t = targets[(cyc + i) % len(targets)]
        if i % 3 == 0:
            en += [s(0.25, "aim_node", path=t, dur=0.3)]
        en += [tap(0.35 if i % 3 else 0.25, "fire", 0.22 if i == 0 else 0.05)]
    en += [s(0.6, "release", action="aim"), tap(0.2, "reload"), s(4.3, "state", tag="cycle_%02d" % cyc)]
    if cyc % 3 == 2:
        # shoot some breakables from lane 1, then reset or restart
        en += [s(0.1, "teleport", x=-4.8, z=0.55, yaw=0), s(0.3, "press", action="aim")]
        for n in ["Breakables/bottle_wine_5", "Breakables/clay_3", "Breakables/pot_4", "Breakables/can_b_1", "Breakables/bottle_beer_1"]:
            en += [s(0.3, "aim_node", path=n, oy=0.08, dur=0.3), tap(0.3, "fire")]
        en += [s(0.8, "release", action="aim"), s(0.3, "teleport", x=-1.6, z=0.55, yaw=0)]
        en += [s(0.5, "restart")] if cyc % 6 == 5 else [tap(0.5, "reset_targets"), tap(0.3, "reload"), s(4.3, "wait")]
en += [s(1.0, "bench_end"), s(0.2, "state", tag="t_end"), s(0.3, "quit")]
W('endurance.json', en)
