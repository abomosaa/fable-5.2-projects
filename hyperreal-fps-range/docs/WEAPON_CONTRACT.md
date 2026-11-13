# Weapon asset / animation contract

Binding interface between the pistol asset (`game/assets/weapon/`), the first-person arms asset
(`game/assets/arms/`) and the game code. All values in metres / degrees / seconds.

## Spaces

**Weapon space** (Godot): −Z = muzzle direction, +Y = up, +X = shooter's right (so the pistol's
LEFT side — safety lever, slide stop, magazine button — is at −X). Origin = centre of the grip.
`game/assets/weapon/service_pistol.gltf` is authored in this space; `pistol_rig.json` next to it lists
sockets and pivots (already in this space):

| Name | Position (x, y, z) | Meaning |
|---|---|---|
| S_Muzzle | (0, 0.0608, −0.1738) | bore centre at the crown |
| S_SightFront | (0, 0.0777, −0.1618) | top-rear edge of the front blade (on the barrel) |
| S_SightRear | (0, 0.0785, +0.0081) | top-rear edge of the rear notch (on the slide) |
| S_Eject | (0, 0.0668, −0.047) | above the chamber, open-top slide |
| Hammer pivot | (0, 0.0494, +0.0290) | |
| Trigger pivot | (0, 0.0358, −0.0512) | |
| Safety pivot | (−0.0105, 0.0635, +0.0070) | lever on the slide's left side (child of Slide) |
| SlideStop | (−0.0114, 0.0423, −0.0437) | thumb pad, left side above the trigger |
| MagRelease | (−0.0095, 0.0105, −0.0232) | push button, left side behind the trigger guard |

Node tree of the pistol: `Pistol/{Frame, SlideStop, MagRelease, Barrel/{S_Muzzle,S_SightFront}, Slide/{Safety, S_SightRear},
Hammer, Trigger, ChamberRound, Mag/{MagBody, Round1..Round8}, S_Eject, S_Bore, S_MagWell}`.

## Mechanical part motion (driven by the simulation, NOT by animation clips)

| Part | Motion | Range |
|---|---|---|
| Slide | translate +Z (rearward) | 0 … 0.048 (locked open at 0.045) |
| Barrel | translate +Z with the slide | 0 … 0.0064 (first 6.4 mm of slide travel only) |
| Hammer | rotate about +X at its pivot | 0° = down, +50° = cocked |
| Trigger | rotate about +X at its pivot | 0° = double-action rest, −20° = single-action rest (hammer cocked), −28° = break, −30° = over-travel |
| Safety lever | rotate about +X at its pivot (child of Slide) | 0° = FIRE (as modelled, red F visible), −55° = SAFE (lever swung down; also drops the hammer) |
| SlideStop | translate +Y | 0 … +0.0015 (up = slide held open) |
| MagRelease | translate +X (into the frame) | 0 … 0.0015 |
| Mag (whole magazine) | driven by the arms rig's `mag` bone | inserted = identity; withdrawal direction (0, −0.976, +0.218) |

Magazine length along its axis is ≈ 0.107; it is clear of the grip after ≈ 0.11 of travel.

## Arms rig (`game/assets/arms/fp_arms.gltf`)

* **Rig space == weapon space of the pistol in the base grip.** i.e. with every animation at its base pose the
  `gun` bone is at the origin with identity rotation and the hands hold a pistol placed at identity.
* Bones (clean names, proper parent chain, deform bones only + props):
  `root` → `gun` → `mag`; `root` → `shoulder.R` → `upper_arm.R` → (`upper_arm_twist.R`) → `forearm.R` → (`forearm_twist.R`) → `hand.R`
  → palms / `thumb.01-03.R`, `index.01-03.R`, `middle.01-03.R`, `ring.01-03.R`, `pinky.01-03.R`; same for `.L`.
  `mag` rest pose = identity (magazine seated). Right hand = firing hand, left = support hand.
* In Godot the pistol scene is attached to the `gun` bone and the `Mag` node to the `mag` bone.
* The game moves the whole rig relative to the camera (hip ↔ sights, sway, recoil, obstruction) — clips never contain that.
  For reference the eye is at about (+0.0, +0.0785, +0.41) in rig space when aiming down the sights
  and at about (−0.11, +0.20, +0.47) at the hip/ready position (gun right-of-centre and below the eye line).

## Animation clips (all start and end in the base grip unless noted)

| Clip | Content |
|---|---|
| `pose_grip` | 1 frame. Two-handed thumbs-forward grip, firing-hand index finger straight along the frame above the trigger guard (register position). |
| `pose_trigger_touch` | 1 frame. As above but index fingertip pad on the trigger face, trigger at 0° (DA rest). |
| `pose_trigger_sa` | 1 frame. Index on the trigger at −20° (SA rest). |
| `pose_trigger_break` | 1 frame. Index holding the trigger at −28°. |
| `reload` | Magazine change with a round still chambered / slide forward. |
| `reload_empty` | Same, slide locked open: after seating the magazine the support-hand thumb presses the slide stop down as that hand returns to the grip (the firing thumb cannot reach the lever on this model without breaking the grip). |
| `inspect` | Shows the left side, then the right side, then tilts to look at the open top / chamber area; returns to base. |
| `safety_on` / `safety_off` | Firing-hand thumb sweeps the slide-mounted lever down (0 → −55°) / up. |
| `hammer_cock` | Support-hand thumb draws the hammer back (0 → +50°). |

`game/assets/arms/anim_events.json`: `{ "<clip>": { "duration": s, "events": { "<name>": t, … } } }` with at least
`reload*`: `left_hand_leaves`, `mag_release_press`, `mag_out_start`, `mag_clear`, `mag_swap` (magazine fully off-screen —
the game swaps its contents here), `mag_in_start`, `mag_seated`, `regrip_done`; `reload_empty` additionally
`slide_stop_press`; `safety_*`: `lever_start`, `lever_end`; `hammer_cock`: `hammer_start`, `hammer_end`;
`inspect`: `left_view`, `right_view`, `top_view`.
