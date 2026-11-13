extends RigidBody3D
## One ejected 9 x 19 mm case (4.1 g). Jolt handles the flight and contacts; this script only adds what a single
## physics material per body cannot: the surface it lands on decides whether it rings and skips (concrete, wood,
## steel) or stops nearly dead (dirt, grass, gravel, sand), and the first few real impacts are reported for sound.

const DEAD := {"dirt": true, "grass": true, "gravel": true, "sandbag": true, "rubber": true}
const MAX_SOUNDS := 4
const MIN_SOUND_SPEED := 0.45      # m/s normal speed change; below this a contact is rolling/chatter
const SOUND_GAP := 0.07            # s

var owner_fx: Node
var slot := -1
var active := false
var settled := false
var age := 0.0
var _sounds := 0
var _last_sound := -1.0
var _in_contact := false
var _still := 0.0

func launch(xf: Transform3D, lin: Vector3, ang: Vector3) -> void:
	freeze = false
	global_transform = xf
	reset_physics_interpolation()
	linear_velocity = lin
	angular_velocity = ang
	sleeping = false
	visible = true
	collision_mask = 1
	active = true
	settled = false
	age = 0.0
	_sounds = 0
	_last_sound = -1.0
	_in_contact = false
	_still = 0.0

func park() -> void:
	active = false
	settled = false
	visible = false
	collision_mask = 0
	freeze = true

func settle() -> void:
	settled = true
	freeze = true

static func _surface_of(o: Object) -> String:
	var n: Object = o
	while n != null:
		if n.has_meta("surface"):
			return str(n.get_meta("surface"))
		n = n.get_parent() if n is Node else null
	return "dirt"

func _integrate_forces(state: PhysicsDirectBodyState3D) -> void:
	if not active or settled:
		return
	var dt := state.step
	age += dt
	var n := state.get_contact_count()
	if n == 0:
		_in_contact = false
		_still = 0.0
		return
	var best := 0
	var best_imp := -1.0
	for i in n:
		var imp := state.get_contact_impulse(i).length()
		if imp > best_imp:
			best_imp = imp
			best = i
	var surface := _surface_of(state.get_contact_collider_object(best))
	var dv := best_imp / mass                      # normal speed change caused by this contact
	var dead := DEAD.has(surface)
	if dead:
		# loose ground swallows the case: no bounce to speak of, no roll
		if dv > 0.3:
			state.linear_velocity *= 0.22
			state.angular_velocity *= 0.25
		state.linear_velocity *= maxf(0.0, 1.0 - 9.0 * dt)
		state.angular_velocity *= maxf(0.0, 1.0 - 10.0 * dt)
	else:
		# rolling resistance on hard floors (a case is not a perfect cylinder: rim and mouth differ)
		state.linear_velocity *= maxf(0.0, 1.0 - 0.9 * dt)
		state.angular_velocity *= maxf(0.0, 1.0 - 1.6 * dt)
	if dv > MIN_SOUND_SPEED and _sounds < MAX_SOUNDS and age - _last_sound > SOUND_GAP and (not _in_contact or dv > 1.2):
		_sounds += 1
		_last_sound = age
		if owner_fx != null:
			owner_fx.call("_on_casing_contact", self, state.get_contact_local_position(best), surface, dv)
	_in_contact = true
	if state.linear_velocity.length_squared() < 0.0025 and state.angular_velocity.length_squared() < 0.25:
		_still += dt
		if _still > 0.6:
			state.linear_velocity = Vector3.ZERO
			state.angular_velocity = Vector3.ZERO
			owner_fx.call_deferred("_on_casing_settled", self)
	else:
		_still = 0.0
