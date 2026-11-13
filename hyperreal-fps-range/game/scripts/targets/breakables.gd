extends Node3D
## Shelves with breakable things: glass bottles, clay pigeons on slotted holders, terracotta pots (brittle: they
## shatter into the pre-fractured pieces stored in their .glb) and empty tin cans (not brittle: they are light
## rigid bodies that get holed and knocked off).
##
## Brittle objects are static until hit. On a hit the intact mesh is swapped for its fragment set: every piece
## becomes a rigid body from a fixed pool (96) and gets a velocity from the bullet's lost momentum, weighted by
## its distance to the entry and exit points (pieces at the hit fly, far ones just drop; neck and base survive as
## single pieces). Settled pieces are converted to plain MeshInstance3D from a second pool (256, oldest reused)
## and their bodies go back to the pool, so nothing keeps simulating or jittering.
##
## Bullet behaviour (documented decisions): glass 0.95-0.96, clay 0.975, terracotta 0.92 of the speed is kept and
## the bullet goes on to the berm. Cans are EMPTY steel food tins (0.25 mm sheet): a 9 mm FMJ goes clean through
## both walls and keeps 0.97 of its speed; the 3 % of momentum it loses (~0.08 N s) is what throws the can.

signal hit_registered(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const TinCan := preload("res://scripts/targets/tin_can.gd")
const _B := "res://assets/targets/break/"
const _P := "res://assets/targets/props/"

const LIVE_CAP := 96
const STATIC_CAP := 256
const SETTLE_SPEED := 0.12
const MAX_LIVE_TIME := 7.0

const TYPES := {
	"bottle_wine": {"glb": "bottle_wine", "speed_scale": 0.95, "sigma": 0.05, "burst": 2.4, "sound": "break_glass_bottle", "debris": "debris_glass",
		"fx": "glass", "bounce": 0.22, "friction": 0.5, "glass": true, "kind": "glass"},
	"bottle_beer": {"glb": "bottle_beer", "speed_scale": 0.96, "sigma": 0.04, "burst": 2.4, "sound": "break_glass_bottle", "debris": "debris_glass",
		"fx": "glass", "bounce": 0.22, "friction": 0.5, "glass": true, "kind": "glass", "pitch": 1.08},
	"clay": {"glb": "clay", "speed_scale": 0.975, "sigma": 0.09, "burst": 4.0, "sound": "break_ceramic", "debris": "debris_ceramic",
		"fx": "clay", "bounce": 0.12, "friction": 0.6, "glass": false, "kind": "clay", "pitch": 1.22, "volume_db": -4.0},
	"pot": {"glb": "pot", "speed_scale": 0.92, "sigma": 0.08, "burst": 1.5, "sound": "break_ceramic", "debris": "debris_ceramic",
		"fx": "ceramic", "bounce": 0.1, "friction": 0.7, "glass": false, "kind": "ceramic"},
}
const GLASS_TINTS := {
	# transmission colour of ONE bottle wall seen face-on (sRGB)
	"green": Color(0.50, 0.72, 0.40), "amber": Color(0.82, 0.55, 0.22), "clear": Color(0.95, 0.985, 0.97),
}

class Item:
	var type := ""
	var tint := ""
	var body: StaticBody3D
	var mesh: MeshInstance3D
	var broken := false
	var mats: Array = []

var _types := {}                 # key -> {mass, radius, height, intact: Mesh, pieces: [{mesh, shape, centroid, frac, tag}]}
var _glass_mats := {}            # tint -> [outer, break]
var _phys_mats := {}
var _items: Array = []
var _cans: Array = []
var _live: Array[RigidBody3D] = []
var _free: Array[RigidBody3D] = []
var _live_info := {}             # body -> {born, cfg}
var _statics: Array[MeshInstance3D] = []
var _static_next := 0
var _static_used := 0
var _rng := RandomNumberGenerator.new()
var _broken_total := 0
var _pieces_released := 0

func _ready() -> void:
	_rng.seed = 0xb07713
	for key in TYPES:
		_load_type(key)
	var holder := Node3D.new()
	holder.name = "Fragments"
	add_child(holder)
	for i in LIVE_CAP:
		var b := RigidBody3D.new()
		b.name = "Frag%02d" % i
		b.collision_layer = 0
		b.collision_mask = 0
		b.freeze_mode = RigidBody3D.FREEZE_MODE_STATIC
		b.freeze = true
		b.visible = false
		b.continuous_cd = false
		b.can_sleep = true
		b.linear_damp = 0.08
		b.angular_damp = 0.6
		var cs := CollisionShape3D.new()
		cs.name = "Shape"
		b.add_child(cs)
		var mi := MeshInstance3D.new()
		mi.name = "Mesh"
		mi.layers = U.RENDER_LAYER_TARGET
		mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		b.add_child(mi)
		holder.add_child(b)
		_free.append(b)
	var sh := Node3D.new()
	sh.name = "Settled"
	sh.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	add_child(sh)
	for i in STATIC_CAP:
		var mi2 := MeshInstance3D.new()
		mi2.visible = false
		mi2.layers = U.RENDER_LAYER_TARGET
		mi2.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		sh.add_child(mi2)
		_statics.append(mi2)

# ------------------------------------------------------------------------------------------------ assets
func _load_type(key: String) -> void:
	var cfg: Dictionary = TYPES[key]
	var js := U.load_json(_B + cfg["glb"] + ".json")
	var scene := U.instance_glb(_B + cfg["glb"] + ".glb")
	var t := {"mass": float(js.get("mass", 0.3)), "radius": float(js.get("radius", 0.04)), "height": float(js.get("height", 0.2)),
		"neck_radius": float(js.get("neck_radius", 0.0)), "pieces": []}
	t["intact"] = U.find_mesh(scene, "intact").mesh
	for p in js.get("pieces", []):
		var mi := U.find_mesh(scene, str(p["name"]))
		if mi == null:
			continue
		var shape: ConvexPolygonShape3D = mi.mesh.create_convex_shape(true, true)
		t["pieces"].append({"mesh": mi.mesh, "shape": shape, "centroid": mi.position, "frac": float(p.get("volume_frac", 0.05)), "tag": str(p.get("tag", "body"))})
	scene.free()
	_types[key] = t

func _glass(tint: String) -> Array:
	if _glass_mats.has(tint):
		return _glass_mats[tint]
	var c: Color = GLASS_TINTS[tint]
	var sh: Shader = preload("res://scripts/targets/shaders/glass.gdshader")
	var outer := ShaderMaterial.new()
	outer.shader = sh
	outer.set_shader_parameter("tint", Color(c.r, c.g, c.b))
	outer.set_shader_parameter("walls", 2.0)
	outer.set_shader_parameter("roughness", 0.03)
	var shard := ShaderMaterial.new()          # a loose shard is one wall thick
	shard.shader = sh
	shard.set_shader_parameter("tint", Color(c.r, c.g, c.b))
	shard.set_shader_parameter("walls", 1.0)
	shard.set_shader_parameter("roughness", 0.03)
	var brk := ShaderMaterial.new()            # fracture faces
	brk.shader = sh
	brk.set_shader_parameter("tint", Color(c.r, c.g, c.b))
	brk.set_shader_parameter("walls", 2.5)
	brk.set_shader_parameter("roughness", 0.22)
	brk.set_shader_parameter("frost", 0.8)
	_glass_mats[tint] = [outer, brk, shard]
	return _glass_mats[tint]

func _apply_mats(mi: MeshInstance3D, mats: Array) -> void:
	var n := mi.mesh.get_surface_count() if mi.mesh != null else 0
	for i in n:
		mi.set_surface_override_material(i, mats[mini(i, mats.size() - 1)] if not mats.is_empty() else null)

# ------------------------------------------------------------------------------------------------ building
func add_shelf(pos: Vector3, yaw_deg := 0.0) -> Node3D:
	var js := U.load_json(_P + "shelf.json")
	var shelf := Node3D.new()
	shelf.name = "Shelf%d" % get_child_count()
	shelf.position = pos
	shelf.rotation_degrees.y = yaw_deg
	add_child(shelf)
	shelf.add_child(U.instance_glb(_P + "shelf.glb"))
	U.add_box_colliders(shelf, js.get("colliders", []), U.LAYER_WORLD_BIT)
	shelf.set_meta("top_y", float(js.get("top_y", 0.988)))
	return shelf

## brittle object standing at `pos` (world), yaw in degrees
func add_brittle(type: String, pos: Vector3, yaw_deg := 0.0, tint := "") -> void:
	var t: Dictionary = _types[type]
	var it := Item.new()
	it.type = type
	it.tint = tint
	var body := StaticBody3D.new()
	body.name = "%s_%d" % [type, _items.size()]
	body.collision_layer = U.LAYER_TARGET_BIT
	body.collision_mask = 0
	body.set_meta("surface", "glass" if TYPES[type]["glass"] else "ceramic")
	body.set_meta("item", _items.size())
	body.set_script(preload("res://scripts/targets/brittle_body.gd"))
	body.set("manager", self)
	var xf := Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_deg)), pos)
	if type == "clay":
		# stands on edge in the holder's saw kerf, dome toward the firing line
		xf = Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_deg)) * Basis(Vector3.RIGHT, PI * 0.5), pos)
	body.transform = xf
	if TYPES[type]["glass"]:
		var r := float(t["radius"])
		var h := float(t["height"])
		var body_h := h * 0.64
		_cyl(body, r, body_h, Vector3(0, body_h * 0.5, 0))
		_cyl(body, maxf(float(t["neck_radius"]), 0.012) + 0.002, h - body_h, Vector3(0, body_h + (h - body_h) * 0.5, 0))
	else:
		var cs := CollisionShape3D.new()
		cs.shape = (t["intact"] as Mesh).create_convex_shape(true, true)
		body.add_child(cs)
	var mi := MeshInstance3D.new()
	mi.mesh = t["intact"]
	mi.layers = U.RENDER_LAYER_TARGET
	if TYPES[type]["glass"]:
		it.mats = _glass(tint if tint != "" else "green")
		_apply_mats(mi, it.mats)
	body.add_child(mi)
	add_child(body)
	it.body = body
	it.mesh = mi
	_items.append(it)

func _cyl(body: Node3D, r: float, h: float, at: Vector3) -> void:
	var cs := CollisionShape3D.new()
	var sh := CylinderShape3D.new()
	sh.radius = r
	sh.height = h
	cs.shape = sh
	cs.position = at
	body.add_child(cs)

func add_clay_on_holder(pos: Vector3, yaw_deg := 0.0) -> void:
	var js := U.load_json(_P + "clay_holder.json")
	var holder := Node3D.new()
	holder.name = "ClayHolder%d" % _items.size()
	holder.position = pos
	holder.rotation_degrees.y = yaw_deg
	add_child(holder)
	holder.add_child(U.instance_glb(_P + "clay_holder.glb"))
	U.add_box_colliders(holder, js.get("colliders", []), U.LAYER_WORLD_BIT)
	var floor_y := float(js.get("slot_floor_y", 0.026))
	var r := float(_types["clay"]["radius"])
	# model base plane (y = 0) -> 5.5 mm behind the slot centre, so the 11 mm rim sits in the 13 mm kerf
	add_brittle("clay", pos + Basis(Vector3.UP, deg_to_rad(yaw_deg)) * Vector3(0, floor_y + r, -0.0055), yaw_deg)

func add_can(which: String, pos: Vector3, yaw_deg := 0.0) -> void:
	var js := U.load_json(_B + which + ".json")
	var can: RigidBody3D = TinCan.new()
	can.name = "%s_%d" % [which, _cans.size()]
	can.build(_B + which + ".glb", js)
	can.transform = Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_deg)), pos)
	add_child(can)
	can.remember_rest()
	can.can_hit.connect(func(info: Dictionary) -> void: hit_registered.emit(info))
	_cans.append(can)

# ------------------------------------------------------------------------------------------------ breaking
func on_item_hit(index: int, hit: Dictionary) -> Dictionary:
	var it: Item = _items[index]
	var cfg: Dictionary = TYPES[it.type]
	if it.broken:
		return {"stop": false, "speed_scale": 1.0, "fx": false}
	_break(it, hit)
	hit_registered.emit({"kind": cfg["kind"], "shot_index": int(hit.get("shot_index", -1)), "position": hit["position"]})
	return {"stop": false, "speed_scale": float(cfg["speed_scale"]), "fx": false}

func _exit_point(it: Item, t: Dictionary, pos: Vector3, dir: Vector3) -> Vector3:
	# far side of the object along the path: ray vs the object's bounding cylinder (model axis +Y)
	var inv := it.body.global_transform.affine_inverse()
	var p := inv * pos
	var d := (inv.basis * dir).normalized()
	var r := float(t["radius"])
	var a := d.x * d.x + d.z * d.z
	var chord := float(t["height"])
	if a > 1e-5:
		var b := 2.0 * (p.x * d.x + p.z * d.z)
		var c := p.x * p.x + p.z * p.z - r * r
		var disc := b * b - 4.0 * a * c
		if disc > 0.0:
			chord = (-b + sqrt(disc)) / (2.0 * a)
	chord = clampf(chord, 0.01, 2.5 * r + 0.02)
	if absf(d.y) > 1e-4:
		# leaves through the top or bottom first
		var ty := ((float(t["height"]) if d.y > 0.0 else 0.0) - p.y) / d.y
		if ty > 0.0:
			chord = minf(chord, ty)
	return pos + dir * chord

func _break(it: Item, hit: Dictionary) -> void:
	var cfg: Dictionary = TYPES[it.type]
	var t: Dictionary = _types[it.type]
	it.broken = true
	_broken_total += 1
	it.mesh.visible = false
	it.body.collision_layer = 0
	var pos: Vector3 = hit["position"]
	var dir: Vector3 = (hit.get("direction", Vector3.FORWARD) as Vector3).normalized()
	var p_lost := float(hit.get("mass", 0.008035)) * float(hit.get("speed", 335.0)) * (1.0 - float(cfg["speed_scale"]))
	var exit_pos := _exit_point(it, t, pos, dir)
	var xf := it.body.global_transform
	var sigma := float(cfg["sigma"])
	var pieces: Array = t["pieces"]
	var w1: Array[float] = []
	var w2: Array[float] = []
	var s1 := 0.0
	var s2 := 0.0
	var total_mass := float(t["mass"])
	for pc in pieces:
		var c: Vector3 = xf * (pc["centroid"] as Vector3)
		var a := exp(-pow(c.distance_to(pos) / sigma, 2.0))
		var b := exp(-pow(c.distance_to(exit_pos) / sigma, 2.0))
		w1.append(a)
		w2.append(b)
		var m := maxf(total_mass * float(pc["frac"]), 0.002)
		s1 += a * m
		s2 += b * m
	var burst := float(cfg["burst"])
	var axis_world := xf.basis.y.normalized()
	for i in pieces.size():
		var pc: Dictionary = pieces[i]
		var body := _take_body()
		var m := maxf(total_mass * float(pc["frac"]), 0.002)
		var c: Vector3 = xf * (pc["centroid"] as Vector3)
		# share of the lost momentum: 35 % where the bullet enters, 65 % where it leaves
		var v := dir * (0.35 * p_lost * w1[i] / maxf(s1, 1e-5) + 0.65 * p_lost * w2[i] / maxf(s2, 1e-5))
		var near := maxf(w1[i], w2[i])
		var from := pos if w1[i] >= w2[i] else exit_pos
		var out := c - from
		out = out.normalized() if out.length_squared() > 1e-8 else dir
		v += out * burst * near * _rng.randf_range(0.6, 1.3)
		# everything else just loses its support
		var radial := c - xf.origin
		radial -= axis_world * radial.dot(axis_world)
		v += (radial.normalized() if radial.length_squared() > 1e-8 else Vector3.ZERO) * _rng.randf_range(0.05, 0.3)
		v += Vector3(_rng.randf_range(-0.12, 0.12), _rng.randf_range(0.0, 0.25) * near, _rng.randf_range(-0.12, 0.12))
		if v.length() > 14.0:
			v = v.normalized() * 14.0
		var w := Vector3(_rng.randf_range(-1, 1), _rng.randf_range(-1, 1), _rng.randf_range(-1, 1)).normalized() * (1.5 + 28.0 * near) * _rng.randf_range(0.4, 1.0)
		_launch(body, pc, Transform3D(xf.basis, c), v, w, m, cfg, [it.mats[2], it.mats[1]] if it.mats.size() >= 3 else it.mats)
	_pieces_released += pieces.size()
	var fxn := U.fx(self)
	if fxn != null:
		var tint := Color.WHITE
		if it.tint != "" and GLASS_TINTS.has(it.tint):
			tint = GLASS_TINTS[it.tint]
		fxn.call("burst", cfg["fx"], exit_pos if cfg["glass"] else pos, -dir, dir, 1.0, tint)
	U.play(self, cfg["sound"], pos, {"pitch": float(cfg.get("pitch", 1.0)) * _rng.randf_range(0.97, 1.04), "volume_db": float(cfg.get("volume_db", 0.0))})
	# pieces reach the ground a moment later
	var drop := maxf(pos.y, 0.05)
	U.play(self, cfg["debris"], Vector3(pos.x, 0.05, pos.z) + dir * 0.4, {"delay": sqrt(2.0 * drop / 9.81) + 0.05, "volume_db": -3.0,
		"pitch": float(cfg.get("pitch", 1.0))})

func _take_body() -> RigidBody3D:
	if _free.is_empty():
		# pool exhausted: retire the oldest live fragment to a static mesh right away
		_settle(_live[0])
	var b: RigidBody3D = _free.pop_back()
	_live.append(b)
	return b

func _launch(body: RigidBody3D, pc: Dictionary, xf: Transform3D, v: Vector3, w: Vector3, m: float, cfg: Dictionary, mats: Array) -> void:
	var cs: CollisionShape3D = body.get_node("Shape")
	cs.shape = pc["shape"]
	var mi: MeshInstance3D = body.get_node("Mesh")
	mi.mesh = pc["mesh"]
	_apply_mats(mi, mats)
	body.mass = m
	var pm: PhysicsMaterial = _phys_mats.get(cfg["glb"])
	if pm == null:
		pm = PhysicsMaterial.new()
		pm.bounce = float(cfg["bounce"])
		pm.friction = float(cfg["friction"])
		_phys_mats[cfg["glb"]] = pm
	body.physics_material_override = pm
	body.freeze = false
	body.collision_layer = U.LAYER_DEBRIS_BIT
	body.collision_mask = U.LAYER_WORLD_BIT
	body.global_transform = xf
	body.reset_physics_interpolation()
	body.linear_velocity = v
	body.angular_velocity = w
	body.sleeping = false
	body.visible = true
	_live_info[body] = {"born": Engine.get_physics_frames(), "mats": mats}

func _settle(body: RigidBody3D) -> void:
	var mi: MeshInstance3D = body.get_node("Mesh")
	var info: Dictionary = _live_info.get(body, {})
	var s := _statics[_static_next]
	_static_next = (_static_next + 1) % STATIC_CAP
	if not s.visible:
		_static_used += 1
	s.mesh = mi.mesh
	_apply_mats(s, info.get("mats", []))
	s.global_transform = body.global_transform
	s.visible = true
	_park(body)

func _park(body: RigidBody3D) -> void:
	body.visible = false
	body.freeze = true
	body.collision_layer = 0
	body.collision_mask = 0
	_live.erase(body)
	_live_info.erase(body)
	if not _free.has(body):
		_free.append(body)

func _physics_process(_delta: float) -> void:
	if _live.is_empty():
		return
	var now := Engine.get_physics_frames()
	var tick := 1.0 / float(Engine.physics_ticks_per_second)
	var i := 0
	while i < _live.size():
		var b := _live[i]
		var age := float(now - int(_live_info[b]["born"])) * tick
		var slow := b.linear_velocity.length() < SETTLE_SPEED and b.angular_velocity.length() < 1.2
		if b.global_position.y < -5.0:
			_park(b)
		elif (age > 0.6 and (b.sleeping or slow)) or age > MAX_LIVE_TIME:
			_settle(b)
		else:
			i += 1

# ------------------------------------------------------------------------------------------------ API
func reset_all() -> void:
	while not _live.is_empty():
		_park(_live[0])
	for s in _statics:
		s.visible = false
		s.mesh = null
	_static_used = 0
	_static_next = 0
	for it in _items:
		it.broken = false
		it.mesh.visible = true
		it.body.collision_layer = U.LAYER_TARGET_BIT
	for c in _cans:
		c.reset_can()

func item_count() -> int:
	return _items.size()

func piece_count(type: String) -> int:
	return (_types[type]["pieces"] as Array).size()

func get_item(i: int) -> Item:
	return _items[i]

func get_cans() -> Array:
	return _cans

func all_asleep() -> bool:
	if not _live.is_empty():
		return false
	for c in _cans:
		if not c.sleeping:
			return false
	return true

func get_stats() -> Dictionary:
	var broken := 0
	for it in _items:
		if it.broken:
			broken += 1
	var moved := 0
	var can_hits := 0
	for c in _cans:
		can_hits += int(c.hits)
		if c.global_position.distance_to(c.rest_transform().origin) > 0.05:
			moved += 1
	return {"brittle": _items.size(), "broken": broken, "broken_total": _broken_total, "pieces_released": _pieces_released,
		"fragments_live": _live.size(), "fragments_free": _free.size(), "fragments_static": _static_used,
		"live_cap": LIVE_CAP, "static_cap": STATIC_CAP, "cans": _cans.size(), "cans_moved": moved, "can_hits": can_hits}
