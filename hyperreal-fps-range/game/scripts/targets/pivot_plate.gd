extends Node3D
## Spring-loaded knock-back plate ("auto-reset" pistol target): a 6 in AR500 disc on a flat-bar arm hinged 12 cm
## above the ground; a hit throws it back against a torsion spring, which stands it up again against a stop tab.
##
## The arm has exactly one degree of freedom, so it is NOT handed to the constraint solver: the hinge angle is
## integrated here from the real equation of motion  I * phi'' = m g Lc sin(phi) - (tau0 + k phi) - c phi'  with
## the bullet's angular impulse (r x J) / I added on a hit, a restitution stop at upright and a hard stop at the
## rear. The body that bullets and brass collide with is an AnimatableBody3D rotated about the hinge every tick.

signal hit_registered(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const PlateFace := preload("res://scripts/targets/plate_face.gd")
const _S := "res://assets/targets/steel/"
const ARM_LEN := 0.45
const ARM_MASS := 0.53            # 25 x 6 mm flat bar, 0.46 m
const SPRING_PRELOAD := 2.0       # N m at upright
const SPRING_RATE := 7.5          # N m / rad
const HINGE_DAMP := 0.12          # N m s
const STOP_RESTITUTION := 0.25
const PHI_MAX := deg_to_rad(82.0)

var label := "Auto-reset plate"
var distance_m := 12.0
var phi := 0.0                    # lean-back angle from upright, rad
var omega := 0.0
var hits := 0
var peak_deg := 0.0
var face: PlateFace
var _arm: AnimatableBody3D
var _pivot := Vector3(0, 0.12, 0)
var _inertia := 0.31
var _gravity_moment := 7.2
var _plate_mass := 1.36
var _radius := 0.0762
var _clanked := true

func setup(p_label: String, x: float, p_distance: float) -> void:
	label = p_label
	distance_m = p_distance
	position = Vector3(x, 0.0, -p_distance - 0.0047625)

func _ready() -> void:
	var js := U.load_json(_S + "pivot_target.json")
	var pinfo := U.load_json(_S + "plate_6.json")
	_pivot = U.v3(js.get("pivot", [0, 0.12, 0]))
	_radius = float(pinfo["radius"])
	_plate_mass = float(pinfo["mass"])
	_inertia = _plate_mass * (ARM_LEN * ARM_LEN + _radius * _radius * 0.25) + ARM_MASS * ARM_LEN * ARM_LEN / 3.0
	_gravity_moment = (_plate_mass * ARM_LEN + ARM_MASS * ARM_LEN * 0.5) * 9.81
	var scene := U.instance_glb(_S + "pivot_target.glb")
	var base := U.find_mesh(scene, "base")
	var arm_mesh := U.find_mesh(scene, "arm")
	base.get_parent().remove_child(base)
	arm_mesh.get_parent().remove_child(arm_mesh)
	scene.free()
	add_child(base)
	U.add_box_colliders(self, js.get("base_colliders", []), U.LAYER_WORLD_BIT)
	_arm = AnimatableBody3D.new()
	_arm.name = "Arm"
	_arm.sync_to_physics = false
	_arm.collision_layer = U.LAYER_TARGET_BIT
	_arm.collision_mask = 0
	_arm.set_meta("surface", "steel")
	_arm.position = _pivot
	add_child(_arm)
	arm_mesh.transform = Transform3D.IDENTITY
	_arm.add_child(arm_mesh)
	for b in js.get("arm_colliders", []):
		var cs := CollisionShape3D.new()
		var sh := BoxShape3D.new()
		sh.size = U.v3(b["size"])
		cs.shape = sh
		cs.position = U.v3(b["center"])
		_arm.add_child(cs)
	var pc := U.v3(js.get("plate_center_local", [0, ARM_LEN, 0]))
	var pcs := CollisionShape3D.new()
	var cyl := CylinderShape3D.new()
	cyl.radius = _radius
	cyl.height = float(pinfo["thickness"])
	pcs.shape = cyl
	pcs.position = pc
	pcs.rotation = Vector3(PI * 0.5, 0, 0)
	_arm.add_child(pcs)
	var pscene := U.instance_glb(_S + "plate_6.glb")
	var pm := U.find_mesh(pscene)
	pm.get_parent().remove_child(pm)
	pscene.free()
	pm.name = "PlateMesh"
	pm.transform = Transform3D(Basis.IDENTITY, pc)
	_arm.add_child(pm)
	face = PlateFace.new()
	face.setup(pm, _radius, float(pinfo["thickness"]))
	set_physics_process(false)

func on_bullet_hit(hit: Dictionary) -> Dictionary:
	if hit.get("collider") != _arm:
		return {}                # base / bracket: plain static steel (default: stop + generic steel effect)
	hits += 1
	var n: Vector3 = (hit.get("normal", Vector3.BACK) as Vector3).normalized()
	var d: Vector3 = (hit.get("direction", Vector3.FORWARD) as Vector3).normalized()
	var p := float(hit.get("mass", 0.008035)) * float(hit.get("speed", 335.0))
	var dn := d.dot(n)
	var j := (n * dn + (d - n * dn) * 0.3) * p
	var pos: Vector3 = hit["position"]
	var r := pos - _arm.global_position
	var axis := global_transform.basis.x.normalized()
	# rotation about +X by a negative angle leans the plate back, so phi' = -(r x J) . x / I
	omega += -r.cross(j).dot(axis) / _inertia
	set_physics_process(true)
	_clanked = false
	var pm: Node3D = _arm.get_node("PlateMesh")
	face.mark(pm.to_local(pos))
	var fxn := U.fx(self)
	if fxn != null:
		fxn.call("burst", "plate", pos, n, d, clampf(p / 2.7, 0.3, 1.2))
	var snd := face.ring_sound()
	# a plate welded to a post rings shorter and duller than one on chains
	U.play(self, snd[0], pos, {"pitch": float(snd[1]), "intensity": clampf(absf(dn) * p / 2.7, 0.15, 1.0) * 0.7, "follow": _arm})
	hit_registered.emit({"kind": "steel", "distance_m": distance_m, "label": label, "target": self, "shot_index": int(hit.get("shot_index", -1))})
	return {"stop": true, "fx": false}

func _physics_process(delta: float) -> void:
	var torque := _gravity_moment * sin(phi) - (SPRING_PRELOAD + SPRING_RATE * phi) - HINGE_DAMP * omega
	omega += torque / _inertia * delta
	phi += omega * delta
	if phi > PHI_MAX:
		phi = PHI_MAX
		omega = -absf(omega) * 0.2
	if phi <= 0.0:
		phi = 0.0
		if omega < -0.6 and not _clanked:
			U.play(self, "impact_steel_small", _arm.global_position, {"intensity": clampf(-omega / 12.0, 0.05, 0.4), "pitch": 0.8})
		if omega < 0.0:
			omega = -omega * STOP_RESTITUTION
			if omega < 0.25:
				omega = 0.0
				_clanked = true
				set_physics_process(false)
	peak_deg = maxf(peak_deg, rad_to_deg(phi))
	_arm.transform = Transform3D(Basis(Vector3.RIGHT, -phi), _pivot)

func is_asleep() -> bool:
	return not is_physics_processing()

func reset_target() -> void:
	phi = 0.0
	omega = 0.0
	hits = 0
	peak_deg = 0.0
	face.clear()
	_arm.transform = Transform3D(Basis.IDENTITY, _pivot)
	_arm.reset_physics_interpolation()
	set_physics_process(false)

func get_stats() -> Dictionary:
	return {"hits": hits, "marks": face.marks, "asleep": is_asleep(), "lean_deg": rad_to_deg(phi), "peak_deg": peak_deg}
