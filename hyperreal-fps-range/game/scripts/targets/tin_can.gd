extends RigidBody3D
## Empty steel food tin: a light rigid body. A 9 mm FMJ passes through both walls (keeps 0.97 of its speed); the
## momentum it loses is applied at the entry point, so the can is knocked off and spins according to where it
## was hit. Entry and exit holes are small decals that travel with the can.

signal can_hit(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const SPEED_KEPT := 0.97
const MARKS := 6
const _T := "res://assets/fx/tex/"
const ENTRY := [[preload(_T + "decal_metal_0.png"), preload(_T + "decal_metal_0_n.png")], [preload(_T + "decal_metal_1.png"), preload(_T + "decal_metal_1_n.png")]]
const EXIT := [[preload(_T + "decal_metalexit_0.png"), preload(_T + "decal_metalexit_0_n.png")], [preload(_T + "decal_metalexit_1.png"), preload(_T + "decal_metalexit_1_n.png")]]

var radius := 0.04
var height := 0.1
var hits := 0
var _rest: Transform3D
var _marks: Array[Decal] = []
var _mark_next := 0

func build(glb_path: String, info: Dictionary) -> void:
	radius = float(info["radius"])
	height = float(info["height"])
	mass = float(info.get("mass", 0.06))
	collision_layer = U.LAYER_TARGET_BIT
	collision_mask = U.LAYER_WORLD_BIT
	continuous_cd = true
	can_sleep = true
	angular_damp = 0.5
	linear_damp = 0.05
	set_meta("surface", "can")
	var pm := PhysicsMaterial.new()
	pm.bounce = 0.3
	pm.friction = 0.55
	physics_material_override = pm
	var cs := CollisionShape3D.new()
	var sh := CylinderShape3D.new()
	sh.radius = radius
	sh.height = height
	cs.shape = sh
	cs.position = Vector3(0, height * 0.5, 0)
	add_child(cs)
	var scene := U.instance_glb(glb_path)
	var mi := U.find_mesh(scene)
	mi.get_parent().remove_child(mi)
	scene.free()
	mi.transform = Transform3D.IDENTITY
	mi.layers = U.RENDER_LAYER_CAN
	add_child(mi)
	for i in MARKS:
		var d := Decal.new()
		d.visible = false
		d.cull_mask = U.RENDER_LAYER_CAN
		d.size = Vector3(0.034, 0.02, 0.034)
		d.normal_fade = 0.2
		d.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_INHERIT
		add_child(d)
		_marks.append(d)

func remember_rest() -> void:
	_rest = global_transform

func rest_transform() -> Transform3D:
	return _rest

func _mark(set: Array, world_pos: Vector3, world_n: Vector3, size: float) -> void:
	var d := _marks[_mark_next]
	_mark_next = (_mark_next + 1) % MARKS
	var pair: Array = set[randi() % set.size()]
	d.texture_albedo = pair[0]
	d.texture_normal = pair[1]
	d.size = Vector3(size, 0.02, size)
	var n := world_n.normalized()
	var x := n.cross(Vector3.UP if absf(n.y) < 0.9 else Vector3.RIGHT).normalized().rotated(n, randf() * TAU)
	d.global_transform = Transform3D(Basis(x, n, x.cross(n)), world_pos)
	d.visible = true

func on_bullet_hit(hit: Dictionary) -> Dictionary:
	hits += 1
	var pos: Vector3 = hit["position"]
	var n: Vector3 = (hit.get("normal", Vector3.BACK) as Vector3).normalized()
	var d: Vector3 = (hit.get("direction", Vector3.FORWARD) as Vector3).normalized()
	var p := float(hit.get("mass", 0.008035)) * float(hit.get("speed", 335.0)) * (1.0 - SPEED_KEPT)
	_mark(ENTRY, pos, n, 0.034)
	# exit through the far wall: ray vs the can's cylinder in local space
	var inv := global_transform.affine_inverse()
	var lp := inv * pos
	var ld := (inv.basis * d).normalized()
	var a := ld.x * ld.x + ld.z * ld.z
	var t_exit := -1.0
	var ln := Vector3.ZERO
	if a > 1e-6:
		var b := 2.0 * (lp.x * ld.x + lp.z * ld.z)
		var c := lp.x * lp.x + lp.z * lp.z - radius * radius
		var disc := b * b - 4.0 * a * c
		if disc > 0.0:
			t_exit = (-b + sqrt(disc)) / (2.0 * a)
	if t_exit > 0.002:
		var e := lp + ld * t_exit
		ln = Vector3(e.x, 0, e.z).normalized()
		if e.y > height or e.y < 0.0:
			# leaves through the lid or the bottom instead
			var ty := ((height if ld.y > 0.0 else 0.0) - lp.y) / ld.y
			e = lp + ld * ty
			ln = Vector3(0, signf(ld.y), 0)
		_mark(EXIT, global_transform * e, (global_transform.basis * ln).normalized(), 0.042)
	sleeping = false
	apply_impulse(d * p + Vector3(randf_range(-0.2, 0.2), randf_range(0.0, 0.35), randf_range(-0.2, 0.2)) * p, pos - global_position)
	var fxn := U.fx(self)
	if fxn != null:
		fxn.call("burst", "can", pos, n, d, 1.0)
	U.play(self, "impact_can", pos, {"pitch": randf_range(0.95, 1.06), "follow": self})
	can_hit.emit({"kind": "can", "shot_index": int(hit.get("shot_index", -1)), "position": pos})
	return {"stop": false, "speed_scale": SPEED_KEPT, "fx": false}

func reset_can() -> void:
	hits = 0
	for d in _marks:
		d.visible = false
	linear_velocity = Vector3.ZERO
	angular_velocity = Vector3.ZERO
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_TRANSFORM, _rest)
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_LINEAR_VELOCITY, Vector3.ZERO)
	PhysicsServer3D.body_set_state(get_rid(), PhysicsServer3D.BODY_STATE_ANGULAR_VELOCITY, Vector3.ZERO)
	global_transform = _rest
	reset_physics_interpolation()

var _still := 0.0

func _physics_process(delta: float) -> void:
	if sleeping or freeze:
		return
	var v := linear_velocity.length()
	# a dented tin does not roll far: more resistance once it is slow
	if v < 1.2:
		angular_damp = 2.5
		linear_damp = 0.9
	else:
		angular_damp = 0.5
		linear_damp = 0.05
	if v < 0.06 and angular_velocity.length() < 0.6:
		_still += delta
		if _still > 0.8:
			linear_velocity = Vector3.ZERO
			angular_velocity = Vector3.ZERO
			sleeping = true
			_still = 0.0
	else:
		_still = 0.0
