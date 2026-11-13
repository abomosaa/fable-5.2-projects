extends RigidBody3D
## AR500 gong plate: a real rigid body (correct mass, 3/8 in thick cylinder, CCD) hung from two chain bodies by
## pin joints (see steel_gong.gd). A 9 mm FMJ splashes on hardened steel, so the hit is treated as fully
## inelastic: the plate receives the bullet's momentum along the surface normal plus 30 % of the tangential part,
## applied at the hit point - off-centre hits twist the plate, edge hits spin it.

signal plate_hit(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const PlateFace := preload("res://scripts/targets/plate_face.gd")
const TANGENTIAL_TRANSFER := 0.3

var face: PlateFace
var radius := 0.1016
var hits := 0
var last_impulse := Vector3.ZERO
var _rest_xf: Transform3D
var _calm := 0.0

func build(glb_path: String, info: Dictionary) -> void:
	radius = float(info["radius"])
	var thick := float(info["thickness"])
	mass = float(info["mass"])
	collision_layer = U.LAYER_TARGET_BIT
	collision_mask = U.LAYER_WORLD_BIT
	continuous_cd = true
	can_sleep = true
	linear_damp_mode = RigidBody3D.DAMP_MODE_REPLACE
	angular_damp_mode = RigidBody3D.DAMP_MODE_REPLACE
	linear_damp = 0.4
	angular_damp = 0.55
	set_meta("surface", "steel")
	var pm := PhysicsMaterial.new()
	pm.bounce = 0.15
	pm.friction = 0.5
	physics_material_override = pm
	var cs := CollisionShape3D.new()
	var sh := CylinderShape3D.new()
	sh.radius = radius
	sh.height = thick
	cs.shape = sh
	cs.rotation = Vector3(PI * 0.5, 0, 0)
	add_child(cs)
	var scene := U.instance_glb(glb_path)
	var mi := U.find_mesh(scene)
	mi.get_parent().remove_child(mi)
	scene.free()
	mi.name = "PlateMesh"
	mi.transform = Transform3D.IDENTITY
	add_child(mi)
	face = PlateFace.new()
	face.setup(mi, radius, thick)

func remember_rest() -> void:
	_rest_xf = global_transform

func rest_transform() -> Transform3D:
	return _rest_xf

func on_bullet_hit(hit: Dictionary) -> Dictionary:
	hits += 1
	var n: Vector3 = (hit.get("normal", Vector3.BACK) as Vector3).normalized()
	var d: Vector3 = (hit.get("direction", Vector3.FORWARD) as Vector3).normalized()
	var p := float(hit.get("mass", 0.008035)) * float(hit.get("speed", 335.0))
	var dn := d.dot(n)
	var j := (n * dn + (d - n * dn) * TANGENTIAL_TRANSFER) * p
	var pos: Vector3 = hit["position"]
	sleeping = false
	apply_impulse(j, pos - global_position)
	last_impulse = j
	_calm = 0.0
	linear_damp = 0.4
	angular_damp = 0.55
	face.mark(to_local(pos))
	var fxn := U.fx(self)
	if fxn != null:
		fxn.call("burst", "plate", pos, n, d, clampf(p / 2.7, 0.3, 1.2))
	var snd := face.ring_sound()
	var level := clampf(absf(dn) * p / 2.7, 0.15, 1.0)
	U.play(self, snd[0], pos, {"pitch": float(snd[1]) * randf_range(0.985, 1.015), "intensity": level, "follow": self})
	# chains: one rattle as the plate is kicked, a softer one as it swings back
	var ke := j.length_squared() / (2.0 * mass)
	var rattle := clampf(ke / 1.6, 0.12, 1.0)
	U.play(self, "chain_rattle", global_position + Vector3(0, radius + 0.12, 0), {"intensity": rattle, "delay": 0.04, "follow": self})
	U.play(self, "chain_rattle", global_position + Vector3(0, radius + 0.12, 0), {"intensity": rattle * 0.4, "delay": 0.62, "follow": self,
		"pitch": 0.96})
	plate_hit.emit({"kind": "steel", "shot_index": int(hit.get("shot_index", -1)), "impulse": j.length(), "plate": self})
	return {"stop": true, "fx": false}

func _physics_process(delta: float) -> void:
	if sleeping:
		return
	# chain links rub: once the swing is small the motion dies quickly (Coulomb-like), instead of ringing on
	var v := linear_velocity.length() + angular_velocity.length() * radius
	if v < 0.3:
		_calm += delta
		linear_damp = 2.2
		angular_damp = 2.6
	else:
		_calm = 0.0
		linear_damp = 0.4
		angular_damp = 0.55

func reset_plate() -> void:
	hits = 0
	last_impulse = Vector3.ZERO
	face.clear()
	linear_velocity = Vector3.ZERO
	angular_velocity = Vector3.ZERO
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_TRANSFORM, _rest_xf)
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_LINEAR_VELOCITY, Vector3.ZERO)
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_ANGULAR_VELOCITY, Vector3.ZERO)
	global_transform = _rest_xf
	reset_physics_interpolation()
