class_name WeaponDef
## Parameters of the simulated pistol: P38/P1-pattern 9x19 mm service pistol as represented by the
## Poly Haven "Service Pistol" model (DA/SA, slide-mounted safety/decocker, 8-round single-stack magazine,
## push-button magazine catch on this model). Tags: [M] measured/published, [O] observed, [A] approximation.
## Sources: docs/REFERENCES.md.

const MAG_CAPACITY := 8                 # [M]
const MAGAZINES := 6                    # magazines carried per session (1 in the gun + 5 spare) [A]

# --- mechanism geometry (docs/WEAPON_CONTRACT.md) ---
const SLIDE_STROKE := 0.048             # m [A]
const SLIDE_LOCK_POS := 0.045           # m, held by the slide stop [A]
const BARREL_TRAVEL := 0.0064           # m, straight-line short recoil [O]
const HAMMER_COCKED_DEG := 50.0         # [A]
const HAMMER_DA_PEAK_DEG := 40.0        # hammer arc reached before a double-action release [A]
const TRIGGER_SA_REST_DEG := -20.0
const TRIGGER_BREAK_DEG := -28.0
const TRIGGER_OVERTRAVEL_DEG := -30.0
const TRIGGER_RESET_DEG := -23.0        # disconnector reset point on release [A]
const SAFETY_SAFE_DEG := -55.0

# --- timing (seconds) ---
const LOCK_TIME := 0.005                # sear release -> ignition [A, by analogy]
const DA_PULL_TIME := 0.11              # long double-action stroke at a brisk pull [A]
const SLIDE_REAR_TIME := 0.016          # ignition -> slide fully rearward [A]
const SLIDE_DWELL := 0.002
const CYCLE_TIME := 0.055               # ignition -> back in battery [A]
const EJECT_TIME := 0.011               # case clears the breech [A]
const FEED_TIME := 0.040                # next round stripped from the magazine [A]
const SLIDE_RELEASE_TIME := 0.042       # slide stop released -> in battery [A]
const TRIGGER_RETURN_TIME := 0.045      # finger release -> reset
const DRY_FIRE_RECOVER := 0.03

# --- ballistics (124 gr FMJ) ---
const BULLET_MASS := 0.008035           # kg (124 gr) [M]
const MUZZLE_VELOCITY := 346.0          # m/s from the 125 mm barrel [M, chronograph mean]
const MUZZLE_VELOCITY_SD := 3.5         # m/s [M]
const BC_G1 := 0.154                    # [A, fitted]
const ZERO_RANGE := 25.0                # m (sights regulated for 25 m in this simulation) [A]
const DISPERSION_SD_MRAD := 0.55        # per-axis mechanical + ammunition dispersion [A from M groups]
const CASE_MASS := 0.0041               # kg, spent 9x19 brass [A]
const CARTRIDGE_MASS := 0.0121          # kg [M]

# --- recoil as rendered (two-handed grip) ---
const RECOIL_PITCH_PEAK_DEG := 4.2      # muzzle rise at peak [A; refs give ~6 deg free-ish, less with firm grip]
const RECOIL_PITCH_PEAK_TIME := 0.055   # [A]
const RECOIL_BACK_PEAK := 0.011         # m rearward push of the gun [A]
const RECOIL_CAMERA_FRACTION := 0.16    # share of muzzle rise that reaches the view direction [A]

# --- default clip timing, replaced at runtime by game/assets/arms/anim_events.json ---
const DEFAULT_CLIPS := {
	"reload": {"duration": 3.6, "events": {"left_hand_leaves": 0.15, "mag_release_press": 0.55, "mag_out_start": 0.62,
		"mag_clear": 0.95, "mag_swap": 1.6, "mag_in_start": 2.35, "mag_seated": 2.75, "regrip_done": 3.45}},
	"reload_empty": {"duration": 4.0, "events": {"left_hand_leaves": 0.15, "mag_release_press": 0.55, "mag_out_start": 0.62,
		"mag_clear": 0.95, "mag_swap": 1.6, "mag_in_start": 2.35, "mag_seated": 2.75, "slide_stop_press": 3.15, "regrip_done": 3.85}},
	"inspect": {"duration": 4.5, "events": {"left_view": 0.9, "right_view": 2.2, "top_view": 3.3}},
	"safety_on": {"duration": 0.4, "events": {"lever_start": 0.14, "lever_end": 0.26}},
	"safety_off": {"duration": 0.4, "events": {"lever_start": 0.14, "lever_end": 0.26}},
	"hammer_cock": {"duration": 0.45, "events": {"hammer_start": 0.15, "hammer_end": 0.30}},
}
