class_name Ballistics
## Point-mass external ballistics with the G1 drag function. SI units throughout.

const AIR_DENSITY := 1.225          # kg/m^3, ICAO sea level
const SPEED_OF_SOUND := 343.0       # m/s at 20 C
const GRAVITY := 9.80665
# a = rho * v^2 * Cd_G1(M) * K / BC   with K = A_std / (2 m_std) for the 1 lb, 1 inch reference projectile
const K_STD := 5.5855e-4            # m^2/kg

const G1_MACH: PackedFloat32Array = [0.0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 1.0, 1.025, 1.05, 1.075, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0]
const G1_CD: PackedFloat32Array = [0.2629, 0.2032, 0.2034, 0.2165, 0.2546, 0.2901, 0.3415, 0.3734, 0.4084, 0.4448, 0.4805, 0.5136, 0.5427, 0.5677, 0.5883, 0.6191, 0.6393, 0.6589, 0.6621, 0.6573, 0.6474, 0.6210, 0.5934]

static func g1_cd(mach: float) -> float:
	if mach <= G1_MACH[0]:
		return G1_CD[0]
	for i in range(1, G1_MACH.size()):
		if mach <= G1_MACH[i]:
			var t := (mach - G1_MACH[i - 1]) / (G1_MACH[i] - G1_MACH[i - 1])
			return lerpf(G1_CD[i - 1], G1_CD[i], t)
	return G1_CD[G1_CD.size() - 1]

static func drag_decel(speed: float, bc: float) -> float:
	return AIR_DENSITY * speed * speed * g1_cd(speed / SPEED_OF_SOUND) * K_STD / bc

## One integration step (midpoint). Returns [new_pos, new_vel].
static func step(pos: Vector3, vel: Vector3, dt: float, bc: float) -> Array:
	var a1 := _accel(vel, bc)
	var vm := vel + a1 * (dt * 0.5)
	var a2 := _accel(vm, bc)
	var nv := vel + a2 * dt
	var np := pos + (vel + nv) * 0.5 * dt
	return [np, nv]

static func _accel(vel: Vector3, bc: float) -> Vector3:
	var sp := vel.length()
	if sp < 1e-3:
		return Vector3(0, -GRAVITY, 0)
	return -vel / sp * drag_decel(sp, bc) + Vector3(0, -GRAVITY, 0)

## Flat-fire table: fires along +X from height `h0` (relative to the line of sight) with elevation `elev` (rad).
## Returns {y: height above the line of sight at `range_m`, t: time of flight, v: remaining speed}.
static func solve_at(range_m: float, v0: float, bc: float, elev: float, h0: float) -> Dictionary:
	var pos := Vector3(0, h0, 0)
	var vel := Vector3(cos(elev), sin(elev), 0) * v0
	var t := 0.0
	var dt := 0.0005
	while pos.x < range_m and t < 5.0:
		var prev := pos
		var r := step(pos, vel, dt, bc)
		pos = r[0]
		vel = r[1]
		t += dt
		if pos.x >= range_m:
			var f := (range_m - prev.x) / (pos.x - prev.x)
			return {"y": lerpf(prev.y, pos.y, f), "t": t - dt * (1.0 - f), "v": vel.length()}
	return {"y": pos.y, "t": t, "v": vel.length()}

## Elevation of the departure line above the line of sight (rad) for the trajectory to cross it at zero_range.
## sight_over_bore: height of the sight line above the bore at the muzzle (m); muzzle_ahead: muzzle distance
## in front of the rear sight (the range is measured from the firing line ~ shooter, so it is ignored here).
static func zero_elevation(zero_range: float, v0: float, bc: float, sight_over_bore: float) -> float:
	var lo := -0.01
	var hi := 0.03
	for i in 40:
		var mid := (lo + hi) * 0.5
		if solve_at(zero_range, v0, bc, mid, -sight_over_bore)["y"] > 0.0:
			hi = mid
		else:
			lo = mid
	return (lo + hi) * 0.5

static func kinetic_energy(mass: float, speed: float) -> float:
	return 0.5 * mass * speed * speed
