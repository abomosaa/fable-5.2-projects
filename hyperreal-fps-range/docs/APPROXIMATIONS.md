# Documented approximations

What the simulation models, what it simplifies, and where a value is an estimate rather than a measurement.
References and their evidence tags are in `docs/REFERENCES.md`; parameters live in
`game/scripts/sim/weapon_def.gd`. This is entertainment software — not firearms instruction and not a
reproduction of the physical impulse or sound pressure of a real firearm.

## The firearm

* **Identity.** The pistol is the Poly Haven "Service Pistol" (CC0): a Walther P38 / P1-pattern 9×19 mm pistol,
  not a replica of one. Visible differences from a historical P38: a push-button magazine catch on the left behind
  the trigger guard instead of the heel catch, smooth wooden grip panels with a screw instead of ribbed
  bakelite, three red dots on the sights, a light parkerised/nickel-grey slide. The simulation follows *the model
  that is on screen*: button release, magazine withdrawn by the support hand. Everything else follows the P38/P1 design:
  double-action first shot, single-action follow-up shots, slide-mounted safety that also drops the hammer,
  exposed hammer, slide stop that locks the slide open on an empty magazine, 8-round single-stack magazine,
  open-top slide with the front sight on the barrel, ejection up and to the left.
* **Not modelled:** the loaded-chamber indicator pin (no separate mesh in the asset), a magazine follower (the
  asset has none: an empty magazine shows an empty feed opening), the locking block and recoil springs (hidden),
  stoppages and wear (deliberately: no random failures), manual slide racking / press checks (the state they
  would be needed for cannot be reached in normal play), and the cartridge travelling from magazine to chamber
  during feeding (it happens inside 15 ms under the slide).
* **Timing.** No instrumented P38 cycle data was found. Lock time 5 ms, slide rearward in 16 ms, full cycle
  55 ms, ejection at 11 ms and feed at 40 ms after ignition are estimates by analogy with published Glock 17 and
  1911 high-speed analyses. The double-action stroke is a fixed 110 ms; releasing the trigger earlier aborts it.
  Reload timing comes from the hand animation (≈3.5–4 s), consistent with unhurried range reloads.
* **Angles and travel.** Slide stroke 48 mm, barrel travel 6.4 mm, hammer arc 50°, trigger angles and the safety
  lever's 55° sweep are fitted to the 3-D model, not taken from drawings.
* **Safety lever.** Applying it decocks at 70 % of the lever travel. Cocking the hammer with the safety applied
  is refused (on the real pistol the hammer would simply not stay back).
* **Trigger with the slide locked or the safety on:** modelled as a dead trigger (it moves, nothing happens).
* **Magazines.** Six per session (one in the gun). Magazines keep their individual round counts; a reload takes
  the fullest spare. There is no loose-ammunition handling: restarting the session restocks.

## Sights, ballistics, dispersion

* **Sight picture is geometry, not an overlay.** In the aimed position the rig is rotated and translated so that
  the line through the rear notch and the front blade (taken from the model) passes through the eye point, 0.41 m
  behind the rear sight. The view zooms modestly while aiming (default ×0.76 of the 62° vertical FOV, adjustable; 1.0 = none): a
  presentation aid, since a monitor cannot reproduce the eye's acuity at true scale.
* **Zero.** The bullet leaves from the modelled muzzle. Its departure line is defined relative to the *sight
  line* (raised by the 25 m zero angle, 1.7 mrad) rather than the mesh's bore axis: on the asset the front blade
  is ~0.8 mm lower than a 25 m zero needs, which would otherwise put shots ≈7 cm high at 25 m. The angular
  difference between drawn bore and departure line is 3 mrad — not visible.
* **Trajectory.** Point mass, G1 drag (BC 0.154, fitted), gravity, ICAO sea-level air, no wind, no spin drift.
  Muzzle velocity 346 m/s (mean of published P38 chronograph results) with 3.5 m/s standard deviation.
  Bullets are stepped at ≤ 0.6 m per ray segment; time of flight is real (≈74 ms to 25 m, ≈152 ms to 50 m).
* **Dispersion.** Gaussian, 0.55 mrad per axis (ammunition + pistol, from published 25-yard groups). Everything
  else that moves a shot comes from the simulated hold: wobble, trigger disturbance (larger in double action),
  recoil not yet recovered. Nothing adds spread "for feel".
* **Terminal effects.** Bullets stop in earth, concrete, block, steel and timber posts; they pass through paper
  and cardboard (≈ no loss), 18 mm plywood (−15 % speed), corrugated sheet (−7 %), glass and clay (−3…8 %).
  No ricochets and no fragments that can hit something else. Steel splash is visual only.

## Handling, recoil, camera

* **Recoil** is a set of damped springs (pitch, yaw, roll, rearward push, lift) excited by one impulse per shot,
  rotating the gun and hands about the wrists. Peak muzzle rise ≈4.2° at ≈55 ms is an estimate for a firm
  two-handed grip (free-recoil figures in the references are higher). Grip stiffness and damping vary ±15–20 %
  from shot to shot; the main rise is over within ≈0.15–0.2 s. 16 % of the muzzle rise reaches the view direction
  and returns; the player's aim point is never moved permanently.
* **Recoil recovery.** The hold does not come back to where it was. Each shot adds a return error drawn from an
  invented distribution (0.3° low to 0.7° high — mostly high — and up to 0.5° to either side; not measured from
  any shooter), applied as a rotation of the whole hold about the eye. After a reaction time of 0.16–0.26 s, during
  which it drifts, the simulated shooter steers it out as a damped movement (natural frequency 10–15 rad/s,
  damping 0.55–0.9, so it may overshoot slightly). Separately the gun sits up to ≈0.5° off in the hands (front
  post off-centre in the notch) and settles with a 0.12–0.22 s time constant. Measured in 1080p recordings of
  aimed shots: sights 4–14 px off at 0.2 s, ≈2 px by 0.4 s. A shot fired before the correction goes where the
  sights point, so fast strings open up; errors accumulate in a string up to 1.3°. A mouse and a monitor cannot
  convey recoil force; the model aims only at the visual timing, and nobody has judged whether a player can work
  with it by hand.
* **Hold wobble** is a sum of slow sinusoids about the eye point (≈2 mrad aimed, more at the hip, when moving, and
  just after a shot; less when crouched or holding breath for up to 6 s). It is not a recording of a real hold.
* **Arms** are a rigid first-person rig (shoulders move with the gun). Hands were posed and animated for this
  pistol by script, without motion capture and without anyone seeing them move: contact between gloves and
  pistol is approximate (see `evidence/arms/NOTES.md` and the reviews for the visible defects).
* **Body.** A static first-person body (jacket front, belt, trousers, boots; modelled by script, no skeleton) is
  attached to the player: legs swing as rigid pieces with the stride (no knee) and are compressed when crouching.
  The trousers reuse the jacket's cloth textures, tinted darker, so the fold pattern does not follow the leg.
  Head and shoulders exist only as shadow casters. The arms are a separate camera-fixed rig that does not join
  the torso.
* **Contact shade under the shooter** is three soft dark decals (one per boot, one under the body), faint in sun
  and stronger under the roof — a stand-in for ambient occlusion, not computed from geometry.
* **Hands under the roof.** Looking from the shaded bay into the sunlit range, the exposure follows the range and
  hands and pistol would fall to near-black (camera behaviour; an eye adapts locally). A weak shadowless light
  that affects only arms, pistol and body is switched in under cover in proportion to how far the view points
  out into the sun. It is a perceptual compensation: no such light exists on the range.
* **Trigger finger** follows the simulated trigger angle by blending authored finger poses.
* **Near surfaces.** When something is within reach of the muzzle the gun is drawn back and tipped up (a
  compressed high-ready) instead of clipping through; shots fired in that position go where the muzzle points.
* **Movement.** Walk 1.55 m/s, jog 3.3 m/s, crouch 0.85 m/s with ~9 m/s² acceleration. No jumping, climbing or
  leaning. Head bob is ≈2.4 cm vertical / 1.2 cm lateral at a walk (no view rotation) and the gun dips and rocks slightly per
  footfall; both scale to zero with the camera-motion and weapon-sway settings.
* **Motion blur** is not rendered at all; the setting exists so the choice is explicit.

## Sound

* **Sources.** The shot is a real Walther P38 recorded outdoors from 2 m behind the shooter (Pole Position
  Production, via the Sonniss GDC bundle; six takes, each hard-clipped at source for 0.6–0.8 ms at the very first
  peak — used as they are because no other P38 firing recording could be licensed; a quiet close-microphone layer
  from a SIG P229 at 1 m is mixed under it). It is the only P38 firing perspective that could be licensed without
  cost, so the "shooter's ears" perspective is *constructed*: the first 45 ms of each take (the dry crack) and its
  natural tail are separated, and the surroundings are added from the range geometry. Mechanical sounds come
  from the Free Firearm Sound Library (CC0): mainly a Bersa (DA/SA with decocker, the closest mechanism) and a
  steel 1911, plus one Sonniss P38 magazine recording. They are real but not from a P38.
* **Ambience** (high-passed at 90 Hz to remove wind rumble) sits ≈52 dB below the shot peak (measured −64 dBFS
  RMS between shots against −11 dBFS peaks). Its bus gain is dropped by 9 dB at each of the player's shots and
  ramps back over 1.5 s — a mixing decision, not physics. In the summed output that shows only as the bay level
  sitting 1–4 dB under the quiet bed around 0.5–1 s after a shot; it is not separately measurable.
* **Stereo image of the shot.** The dry onset is a mono (mid) signal for the reflection renderer; the tail is
  rebuilt at load as *full recording − onset* so that onset + tail reproduce the stereo take.
* **Level.** Real muzzle blast is ≈160 dB peak; the simulation plays at ordinary listening levels, starts at a
  conservative master level, keeps peaks below −1 dBFS with a limiter that normally does not engage, and offers
  compressed "Headphones" and "Night" dynamic-range modes. Relative levels (shot ≫ steel ≫ mechanism ≫ brass ≫
  footsteps) are compressed compared with reality so quiet events remain audible.
* **Early reflections** are computed with the image-source method (first and second order) off the slab, pad,
  roof, back wall, block wall and lane dividers defined in `RangeLayout`, with per-material reflection factors and
  low-pass corners (estimates), mild blast directivity, and reference distance 1 m. They are rendered at sample
  accuracy into a stereo buffer per shooter position (0.25 m / 12° grid) on a worker thread. Binaural mode uses a
  spherical-head model (interaural delay up to 0.66 ms, level difference and far-ear shadow filter) — not a
  measured HRTF. Benches, posts, the shooter's own body and diffraction are ignored.
* **Late bay reverberation** is the dry crack convolved with a synthetic decaying-noise impulse response
  (band RT60 0.55 s at 125 Hz falling to 0.18 s at 8 kHz — estimates for a hard, partly open shed; no measured
  response of such a firing line was found). Its level follows a continuous enclosure factor (1 under the roof,
  fading over 6 m outside it); there is no reverb zone switch.
* **Berm echoes**: one diffuse return each from the backstop and both side berms, timed by the real path length
  from the shooter's position (≈0.33 s for the backstop from the firing line, sooner when standing downrange),
  played from the berm's direction using a real distant-perspective 9 mm recording, low-passed.
* **World sounds** (impacts, steel, brass, breakage) start after the true propagation delay (distance / 343 m/s)
  on top of the bullet's time of flight, with distance attenuation, three-ray occlusion against static geometry
  and Steam Audio HRTF (or stereo panning). Levels follow an inverse-distance law per sound group, except ringing
  steel, which falls off at 0.75 of that rate so a 50 m plate stays audible at the compressed playback level.
  Sounds start on the first rendered frame after their arrival time (measured 3–24 ms late, never early).
  Steel pitch is shifted slightly by plate size; ring decay is whatever the recordings contain. **There is no real
  bullet-on-steel recording in the game** (every licence-clean one found was clipped or masked by the shot):
  the steel sounds are hammer-struck plates and a small bell-like metal target.
* **No supersonic crack** is played: the load is transonic at the muzzle and the shooter does not hear a fly-by.
* **Nobody listened.** The agents that built and reviewed this cannot hear. Audio was verified by loopback
  capture and signal analysis (levels, clipping, onset timing, decay, spectra, inter-aural differences), not by
  ear. See `docs/VERIFICATION.md`.

## Targets and physics

* Steel plates are rigid bodies on constraints; a hit applies the bullet's momentum (fully inelastic) at the
  contact point. Chain links are simplified; plate ring is a recording, not modal synthesis.
* Paper holes are drawn at the computed hit position in the target's texture; tearing is stylised.
* Breakables use pre-fractured pieces released by the hit, not a fracture simulation.
* Moving a target stand to another distance is abstracted: the screen goes to black for about 0.4 s with a
  caption ("Target stand moved to 15 m") and the stand is at the new line when it returns. Nobody walks downrange.
* Casings are rigid bodies with rate-limited contact sounds; they do not interact with the player or targets.

## Rendering

* Real-time rasterisation (Godot Forward+): shadow maps, screen-space effects and probe/voxel-based indirect
  light, not path tracing. Details of the lighting solution and its known artefacts: `evidence/env/NOTES.md`.
* **Covered-bay light at Low–High** is a stand-in, not a simulation: inside the bay the sky ambient is replaced
  by a low constant warm ambient, and five shadowless fill lights lying on the sunlit ground just outside the
  slab imitate the light bounced into the bay (brighter low at the open front, falling off toward the back wall
  and the roof's rear). Nothing is occluded by benches or dividers except by screen-space AO; allowing the AO to
  darken direct and fill light as well (30 % of its strength) made no difference the reviewer could see at bench
  legs and posts. Ultra uses voxel GI
  instead and does not hold 60 fps on the test GPU.
* The distant landscape is a photograph (HDRI) with no parallax; near vegetation is card/low-poly geometry.
* Impact marks, paper holes and lead splash are drawn stamps placed at the true hit point, not geometry.
* Muzzle flash intensity follows a two-level estimate of ambient light (open sun / shade under a roof).
* The muzzle has no modelled bore (flat face with a normal-mapped crown); it is never shown from the front.
