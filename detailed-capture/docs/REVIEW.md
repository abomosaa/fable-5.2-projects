# Independent review

The app and its outputs were inspected by reviewer agents that had no part in building them (fresh context, brief in
`docs/review/BRIEF.md`). They drove the installed app on the Android emulator through adb and produced their own
matched full-resolution crops (fused result | overview enlarged to the same pixels | raw source pixels) with the
core's `debug.crops` command at positions of their choosing. Their reports are saved verbatim and their evidence
(screenshots, crops) is preserved:

| Round | Report | Evidence |
|---|---|---|
| 1 | `docs/review/round1/REPORT.md` | `docs/review/round1/app/` (97 files), `docs/review/round1/crops/` (53 files) |
| 2 | `docs/review/round2/REPORT.md` | `docs/review/round2/app/`, `docs/review/round2/crops/` |

Nothing in this file claims more than the reviewers actually inspected; their "not inspected" lists are part of
the reports. **No physical device was available to anyone**: both rounds are emulator + imported photographs.

## Round 1 — findings and what was done

Round 1 inspected the APK built before the fixes below and the host results of that build. No blocker; three major
findings.

| # | Finding (reviewer's evidence) | Response | Status after round 1 |
|---|---|---|---|
| M1 | Crop: after a first crop, the other corner could not be adjusted; drags were lost (`app/a60`, `a61`, `a73b`, `a78b`, `c123_crop_three_drags.jpg`) | Bug: the gesture handler was re-created on every edit-state change, so a drag in progress lost its handler and a later drag started from stale state. Handlers are now created once per mode and read the current state when a drag starts; the title shows the size the export will have. Re-run on the emulator: 4672×3504 → top-left drag → 3270×2533 → bottom-right drag → 2075×1719 → move → undo → 3270×2533 → undo → 4672×3504 (`docs/evidence/emulator/steps_log.txt`, `18_crop.png`). | fixed, re-tested by the developer; re-checked in round 2 |
| M2 | Relief set: accepted close-ups placed box side faces where the overview shows the box top (`crops/rl1`, `rl2`, `rl3`, `rl5`); docs understated this | The planarity check only looked at cells where both images had texture. Added two cell tests against the overview: structure present in one image but not the other, and brightness differing by more than 30 grey levels after exposure normalisation; masked groups grow by one cell. One more relief close-up is now rejected (6 accepted, 1 uncertain, 2 rejected). A new metric, "structural agreement with the overview", was added to the evaluation for every set: for `relief` the share of pixels differing from the overview by more than 20 grey levels inside the close-up area went from 2.6 % (first measurement of the metric, taken part-way through these fixes; the round-1 build itself was not measured) to 0.00 %. README, capture guide and architecture limits now state that this detection is cell-based and imperfect. | improved, not a guarantee; re-checked in round 2 |
| M3 | Alexander mosaic: frame `closeup_05` accepted with a 3 overview-px anchor residual; edges break by ≈ 20 output px at its border (`crops/a8`, `a12`, `a13`) | Acceptance now also requires the anchor (overview) residual to be ≤ 1.5 overview px RMS; otherwise the photo is "uncertain: high_residual" and is not composited unless the user forces it. `closeup_05` is now uncertain (6 accepted, 5 uncertain in that set). The limit is documented. | fixed for this frame; residual tolerance documented |
| m1 | Sharpness changes abruptly where a 7.4× frame ends mid-face | Inherent to using each photo where it is best; no change. Stated in README "Honest limits" and the capture guide. | documented |
| m2 | Vatican: ≈ 50 px soft band at one seam (`crops/v3b`) | No change (multi-band transition between two photos of different sharpness). | open, minor |
| m3 | Document: 1–2 px step in line-pair bars at the 3×/6.5× seam (`crops/d8`) | Within the documented tolerance (pairwise error mean 0.33, max 1.6 output px on that set); no change. | open, minor, documented |
| m4 | Colour panel: fifth slider cut off | Panel height fixed (scrolls to all five sliders + Reset). | fixed |
| m5 | Measure disclaimer cut mid-sentence | Line limit removed. | fixed |
| m6 | Back from "original pixels" reset the viewer mode and zoom | Viewer mode and position are restored on return. | fixed |
| m7 | Internal ids shown ("f0015") | Photos are labelled "Close-up N (file name)" in the source sheet, map bubble and frame screen; progress shows file names. | fixed |
| m8 | Camera: "Captured — checking…" stayed; black preview for seconds on first open | Status text now clears after a few seconds. Slow first preview on the emulator: not changed. | partly fixed |
| m9 | Remove acted without confirmation | Confirmation dialog explaining that Undo restores the photo. | fixed |
| m10 | README said "eight 24 MP photographs"; `docs/REVIEW.md` missing | Corrected to 9.5–24 MP; this file added. | fixed |
| m11 | Map said 78 %, result details 77 % | Both are right but measure different things; the details dialog now says "Result area … (after seam selection)". | clarified |
| m12 | Reviewer could not finish the test binary under memory throttling | Not reproducible outside that environment: `eval/results/core_tests.txt` (9 tests, 338 checks, 0 failures). Round 2 was told not to run it next to the emulator. | not an app issue |
| cosmetic | Viewer subtitle cut; project title cut; mode row scrolls off-screen; export sheet's last entry below the fold; no sign of an interrupted fusion on the home card; abrupt coverage border on the repetitive set | Subtitle shortened; home card shows "fusion interrupted". The rest is unchanged. | partly fixed |

The round-1 reviewer's own "limitations users must be told" (non-flat parts can be misplaced even on a verified
photo; verified hand-held photos can be off by a couple of overview pixels; abrupt sharpness changes; repeating
patterns need landmarks; nothing verified on hardware) are now in README "Honest limits", `docs/CAPTURE_GUIDE.md`
and the limits table of `docs/ARCHITECTURE.md`.
