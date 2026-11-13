# Architecture and module contracts

Engine: Godot 4.7.2, Forward+ (Vulkan), Jolt physics at 120 Hz, GDScript. Project in `game/`.
Axes: +Y up, −Z downrange, firing line z = 0, metres. Range dimensions: `game/scripts/range/layout.gd` (`RangeLayout`).
Physics layers (1-based): 1 world (static), 2 player, 3 target (hittable dynamic things), 4 debris (casings, fragments).
Bullets ray-cast against layers 1 + 3 only.

## Ownership

| Area | Files | Owner |
|---|---|---|
| Project file, autoloads, main scene, player, weapon sim/view, projectiles, audio runtime, tests, capture tooling | `game/project.godot`, `game/scenes/main.tscn`, `game/scripts/{core,sim,player,weapon,audio}/**`, `game/tests/**`, `tools/capture/**` | lead |
| Static environment + lighting | `game/scenes/range_env.tscn`, `game/scripts/range/range_env.gd`, `game/assets/env/**` | environment |
| Targets, impact/muzzle/casing effects | `game/scenes/targets/**`, `game/scripts/targets/**`, `game/scripts/fx/**`, `game/scenes/fx/**`, `game/assets/targets/**`, `game/assets/fx/**` | targets/fx |
| HUD, menus, settings UI | `game/scenes/ui/**`, `game/scripts/ui/**`, `game/assets/ui/**` | ui |

Nobody but the lead edits `project.godot`, autoload scripts or `main.tscn`; ask for what you need in your final report.

## Autoloads (exist now)

* `Settings` (`scripts/core/settings.gd`): `get_value(key)`, `getf/getb/gets`, `set_value(key, value)`, `reset_all()`, `range_of(key)`, signal `changed(key)`; keys + defaults in `DEFAULTS`.
* `Controls` (`scripts/core/controls.gd`): action list `ACTIONS`, `label(action)`, `binding_text(action)`, `rebind(action, event)`, `reset_to_defaults()`, signal `bindings_changed`.
* `AudioDirector` (`scripts/audio/audio_director.gd`):
  * `play_world(group: String, position: Vector3, opts := {}) -> void` — positional one-shot from the sound group `group`
    (ids = keys of `game/assets/audio/manifest.json`, e.g. `impact_steel`, `impact_steel_small`, `impact_dirt`, `impact_paper`,
    `impact_cardboard`, `impact_wood`, `impact_concrete`, `impact_sheet_metal`, `impact_can`, `break_glass_bottle`, `break_ceramic`,
    `debris_glass`, `debris_ceramic`, `chain_rattle`, `metal_creak`, `casing_concrete_hit`, `casing_wood_hit`, `casing_dirt_hit`,
    `casing_concrete_seq`, …). A random non-repeating variant is chosen. The director adds the acoustic propagation delay
    (distance to listener / 343 m/s), distance attenuation, air absorption and occlusion itself — callers pass the moment and place
    of the physical event only. `opts`: `volume_db` (float, default 0), `pitch` (float, default 1; keep within 0.94–1.06 unless the
    physics justifies more, e.g. plate size), `delay` (extra seconds), `intensity` (0–1 scales level for soft contacts),
    `follow` (Node3D to track, for ringing plates that swing). Unknown groups are ignored with one warning.

## Bullet hits

`scripts/weapon/projectiles.gd` integrates each bullet (G1 drag + gravity, sub-stepped, continuous ray segments, so thin
targets cannot be tunnelled) and for every intersection builds a hit dictionary:

```
{ "position": Vector3, "normal": Vector3, "direction": Vector3 (unit travel direction), "speed": float (m/s),
  "mass": float (kg, 0.008035), "energy": float (J), "collider": Object, "shape": int, "surface": String,
  "tof": float (s since ignition), "origin": Vector3 (muzzle), "shot_index": int }
```

`surface` = the collider's meta `"surface"` (one of `RangeLayout.SURFACES` or a target-specific tag such as `paper`, `cardboard`,
`steel`, `glass`, `ceramic`, `can`), default `dirt`.

Dispatch: walking up from the collider, the first node that has `on_bullet_hit(hit: Dictionary) -> Dictionary` is called. Return:

```
{ "stop": bool,                 # true: the bullet ends here (default true)
  "speed_scale": float,         # remaining speed factor when it continues (default 1.0)
  "fx": bool }                  # true (default): also spawn the generic surface effect; false: handler did its own
```

If no handler exists the bullet stops (except surfaces `paper`, `cardboard` → continues unchanged; `plywood`, `sheet_metal`
→ continues at 0.85 / 0.93 speed and leaves a hole decal on both faces) and `FXWorld.spawn_world_impact(hit)` is called.

## FX module (targets/fx owner) — node `FXWorld`, scene `res://scenes/fx/fx_world.tscn`, group `fx_world`

* `spawn_world_impact(hit: Dictionary) -> void` — material-specific mark + debris + sound for static world surfaces
  (concrete, gravel, dirt, grass, wood, plywood, sheet_metal, steel, rubber, sandbag, block).
* `eject_casing(xform: Transform3D, linear_velocity: Vector3, angular_velocity: Vector3) -> void` — pooled rigid-body brass
  (mesh `res://assets/weapon/casing.gltf`, 9.9 mm × 19 mm, 4.1 g), bounce sounds by surface, bounded count/lifetime.
* `muzzle_event(muzzle_xform: Transform3D, ambient_luminance: float, shot_index: int) -> void` — flash + smoke for one shot
  (−Z of the transform is the bore direction). Must be visible on the very frame it is called.
* `clear() -> void` — remove all transient marks/casings/debris (session restart). `get_stats() -> Dictionary` (live counts).

## Targets module — node `Targets`, scene `res://scenes/targets/targets.tscn`, group `targets`

* `reset_all()`, `step_paper_distance(dir: int)`, `get_paper_targets() -> Array` (each: `distance_m`, `label`,
  `face_size_mm: Vector2`, `get_hits() -> Array[Dictionary]` with `pos_mm: Vector2` (x right, y up from centre), `score: int`,
  `get_face_texture() -> Texture2D`, `clear()`), `get_selected_paper_target()`, `get_stats() -> Dictionary`.
* signals `target_hit(info: Dictionary)` (`kind`, `distance_m`, optional `score`, `pos_mm`, `target`), `layout_changed`,
  `request_fade(text: String)` (ask the UI for the short fade while a stand is moved).

## UI module — scene `res://scenes/ui/ui.tscn` (root script `scripts/ui/ui_root.gd`), instanced by main

* `bind(game: Node)` — called once. `game` (main.gd) offers: `get_weapon_snapshot() -> Dictionary`
  (`chamber`, `mag`, `mag_in`, `hammer_cocked`, `safety`, `spares`, `total`, `shots`), `get_targets() -> Node`,
  `set_paused(p: bool)`, `is_paused() -> bool`, `restart_session()`, `reset_targets()`, `quit_game()`,
  `get_perf() -> Dictionary` (`fps`, `frame_ms`), signals `paused_changed(paused: bool)`, `notice(text: String)`,
  `session_restarted`.
* `show_loading(progress: float, text: String)`, `hide_loading()`, `toast(text: String, seconds := 2.5)`,
  `fade_notice(text: String, seconds := 0.6)`, `open_group_inspector()`, `is_blocking_input() -> bool`
  (true while a menu or the inspector has the mouse).
