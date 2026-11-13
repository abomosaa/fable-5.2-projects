# Capture guide

How to photograph an object so that Pocket 3D Scanner can really reconstruct it — and how to
recognise the cases where it cannot. The same guidance is built into the app
(*New scan → How to capture*).

## The one rule

**The object stands still. You move.**

Photogrammetry recovers shape by assuming that everything in the photos is one rigid scene seen
from different camera positions. The table, the floor and the background help: they give the
solver extra points to locate the cameras.

```
 top view                         side view: 2–3 rings

        ● ● ●                      high   ●   ●   ●      (looking down ~55°)
     ●         ●                   mid  ●    ▓▓▓    ●    (looking down ~30°)
    ●    ▓▓▓    ●   ← you          low ●     ▓▓▓     ●   (almost level)
     ●         ●                  ─────────────────────── table / floor
        ● ● ●
   ~30 photos per ring, a step of about 12° between neighbours
```

* Walk a full circle around the object, keeping it in the centre of the frame and filling
  roughly 60–80 % of the picture. Take a photo about every 12° (≈ 30 per ring): neighbouring
  photos should share about 70 % of what they show.
* Repeat at two or three heights (low, mid, high). Tops, undercuts and concave parts are only
  reconstructed if some photos actually look into them.
* 30–80 photos are typical. Fewer than 20 usually leaves gaps and a fragile camera solution.
* Use soft, even light. Avoid hard shadows, your own shadow, and flash.
* Keep the background reasonably static: no people walking through, no screens playing video.
* Hold still while each photo is taken; blur destroys the fine detail matching depends on.
  Lock focus and exposure after framing if your phone supports it (the app shows whether it does).

## What does not work

| Situation | Why | What to do instead |
|---|---|---|
| Rotating the object in your hands, or on a turntable in front of a visible, static background | Object and background move differently: the rigid-scene assumption is violated and cameras are placed wrongly or not at all. The app warns when the phone is static while the picture changes. | Leave the object on the table and walk around it. (A turntable only works in front of a completely featureless backdrop — not supported by the guidance here.) |
| Turning on the spot (panorama) | No parallax, so no depth. The app holds auto-capture when it sees this; the companion rejects such a set (`no_parallax`). | Move sideways around the object |
| Shiny, mirror-like, glossy objects | Highlights and reflections move with the camera and are matched as if they were surface | Diffuse light; removable matte spray/powder if acceptable; expect noisy or missing surface and patchy texture. The "difficult" example dataset (glossy tumbler, 20 photos) shows it: about a quarter of the surface missing, and a size that is only right after calibrating with a known distance. |
| Transparent or translucent objects (glass, clear plastic) | The camera sees what is behind them | Not supported |
| Plain, texture-less surfaces (white ceramic, uniform plastic) | Nothing to match or to triangulate | Put textured material (newspaper, patterned cloth) under and around the object so the cameras still register; expect holes on the plain parts |
| Very thin structures (wires, leaves, hair, spokes) | Smaller than the stereo patches; usually lost | Not supported |
| Moving or deforming subjects (pets, people, plants in wind) | Not rigid | Not supported |
| The underside / contact area | Never photographed | Do a second capture session with the object turned over. Sessions are reconstructed separately; they are **not** merged automatically. |

## What the app tells you while capturing

* **Viewpoint coverage ring** — 12 direction sectors × 3 height bands. A cell fills only when a
  photo was actually taken from there. On ARCore devices the viewpoints are *tracked*; on other
  devices they are *estimated from the phone's orientation* (assuming you keep aiming at the
  object) and labelled as an estimate. Taking many photos from one spot fills one cell.
  This ring says where you stood, **not** that the surface was reconstructed: verified surface
  support only exists after reconstruction and is shown in the viewer's *Evidence* mode.
* **Quality warnings** — blur (also predicted from fast motion), too dark, overexposed, nearly
  identical to an earlier view, too far from the previous view (little overlap). Auto-capture
  skips such frames; manual captures ask whether to keep them.
* **Turning on the spot** — without AR tracking the phone's orientation sensor cannot tell
  "walked 30° around the object" from "turned 30° where you stand", so the app also watches the
  picture: when you orbit, the centre of the frame keeps showing the object; when you only turn,
  the whole picture slides sideways by the amount the rotation predicts. If the picture slides
  like that from one photo to the next (at least about 6° of turning), auto capture takes no
  further photo and says "Auto capture paused — the picture slides as if the phone were only
  turning. Walk around the object."; if you keep pressing the shutter yourself, a banner "It
  looks like you are turning on the spot" appears after the second such step. One automatic
  photo is taken before the pause, because a single step is not treated as proof. This check is a heuristic on a low-resolution preview (it
  needs texture in the centre of the frame and cannot see slow drift); the companion makes the
  authoritative check — a set of photos without parallax fails with the code `no_parallax` and
  this advice instead of producing a model. With AR tracking the tracked camera positions are
  used directly.
* **Tracking state** (ARCore) — when tracking is lost, auto-capture pauses. After recovery the
  app starts a new tracking segment: positions before and after are never assumed to share a
  coordinate system; the reconstruction aligns the photos by their content.

## After capturing

1. *Review photos*: exclude or delete flagged frames. Originals stay untouched on the phone.
2. *Reconstruct*: photos are uploaded to **your paired companion computer** on the local
   network; reconstruction happens there, not on the phone and not in a cloud. A *Preview*
   preset tells you within a minute or two whether the capture registers at all.
3. Read the diagnostics: registered vs. unregistered photos, viewpoint gaps, surface with weak
   photographic support. Open the *Cameras* view in the model viewer to see which photos were
   used and where coverage is missing, then recapture those directions.

## Real-world size

Photos alone give shape but **not size**. Until you calibrate, lengths are shown as
"units (uncalibrated)". Two ways to get real measurements:

* **Known distance** (any device): measure something on the object with a ruler, mark the two
  points on the model, type the distance. All measurements then carry an uncertainty derived
  from how precisely the points can be picked and how well you know the reference.
* **AR tracking** (ARCore devices): if the tracked phone positions agree with the reconstructed
  camera positions, the companion derives a metric scale and labels it *AR-estimated ±x %*
  (never better than ±3 %). Verify with a ruler when it matters.

## Importing existing photo sets

*New scan → Import* accepts JPEG, PNG, WebP and HEIC through the system picker, copies the
files unchanged, reads orientation / focal length / time, and reports every file it could not
use with the reason. The capture rules above apply just the same; photos from different
zoom settings are calibrated as separate cameras.
