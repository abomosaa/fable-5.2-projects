# Known issues

What still looks, sounds or behaves wrong, collected from the independent reviews (`reviews/round1…5/REVIEW.md`,
index in `reviews/SUMMARY.md`) and from the developers' own captures. The reviewer's scores range from 5.5 to 7.5
out of 10 per category (7 = contemporary high-fidelity commercial FPS): this is a careful, measured simulation
with real assets, **not** a photoreal one.

Nobody has listened to the audio or played with their own hands; see `docs/VERIFICATION.md`.

## Looks

* **Hands.** The gloves, sleeves and poses were built by script without motion capture. The firing grip covers
  the backstrap from both eye positions (ray-checked: no grip surface visible between the gloves), at the price
  of the two palm heels interpenetrating by more than 15 mm and a strongly bent support wrist; at the sights the
  two hands read as one lumpy mass and the right sleeve is the largest object on screen. Glove contact is
  approximate (fingers sink a few millimetres into the grip, the support thumb floats), and the thumb-cock and
  inspect animations read correctly but are not polished. Under the roof a weak hands-only fill light keeps the
  gloves readable when looking out into the sun; it is a compensation, not light that exists in the scene, and at
  its first setting the reviewer found the sleeve twice as bright as the timber beside it (since reduced).
* **Body.** Looking down shows a static jacket front, belt line and boots (modelled by script, no skeleton);
  thighs and knees are hidden behind the jacket hem when standing. When walking, each leg swings out from under
  the jacket as one rigid piece with no knee; crouching simply compresses the legs. The trousers borrow the
  jacket's cloth texture. The arms are a separate camera-fixed rig, so sleeves do not join the torso, and the body
  does not twist or lean. The shade under the boots is a soft decal, not a computed shadow, and is only just
  visible (the slab between the boots is about a quarter darker).
* **Covered bay lighting (Low–High).** No real indirect light: a constant ambient plus fill lights standing in for
  ground bounce. That bounce is not shadowed by benches, posts, dividers or the body, and screen-space ambient
  occlusion adds no visible contact at bench legs or posts. It reads as fill on the walls, not as depth. Ultra has voxel GI but runs below
  60 fps on the test GPU.
* **Environment.** The distant landscape is a photograph with no parallax; near vegetation is card/low-poly and
  does not move in wind; berm silhouettes are smooth; the ground cover repeats; the decorative brass on the slab is
  identical specks; impact dust is a handful of soft billboards.
* **Marks.** Paper holes, lead splash and impact marks are stamps at the true hit point: correct size and
  position, limited detail up close (a 9 mm hole is 9 mm). Wood and sheet-metal marks are small; exit damage is
  modest. Glass fragments are flat chips; clays lack the fine dust cloud.
* **Muzzle flash and smoke** are deliberately faint in daylight; the smoke wisp reads as soft blobs in some frames.
* **Recoil.** The sights come back a few pixels off (4–14 px at 1080p, direction varying) and are steered in
  within ≈0.4 s, and the front post sits briefly off-centre in the notch, but it is still springs with an invented
  error distribution: no shoulder/elbow motion, the hands never re-grip, and the correction is a smooth damped
  curve rather than a human search for the sights. Quick follow-up shots (≈0.35 s apart) land several
  centimetres off at 10 m; whether that feels fair with a mouse has not been tried by anyone.
* **Walking** has modest head and gun motion and no footfall-synchronised arm swing; there is no jump, lean or
  body rotation independent of the view.
* **Target stand moves** cut to black (0.3 s fully black, ≈0.7 s including the fades) instead of showing anyone
  walk downrange. Target reset is instant.

## Sounds (established by measurement only)

* **One microphone perspective for the shot.** The P38 was recorded 2 m behind the shooter, six takes, each
  clipped for < 1 ms at the first peak. Everything "at the shooter's ears" is constructed around it. Most shots
  have a near-twin (same take, ±0.6 % pitch).
* **No real bullet-on-steel recording.** Steel sounds are hammer-struck plates and a small bell-like target;
  rifle-on-steel recordings found were clipped or masked.
* **Mechanism sounds are real but from other pistols** (Bersa .380, Colt 1911), apart from the P38 magazine removal.
* **Several groups have one or two variants** (decock, safety on, grip, wood/concrete/sheet-metal impacts, glass
  bottle, cardboard), some from lossy sources; casings on dirt are silent; gravel/grass/sandbag/rubber impacts
  borrow the dirt sound.
* **Bay reverberation is synthetic late field + image-source reflections**, with estimated material constants; it
  measures as a coherent difference from the open pad (see VERIFICATION.md) but nobody has judged how it sounds.
* **Low end.** Over the first 0.5 s the game's shot carries 17 dB more energy at 63 Hz (7 dB at 125 Hz) than the
  real 2 m recording; the excess sits after the first 50 ms, i.e. in the reflection/echo/late layers. Which
  layer, and whether it is audible as boom, is not established.
* **HRTF**: only left/right level differences were verified.

## Behaves

* **Frame pacing depends on what else the machine is doing, and no 5-minute run of the final build is free of
  long frames.** High runs at ≈10–11 ms uncapped and the V-synced median is always one refresh. Four runs of the
  final build: 1 long frame (66 ms) under a steady CPU load; 5 of 93–150 ms on a mostly idle machine; 107 (up to
  230 ms) with another project's jobs in the same process group; and 492 (up to 846 ms — plainly visible
  stutter for about a third of the session) while another application's `chrome` process was busy and the host
  was swapping heavily. In the last case the game's main thread was blocked, not short of CPU: something outside
  the game's code held it up (shared GPU or memory reclaim; not separated). The five frames on the mostly idle
  machine are unexplained. The only completely clean run (worst frame 27 ms) is of the round-2 build on an idle
  machine. Nothing was measured on a machine with spare memory and an unshared GPU. Ultra does not hold 60 fps.
  Switching quality presets at run time can stall for seconds.
* **Quit** leaves engine "leaked instance" warnings in the log (no effect during play).
* **Tested on one machine** (Intel Arc B580, Linux, Hyprland/Wayland, PipeWire). Other GPUs, compositors and
  operating systems are untested; fullscreen and window resizing were exercised only in the UI harness.
* **Dry fire on a closed empty chamber** cannot be reached in normal play (no manual slide racking), so it is
  covered only by the state-machine tests.
* **Crouching** compresses the visible legs rather than bending knees.
