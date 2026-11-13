class_name RecoilModel
extends RefCounted
## Recoil as a set of damped springs driven by one impulse per shot. The gun (and the arms holding it) is the
## mass; the shooter's grip and stance are the springs. Outputs are offsets applied to the weapon rig, plus a
## small share passed to the view direction. Firing again before recovery starts from the displaced state,
## so a fast string climbs and a deliberate cadence does not.

class Axis:
	var x := 0.0
	var v := 0.0
	var wn := 20.0
	var zeta := 0.6
	func _init(p_wn: float, p_zeta: float) -> void:
		wn = p_wn
		zeta = p_zeta
	func step(dt: float) -> void:
		var a := -wn * wn * x - 2.0 * zeta * wn * v
		v += a * dt
		x += v * dt
	## velocity impulse that produces peak displacement `peak` from rest
	func impulse_for_peak(peak: float) -> float:
		var wd := wn * sqrt(maxf(1.0 - zeta * zeta, 1e-6))
		var tp := atan2(wd, zeta * wn) / wd
		var unit := exp(-zeta * wn * tp) * sin(wd * tp) / wd
		return peak / unit

var pitch: Axis          # rad, + = muzzle up
var yaw: Axis            # rad, + = muzzle left (Godot +Y rotation)
var roll: Axis           # rad
var back: Axis           # m, + = towards the shooter
var up: Axis             # m
var settle := Vector2.ZERO   # rad (pitch, yaw): where the hold comes back to after a shot; walked back to zero by the shooter
var misalign := Vector2.ZERO # rad (pitch, yaw): error of the gun in the hands (front post off-centre in the notch)
var _settle_v := Vector2.ZERO
var _settle_hold := 0.0
var _settle_wn := 13.0
var _settle_zeta := 0.8
var _misalign_tau := 0.16
var _wn0 := 0.0
var _zeta0 := 0.6
var view_pitch := 0.0    # rad added to the camera pitch (already scaled)
var view_yaw := 0.0
var _view_v := Vector2.ZERO

func _init() -> void:
	# pitch: peak at ~55 ms, slight dip below the line and settled by ~0.3 s
	var zeta := 0.6
	var wd := atan2(sqrt(1.0 - zeta * zeta), zeta) / WeaponDef.RECOIL_PITCH_PEAK_TIME
	pitch = Axis.new(wd / sqrt(1.0 - zeta * zeta), zeta)
	_wn0 = pitch.wn
	_zeta0 = zeta
	yaw = Axis.new(24.0, 0.7)
	roll = Axis.new(26.0, 0.65)
	back = Axis.new(34.0, 0.72)
	up = Axis.new(30.0, 0.7)

func reset() -> void:
	for a: Axis in [pitch, yaw, roll, back, up]:
		a.x = 0.0
		a.v = 0.0
	view_pitch = 0.0
	view_yaw = 0.0
	_view_v = Vector2.ZERO
	settle = Vector2.ZERO
	misalign = Vector2.ZERO
	_settle_v = Vector2.ZERO
	_settle_hold = 0.0

## grip_quality: 1 = aimed two-hand stance, lower = more muzzle rise (moving, hip).
func apply_shot(rng: RandomNumberGenerator, grip_quality := 1.0) -> void:
	var scale := lerpf(1.45, 1.0, clampf(grip_quality, 0.0, 1.0))
	# no two shots are caught by the hands the same way: stiffness and damping of the grip vary from shot to shot,
	# and the gun does not come back to exactly where it was - the shooter has to find the sights again
	pitch.wn = _wn0 * rng.randf_range(0.82, 1.16)
	pitch.zeta = _zeta0 * rng.randf_range(0.80, 1.22)
	yaw.wn = 24.0 * rng.randf_range(0.85, 1.15)
	# [A] return error: the hold comes back up to 0.7 deg high or 0.3 deg low and up to 0.5 deg to either side
	# (mostly high: the muzzle is still coming down when the eye picks the sights up again). The shooter starts
	# steering it out after a short reaction time and the correction is a damped movement that can overshoot a
	# little - not a pause followed by a glide. Stiffness, damping and reaction time differ from shot to shot.
	settle += Vector2(deg_to_rad(rng.randf_range(-0.30, 0.70)), deg_to_rad(rng.randf_range(-0.50, 0.50))) * scale
	settle = settle.limit_length(deg_to_rad(1.3))
	_settle_v = Vector2(deg_to_rad(rng.randf_range(-0.8, 0.8)), deg_to_rad(rng.randf_range(-0.8, 0.8)))
	_settle_hold = rng.randf_range(0.16, 0.26)
	_settle_wn = rng.randf_range(10.0, 15.0)
	_settle_zeta = rng.randf_range(0.55, 0.9)
	# the gun also sits slightly differently in the hands after the shot: the front post is not centred in the notch
	# until the grip settles
	misalign = Vector2(deg_to_rad(rng.randf_range(-0.45, 0.55)), deg_to_rad(rng.randf_range(-0.5, 0.5))) * scale
	_misalign_tau = rng.randf_range(0.12, 0.22)
	var peak := deg_to_rad(WeaponDef.RECOIL_PITCH_PEAK_DEG) * scale * rng.randf_range(0.93, 1.07)
	pitch.v += pitch.impulse_for_peak(peak)
	# right-handed shooter: the gun torques slightly up-and-left around the support hand, with shot-to-shot scatter
	yaw.v += yaw.impulse_for_peak(deg_to_rad(rng.randf_range(-0.25, 0.75)) * scale)
	roll.v += roll.impulse_for_peak(deg_to_rad(rng.randf_range(-1.6, -0.2)) * scale)
	back.v += back.impulse_for_peak(WeaponDef.RECOIL_BACK_PEAK * scale * rng.randf_range(0.92, 1.08))
	up.v += up.impulse_for_peak(0.004 * scale)

## small disturbance of the sights from a trigger stroke (DA is long and heavy)
func apply_trigger_disturbance(rng: RandomNumberGenerator, da: bool) -> void:
	var m := 0.20 if da else 0.03
	pitch.v += pitch.impulse_for_peak(deg_to_rad(rng.randf_range(-m, m * 0.4)))
	yaw.v += yaw.impulse_for_peak(deg_to_rad(rng.randf_range(-m * 0.5, m)))

func step(dt: float) -> void:
	dt = clampf(dt, 0.0, 0.5)
	var n := maxi(1, int(ceil(dt / (1.0 / 480.0))))
	var h := dt / n
	# the hold is re-established over a few tenths of a second, not by the spring alone
	for i in n:
		if _settle_hold > 0.0:
			# reaction time: the error drifts (it was given a small random velocity) and creeps back only slowly
			_settle_hold -= h
			_settle_v -= _settle_v * minf(1.0, 3.0 * h)
			settle += (_settle_v - settle * 0.5) * h
		else:
			_settle_v += (-_settle_wn * _settle_wn * settle - 2.0 * _settle_zeta * _settle_wn * _settle_v) * h
			settle += _settle_v * h
			misalign *= exp(-h / _misalign_tau)
	for i in n:
		pitch.step(h)
		yaw.step(h)
		roll.step(h)
		back.step(h)
		up.step(h)
	# the view follows a share of the muzzle rise through a slower, well damped path (neck/torso)
	var target := Vector2(pitch.x + settle.x * 0.5, yaw.x + settle.y * 0.5) * WeaponDef.RECOIL_CAMERA_FRACTION
	var cur := Vector2(view_pitch, view_yaw)
	var k := 1.0 - exp(-dt * 38.0)
	cur = cur.lerp(target, k)
	view_pitch = cur.x
	view_yaw = cur.y

func is_settled() -> bool:
	return absf(pitch.x) < 0.0006 and absf(pitch.v) < 0.01 and absf(back.x) < 0.0003 and settle.length() < 0.0006 and misalign.length() < 0.0006
