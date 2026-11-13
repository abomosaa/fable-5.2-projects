extends RefCounted
## Shared helpers for the target scripts.

const Layout := preload("res://scripts/range/layout.gd")
const LAYER_WORLD_BIT := 1 << (Layout.LAYER_WORLD - 1)
const LAYER_TARGET_BIT := 1 << (Layout.LAYER_TARGET - 1)
const LAYER_DEBRIS_BIT := 1 << (Layout.LAYER_DEBRIS - 1)
## render layer for target surfaces that world-impact decals must not paint (paper, plates, glass, cans)
const RENDER_LAYER_TARGET := 1 << 1
const RENDER_LAYER_CAN := 1 << 2

static func load_json(path: String) -> Dictionary:
	var txt := FileAccess.get_file_as_string(path)
	var js: Variant = JSON.parse_string(txt)
	return js if js is Dictionary else {}

static func v3(a: Variant) -> Vector3:
	return Vector3(float(a[0]), float(a[1]), float(a[2]))

static func audio(tree_node: Node) -> Node:
	return tree_node.get_node_or_null("/root/AudioDirector") if tree_node.is_inside_tree() else null

static func play(node: Node, group: String, pos: Vector3, opts := {}) -> void:
	var a := audio(node)
	if a != null:
		a.call("play_world", group, pos, opts)

static func fx(node: Node) -> Node:
	return node.get_tree().get_first_node_in_group("fx_world") if node.is_inside_tree() else null

## StaticBody3D boxes from a sidecar list [{name, center, size, rot_deg, surface}]
static func add_box_colliders(parent: Node3D, boxes: Array, layers: int, extra_meta := {}) -> Array[StaticBody3D]:
	var out: Array[StaticBody3D] = []
	for b in boxes:
		var body := StaticBody3D.new()
		body.name = "Col_" + str(b["name"])
		body.collision_layer = layers
		body.collision_mask = 0
		body.set_meta("surface", str(b.get("surface", "wood")))
		for k in extra_meta:
			body.set_meta(k, extra_meta[k])
		var cs := CollisionShape3D.new()
		var sh := BoxShape3D.new()
		sh.size = v3(b["size"])
		cs.shape = sh
		body.add_child(cs)
		body.position = v3(b["center"])
		var r: Variant = b.get("rot_deg", [0, 0, 0])
		body.rotation_degrees = v3(r)
		parent.add_child(body)
		out.append(body)
	return out

static func instance_glb(path: String) -> Node3D:
	var ps: PackedScene = load(path)
	return ps.instantiate() as Node3D

static func find_mesh(n: Node, node_name := "") -> MeshInstance3D:
	if n is MeshInstance3D and (node_name == "" or n.name == node_name):
		return n
	for c in n.get_children():
		var r := find_mesh(c, node_name)
		if r != null:
			return r
	return null

static func set_layers(n: Node, layers: int) -> void:
	if n is VisualInstance3D:
		(n as VisualInstance3D).layers = layers
	for c in n.get_children():
		set_layers(c, layers)

## where a ray that entered an oriented box at `pos` travelling along `dir` leaves it (world space)
static func box_exit(body: Node3D, size: Vector3, pos: Vector3, dir: Vector3) -> Dictionary:
	var inv := body.global_transform.affine_inverse()
	var p := inv * pos
	var d := (inv.basis * dir).normalized()
	var h := size * 0.5
	var t_exit := INF
	var n_local := Vector3.ZERO
	for axis in 3:
		if absf(d[axis]) < 1e-7:
			continue
		var t := ((h[axis] if d[axis] > 0.0 else -h[axis]) - p[axis]) / d[axis]
		if t < t_exit:
			t_exit = t
			n_local = Vector3.ZERO
			n_local[axis] = signf(d[axis])
	if t_exit == INF:
		return {}
	return {"position": body.global_transform * (p + d * maxf(t_exit, 0.0)), "normal": (body.global_transform.basis * n_local).normalized()}
