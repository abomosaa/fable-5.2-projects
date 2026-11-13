extends Node3D
## Hanging steel gong on an A-frame stand. Local frame: origin on the ground under the beam; the plate hangs in
## the plane z = 0 (its front face at z = +4.76 mm looks along +Z, toward the firing line).
##
## Suspension: two chains, each ONE rigid link body (0.25 m, 0.25 kg - 3/8 in chain weighs about 1 kg/m) pinned to
## the beam at the top and to the plate's hanging hole at the bottom (4 PinJoint3D). A loaded chain is straight,
## so a single link per chain reproduces the motion (swing, twist of the bifilar suspension) and keeps the mass
## ratio to the plate at 10-22 : 1, which Jolt solves without stretch at 120 Hz. Nothing is animated.

signal hit_registered(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const SteelPlate := preload("res://scripts/targets/steel_plate.gd")
const CHAIN_LEN := 0.25
const CHAIN_MASS := 0.25
const _S := "res://assets/targets/steel/"

var label := "Steel gong"
var distance_m := 10.0
var size_in := 8
var plate: RigidBody3D
var chains: Array[RigidBody3D] = []
var _chain_rest: Array[Transform3D] = []
var _stand_json := {}

func setup(p_size_in: int, p_label: String, x: float, p_distance: float) -> void:
	size_in = p_size_in
	label = p_label
	distance_m = p_distance
	position = Vector3(x, 0.0, -p_distance - 0.0047625)

func _ready() -> void:
	_stand_json = U.load_json(_S + "gong_stand.json")
	var info := U.load_json(_S + "plate_%d.json" % size_in)
	var stand := U.instance_glb(_S + "gong_stand.glb")
	stand.name = "Stand"
	add_child(stand)
	U.add_box_colliders(self, _stand_json.get("colliders", []), U.LAYER_WORLD_BIT)
	var beam_y := float(_stand_json.get("beam_underside_y", 1.55))
	var holes: Array = info["holes"]
	var hole_y := float(holes[0][1])
	plate = SteelPlate.new()
	plate.name = "Plate"
	plate.build(_S + "plate_%d.glb" % size_in, info)
	plate.position = Vector3(0, beam_y - CHAIN_LEN - hole_y, 0)
	add_child(plate)
	plate.plate_hit.connect(_on_plate_hit)
	var chain_scene := U.instance_glb(_S + "chain.glb")
	var chain_mesh := U.find_mesh(chain_scene).mesh
	chain_scene.free()
	for h in holes:
		var hx := float(h[0])
		var c := RigidBody3D.new()
		c.name = "Chain%d" % chains.size()
		c.mass = CHAIN_MASS
		c.collision_layer = 0
		c.collision_mask = 0
		c.can_sleep = true
		c.linear_damp_mode = RigidBody3D.DAMP_MODE_REPLACE
		c.angular_damp_mode = RigidBody3D.DAMP_MODE_REPLACE
		c.linear_damp = 0.2
		c.angular_damp = 0.8
		var cs := CollisionShape3D.new()
		var sh := BoxShape3D.new()
		sh.size = Vector3(0.016, CHAIN_LEN, 0.016)
		cs.shape = sh
		cs.position = Vector3(0, -CHAIN_LEN * 0.5, 0)
		c.add_child(cs)
		var mi := MeshInstance3D.new()
		mi.mesh = chain_mesh
		c.add_child(mi)
		c.position = Vector3(hx, beam_y, 0)
		add_child(c)
		chains.append(c)
		var top := PinJoint3D.new()
		top.name = "PinTop%d" % chains.size()
		top.position = Vector3(hx, beam_y, 0)
		add_child(top)
		top.node_a = top.get_path_to(c)
		var bottom := PinJoint3D.new()
		bottom.name = "PinBottom%d" % chains.size()
		bottom.position = Vector3(hx, beam_y - CHAIN_LEN, 0)
		add_child(bottom)
		bottom.node_a = bottom.get_path_to(c)
		bottom.node_b = bottom.get_path_to(plate)
	plate.remember_rest()
	for c in chains:
		_chain_rest.append(c.global_transform)

func _on_plate_hit(info: Dictionary) -> void:
	info["distance_m"] = distance_m
	info["label"] = label
	info["target"] = self
	for c in chains:
		c.sleeping = false
	hit_registered.emit(info)

## swing angle of the suspension from vertical, degrees (pivot line -> plate centre)
func swing_deg() -> float:
	var pivot := to_global(Vector3(0, float(_stand_json.get("beam_underside_y", 1.55)), 0))
	var v := plate.global_position - pivot
	return rad_to_deg(acos(clampf(-v.normalized().y, -1.0, 1.0)))

func is_asleep() -> bool:
	if not plate.sleeping:
		return false
	for c in chains:
		if not c.sleeping:
			return false
	return true

func reset_target() -> void:
	plate.reset_plate()
	for i in chains.size():
		var c := chains[i]
		c.linear_velocity = Vector3.ZERO
		c.angular_velocity = Vector3.ZERO
		PhysicsServer3D.body_set_state(c.get_rid(), PhysicsServer3D.BODY_STATE_TRANSFORM, _chain_rest[i])
		PhysicsServer3D.body_set_state(c.get_rid(), PhysicsServer3D.BODY_STATE_LINEAR_VELOCITY, Vector3.ZERO)
		PhysicsServer3D.body_set_state(c.get_rid(), PhysicsServer3D.BODY_STATE_ANGULAR_VELOCITY, Vector3.ZERO)
		c.global_transform = _chain_rest[i]
		c.reset_physics_interpolation()

func get_stats() -> Dictionary:
	return {"hits": plate.hits, "marks": plate.face.marks, "asleep": is_asleep(), "swing_deg": swing_deg()}
