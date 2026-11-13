# REFERENCES — Walther P38 / P1 service pistol at a compact outdoor range

Descriptive reference for simulating appearance, sound, animation timing and target behaviour in an entertainment
product. Nothing here is construction, modification or conversion guidance.

**Tags.** `[MEASURED]` published specification or instrumented measurement · `[OBSERVED]` described in a review,
manual, forum or first-hand account · `[APPROX]` my estimate or derivation (reasoning shown; never a measurement).
**Source refs** `[S#]` (generic) and `[P#]` (P38/P1) resolve to URLs in the table at the end. `‡` after a ref = I saw the value only in a
search-engine extract of that page (page not opened, or blocked by paywall/bot wall); no mark = I read the page/PDF text.
No video was watched; every video is "not directly inspected".
**Solver.** `[APPROX]` trajectory numbers come from my own point-mass G1 integration (ICAO air 1.225 kg/m³,
c = 340.3 m/s). It reproduces Federal's published 115 gr velocity table (1180 → 1106/1048/1001/961 fps at
25/50/75/100 yd [S20‡]) to within 1 fps with BC 0.123, so the drag table is sound.

**Firearm.** The simulated pistol is the Walther P38 / Bundeswehr P1 (9×19 mm). Glock 17 data gathered earlier is kept
only in Appendix A as a labelled comparison and as the basis for cycle-timing analogies.

---

## 1. Pistol (Walther P38 / Bundeswehr P1 — the simulated firearm)

The art asset is a P38/P1-pattern "Service Pistol" (asset itself not inspected). P38 = wartime/steel frame;
P1 = post-war Bundeswehr issue with black-anodised aluminium ("Dural") frame. Same dimensions and controls.

### 1.1 Dimensions, mass, capacity

| Item | Value | Tag | Src |
|---|---|---|---|
| Overall length | 214 mm (manual) / 216 mm (Wikipedia); 8.3 in = 211 mm on one measured wartime gun | MEASURED | P2, P1, P5 |
| Barrel length | 125 mm (4.9 in); 6 grooves, 1:10 in RH twist. (Gun Tests lists 4.5 in — outlier/measured differently) | MEASURED | P2, P3, P5 |
| Height | 136 mm (manual, Wikidata) / 140 mm (Wikipedia) / 5.3 in = 135 mm (Gun Tests) | MEASURED | P2, P1, P5, P18‡ |
| Width | 36–37 mm; 1.6 in (41 mm) max across grips on one measured gun | MEASURED | P1, P18‡, P5 |
| Sight radius | 7 in ≈ 178 mm (manual); 6.95 in = 176.5 mm (Gun Tests) | MEASURED | P2, P5 |
| Grip | circumference 5.45 in (138 mm); front strap 2.6 in, back strap 3.4 in; trigger span 2.4 in (61 mm) | MEASURED | P5 |
| Mass, P1 alloy frame, empty | 780 g (27.5 oz); another review 27 oz (765 g) | MEASURED | P2, P3 |
| Mass, P1 alloy frame, loaded (8 rds) | 865 g (30.5 oz) | MEASURED | P2 |
| Mass, P38 steel frame, empty | ≈ 960 g (Wikipedia 960 g; manual: steel adds ≈ 6.5 oz/184 g → 964 g). Conflicts: Wikidata 880 g; Gun Tests 38.0 oz = 1077 g | MEASURED (sources disagree) | P1, P2, P18‡, P5 |
| Mass, P38 steel frame, loaded | ≈ 1045–1050 g (964 g + 85 g) | APPROX (sum) | P2 |
| Per cartridge | manual implies 10.6 g ((865 − 780)/8); Glock spec difference implies 12.35 g — use 12 g | APPROX | P2, S1 |
| Magazine | 8-round single-column steel box, index/witness holes; capacity 8 + 1 chambered | MEASURED | P1, P2, P4 |
| Magazine mass, empty / loaded | ≈ 80 g / ≈ 175 g — **not sourced**; by analogy with other steel pistol magazines + 8 × 12 g | APPROX | — |
| Finish | P1: black anodised alloy frame, dull grey parkerised steel slide/barrel (two-tone); wartime P38: blued (later rougher) steel | OBSERVED | P3, P5 |
| Grips | early walnut; wartime ribbed Bakelite (black or brown); 1945–46 French sheet-metal; P1 black plastic with moulded checkering. No metal backstrap — panels wrap round clamshell-style to form it. Lanyard loop on the butt | OBSERVED | P1, P4, P3 |
| P1 identifiers | "P1" on slide (first years still marked P38); from 1970s a steel hex bolt through the frame above the trigger guard and a thicker "fat" slide | OBSERVED | P1, P4 |

### 1.2 Trigger (DA/SA) and hammer

| Item | Value | Tag | Src |
|---|---|---|---|
| Type | double-action first shot (long pull cocks and drops the exposed hammer); every following shot single-action because the slide re-cocks the hammer | OBSERVED | P1, P2 |
| DA pull weight | avg 12.0 lb / 53 N over 4 guns (8.3–14.8 lb); 10.7 lb; P1 9.5 lb (42 N); 17.0 lb on one worn wartime gun | MEASURED (reviews/database) | P8‡, P10‡, P9‡, P5 |
| SA pull weight | avg 5.5 lb / 24 N (4.0–6.8 lb); 5.25 lb; P1 5.5 lb; Gun Tests 7.0 lb in table but 4.25 lb in text | MEASURED (reviews/database) | P8‡, P10‡, P9‡, P5 |
| DA feel | long; smooth and "fairly light" on a good P1 but "stacks just before let-off"; "unnecessarily heavy" on the wartime gun | OBSERVED | P3, P5 |
| SA feel | slight take-up, slight creep, light and fairly crisp, slight over-travel | OBSERVED | P3, P4 |
| Trigger rest position | forward when hammer is down; sits visibly **further rearward** when the hammer is cocked | OBSERVED | P2 |
| DA / SA travel, reset distance | **not sourced.** Use DA ≈ 15 mm, SA ≈ 4 mm from its rearward rest position, reset ≈ 5 mm | APPROX (typical DA/SA service pistol; unsourced) | — |
| Hammer | exposed spur hammer at the slide rear; two visible states: **down** (rest) and **cocked** (rocked back ≈ 45–50° `[APPROX]`). Can be thumb-cocked for an SA first shot (manual recommends this for target shooting) | OBSERVED | P2, P1 |
| Lock time (hammer fall) | not sourced; hammer guns ≈ 2× a striker's 3 ms → ≈ 5–7 ms | APPROX | S15‡ |

### 1.3 Sights

| Item | Value | Tag | Src |
|---|---|---|---|
| Pattern | fixed. **Front:** tall blade/post on the barrel near the muzzle. **Rear:** broad blade with a deep U-notch on the slide; drift-adjustable for windage | OBSERVED | P1, P4, P3, P5 |
| Markings | wartime P38: plain black. Bundeswehr P1 test gun: white dot on front post and a white bar under the rear notch (same article also says "U-notch") — match the art asset | OBSERVED (source inconsistent) | P3 |
| Factory zero | "sights set for 50 metres" | OBSERVED | P1 |
| Post / notch widths, heights | **not sourced** | — | — |
| Sight line above bore | ≈ 21 mm — not sourced; tall "high-profile" sights over an exposed barrel | APPROX | P5 |
| Note for animation | front sight rides on the **barrel**, rear sight on the **slide**: in recoil the front sight moves back only ≈ 6–8 mm with the barrel and stops, while the rear sight travels the full slide stroke | APPROX (follows from layout; verify on model) | P4 |

### 1.4 Visible controls and features

| Control | Position / behaviour | Tag | Src |
|---|---|---|---|
| Safety / decocker lever | left side of the **slide**, just below the rear sight. **Up = Fire** (red "F" exposed). **Down = Safe** (white "S" exposed, "F" covered). Long, easy to reach with the firing thumb | OBSERVED | P4, P2, P5 |
| Decocking | moving the lever to Safe with the hammer cocked first locks the firing pin, then — in the last third of lever travel — trips the hammer, which falls onto the locked pin. Trigger returns forward. Lever may be left down (trigger/hammer blocked) or flicked back up for a DA first shot | OBSERVED | P2, P4 |
| Racking on Safe | with the lever down, racking the slide chambers a round but the hammer does not stay cocked | OBSERVED (manual text fragmentary) | P2 |
| Loaded-chamber indicator | "signal pin": a steel rod that protrudes from the rear face of the slide just **above the hammer / below the rear sight** when a round is chambered; flush when empty; stays visible with the safety on; can be felt in the dark | OBSERVED | P1, P2, P4 |
| Slide stop lever | left side of the frame at the top rear of the trigger opening, partly fenced by a thumb shelf moulded into the grip panel; magazine follower lifts it after the last round → slide locks open; press down (or pull the slide back and release) to close | OBSERVED | P4, P3, P2 |
| Take-down (barrel catch) lever | left side of the frame, forward, above the trigger guard | OBSERVED | P3, P2 |
| Magazine catch | **heel type**: stamped-steel sliding latch at the bottom rear of the grip, behind the magazine well, hooking over the rear of the magazine floorplate. Push it rearward to free the magazine. Magazine does **not** drop free | OBSERVED | P4, P3, P5, P16‡ |
| Slide shape | "open-top": slide is "almost skeletonized forward of the breech face"; the barrel is exposed along most of its length and protrudes well ahead of the slide | OBSERVED | P4 |
| Extractor / ejector | external claw extractor on the **left** of the slide; pivoting blade ejector in the frame on the right | OBSERVED | P4 |
| Recoil springs | two small parallel springs on guide pins, one each side of the frame under the slide rails; not visible when assembled | OBSERVED | P1, P4, P5 |

### 1.5 What moves during one shot (order)

| # | Event | Number | Tag | Src |
|---|---|---|---|---|
| 1 | First shot: long DA pull rocks the hammer back and releases it (or SA: short pull drops the already-cocked hammer) | DA ≈ 53 N, SA ≈ 24 N | MEASURED | P8‡ |
| 2 | Hammer strikes firing pin | ≈ 5–7 ms | APPROX | §1.2 |
| 3 | Barrel + slide recoil **straight back**, locked by a wedge-shaped pivoting locking block under the breech (two lugs in slide recesses). No tilt — "strictly linear" | ≈ 6.4 mm (0.25 in) / ≈ 8 mm (5/16 in); derivative P5 ≈ 5 mm | OBSERVED (sources differ) | P4, P6‡, P7‡ |
| 4 | Plunger at the rear of the barrel lug hits the frame, cams the locking block **down** into a frame recess; barrel stops dead, still level | — | OBSERVED | P4, P1 |
| 5 | Slide continues alone, extracts and ejects the case, rides over and cocks the hammer, compresses the twin springs | full slide stroke **not sourced**; ≈ 50 mm | APPROX (> 29.7 mm cartridge length) | P1 |
| 6 | Springs return the slide; next round chambered; slide picks the barrel up, locking block rises; signal pin pops out; hammer stays cocked; trigger now rests rearward (SA) | — | OBSERVED | P1, P2 |
| 7 | Last round: slide stop rises, slide stays open (hammer cocked) | — | OBSERVED | P4 |

Cycle timing: **no instrumented P38/P1 data found.** Use the generic 9 mm service-pistol envelope from Appendix A
(slide rearward ≈ 8–10 ms, full cycle ≈ 50–60 ms) `[APPROX — by analogy]`. Wikipedia's "116 rpm" is a practical
aimed rate including reloads, not a mechanical rate (P1).

### 1.6 Ejection

| Item | Value | Tag | Src |
|---|---|---|---|
| Side | **LEFT** — "unlike most autopistols, which eject to the right" (the P5 kept this) | OBSERVED | P1, P7‡ |
| Why | extractor is on the left of the breech face | OBSERVED | P4, P14‡ |
| Trajectory | cases go straight left or up-and-left; "tend to travel vertically rather than laterally"; "erratic… occasionally whack you in the forehead" | OBSERVED | P14‡, P4, P3 |
| Carry distance / speed | **not sourced.** Use up-left launch ≈ 45–70° above horizontal, 2.5–3.5 m/s, landing 0.5–1.5 m left of the shooter with wide scatter, ≈ 1 in 20 arcing back over the head | APPROX | P3, P4 |
| On the covered line | brass crosses toward the shooter's left neighbour/bench and rings on concrete | APPROX | — |

### 1.7 Handling quirks

| Quirk | Tag | Src |
|---|---|---|
| Heavy, long DA first shot then light SA — first-shot point of impact tends to differ; DA "unnecessarily heavy" on old guns | OBSERVED | P5, P1 |
| Heel magazine catch is "deathly slow", "the slowest to operate", the "one antiquated feature" | OBSERVED | P3, P5, P4 |
| Slide-mounted lever is "far easier than the modern Beretta 92"; decocks every time it is applied | OBSERVED | P5 |
| Recoil "mild", "light"; alloy P1 has a slightly heavier "push" than the steel P38 | OBSERVED | P3, P4 |
| Needs standard-pressure ≈ 1,100 fps 115–124 gr ball to cycle; hollow points may not feed; runs badly when dry | OBSERVED | P12‡, P2, P3 |
| Groups centred but ≈ 3 in high at 15 yd on one gun (consistent with a 50 m factory zero) | OBSERVED | P4, P1 |
| Hammer bite, slide top-cover behaviour | **not found in sources** | — | — |

---

## 2. Cycle timing and firing cadence

| Item | Value | Tag | Src |
|---|---|---|---|
| P38/P1 slide velocity, stroke time, cycle time | not sourced — use ≈ 9 ms rearward, ≈ 55 ms total (see Appendix A for the measured Glock 17 / 1911 basis) | APPROX | S7‡, S19‡, S6‡ |
| Barrel stops after | ≈ 6–8 mm, i.e. within the first ≈ 1–1.5 ms of slide motion | APPROX | P4, P6‡ |
| DA first shot, extra time | add ≈ 0.1–0.2 s to the first shot for the long pull | APPROX (unsourced) | — |
| Splits (SA shots), recreational / club / Master / GM | 0.30–0.40 s / 0.20–0.25 s / 0.18–0.22 s / 0.15–0.18 s (generic pistol data) | OBSERVED | S24‡, S25‡ |
| Fastest human splits | ≈ 0.10–0.13 s | OBSERVED | S26‡ |
| Practical rate | 4–5 aimed shots/s trained; magazine of 8 lasts ≈ 2 s at that pace | APPROX | S24‡ |

At 60 fps the slide cycle spans ≈ 3 frames; the visible, slower elements are the hammer (down → cocked and staying
cocked), the trigger's two rest positions, the signal pin, and the left-going brass.

---

## 3. Recoil as perceived

Loads as measured from P38s (§5.1): 115 gr @ 349 m/s, 124 gr @ 346 m/s.

| Item | Value | Tag | Src |
|---|---|---|---|
| Bullet momentum | 2.60 N·s (115 gr); 2.78 N·s (124 gr) | APPROX (m·v) | P5, P11‡ |
| Total recoil impulse incl. gas | 2.77 / 2.95 N·s (SAAMI: gas velocity = 1.50 × muzzle velocity for pistols; 5 gr charge assumed) | APPROX | S23, S22‡ |
| Free recoil velocity, **P1** 865 g loaded → 780 g empty | 3.4 → 3.8 m/s (124 gr); 3.2 → 3.6 m/s (115 gr) | APPROX | S23, P2 |
| Free recoil energy, P1 | 5.0 → 5.6 J (124 gr) | APPROX | S23, P2 |
| Free recoil velocity, **P38 steel** ≈ 1049 g → 964 g | 2.8 → 3.1 m/s (124 gr); energy 4.1 → 4.5 J | APPROX | S23, P2 |
| Published comparison (Glock 17) | 7.7 J: 905 g gun, 124 gr @ 1228 fps, 6.1 gr charge | MEASURED (calculated table) | S27 |
| Felt character | "mild"/"light", comfortable; alloy P1 "heavier push" than steel P38, control difference marginal | OBSERVED | P3, P4 |
| Muzzle rise, sensor reports from other 9 mm pistols | ≈ 14° (Walther PPQ, one owner); 5° solid grip vs 25° failing grip (micro-compact) | OBSERVED (Mantis X10) | S28‡, S29‡ |
| Muzzle rise, P38/P1, firm two-hand grip | ≈ 5–8° peak (P1), ≈ 4–6° (steel P38); ≈ 3° expert. No P38 data found | APPROX | S28‡, S29‡ |
| Recovery to target | 0.1–0.3 s; mean 0.42 s, range 0.12–1.02 s (other 9 mm pistols) | OBSERVED (Mantis X10) | S28‡, S30‡ |
| When the bullet leaves | most gun movement happens after the bullet has exited | OBSERVED | S31‡ |

Sight-picture / camera notes `[APPROX — synthesised]`: the front blade (on the barrel) jumps back a few mm and
lifts out of the U-notch while the rear sight and hammer area slam back toward the eye and return; brass leaves
up-left across the view; the blade settles back into the notch in ≈ 0.15–0.25 s. Pivot is at the wrists; peak
rise ≈ 50–80 ms after the shot. After the first shot the hammer stays visibly cocked. Keep camera kick small.

---

## 4. Handling cadence

### 4.1 Reload and manipulation times

| Action | Typical | Trained | Tag | Src |
|---|---|---|---|---|
| Button-release pistols, emergency reload (baseline) | 4–5 s (range 2.0–5.0 s) | 2.0–2.5 s; expert 1.5–1.8 s | OBSERVED | S32‡, S33‡, S34‡ |
| Button-release speed / tactical reload (baseline) | 2.5–3.0 s / < 5 s | 1.5–2.0 s / ≈ 3.0 s | OBSERVED | S35‡, S33‡, S36‡ |
| Heel-release pistols | qualitatively slower ("deathly slow", "slowest to operate"); one practised user: "not much slower" than a button; **no timed data found** | — | OBSERVED | P3, P5, P15‡ |
| **P38/P1 emergency (slide-lock) reload** | ≈ 5–6 s | ≈ 3.0–3.5 s; expert ≈ 2.5 s | APPROX (baseline + ≈ 1 s for two-hand catch-and-pull) | S33‡, P15‡ |
| **P38/P1 reload with retention** (natural for this design — the old magazine is already in the hand) | ≈ 6 s | ≈ 4 s | APPROX | S33‡ |
| Draw to first shot, duty holster (generic) | mean 1.78 s (SD 0.33) at 3 yd | 1.2–1.8 s | MEASURED / OBSERVED | S39‡ |
| Low ready to first shot | ≈ 0.6–0.9 s; add ≈ 0.1–0.2 s for a DA first shot | APPROX (unsourced) | S39‡ |

### 4.2 P38/P1 reload, step order

1. Slide locks open on empty (hammer stays cocked). `[OBSERVED]` P4
2. Pistol is canted/lowered toward the support side; support (left) hand comes under the butt. `[OBSERVED]` P15‡
3. **Support-hand thumb pushes the heel catch rearward; the index finger hooks the floorplate lip and withdraws the magazine** — it must be pulled, it will not fall. `[OBSERVED]` P2, P15‡, P16‡
4. Empty magazine is pocketed or dropped; support hand fetches the fresh one. `[APPROX]`
5. Fresh magazine pushed up into the well until the heel catch snaps over the floorplate (audible click). `[OBSERVED]` P4, P2
6. Slide closed by pressing the slide stop lever down with the firing thumb, or by pulling the slide back and releasing. `[OBSERVED]` P3, P2
7. Hammer is still cocked → next shot is single-action. Shooter may decock (lever down, hammer falls, lever up) to return to DA. `[OBSERVED]` P2

Initial loading: insert magazine, rack the slide (hammer cocked, signal pin out), then either fire SA or sweep the
lever down-and-up to decock for a DA first shot. `[OBSERVED]` P1, P2

### 4.3 Chamber check `[OBSERVED]`
The signal pin above the hammer makes a press check unnecessary: glance at, or thumb, the rear of the slide (P2, P4).
A conventional press check — slide retracted ≈ 6 mm (up to 12 mm) with the support hand, brass seen through the
open top, slide released — is also possible (S40‡, S41‡); barrel and slide move together for that first ≈ 6 mm.

### 4.4 Two-handed thumbs-forward grip `[OBSERVED]` S42‡, S43‡, S44‡

| Part | Placement |
|---|---|
| Firing hand | web high under the tang beneath the hammer; middle, ring and little fingers wrap the front strap under the trigger guard; thumb forward, resting on the support-thumb base — below the slide-mounted safety lever and clear of the slide stop |
| Trigger finger | straight along the frame above the trigger when not firing; pad (SA) or first joint (DA) on the trigger when firing |
| Support hand | wrist canted forward-down ≈ 45°; palm heel fills the exposed left grip panel; four fingers wrap over the firing-hand fingers |
| Support index finger | pressed up against the underside of the trigger guard |
| Support thumb | forward along the frame below the slide; must not ride the slide or the slide stop. Left-ejected brass passes just above this hand `[APPROX]` |
| Arms | both extended, elbows slightly unlocked; most clamping force from the support hand |

Ready positions (terms `[OBSERVED]`, angles `[APPROX]`): **low ready** — arms extended, muzzle ≈ 30–45° below the
target; **compressed ready** — pistol at the sternum, muzzle level, then pressed out.

---

## 5. External ballistics (9×19 mm FMJ, 125 mm barrel)

### 5.1 Inputs

| Item | 115 gr FMJ | 124 gr FMJ | Tag | Src |
|---|---|---|---|---|
| Chronographed from a P38 | 1130 fps (SIG Elite FMJ); 1163 fps (Federal FMJ) | 1144 fps (Hornady FMJ handload); 1131 fps (Remington FMJ); 1127 fps (124 gr JHP) | MEASURED | P5, P11‡ |
| Chronographed from a P1 | — (table is an image) | 147 gr: 977 fps | MEASURED | P3 |
| Encyclopaedia figure | 1,050 ft/s (320 m/s), flagged "citation needed" | | OBSERVED | P1 |
| Recommended muzzle velocity | **349 m/s (1145 fps)** | **346 m/s (1135 fps)** | APPROX (mean of the above) | P5, P11‡ |
| Factory ratings, 4 in test barrel (for comparison) | 1180 fps | 1150 fps | MEASURED | S20‡, S21‡ |
| Shot-to-shot spread (from Glock 17 testing of the same ammo types) | SD 9–15 fps | SD 7–11 fps | MEASURED | S4 |
| G1 BC | 0.123 | ≈ 0.154 (my fit to the Federal table) | MEASURED / APPROX | S20‡, S21‡ |
| Sight height | 21 mm | 21 mm | APPROX | §1.3 |

Note: the 125 mm barrel did **not** chronograph faster than factory 4 in ratings in these tests.

### 5.2 Trajectory `[APPROX — solver]` (path = bullet relative to line of sight, mm; − = low)

| Range | 115 gr v (m/s) | TOF (ms) | 124 gr v (m/s) | TOF (ms) | Path, 25 m zero | Path, 50 m factory zero | Gravity drop from bore |
|---|---|---|---|---|---|---|---|
| 0 m | 349.0 | 0 | 345.9 | 0 | −21 | −21 | 0 |
| 7 m | 342.3 | 20.3 | 340.7 | 20.4 | −10 | −5 | 2 |
| 10 m | 339.5 | 29.1 | 338.5 | 29.2 | −6 | +1 | 4 |
| 15 m | 335.1 | 43.9 | 335.0 | 44.1 | −2 | +9 | 9 |
| 25 m | 327.0 | 74.1 | 328.5 | 74.2 | 0 | +18 | 26 |
| 50 m | 309.8 | 152.7 | 314.2 | 152.1 | −36 | 0 | 110 |

Both bullet weights share the path columns to within 1 mm. With the factory 50 m zero the pistol prints ≈ 2 cm high
at 25 m — small against the 85 mm B-8 ten-ring. Launch angle ≈ 0.11° (25 m zero) / 0.15° (50 m zero).

### 5.3 Practical accuracy

| Item | Value | Tag | Src |
|---|---|---|---|
| Wartime P38, bench, 5-shot | avg 2.5 in (115 gr FMJ), 2.7 in (124 gr FMJ), 2.9 in (JHP); best 2.0 in — "most accurate handgun tested" (distance not stated on page; 25 yd is that publication's norm) | MEASURED | P5 |
| Wartime P38, 25 yd | ≤ 3 in both loads, best 2 in; another tester 2.5–3.25 in | MEASURED (reviews) | P12‡, P13‡ |
| Late-war P38, 50 ft | 2.63–2.75 in averages, best 2.25 in | MEASURED | P11‡ |
| P1, 25 yd sandbags, 4 × 5 shots | best load averaged 2.6 in | MEASURED | P3 |
| Reason usually given | in-line (non-tilting) barrel travel | OBSERVED | P1 |
| Dispersion for the sim, gun + ammo + rested shooter | σ ≈ 0.95 mrad per axis (≈ 24 mm at 25 m) ⇒ 2.6 in five-shot groups at 25 yd (mean 5-shot spread ≈ 3.07 σ) | APPROX | P3, P5, S49‡ |
| Mechanical-only dispersion | σ ≈ 0.8 mrad per axis (20 mm at 25 m) | APPROX | — |
| DA first shot | add shooter-induced error, not mechanical error | APPROX | P5 |

---

## 6. Muzzle flash, smoke, brass

| Item | Value | Tag | Src |
|---|---|---|---|
| Flash duration | 1–2 ms including IR (Burke & Bratlie 2011, as cited); a videographer's estimate of ≈ 20 ms conflicts and is uninstrumented | MEASURED (cited) / OBSERVED | S50‡, S51‡ |
| Daylight visibility | not noticed in daylight ("you don't even see it"); too weak to light surroundings; cameras often miss it entirely | OBSERVED | S52‡, S51‡ |
| Dusk / dim light | dull orange ball ≈ 4 cm (1.5 in) with a flashy powder; invisible with low-flash powder; some loads show "no flash, just a faint grey smoke cone" | OBSERVED | S53‡, S54‡ |
| Smoke | "smokeless" still leaves a little; jacketed bullets are low-smoke (lubed lead is the smoky kind); FMJ vs TMJ not distinguishable by eye | OBSERVED | S55‡ |
| Recommended look | daylight: no flash sprite, or one ≤ 1-frame faint pale-orange puff ≤ 3–5 cm; thin grey gas jet ≈ 20–40 cm that disperses in < 0.3 s; small wisp from the ejection port; dusk: ≈ 4–8 cm orange ball for 1 frame | APPROX | S50‡–S55‡ |
| Powder charge (context) | 5–8 gr for 9 mm NATO-class loads | OBSERVED | S50‡ |

Brass: see §1.6. P38/P1 cases leave to the LEFT/up-left, are hot, bounce and roll on concrete, stop dead on grass/gravel
(forensic work fires onto sand precisely to stop bounce and roll, S17).

---

## 7. Acoustics

### 7.1 The shot

| Item | Value | Tag | Src |
|---|---|---|---|
| Peak SPL, 9 mm SIG P228 (114 mm barrel), mic 1 m left of shooter at ear height | within 159.0–161.5 dB outdoors; within 158.6–160.8 dB indoors (≈ 160 shots each) | MEASURED (NIOSH) | S56 |
| Peak SPL, 9 mm (hearing-conservation chart) | 159.8 dB; pistol-test average 157.5 dB (152.4–164.5) | MEASURED | S57‡ |
| Peak SPL, 9 mm pistol, 10 cm from shooter's left ear | 154 dB mean of 10 shots; mean duration 0.3 ms | MEASURED (Ylikoski 1994, as relayed) | S58 |
| Peak SPL, Glock 19 at 3 m, on axis, quasi-anechoic | 151 dB (≈ 160.5 dB referred to 1 m by 1/r — agrees with NIOSH) | MEASURED / APPROX scaling | S59‡, S60 |
| Muzzle-blast waveform | abrupt onset, single positive peak, back to ambient ≈ 2 ms after onset (G19, on-axis, 3 m); "a few milliseconds" generally (< 3–5 ms) | MEASURED | S60, S61‡ |
| Directivity | level to the side (98°) and rear is lower than on-axis; waveform shape/duration similar | MEASURED | S60 |
| Spectrum | broadband; highest 1/3-octave band 500–800 Hz for most handguns, > 130 dB in that band | MEASURED | S56 |
| Bullet shock (N-wave) | handgun shots with subsonic bullets show none | MEASURED | S61‡ |
| Hearing protection the player "wears" | muffs behave like a low-pass filter that smooths the spike; 25–35 dB peak reduction | MEASURED | S56 |

### 7.2 Open firing point vs covered firing line

| Item | Value | Tag | Src |
|---|---|---|---|
| Discrete early reflections under a fabric tent (outdoor test) | head reflection 1.82 ms; tent/shooter 3.58 and 4.23 ms; ground 6.24 ms after the direct peak | MEASURED | S56 |
| Geometry check for the sim (muzzle 1.45 m, ear 1.6 m, 0.6 m apart) | roof 2.4 / 2.7 / 3.0 m → reflection at 3.6 / 5.3 / 7.0 ms, ≈ −10 / −12 / −14 dB re direct; ground 7.3 ms | APPROX (image-source, rigid surface, 1/r) | S56 |
| Open-air decay | outdoors, non-reverberant: ring-out "on the order of a few hundred milliseconds" (distant terrain/berm returns) | OBSERVED (vendor primer citing Penn State ARL) | S62 |
| Fully enclosed untreated range (upper bound) | RT60 5.64 s and 5.39 s measured; treated target ≤ 1.3–1.5 s; treated example 1.08 s | MEASURED (vendor) | S62 |
| Indoor vs outdoor exposure | A-weighted exposure ≈ 6 dB(A) higher indoors (rifles; shooter position) | MEASURED | S63 |
| Roofed shed, absorptive lining added | lowers level at the shooter ≈ 2–4 dB ⇒ an untreated shed adds about that much reflected energy | MEASURED / inference | S64 |
| Roof material | corrugated metal or fibreglass roofing "can actually increase sound levels at the firing line"; hollow roofs produce a "drum effect" | OBSERVED (design criteria) | S65 |
| Covered firing line, recommended sim values | same peak; +2 to +3 dB exposure; dense early reflections 3–15 ms; metallic roof "drum" tail; RT60 ≈ 0.4–0.6 s (open front) vs ≈ 0.2–0.3 s plus a berm slap-back at the open position | APPROX | S56, S62–S65 |
| Berm slap-back delay | 2·d / 343: 146 ms for a berm 25 m away, 320 ms for 55 m | APPROX | S66‡ |

### 7.3 Bullet flight and impact sounds

| Item | Value | Tag | Src |
|---|---|---|---|
| Speed of sound | 343 m/s at 20 °C (1125 fps) | MEASURED | S66‡ |
| 115 gr @ 349 m/s (P38) | Mach 1.02 at muzzle; subsonic by ≈ 6 m (factory 1180 fps: Mach 1.05, subsonic by ≈ 16 m) | APPROX (solver) | P5, S20‡ |
| 124 gr @ 346 m/s (P38) | Mach 1.01 at muzzle; subsonic by ≈ 4 m; 1090 fps loads are subsonic from the muzzle | APPROX (solver) | P5, S21‡ |
| Fly-by crack for the shooter | none separately audible: the shooter is behind the Mach cone, and the weak transonic shock merges with the muzzle blast | OBSERVED (forum/patent explanations) + APPROX | S67‡ |
| Steel hit: shot-to-"ting" delay (bullet TOF + sound return) | 7 m 41 ms · 10 m 58 ms · 15 m 88 ms · 25 m 147 ms · 35 m 207 ms · 50 m 298 ms | APPROX (solver + 343 m/s) | §5.2, S66‡ |
| Perception | ≤ 15 m the ring fuses with the report ("bang-ting" as one event); 25 m clearly separate; 50 m a distinct late "tink" | APPROX | — |
| Plate ring pitch (free circular plate, 3/8 in steel) | lowest modes: 6 in ≈ 2.1 / 3.6 / 4.9 kHz; 8 in ≈ 1.18 / 2.04 / 2.74 kHz; 10 in ≈ 0.75 / 1.30 / 1.76 kHz; 12 in ≈ 0.52 / 0.91 / 1.22 kHz | APPROX (f = λ²/(2πa²)·h·√(E/12ρ(1−ν²)), λ² = 5.25, 9.08, 12.2) | S68‡ |
| Size/thickness law | pitch ∝ thickness / diameter². 10 in plate: ¼ in ≈ 0.50 kHz, ⅜ in ≈ 0.75 kHz, ½ in ≈ 1.0 kHz | APPROX | S68‡ |
| Vendor description | ¼ in short high "tink"; ⅜ in "moderate-sustain ping"; ½ in longer deeper tone; chains/straps ring better than rigid mounts; mild or damaged plate rings duller/shorter | OBSERVED (conflicts with the thickness law — vendors' thicker plates are also larger) | S69‡ |
| Ring decay | ≈ 0.3–1.0 s to inaudible on chains; plus chain rattle during swing | APPROX (unsourced) | — |
| Earth berm impact | dull "thud/shmuck" and a visible puff of dust or sand; quiet enough that it is noticed mainly near the berm | OBSERVED (rifle anecdotes) | S70‡ |

---

## 8. Targets and range architecture

### 8.1 Steel

| Item | Value | Tag | Src |
|---|---|---|---|
| Pistol plate | 3/8 in (9.5 mm) AR500, flat, chain/strap or hook hung | OBSERVED | S71, S72 |
| Hardness | AR500 ≈ 477–550 BHN (suppliers quote 460–544 / 470–540) | MEASURED (supplier specs) | S73‡ |
| Round gong weights, 3/8 in | 5 in ≈ 2 lb · 8 in ≈ 5 lb (2.4 kg) · 10 in ≈ 8 lb (3.8 kg) · 12 in ≈ 12 lb (5.5 kg) | MEASURED (vendor) | S71 |
| Competition sizes | 10 in and 12 in rounds, 18 × 24 in rectangle (Steel Challenge); placed 7–35 yd | MEASURED (rules summary) | S74‡ |
| Minimum distance, handgun | **10 yd (9.1 m)** on 3/8 in AR500 — manufacturers agree; a 7 m plate breaks this guidance (one forum post cites 23 ft for USPSA) | MEASURED (guidance) | S72, S71, S75‡ |
| Angle | never engage at more than 20° off square; plate often hung tilted 10–20° face-down | OBSERVED | S72, S76‡ |
| Fragment zone | ≈ 95 % of fragments leave within 0–20° of the plate face (a flat radial disc) | OBSERVED | S77‡ |
| Plate condition | must stay flat and smooth; cratered/pitted plates are retired | OBSERVED | S72 |
| Bullet on plate | FMJ flattens and sprays radially along the face; flash/sparks at contact in high-speed footage | OBSERVED | S78, S79‡ |
| Splash mark | "heavy grey impact marks" on white paint; paint is stripped beyond the hit; ranges re-spray white between strings | OBSERVED | S80‡ |
| Splash size | bare grey-silver disc ≈ 2–4 cm with radial streaks to ≈ 6–10 cm | APPROX (unsourced size) | S80‡ |

Swing from one 9 mm hit `[APPROX]`: fragments leave sideways, so the plate takes ≈ the bullet's momentum p
(124 gr from the P38: 2.72 N·s at 10 m, 2.64 at 25 m, 2.52 at 50 m, §5; table computed with 2.75/2.67/2.55 — within 1°). v = p / M; rise h = v² / 2g; angle θ = arccos(1 − h / L),
L = pivot-to-centre distance (0.25 m chain + radius assumed); period T = 2π√(L/g).

| Plate (3/8 in) | Mass | v after hit | Swing θ (10 m → 50 m) | Peak deflection | Period |
|---|---|---|---|---|---|
| 6 in | 1.36 kg | 2.0 m/s | 69° → 63° (may flip on short hangers) | ≈ 30 cm | 1.15 s |
| 8 in | 2.42 kg | 1.1 m/s | 36° → 33° | ≈ 20 cm | 1.19 s |
| 10 in | 3.79 kg | 0.7 m/s | 22° → 20° | ≈ 14 cm | 1.23 s |
| 12 in | 5.46 kg | 0.5 m/s | 15° → 13° | ≈ 10 cm | 1.27 s |

Off-centre hits add twist about the chain axis; swing damps over ≈ 5–10 cycles `[APPROX, unsourced]`.

### 8.2 Paper and cardboard

| Target | Dimensions | Tag | Src |
|---|---|---|---|
| NRA B-8 (25 yd timed/rapid) | ring diameters: X 1.695 in (43.1 mm); 10 = 3.36 in (85.3 mm); 9 = 5.54 in (140.7 mm, edge of black); 8 = 8.00 in (203 mm); 7 = 11.00 in; 6 = 14.80 in; 5 = 19.68 in. Repair centre is letter-size and shows X–8 | MEASURED | S81, S82‡ |
| ISSF 25 m precision / 50 m pistol | 10 = 50 mm; each ring +50 mm to 1-ring = 500 mm; inner ten 25 mm; black = rings 7–10 = 200 mm; card 550 × 550 mm; ring lines 0.2–0.5 mm; numerals 1–9 only | MEASURED (ISSF 6.3.4.5) | S83‡, S84‡ |
| USPSA cardboard | ≈ 18.12 × 29.93 in (460 × 760 mm) octagonal torso with head; lower A-zone ≈ 6 × 11 in (15 × 28 cm); smaller upper A in head; C and D outside; 1/8 in (3 mm) corrugated, die-cut; scoring A5/C3/D1 minor | MEASURED (vendor/rules) | S85, S86, S87‡ |
| IPSC target | ≈ 45 × 57 cm (≈ 46 × 58 cm with 5 mm non-scoring border); A ≈ 15 × 32.5 cm; C ≈ 30 × 45 cm | MEASURED (vendor) | S88‡ |
| IDPA cardboard | 18 × 30 in; 8 in "−0" chest circle; 4 in circle in 6 in head box | MEASURED (vendor chart) | S81 |

Bullet holes `[OBSERVED]` S89‡, S90‡: round-nose FMJ stretches and tears paper — a ragged hole *smaller* than the
bullet with short radial tears, ringed by a dark grey bullet-wipe/grease ring that stops short of full calibre;
loosely hung thin paper tears larger. Wadcutters punch clean full-calibre "cookie-cutter" holes. Sim values
`[APPROX]`: visible hole 6–8 mm for the 9.01 mm bullet, wipe ring out to ≈ 9 mm; in 3 mm corrugated cardboard a
rounder ≈ 8–9 mm hole with a slightly pushed-out rear face; overlapping hits merge into one ragged hole.

### 8.3 Breakables

| Item | Value | Tag | Src |
|---|---|---|---|
| Clay target, international | Ø 110 ± 1 mm; height 25–26 mm; 105 ± 5 g; base 11 mm, ring Ø 95–98 mm, dome 8 mm | MEASURED (ISSF 6.3.7) | S91‡ |
| Clay target, US | ≈ 108–109.5 mm × 28–29 mm; ≈ 100 g | MEASURED | S92‡, S93‡ |
| Clay colours | orange dome (often black rim); all-black, white, green also sold | APPROX (unsourced) | — |
| Clay break | brittle: a 9 mm hit anywhere shatters it into ≈ 5–15 shards plus a puff of dust; edge-on clipping chips a piece | APPROX (unsourced) | — |
| Glass, generally | high-speed projectile leaves a cone/crater with radial cracks first, then concentric cracks; crack count rises with energy; crack speed in glass ≈ 5,100 m/s class (sound speed) | MEASURED (forensic/failure lit.) | S94‡, S95‡ |
| Glass bottle, empty | shatters almost completely; shards thrown mostly downrange and sideways; base and neck often survive as large pieces | APPROX (unsourced) | S94‡ |
| Glass bottle, water-filled | bursts outward in all directions with a spray cloud (hydraulic pressure) | APPROX (unsourced) | S95‡ |

### 8.4 Range layout

| Item | Value | Tag | Src |
|---|---|---|---|
| Pistol lane spacing | 5 ft (1.52 m) centre-to-centre (DOE); 4 ft (1.22 m) minimum firing point (NRA rules/RSB) | MEASURED (design criteria) | S65, S96‡ |
| Firing-line depth, pistol | ≈ 6–10 ft (1.8–3.0 m) | MEASURED | S65 |
| Firing-line cover | weather shelter; usually wood, shed or gable roof; corrugated metal common but noisy | OBSERVED | S65 |
| Ballistic canopy (baffled ranges) | starts ≥ 3 ft (0.9 m) behind the line, extends ≥ 13 ft (4 m) forward; USAF: ≥ 1 m behind, ≥ 4 m forward | MEASURED | S65, S97‡ |
| Roof height | no published value for firing-line covers (DOE gives 8 ft ceilings for indoor ranges); use eave ≈ 2.4–2.7 m, ridge ≈ 3.0–3.3 m | APPROX | S65 |
| Bench height, pistol | 36 in (0.91 m) (NRA RSB 4.03.15); Minnesota guide says 30 in | MEASURED | S96‡ |
| Firing-line surface | concrete, gravel, wood, asphalt or sod; smooth, firm, graded to drain; lanes marked on the surface | MEASURED | S65 |
| Range floor | compacted earth with mown grass; sand or fine gravel | MEASURED | S65 |
| Target line | ≥ 30 ft (9.1 m) in front of the berm toe; target spacing = lane spacing | MEASURED | S65 |
| Target holders | portable 2 × 4 in wood frames, or 2 × 2 in wood uprights in buried PVC sockets; no metal within 33 ft (10 m) of the firing line | MEASURED | S65 |
| DIY stand | H-base from an 8 ft 2 × 4; two 1 × 2 in furring-strip uprights; cardboard backer stapled on; paper stapled to cardboard; uprights get shot and replaced | OBSERVED | S98‡ |
| Backstop berm height | 16 ft (4.9 m) for ranges ≤ 50 yd, 26 ft (7.9 m) for ≥ 100 yd (DOE); 20 ft (6.1 m) NRA RSB (15 ft floor); NJ: 12 ft for 25 yd, 20 ft for 50 yd; Tennessee: 12 ft | MEASURED | S65, S96‡, S99‡ |
| Berm shape | face 1:1 or steeper; flat top 10 ft (3 m) (MN: 4 ft); 3 ft stone-free soil face; grassed | MEASURED | S65, S96‡ |
| Side berms | 8 ft (2.4 m) minimum, 10–12 ft preferred; inside slope 1:1.5; ≥ 10 ft outside the outer lane centreline | MEASURED | S65, S99‡ |
| Overhead baffles | optional; wood/ballistic panels 5–8 ft deep spanning the range, each overlapping the line of sight under the previous one | MEASURED | S65 |
| Signage | permanent warning signs around the danger zone, range poles/banners/flags; red flag when live | OBSERVED | S65 |
| Clutter | brass buckets, brooms, staple guns, target pasters/tape, spray-paint cans (white, for steel), sandbag rests, spare furring strips, shot-up cardboard, ammo boxes and trays, ear/eye-protection hooks, rule boards, lane numbers | APPROX (general; only stands, staple guns, sandbags, paint sourced) | S98‡, S80‡ |

Suggested lane distances for this range `[APPROX]`: paper/cardboard at 7, 10, 15, 25 m; steel at 10, 15, 25, 35,
50 m; bottles/clays on a rail at 10–15 m in front of the berm; berm toe ≥ 9 m behind the 50 m line.

---

## 9. Presentation references (none inspected — URLs from search results only)

No P38/P1-specific footage URL was collected before the firearm change; F1–F6 are Glock clips, useful only for generic
framing, recoil arc and slide-cycle timing. P38-specific footage (left ejection, hammer, heel reload) still needs finding.


| # | Reference | URL | Use for |
|---|---|---|---|
| F1 | POV Glock 17 Shooting At The Range | https://www.youtube.com/watch?v=6J5sipzaRw4 | first-person framing, sight picture, hand occlusion — Glock, generic use only (video, not directly inspected) |
| F2 | Slow Motion Glock 17 POV (240 fps, steel plates) | https://www.youtube.com/watch?v=FmG-fqAqtyM | recoil arc and sight return from the shooter's eye (video, not directly inspected) |
| F3 | Hellenic SF Glock 17 in slow motion (600 fps) | https://www.youtube.com/watch?v=xleZLsdebcw | slide cycle, barrel tilt, case ejection path (video, not directly inspected) |
| F4 | Custom G17 at 1,000 fps (via GlockTalk thread) | https://www.youtube.com/watch?v=TmN99t7ulSE | slide timing frame-count check (video, not directly inspected) |
| F5 | Glock Super Slow Mo Firing and Reloading | https://www.youtube.com/watch?v=KyOg1ABPUEs | reload hand motion, magazine drop (video, not directly inspected) |
| F6 | Glock 17 Animation (cutaway) | https://www.youtube.com/watch?v=8rt5c-Y_jU0 | order of internal events in §1.5 (animation, not directly inspected) |
| F7 | .45 ACP + 9 mm on hardened plate, 600 fps | https://www.youtube.com/watch?v=KL0FQYhqCCg | radial splash on AR500 (video, not directly inspected) |
| F8 | Bullet hitting steel target, 960 fps | https://www.youtube.com/watch?v=srVouyX_WOQ | plate swing and fragment disc (video, not directly inspected) |
| F9 | 1 million fps bullet impacts (Werner Mehl / Kurzzeit) | https://www.youtube.com/watch?v=QfDoQwIAaXg | bullet disintegration on steel (video, not directly inspected) |
| F10 | Slow Mo Guys "Bullets vs Steel" (write-up) | https://gigazine.net/gsc_news/en/20231107-bullets-vs-steel-800000-fps | 9 mm on steel up to 800,000 fps; contact flash (article read via S78; video not inspected) |
| F11 | Hickok45 "Range Tour 2" | https://www.youtube.com/watch?v=omVvuRFuAZ4 | outdoor range layout, hanging steel, berms, clutter (video, not directly inspected) |
| G1 | Ready or Not (VOID Interactive) | https://store.steampowered.com/app/1144200/Ready_or_Not/ · audio dev update https://steamcommunity.com/games/1144200/announcements/detail/3024709701809259416 | indoor/outdoor weapon audio layering, restrained recoil (game, not directly inspected) |
| G2 | Receiver 2 (Wolfire) | https://store.steampowered.com/app/1129310/Receiver_2/ | every pistol part simulated incl. DA/SA hammers, decockers, chamber checks (game, not directly inspected) |
| G3 | Hot Dogs, Horseshoes & Hand Grenades | https://store.steampowered.com/app/450540/Hot_Dogs_Horseshoes__Hand_Grenades/ | manual manipulation fidelity, range-toy feel (game, not directly inspected) |
| G4 | Ground Branch | https://store.steampowered.com/app/16900/GROUND_BRANCH/ | true first-person body, shots leave the real barrel (game, not directly inspected) |
| G5 | Unrecord (DRAMA) | https://en.wikipedia.org/wiki/Unrecord | photoreal body-cam presentation, free-aim pistol (trailer/game, not directly inspected) |
| G6 | Escape from Tarkov | https://www.escapefromtarkov.com/ | weapon handling states, chamber checks, audio detail (game, not directly inspected) |

---

## 10. Key simulation parameters (single recommended values) — Walther P38 / P1

| Quantity | Value | Tag | Src |
|---|---|---|---|
| Overall length / height / width | 214 mm / 136 mm / 37 mm | MEASURED | P2, P18‡ |
| Barrel length / sight radius | 125 mm / 178 mm | MEASURED | P2 |
| Sights | front blade on barrel, rear U-notch on slide; widths unsourced | OBSERVED | P1, P4 |
| Sight line over bore | 21 mm | APPROX | §1.3 |
| Mass P1 (alloy): empty / loaded 8 rds | 780 g / 865 g | MEASURED | P2 |
| Mass P38 (steel): empty / loaded | 960 g / ≈ 1045 g | MEASURED / APPROX | P1, P2 |
| Per round / empty magazine | 12 g / ≈ 80 g | APPROX | §1.1 |
| Capacity | 8 + 1, single stack | MEASURED | P1, P2 |
| Trigger pull: DA first shot / SA | 53 N (12 lb) / 24 N (5.5 lb); good P1: 42 N DA | MEASURED | P8‡, P9‡ |
| Trigger travel: DA / SA / reset | 15 mm / 4 mm / 5 mm | APPROX (unsourced) | §1.2 |
| Hammer states | down; cocked (stays cocked after every shot and at slide-lock) | OBSERVED | P2 |
| Safety/decocker | slide, left; up = Fire (red F), down = Safe (white S) and drops the hammer safely | OBSERVED | P2, P4 |
| Loaded-chamber signal pin | protrudes above hammer when chambered | OBSERVED | P1, P2 |
| Slide stop | left frame above trigger; locks open on empty | OBSERVED | P4 |
| Magazine catch | heel; push back, pull magazine out by hand | OBSERVED | P2, P4 |
| Action | short recoil, pivoting locking block; barrel moves straight back 6.4 mm, no tilt | OBSERVED | P4 |
| Slide stroke | 50 mm | APPROX (unsourced) | §1.5 |
| Twin recoil springs | in frame, hidden | OBSERVED | P1 |
| Lock time (hammer) | 6 ms | APPROX | §1.2 |
| Slide rearward / full cycle | 9 ms / 55 ms | APPROX (by analogy) | App. A |
| Splits (SA) | 0.18–0.25 s trained; floor 0.11 s; DA first shot +0.15 s | OBSERVED / APPROX | S24‡–S26‡ |
| Ejection | **LEFT**, up-left 45–70°, 3 m/s ± 30 %, lands 0.5–1.5 m left, erratic | OBSERVED (side) / APPROX (numbers) | P1, P3, P4 |
| Recoil impulse (124 gr) | 2.95 N·s | APPROX | S23 |
| Free recoil velocity, P1 full → empty | 3.4 → 3.8 m/s (steel P38: 2.8 → 3.1) | APPROX | S23, P2 |
| Muzzle rise / time to peak / back on target | 6° / 60 ms / 0.20 s | APPROX | §3 |
| Emergency reload (trained) | 3.2 s shot-to-shot; typical 5–6 s | APPROX | §4.1 |
| Reload with retention | 4 s | APPROX | §4.1 |
| Muzzle velocity 115 gr / 124 gr | 349 m/s / 346 m/s; SD 3–4 m/s | MEASURED (mean of chronograph reports) | P5, P11‡, S4 |
| G1 BC 115 gr / 124 gr | 0.123 / 0.154 | MEASURED / APPROX | S20‡, §5 |
| Zero | factory 50 m: +18 mm at 25 m, +9 mm at 15 m, −5 mm at 7 m (or 25 m zero: −36 mm at 50 m) | OBSERVED / APPROX | P1, §5.2 |
| TOF 10 / 25 / 50 m (124 gr) | 29 / 74 / 152 ms | APPROX | §5.2 |
| Dispersion | σ 0.8 mrad per axis mechanical; 0.95 mrad incl. ammo and rest | APPROX | §5.3 |
| Muzzle flash | daylight: none or ≤ 1 frame faint; real duration 1–2 ms; dusk: 4–8 cm orange | MEASURED / APPROX | S50‡, §6 |
| Peak SPL at shooter | 160 dB (1 m to the side; 9 mm pistol, 114 mm barrel) | MEASURED | S56 |
| Blast duration / dominant band | 2 ms / 500–800 Hz | MEASURED | S60, S56 |
| Roof reflection (2.7 m) / ground reflection | +5 ms, −12 dB / +7 ms | APPROX | §7.2 |
| Covered vs open exposure | +2–3 dB, RT60 0.5 s vs 0.25 s + berm slap-back | APPROX | §7.2 |
| Speed of sound | 343 m/s | MEASURED | S66‡ |
| Supersonic crack | none (both loads ≈ Mach 1.01–1.02 at muzzle, subsonic within 4–6 m) | APPROX | §7.3 |
| Steel "ting" delay 10 / 25 / 50 m | 58 / 147 / 298 ms | APPROX | §7.3 |
| Steel ring fundamental 8 / 10 / 12 in × 3/8 in | 1.18 / 0.75 / 0.52 kHz | APPROX | §7.3 |
| Steel plate mass 8 / 10 / 12 in | 2.4 / 3.8 / 5.5 kg | MEASURED | S71 |
| Plate swing per hit 8 / 10 / 12 in | 34° / 21° / 14°, period 1.2 s | APPROX | §8.1 |
| Minimum steel distance | 10 yd (9.1 m) — first steel at 10 m, not 7 m | MEASURED (guidance) | S72 |
| Splash mark | 3 cm grey disc + streaks to 8 cm | APPROX | §8.1 |
| Paper hole | 7 mm ragged + grey ring to 9 mm | APPROX | §8.2 |
| B-8 rings X / 10 / 9 (black) / 8 | 43.1 / 85.3 / 140.7 / 203.2 mm | MEASURED | S81 |
| USPSA target / A-zone | 460 × 760 mm / 150 × 280 mm | MEASURED | S85 |
| ISSF 25 m: 10-ring / black / 1-ring | 50 / 200 / 500 mm | MEASURED | S83‡ |
| Clay | Ø 110 mm × 25.5 mm, 105 g | MEASURED | S91‡ |
| Lane spacing / line depth / bench | 1.5 m / 2.4 m / 0.91 m | MEASURED | S65, S96‡ |
| Berm height / face slope / side berm | 4.9 m (6.1 m NRA) / 1:1 / 2.4 m | MEASURED | S65, S96‡ |
| Roof eave height | 2.6 m | APPROX | §8.4 |

Fallback comparison only (Glock 17, **not** the simulated pistol): 202 × 139 × 32 mm, 114 mm barrel, 705 g / 915 g,
17 + 1, 28 N striker trigger, right ejection ≈ 1.5 m, tilting barrel, 360 / 350 m/s — details in Appendix A.

## 11. Not sourced / weakly sourced (treat as open)

P38/P1-specific:
- **Slide stroke length** (50 mm is an estimate); **exact barrel travel** (sources give 0.25 in, 5/16 in; 5 mm for the P5).
- **Any instrumented slide velocity, cycle time or lock time** for the P38/P1 — values are by analogy with other 9 mm pistols.
- **DA and SA trigger travel and reset distance**; hammer arc angle.
- **Sight dimensions** (front blade width/height, notch width/depth), **sight height over bore**, and whether the asset's sights carry the P1 dot/bar.
- **Magazine mass** (empty/loaded) and slide/barrel component masses; per-round mass is inconsistent between sources (10.6 vs 12.35 g).
- **Steel P38 empty weight** — sources range 880 g to 1077 g; 960 g used.
- **Ejection distance, angle and speed** — only "left", "vertical", "erratic" descriptions; no forensic pattern study found for the P38.
- **Timed heel-release reloads** — none found; reload durations are baseline + estimate.
- **Muzzle rise/recovery for a P38/P1** — none found.
- **P1 chronograph table** (image only); GunsAmerica P1 page could not be opened (trigger figures via search extract).
- **Hammer bite / top-cover quirks** — not found in the sources consulted.
- Gun Tests accuracy distance not stated; its 4.5 in barrel and 7.0 vs 4.25 lb SA figures are internally inconsistent.

Generic:
- **124 gr G1 BC** — back-fitted (0.154 Federal table; 0.19 Speer table).
- **Low-ready-to-shot time** — no timed data.
- **Flash size/brightness by light level; visible smoke quantity** — forum descriptions only; duration sources conflict (1–2 ms vs ≈ 20 ms).
- **A-duration for 9 mm** — one relayed figure (0.3 ms); **RT60 or level increase of a roofed, open-sided firing line** — not found; indoor and treated-shed data used as brackets.
- **AR500 ring spectrum and decay** — no measurement found; frequencies are plate-theory estimates (λ² constants quoted from memory of Leissa; S68 not opened).
- **Splash-mark size, paper/cardboard hole size, clay and bottle fragment counts, berm impact sound of 9 mm** — qualitative sources only.
- **Roof height of firing-line covers; USPSA zone dimensions from the rulebook itself** (diagrams are images); **NRA Range Source Book** (PDF link dead — snippets only).
- All videos and games in §9; the Poly Haven model itself.

---

## Appendix A — Glock 17 comparison data (NOT the simulated pistol)

Kept as a fallback/reference and because it holds the only instrumented slide-timing data found.

### A1.1 Dimensions, mass, capacity

| Item | Value | Tag | Src |
|---|---|---|---|
| Overall length | 202 mm (Gen4); 204 mm (Gen3 row of manual table) | MEASURED | S1, S2 |
| Slide length | 186 mm | MEASURED | S1 |
| Width overall / slide | 32 mm / 25.5 mm | MEASURED | S1 |
| Height incl. magazine | 139 mm | MEASURED | S1 |
| Barrel length | 114 mm (4.49 in) | MEASURED | S1 |
| Rifling | hexagonal polygonal, right-hand, 6 "grooves", twist 250 mm (9.84 in) | MEASURED | S2 |
| Sight radius | 165 mm polymer / 164 mm steel / 163 mm GNS | MEASURED | S1 |
| Trigger reach ("trigger distance") | 70 mm (Gen4 small backstrap; M +2 mm, L +4 mm) | MEASURED | S1, S2 |
| Grip angle | 109° | MEASURED | S3 |
| Mass, no magazine | 625 g | MEASURED | S1 |
| Mass, empty magazine in | 705 g (review scale-check: 24.79 oz = 703 g) | MEASURED | S1, S4 |
| Mass, loaded (17 rds) | 915 g | MEASURED | S1 |
| Empty magazine | 80 g (705 − 625) | APPROX (difference of specs) | S1 |
| Per cartridge | 12.35 g ((915 − 705) / 17) | APPROX (difference of specs) | S1 |
| Empty case | ≈ 4 g (12.35 g − 7.45 g bullet − ~0.3 g powder − primer) | APPROX | S1, S22‡ |
| Cartridge geometry | bullet Ø 9.01 mm; case length 19.15 mm; max overall length 29.69 mm | MEASURED | S5‡ |
| Magazine | 17 rds double-stack; steel body over-moulded in polymer, numbered witness holes on the rear face | MEASURED/OBSERVED | S1, S3 |
| Recoil / striker spring ratings | 17 lb recoil; 5.5 lb striker | MEASURED (as listed by reviewer) | S4 |
| Parts moving mass: slide alone | ≈ 0.36 kg (implied by 1.31 kg·m/s ÷ 3.60 m/s in S7) | APPROX | S7‡ |
| Complete slide assembly (slide+barrel+spring) | ≈ 405 g (14.3 oz retailer figure) | OBSERVED | S8‡ |

### A1.2 Trigger

| Item | Value | Tag | Src |
|---|---|---|---|
| Trigger pull | 28 N (6.3 lb) Gen4 spec; ~25 N (5.5 lb) standard connector on older specs | MEASURED | S1, S2, S3 |
| Trigger travel (factory figure) | ≈ 12.5 mm (0.49 in) | MEASURED | S2, S3 |
| Take-up to first pressure point ("wall") | ≈ 5 mm (0.2 in) | MEASURED | S2 |
| Total travel on a trigger-scan rig | 0.34 in (8.6 mm) stock Gen3 — smaller than factory figure; datum differs | MEASURED | S9‡ |
| Reset distance (forward travel to audible/tactile click) | ≈ 3.2–3.3 mm (0.125–0.13 in) | OBSERVED (owner calipers; magazine spec table) | S10‡, S11‡ |
| Over-travel | ≈ 0 | OBSERVED | S11‡ |
| Feel | light spongy take-up → firm wall → break; trigger stays rearward until released | OBSERVED | S2, S4 |

### A1.3 Sights

| Item | Value | Tag | Src |
|---|---|---|---|
| Standard pattern | polymer; ramped front post with **white dot**; rear notch with **white U/rectangular outline** ("ball-in-cup"). Steel and night sights (GNS) are 3-dot. One reviewer loosely calls the stock set "3-dot". | OBSERVED | S2, S3, S4 |
| Rear sight height | 6.5 mm standard (options 6.1 / 6.9 / 7.3 mm, coded by side bars) | MEASURED | S2 |
| Front sight height | 4.1 mm | OBSERVED | S12‡ |
| Front post width | ≈ 3.85 mm (0.151–0.152 in) | OBSERVED (forum calipers) | S13‡ |
| Rear notch width | ≈ 3.45–3.55 mm (0.135–0.140 in) | OBSERVED (forum calipers) | S13‡ |
| Sight line above bore axis | ≈ 18 mm (0.7 in). No published figure found; generic "0.7–1.5 in for pistols" only | APPROX | S14‡ |
| Apparent post width | 6.3 mrad with eye 450 mm behind rear sight (assumed) → covers 63 mm at 10 m, 157 mm at 25 m, 314 mm at 50 m | APPROX (3.86 mm / 615 mm) | S13‡, S1 |
| Light bar each side of post | ≈ 0.8 mrad ≈ 13 % of post width (notch 3.56 mm / 450 mm = 7.9 mrad) | APPROX | S13‡ |

### A1.4 Visible controls and features (right-handed pistol)

| Control | Position / look | Tag | Src |
|---|---|---|---|
| Trigger + trigger-safety blade | blade in centre of trigger face; protrudes forward at rest, sits flush while pressed | OBSERVED | S2 |
| Slide stop lever | left side of frame directly below the slide, above the thumb; small stamped tab inside a raised moulded guard; up = lock, down = release | OBSERVED | S2, S3 |
| Magazine catch | left side at rear of trigger guard; Gen4 enlarged and reversible | OBSERVED | S2, S3 |
| Slide lock (take-down) | small serrated tabs on both sides of frame above the trigger | OBSERVED | S2 |
| Extractor / loaded-chamber indicator | right side of slide just behind ejection port; flush when chamber empty, front edge pivots outward when a round is chambered | OBSERVED | S2, S3 |
| Ejection port | top-right of slide; barrel hood (chamber block) visible in it and forms the locking surface | OBSERVED | S3 |
| Striker status | **no cocked-striker indicator** on the slide rear. Status cue is the trigger: forward = striker part-tensioned (pistol may be loaded); rearward = striker released | OBSERVED | S2 |
| Manual safety / hammer | none | OBSERVED | S2 |
| Gen3 vs Gen4 | Gen3: finger grooves, thumb rests, accessory rail, single recoil spring. Gen4: same plus RTF4 square-stud texture, "Gen4" roll-mark on slide, dual captive recoil spring, larger mag catch, interchangeable backstraps | OBSERVED | S3 |

### A1.5 What moves during one shot (order)

| # | Event | Number | Tag | Src |
|---|---|---|---|---|
| 1 | Safety blade pressed flush; trigger take-up; firing-pin safety lifted; striker fully tensioned | ≈ 5 mm take-up, 12.5 mm total | MEASURED | S2 |
| 2 | Striker release → primer strike | lock time 3.1 ms measured (3.0–3.2 ms calculated) | MEASURED | S15‡ |
| 3 | Bullet travels bore | ≈ 0.5–0.7 ms (2 × 95 mm / 350 m/s, constant-acceleration bound) | APPROX | S1 |
| 4 | Slide + barrel recoil locked together | ≈ 2.5 mm (manual) / ≈ 3 mm | MEASURED | S2, S3 |
| 5 | Barrel cams down over locking block and stops; breech end drops, muzzle tips up slightly inside the slide | drop distance not published | OBSERVED | S2, S3 |
| 6 | Slide continues alone; extractor pulls case; ejector throws it out to the right | full stroke ≈ 45–50 mm (must exceed 29.69 mm cartridge length; no published figure) | APPROX | S2, S5‡ |
| 7 | Slide strikes frame at rear | 3.60 m/s at impact; Δp 1.31 kg·m/s over 1.2 ms; mean force 1089 N (high-speed camera, Phantom v12) | MEASURED | S7‡ |
| 8 | Recoil spring returns slide; next round stripped and chambered; barrel rises and locks; extractor pivots out | — | OBSERVED | S2 |
| 9 | Trigger released → reset click; blade pops forward | ≈ 3.2 mm forward | OBSERVED | S10‡ |
| 10 | Last round: slide stop lever rises and holds slide open (only with a magazine inserted) | — | OBSERVED | S2 |

### A1.6 Ejection

| Item | Value | Tag | Src |
|---|---|---|---|
| Side | right ("thrown out to the right by the ejector") | OBSERVED | S2 |
| Landing direction | right-rear, 3–5 o'clock; G17 cases land in an angled, roughly linear band to rear-right | OBSERVED/MEASURED (surveyed pattern) | S16‡, S17 |
| Landing distance | ≈ 1.5 m (5 ft) right for standard loads, farther for hot loads; forum range 1.2–1.8 m; weak target loads ≈ 0.6 m | OBSERVED | S4, S16‡ |
| Spread across guns/shooters | mean 2.06 m, range 0.09–6.44 m; 26.4 % did not land right-rear (7,670 rounds, 8 handguns) | MEASURED | S18‡ |
| Launch speed | ≈ 2.5–3.5 m/s (projectile motion: 1.5–2.1 m carry from 1.5 m port height, 0.55 s fall). No instrumented value found | APPROX | S4 |
| Flight | case tumbles; brief trail of grey smoke from case mouth; brass rings when it hits concrete | APPROX (unsourced) | — |

---

### A2 Cycle timing (Glock 17 / generic 9 mm)

| Item | Value | Tag | Src |
|---|---|---|---|
| Lock time | 3.1 ms (stock G17 striker) | MEASURED | S15‡ |
| Peak slide velocity | ≈ 7 m/s (recoil impulse 3.0 N·s ÷ ≈0.405 kg slide+barrel; ignores spring/friction) | APPROX | S8‡, S23 |
| Cross-check: 1911 .45 | peak ≈ 7.6 m/s (25 ft/s), rearward stroke ≈ 10 ms, full cycle ≈ 60 ms (encoder strip) | MEASURED | S19‡ |
| Slide velocity at rear stop (G17) | 3.60 m/s | MEASURED | S7‡ |
| Rearward stroke time (G17) | ≈ 8–10 ms (≈47 mm at mean ≈5.3 m/s between 7 and 3.6 m/s) | APPROX | S7‡ |
| Full cycle, shot to in-battery | ≈ 50–55 ms (G18, same mechanism, cycles 1100–1200 rpm) | APPROX from MEASURED rate | S6‡ |
| Return stroke | ≈ 40–45 ms (cycle − rearward stroke) | APPROX | S6‡ |
| Mechanical rate limit | ≈ 18–20 shots/s | APPROX | S6‡ |
| Splits, recreational shooter (7 yd) | 0.30–0.40 s | OBSERVED | S24‡ |
| Splits, club competitor | 0.20–0.25 s | OBSERVED | S24‡ |
| Splits, Master / Grand Master | 0.18–0.22 s / 0.15–0.18 s | OBSERVED | S25‡ |
| Fastest human splits | ≈ 0.10–0.13 s (exceptional, close targets) | OBSERVED | S26‡ |
| Practical semi-auto rate | 4–5 aimed shots/s trained; ≈ 6–7 /s expert; ≈ 8–10 /s absolute human ceiling | APPROX (reciprocal of splits) | S24‡–S26‡ |

Animation consequence: at 60 fps the whole slide cycle spans ≈ 3 frames (rearward < 1 frame); the slide is back in
battery long before a human can reset the trigger (≥ 100 ms).

---

## Sources

| ID | Source | URL |
|---|---|---|
| S1 | Glock Inc., G17 Gen4 technical data | https://us.glock.com/en/products/law-enforcement/pistols/g17-gen4 |
| S2 | Glock "Instructions for Use", all models (PDF copy) | https://www.mcarbo.com/.Owners%20Manuals/Glock-Owners-Manual.pdf |
| S3 | Wikipedia, "Glock" | https://en.wikipedia.org/wiki/Glock |
| S4 | S. A. Camp, "A Critical Look at the Glock 17" | https://hipowersandhandguns.com/a-critical-look-at-the-glock-17/ |
| S5 | Wikipedia, "9×19mm Parabellum" | https://en.wikipedia.org/wiki/9%C3%9719mm_Parabellum |
| S6 | Athlon Outdoors, Glock 18 (1100–1200 rpm) | https://athlonoutdoors.com/article/glock-18-machine-pistol/ |
| S7 | Fikus et al., "Experimental Investigations of Motion of Slide of Selected Pistol Types", Problemy Mechatroniki 7(4), 2016 | https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-217a55a1-af13-4b45-b8e6-76da61b0f88d/c/B_Fikus.pdf |
| S8 | Precision Glock Slides, G17 Gen3 OEM complete slide | https://precisionglockslides.com/product/glock-17-gen-3-mos-oem-slide/ |
| S9 | Pew Pew Tactical, Glock triggers (TriggerScan) | https://www.pewpewtactical.com/best-glock-triggers/ |
| S10 | AR15.com, Glock trigger reset distance | https://www.ar15.com/forums/handguns/Glock_trigger_reset_distance_question/13-71718/ |
| S11 | Gun Tests, drop-in Glock triggers compared | https://www.gun-tests.com/handguns/drop-in-glock-triggers-apex-overwatch-timney-compared/ |
| S12 | KeepShooting, Glock OEM sights | https://www.keepshooting.com/glock-oem-fixed-rear-sight-steel-6-1mm.html |
| S13 | GlockTalk, width of factory front sight | https://www.glocktalk.com/threads/how-wide-is-the-glock-factory-front-sight.1300181/ |
| S14 | Grokipedia, "Bore axis" (low reliability) | https://grokipedia.com/page/Bore_axis |
| S15 | LSPI / Dvorak Instruments lock-time letter | https://www.lspi.com/data.html |
| S16 | GlockTalk, 9 mm Glock ejection pattern | https://www.glocktalk.com/threads/is-your-9mm-glocks-ejection-pattern-consistent.1680621/ |
| S17 | Pepper & Bloomer, J. Forensic Ident. 56(5), 2006 (G17 vs P226 ejection) | https://research.tees.ac.uk/ws/files/5895923/124552.pdf |
| S18 | "Fired Cartridge Case Ejection Patterns from Semi-Automatic Firearms", JFI | https://www.academia.edu/50276376/Fired_Cartridge_Case_Ejection_Patterns_From_Semi_Automatic_Firearms |
| S19 | 1911Forum, 1911 slide speed analysis | https://www.1911forum.com/threads/1911-slide-speed-analysis.477846/ |
| S20 | Federal American Eagle 115 gr FMJ (AE9DP) data | https://www.ammunitiontogo.com/50rds-9mm-federal-american-eagle-115gr-fmj-ammo · https://www.federalpremium.com/handgun/american-eagle/american-eagle-handgun/11-AE9DP.html |
| S21 | 124 gr FMJ tables (Federal AE9AP; Speer Lawman 53651) | https://www.bulkcheapammo.com/blog/9mm-ballistic-guide · https://www.topgunammo.com/speerlawman9mm124grtmj1000rds.html |
| S22 | pistol-forum, 9 mm recoil / typical charges | https://pistol-forum.com/archive/index.php/t-49353.html |
| S23 | SAAMI, "Gun Recoil – Technical: Free Recoil Energy" | https://saami.org/wp-content/uploads/2025/03/Gun-Recoil-Formulae-2018-07-9.pdf |
| S24 | Rifle Configurator, shot-timer split tiers | https://www.rifleconfigurator.com/tools/shot-timer-video-annotator |
| S25 | PartimerPro, USPSA classifier guide | https://partimerpro.com/uspsa-classifiers/ |
| S26 | GlockTalk, split times | https://www.glocktalk.com/threads/split-times.1664280/ |
| S27 | Wikipedia, "Free recoil" | https://en.wikipedia.org/wiki/Free_recoil |
| S28 | AccurateShooter forum, Mantis recoil readings (PPQ) | https://forum.accurateshooter.com/threads/how-to-fix-this-handgun-recoil-impulse-low-left.4103079/ |
| S29 | The Armory Life, Hellcat & Mantis X10 | https://www.thearmorylife.com/hellcat-the-mantis-x10-elite/ |
| S30 | American Handgunner, grip tuning with Mantis X10 | https://americanhandgunner.com/gear/fine-tune-your-handgun-grip-with-high-tech/ |
| S31 | Lucky Gunner, how recoil affects accuracy (high-speed) | https://www.luckygunner.com/lounge/how-recoil-affects-handgun-accuracy/ |
| S32 | KR Training, "The Reloading Pause Fallacy" | https://blog.krtraining.com/the-reloading-pause-fallacy/ |
| S33 | The Timer Lab, reload par times | https://thetimerlab.com/reload-par-time-timer/ |
| S34 | pistol-forum, sub-second slide-lock reloads | https://pistol-forum.com/archive/index.php/t-43315.html |
| S35 | airsoftshottimer.com, reload times | https://airsoftshottimer.com/en/posts/magazine-reload-guide/ |
| S36 | BoomStick Tactical, reload techniques | https://boomsticktactical.com/2025/04/19/mastering-reload-techniques-your-guide-to-speed-and-precision/ |
| S37 | Lucky Gunner, how to reload a semi-auto pistol | https://www.luckygunner.com/lounge/reload-semi-automatic-pistol/ |
| S38 | The Tactical Wire, speed vs emergency reloads | https://thetacticalwire.com/features/672726a1-796d-4359-9268-1059bd0bf355/ |
| S39 | airsoftshottimer.com, draw times (VirTra study) | https://airsoftshottimer.com/en/posts/pistol-draw-guide/ |
| S40 | USA Carry, press/chamber check | https://www.usacarry.com/press-chamber-status-check/ |
| S41 | Concealed Carry Inc., press check | https://www.concealedcarry.com/safety/why-you-should-conducting-press-check/ |
| S42 | American Shooting Journal, thumbs-forward grip | https://americanshootingjournal.com/thumbs-er-forward/ |
| S43 | Relentless Tactical, pistol grip | https://relentless-tactical.com/blogs/rto/how-to-grip-your-pistol-and-why-it-matters |
| S44 | Choice Defense Training, gripping your pistol | https://www.choicedefensetraining.com/firearms-training-blog/gripping-your-pistol |
| S45 | Shooting Illustrated, Gen5 G17 vs G22 | https://www.shootingillustrated.com/content/gen5-glock-g17-vs-gen5-glock-g22/ |
| S46 | Rangehot, Glock Gen4 17 | https://rangehot.com/function-over-form/ |
| S47 | Cheaper Than Dirt, G17 Vickers range report | https://blog.cheaperthandirt.com/glock-17-vickers-tactical/ |
| S48 | AR15.com, mechanical accuracy of a stock Glock | https://www.ar15.com/forums/Handguns/Mechanical-Accuracy-Of-A-Stock-Glock-/13-183726/ |
| S49 | Ballistipedia, range statistics (ES/σ factor; from memory, not opened) | http://ballistipedia.com/index.php?title=Range_Statistics |
| S50 | arXiv 1410.6025 (cites Burke & Bratlie 2011 flash durations) | https://arxiv.org/pdf/1410.6025 |
| S51 | DVinfo forum, muzzle flashes on video | https://www.dvinfo.net/forum/canon-eos-full-frame-hd/485036-rolling-shutter-muzzle-flashes.html |
| S52 | Ruger Forum, muzzle flash | https://www.rugerforum.net/threads/muzzle-flash.113842/ |
| S53 | AR15.com, low-flash powders | https://www.ar15.com/forums/armory/Powders_that_produce_the_least_amount_of_flash/42-246509/ |
| S54 | SIG Talk, no flash from a vigorous 9 mm load | https://www.sigtalk.com/threads/no-muzzle-flash-despite-vigorous-9mm-pistol-load.407198/ |
| S55 | 1911Forum, TMJ vs FMJ smoke; Wikipedia "Smokeless powder" | https://www.1911forum.com/threads/whats-the-difference-between-tmj-and-fmj.21830/ · https://en.wikipedia.org/wiki/Smokeless_powder |
| S56 | Murphy & Tubbs (NIOSH), J. Occup. Environ. Hyg. 4(9):688–697, 2007 | https://stacks.cdc.gov/view/cdc/186468/cdc_186468_DS1.pdf |
| S57 | E.A.R. Inc., gunfire noise level chart | https://earinc.com/gunfire-noise-level-reference-chart/ |
| S58 | yarchive, sound levels (Ylikoski 1994 data) | https://yarchive.net/gun/sound_levels.html |
| S59 | Maher & Shaw, AES 2014 (Glock 19 levels) | https://nios.montana.edu/rmaher/publications/maher_aesconf_0614_1-7.pdf |
| S60 | Maher & Routh, AES 2017 (Glock 19 waveforms vs azimuth) | https://www.montana.edu/rmaher/publications/maher_aesconf_0617_18748.pdf |
| S61 | Maher, IEEE 2006/2007 gunshot modelling | https://www.montana.edu/rmaher/publications/maher_ieeedsp_0906_257-261.pdf · https://www.montana.edu/rmaher/publications/maher_ieeesafe_0407_109-113.pdf |
| S62 | Troy Acoustics, "A Primer on Indoor Shooting Range Acoustics" (vendor) | https://www.pinecliff-hoa.com/wp-content/uploads/A-Primer-on-Indoor-Shooting-Range-Acoustics.pdf |
| S63 | Forum Acusticum 2025, auditory risk indoor vs outdoor shooting | https://dael.euracoustics.org/confs/fa2025/data/articles/000160.pdf |
| S64 | Hawai'i DLNR, shooting-range sound modelling report (2015) | https://dlnr.hawaii.gov/wp-content/uploads/2012/12/201508-Puu-Ana-hulu-Sound-Modeling-Prediction-Report.pdf |
| S65 | U.S. DOE, "Range Design Criteria" (2008) | https://files.engineering.com/files/f16b77fe-17cc-4854-ae10-064b4320b8f9/Range_Design_Criteria.pdf |
| S66 | Wikipedia, "Speed of sound" (not opened) | https://en.wikipedia.org/wiki/Speed_of_sound |
| S67 | AR15.com, sonic crack question; Silencer Shop subsonic vs supersonic | https://www.ar15.com/forums/armory/-/20-214615/?page=1&fvx=1 · https://www.silencershop.com/blog/subsonic-ammo-vs-supersonic-ammo |
| S68 | Leissa, "Vibration of Plates" (NASA SP-160), free circular plate | https://apps.dtic.mil/sti/tr/pdf/ADA307623.pdf |
| S69 | ar500steel-targets.com, "The Science of Ring"; Echogong | https://ar500steel-targets.com/the-science-of-ring-understanding-the-feedback-of-steel-targets/ · https://echogong.com/blogs/bulletinboard/the-science-behind-the-perfect-gongggg-understanding-target-acoustics |
| S70 | Canadian Gun Nutz, sound of passing bullets; AccurateShooter, sand berm | https://www.canadiangunnutz.com/forum/threads/sound-of-passing-bullets.820532/ · https://forum.accurateshooter.com/threads/sand-as-a-berm.3961693/ |
| S71 | Shoot Steel, 3/8 in AR500 round target | https://shootsteel.com/product/ar500-steel-round-target/ |
| S72 | Action Target, steel target safety guide | https://shop.actiontarget.com/content/steel-target-safety-guide.asp |
| S73 | Clifton Steel, AR400 vs AR500; Wikipedia "Abrasion resistant steel" | https://www.cliftonsteel.com/education/ar400-steel-vs-ar500-steel · https://en.wikipedia.org/wiki/Abrasion_resistant_steel |
| S74 | Shooting Sports USA, starting in Steel Challenge | https://www.ssusa.org/content/our-guide-to-starting-in-steel-challenge/ |
| S75 | 1911Forum, minimum safe distance for steel | https://www.1911forum.com/threads/min-safe-distance-for-shooting-steel-target-with-centerfire-pistol-ammo.1059811/ |
| S76 | Double Tap Industries, steel distance chart / angle | https://www.doubletapind.com/blogs/double-tap-industries/steel-target-minimum-distance-chart-pistol-vs-rifle-safe-shooting-distances-by-caliber |
| S77 | National Police Supply, steel target safety rules; Police1 | https://www.nationalpolicesupply.com/pdf/Steel_Targets_Safety_and_Use.pdf · https://www.police1.com/police-products/firearms/accessories/articles/steel-reactive-targets-safety-and-use-gotmc6cvJtbRZb1f/ |
| S78 | The Firearm Blog, Slow Mo Guys bullets vs steel | https://www.thefirearmblog.com/blog/2023/11/13/slow-mo-guys-bullets-vs-steel/ |
| S79 | Wikipedia, "Bullet trap" | https://en.wikipedia.org/wiki/Bullet_trap |
| S80 | MD Shooters, best spray paint for steel targets | https://www.mdshooters.com/threads/best-spray-paint-for-steel-targets.290288/ |
| S81 | GunZee, shooting target dimensions chart | https://gogunzee.com/blogs/range-manual/shooting-target-dimensions-chart |
| S82 | Bullseye Forum, target size info (outer rings); Guns & Ammo, B-8 | https://www.bullseyeforum.net/t13284-bullseye-target-size-info · https://www.gunsandammo.com/editorial/nra-b8-bullseye-target-comeback/462424 |
| S83 | ISSF rules 2017 (British Pistol Club copy), rule 6.3.4.5 | https://www.britishpistolclub.org/perch/resources/pdfs/20161205rules2017gtrriflepistolshotgunrunningtarget.pdf |
| S84 | Eemann Tech, ISSF 25 m precision target | https://www.eemann.tech/et-products/eemann-tech-issf-25m-precision-50m-pistol-target-100pcs/ |
| S85 | Infinity Targets, USPSA target dimensions guide | https://infinitytargets.com/blogs/training-shooting-tips/uspsa-target-dimensions-guide |
| S86 | USPSA rules, Appendix B1 (scoring; diagrams are images) | https://rules.uspsa.org/uspsa/appendix/B1 |
| S87 | Target Barn / Alco, USPSA cardboard | https://www.targetbarn.com/ipsc-100-target-barn-cardboard-targets-1.php · https://alcotarget.com/uspsa-ipsc-licensed-cardboard-shooting-target/ |
| S88 | Drummond Shooting, IPSC target; Shoot N Train | https://www.drummondshooting.ca/product/ipsc-zone-target/ · https://shootntrain.com/what-are-the-dimensions-of-an-ipsc-target/ |
| S89 | 1911Forum, target/hole question | https://www.1911forum.com/threads/target-hole-question.117987/ |
| S90 | Wikipedia, "Wadcutter" and "Semiwadcutter" | https://en.wikipedia.org/wiki/Wadcutter · https://en.wikipedia.org/wiki/Semiwadcutter |
| S91 | ISSF/USA Shooting rules 2013, rule 6.3.7 | https://usashooting.org/app/uploads/2022/04/2013_USAS_GTR.pdf |
| S92 | Wikipedia, "Skeet shooting" | https://en.wikipedia.org/wiki/Skeet_shooting |
| S93 | Triple Gambit, clay shooting basics | https://www.triplegambit.com/blogs/news/a-basic-understanding-of-clay-shooting |
| S94 | SWGMAT, "Glass Fractures" | https://www.asteetrace.org/static/images/pdf/02%20Glass%20Fractures.pdf |
| S95 | Eagar et al., J. Failure Analysis & Prevention 4(5), 2004 (bottle fracture) | https://eagar.mit.edu/publications/Eagar206.pdf |
| S96 | NRA Range Source Book (link dead; snippets) · NRA Precision Pistol Rules · Minnesota DNR | https://www.sheckels.com/Firearms/NRA_Files/NRA%20Range%20Source%20Book/Range%20Source%20Book.pdf · https://competitions.nra.org/documents/pdf/compete/RuleBooks/Pistol/pistol-book.pdf · https://www.dnr.state.mn.us/shooting_ranges/terms.html |
| S97 | USAF small arms range design guide | https://michellawyers.com/wp-content/uploads/2010/10/Air-Force-Small-Arms-Range-Design-and-Construction.pdf |
| S98 | AR15.com, Home Depot target stands; The Firearm Blog $6 stand | https://www.ar15.com/forums/t_1_5/1957683_Target_stands_which_I_can_build_using_materials_from_Home_Depot__Whatchya_got_.html · https://www.thefirearmblog.com/blog/2019/03/01/diy-cardboard-target-stand-for-less-than-6/ |
| S99 | New Jersey outdoor range standards; Tennessee firing-range rule | https://www.nj.gov/oag/dcj/pdfs/OutdoorRgStandards.pdf · https://www.law.cornell.edu/regulations/tennessee/Tenn-Comp-R-Regs-1340-02-03-.07 |
| P1 | Wikipedia, "Walther P38" | https://en.wikipedia.org/wiki/Walther_P38 |
| P2 | Walther P38 owner instruction & safety manual (English compilation of Walther/Manurhin P38–P1 manuals) | http://p-38.info/pdf/P38Manual_vRQS.pdf |
| P3 | Firearms News, "Walther P1 9mm Surplus Pistol Review" (Fortier) | https://www.firearmsnews.com/editorial/walther-p1-9mm-surplus-pistol-review/393813 |
| P4 | Athlon Outdoors, "Examining the Post-War P.1 Walthers" | https://athlonoutdoors.com/article/post-war-p-1-walthers/ |
| P5 | Gun Tests, "Walther P-38 9mm Luger" (2020) | https://www.gun-tests.com/handguns/walther-p-38-9mm-luger/ |
| P6 | Firearms News, "Walther 9mm P-38 Pistol Review" | https://www.firearmsnews.com/editorial/walther-9mm-p38-pistol-review/453012 |
| P7 | Wikipedia, "Walther P5" | https://en.wikipedia.org/wiki/Walther_P5 |
| P8 | The High Road, P1/P38 trigger pull weights (Doyle database relay) | https://www.thehighroad.org/index.php?threads/walther-p1-p38-trigger-pull-wieght.22557/ |
| P9 | GunsAmerica Digest, "The Walther P1" | https://gunsamerica.com/digest/the-walther-p1-from-war-baby-to-nato-surplus-sweetheart/ |
| P10 | Guns.com, Walther P38 review | https://www.guns.com/news/reviews/walther-p38-wwii-history-pistol-review |
| P11 | Shooting Times, "The Walther P-38" | https://www.shootingtimes.com/editorial/handgun_reviews_the_walther_p-38_102510/99823 |
| P12 | Small Arms Review, "The Influential and Innovative Walther P 38" | http://archive.smallarmsreview.com/display.article.cfm?idarticles=1388 |
| P13 | GunsAmerica Digest, "The Walther P 38, a Very Important War Dog" | https://gunsamerica.com/digest/the-walther-p-38-a-very-important-war-dog/ |
| P14 | Guns Fandom "Walther P38"; Tropedia (left ejection, low authority) | https://guns.fandom.com/wiki/Walther_P38 · https://tropedia.fandom.com/wiki/Right-Handed_Left-Handed_Guns |
| P15 | MD Shooters, "European style" magazine catch technique | https://www.mdshooters.com/threads/european-style-magazine-catch.26026/ |
| P16 | Chuck Hawks, heel clip magazine release | https://www.chuckhawks.com/heel_clip_mag_release.html |
| P18 | Wikidata, Walther P38 (Q157586) | https://www.wikidata.org/wiki/Q157586 |
