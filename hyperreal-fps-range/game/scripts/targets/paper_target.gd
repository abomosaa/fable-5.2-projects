extends Node3D
## Paper target stapled to a cardboard backer on a DIY wooden stand.
##
## Local frame: origin on the ground under the target, the paper's front face is the plane z = 0 and looks along
## +Z (toward the firing line). Targets.gd places the node at world z = -distance, so `distance_m` is exactly the
## distance from the firing-line plane (z = 0) to the face.
##
## Every bullet that crosses the paper is recorded in millimetres on the face (x right, y up from the centre, as
## seen by the shooter) and a hole is stamped into the face texture at that exact spot; the cardboard gets its own
## hole where the bullet crosses it. The bullet goes on (paper 0.998 x cardboard 0.992 ~ 0.99 of its speed).

signal hit_registered(info: Dictionary)

const U := preload("res://scripts/targets/target_util.gd")
const FieldCanvas := preload("res://scripts/targets/field_canvas.gd")

const CENTER_Y := 1.40                         # height of the face centre (ISSF: 1.4 m)
const BACKER_SIZE := Vector2(0.610, 0.762)     # 24 x 30 in corrugated sheet
const BACKER_THICK := 0.003
const BACKER_FRONT_Z := -0.001
const PAPER_THICK := 0.001
const PAPER_PX_MM := 4.0
const BACKER_PX_MM := 2.0
const BULLET_RADIUS_MM := 4.5

const FACES := {
	"b8": {"title": "25 yd bullseye", "size_mm": Vector2(533.4, 609.6), "tint": Color(0.93, 0.86, 0.70),
		"artwork": "res://assets/targets/faces/face_b8.png", "ui": "res://assets/targets/faces/face_b8_ui.png",
		# scoring-ring radii in mm (outer edge of the line), NRA B-8 pattern: X, 10 ... 5
		"x_radius": 21.5265, "rings": [[10, 42.672], [9, 70.358], [8, 101.6], [7, 139.7], [6, 187.96], [5, 249.936]]},
	"issf": {"title": "25 m precision", "size_mm": Vector2(550.0, 550.0), "tint": Color(0.93, 0.915, 0.86),
		"artwork": "res://assets/targets/faces/face_issf.png", "ui": "res://assets/targets/faces/face_issf_ui.png",
		"x_radius": 12.5, "rings": [[10, 25.0], [9, 50.0], [8, 75.0], [7, 100.0], [6, 125.0], [5, 150.0], [4, 175.0], [3, 200.0], [2, 225.0], [1, 250.0]]},
}

var face_kind := "b8"
var label := "Paper target"
var distance_m := 10.0
var face_size_mm := Vector2(533.4, 609.6)
var selectable := false
var lane_x := 0.0

var _hits: Array[Dictionary] = []
var _card_hits := 0
var _wood_hits := 0
var _paper_canvas: FieldCanvas
var _card_canvas: FieldCanvas
var _paper_body: StaticBody3D
var _card_body: StaticBody3D
var _wood_sizes := {}
var _ui_base: Image
var _ui_tex: ImageTexture
var _ui_dirty := true
var _rng := RandomNumberGenerator.new()
var _last_paper_shot := -1

static var _paper_stamps: Array[Image] = []
static var _card_stamps: Array[Image] = []
static var _stand_json := {}

func setup(kind: String, p_label: String, p_lane_x: float, p_distance: float, p_selectable := false) -> void:
	face_kind = kind
	label = p_label
	lane_x = p_lane_x
	selectable = p_selectable
	face_size_mm = FACES[kind]["size_mm"]
	distance_m = p_distance
	position = Vector3(lane_x, 0.0, -distance_m)

func _ready() -> void:
	_rng.seed = hash(label) ^ 0x5f3759df
	if _paper_stamps.is_empty():
		_paper_stamps = FieldCanvas.load_stamps(load("res://assets/targets/stamps/paper_hole.png"), 56)
		_card_stamps = FieldCanvas.load_stamps(load("res://assets/targets/stamps/card_hole.png"), 28)
		_stand_json = U.load_json("res://assets/targets/stand/target_stand.json")
	var stand := U.instance_glb("res://assets/targets/stand/target_stand.glb")
	stand.name = "Stand"
	add_child(stand)
	for b in U.add_box_colliders(self, _stand_json.get("colliders", []), U.LAYER_WORLD_BIT, {"part": "wood", "fx_follow": true}):
		_wood_sizes[b] = (b.get_child(0) as CollisionShape3D).shape.size
	_build_backer()
	_build_paper()
	_build_staples()

# ------------------------------------------------------------------------------------------------ construction
func _quad(st: SurfaceTool, c: Vector3, w: float, h: float, front: bool, color := Color.WHITE) -> void:
	var pts := [Vector3(-w * 0.5, h * 0.5, 0), Vector3(w * 0.5, h * 0.5, 0), Vector3(w * 0.5, -h * 0.5, 0), Vector3(-w * 0.5, -h * 0.5, 0)]
	var uvs := [Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)]
	var order := [0, 1, 2, 0, 2, 3] if front else [0, 2, 1, 0, 3, 2]
	for i in order:
		st.set_color(color)
		st.set_normal(Vector3(0, 0, 1 if front else -1))
		st.set_uv(uvs[i])
		st.add_vertex(c + pts[i])

func _build_paper() -> void:
	var f: Dictionary = FACES[face_kind]
	var size := face_size_mm * 0.001
	var px := Vector2i(int(round(face_size_mm.x * PAPER_PX_MM)), int(round(face_size_mm.y * PAPER_PX_MM)))
	_paper_canvas = FieldCanvas.new()
	_paper_canvas.setup(px, 256)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	_quad(st, Vector3.ZERO, size.x, size.y, true)
	st.generate_tangents()
	var mat := ShaderMaterial.new()
	mat.shader = preload("res://scripts/targets/shaders/paper.gdshader")
	mat.set_shader_parameter("artwork", load(f["artwork"]))
	mat.set_shader_parameter("paper_normal", preload("res://assets/targets/faces/paper_normal.png"))
	mat.set_shader_parameter("field", _paper_canvas.texture)
	mat.set_shader_parameter("grid", Vector2(_paper_canvas.cols, _paper_canvas.rows))
	mat.set_shader_parameter("canvas_scale", Vector2(px) / (Vector2(_paper_canvas.cols, _paper_canvas.rows) * 256.0))
	mat.set_shader_parameter("paper_tint", f["tint"])
	var mi := MeshInstance3D.new()
	mi.name = "PaperMesh"
	mi.mesh = st.commit()
	mi.material_override = mat
	mi.layers = U.RENDER_LAYER_TARGET
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_paper_body = StaticBody3D.new()
	_paper_body.name = "Paper"
	_paper_body.collision_layer = U.LAYER_TARGET_BIT
	_paper_body.collision_mask = 0
	_paper_body.set_meta("surface", "paper")
	_paper_body.set_meta("part", "paper")
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = Vector3(size.x, size.y, PAPER_THICK)
	cs.shape = sh
	cs.position = Vector3(0, 0, -PAPER_THICK * 0.5)
	_paper_body.add_child(cs)
	_paper_body.add_child(mi)
	_paper_body.position = Vector3(0, CENTER_Y, 0)
	add_child(_paper_body)

func _build_backer() -> void:
	var px := Vector2i(int(round(BACKER_SIZE.x * 1000.0 * BACKER_PX_MM)), int(round(BACKER_SIZE.y * 1000.0 * BACKER_PX_MM)))
	_card_canvas = FieldCanvas.new()
	_card_canvas.setup(px, 128)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	_quad(st, Vector3(0, 0, 0), BACKER_SIZE.x, BACKER_SIZE.y, true)
	_quad(st, Vector3(0, 0, -BACKER_THICK), BACKER_SIZE.x, BACKER_SIZE.y, false)
	# cut edges
	var hw := BACKER_SIZE.x * 0.5
	var hh := BACKER_SIZE.y * 0.5
	var edge := Color(0, 0, 0)
	var rim := [[Vector3(-hw, hh, -BACKER_THICK), Vector3(hw, hh, -BACKER_THICK), Vector3(hw, hh, 0), Vector3(-hw, hh, 0), Vector3.UP],
		[Vector3(-hw, -hh, 0), Vector3(hw, -hh, 0), Vector3(hw, -hh, -BACKER_THICK), Vector3(-hw, -hh, -BACKER_THICK), Vector3.DOWN],
		[Vector3(hw, hh, 0), Vector3(hw, hh, -BACKER_THICK), Vector3(hw, -hh, -BACKER_THICK), Vector3(hw, -hh, 0), Vector3.RIGHT],
		[Vector3(-hw, hh, -BACKER_THICK), Vector3(-hw, hh, 0), Vector3(-hw, -hh, 0), Vector3(-hw, -hh, -BACKER_THICK), Vector3.LEFT]]
	for q in rim:
		var uv := [Vector2(0, 0), Vector2(1, 0), Vector2(1, 0.005), Vector2(0, 0.005)]
		for i in [0, 1, 2, 0, 2, 3]:
			st.set_color(edge)
			st.set_normal(q[4])
			st.set_uv(uv[i])
			st.add_vertex(q[i])
	st.generate_tangents()
	var mat := ShaderMaterial.new()
	mat.shader = preload("res://scripts/targets/shaders/backer.gdshader")
	mat.set_shader_parameter("albedo_tex", preload("res://assets/targets/textures/cardboard_albedo.jpg"))
	mat.set_shader_parameter("normal_tex", preload("res://assets/targets/textures/cardboard_normal.jpg"))
	mat.set_shader_parameter("orm_tex", preload("res://assets/targets/textures/cardboard_orm.jpg"))
	mat.set_shader_parameter("field", _card_canvas.texture)
	mat.set_shader_parameter("grid", Vector2(_card_canvas.cols, _card_canvas.rows))
	mat.set_shader_parameter("canvas_scale", Vector2(px) / (Vector2(_card_canvas.cols, _card_canvas.rows) * 128.0))
	mat.set_shader_parameter("size_m", BACKER_SIZE)
	var mi := MeshInstance3D.new()
	mi.name = "BackerMesh"
	mi.mesh = st.commit()
	mi.material_override = mat
	mi.layers = U.RENDER_LAYER_TARGET
	_card_body = StaticBody3D.new()
	_card_body.name = "Backer"
	_card_body.collision_layer = U.LAYER_TARGET_BIT
	_card_body.collision_mask = 0
	_card_body.set_meta("surface", "cardboard")
	_card_body.set_meta("part", "backer")
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = Vector3(BACKER_SIZE.x, BACKER_SIZE.y, BACKER_THICK)
	cs.shape = sh
	cs.position = Vector3(0, 0, -BACKER_THICK * 0.5)
	_card_body.add_child(cs)
	_card_body.add_child(mi)
	_card_body.position = Vector3(0, CENTER_Y, BACKER_FRONT_Z)
	add_child(_card_body)

func _build_staples() -> void:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var bm := BoxMesh.new()
	bm.size = Vector3(0.0125, 0.0013, 0.0007)
	var half := face_size_mm * 0.0005
	var spots: Array[Vector3] = []
	for sx in [-1.0, 1.0]:
		for sy in [-1.0, 1.0]:
			spots.append(Vector3(sx * (half.x - 0.016), CENTER_Y + sy * (half.y - 0.014), 0.0004))
	# cardboard onto the uprights
	for sx in [-0.215, 0.215]:
		for y in [CENTER_Y + 0.33, CENTER_Y, CENTER_Y - 0.33]:
			spots.append(Vector3(sx + _rng.randf_range(-0.006, 0.006), y + _rng.randf_range(-0.03, 0.03), BACKER_FRONT_Z + 0.0004))
	for s in spots:
		st.append_from(bm, 0, Transform3D(Basis(Vector3.BACK, _rng.randf_range(-0.5, 0.5)), s))
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(0.72, 0.72, 0.74)
	m.metallic = 1.0
	m.roughness = 0.35
	var mi := MeshInstance3D.new()
	mi.name = "Staples"
	mi.mesh = st.commit()
	mi.material_override = m
	mi.layers = U.RENDER_LAYER_TARGET
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)

# ------------------------------------------------------------------------------------------------ geometry
func set_distance(d: float) -> void:
	distance_m = d
	position = Vector3(lane_x, 0.0, -d)
	reset_physics_interpolation()

## world position -> millimetres on the face (x right, y up from the centre, seen from the firing line)
func world_to_mm(world: Vector3) -> Vector2:
	var l := to_local(world)
	return Vector2(l.x, l.y - CENTER_Y) * 1000.0

func mm_to_world(mm: Vector2) -> Vector3:
	return to_global(Vector3(mm.x * 0.001, CENTER_Y + mm.y * 0.001, 0.0))

func is_on_paper(mm: Vector2) -> bool:
	return absf(mm.x) <= face_size_mm.x * 0.5 and absf(mm.y) <= face_size_mm.y * 0.5

## ring value for a hit centred at `mm`: a hole that touches a ring line counts for the higher ring, so the
## bullet's edge (4.5 mm inside its centre) is compared with the outer edge of each line.
static func score_at(kind: String, mm: Vector2) -> Dictionary:
	var f: Dictionary = FACES[kind]
	var edge := mm.length() - BULLET_RADIUS_MM
	var res := {"score": 0, "x": false}
	for ring in f["rings"]:
		if edge <= float(ring[1]):
			res["score"] = int(ring[0])
			break
	if edge <= float(f["x_radius"]):
		res["x"] = true
	return res

# ------------------------------------------------------------------------------------------------ hits
func on_bullet_hit(hit: Dictionary) -> Dictionary:
	var col: Object = hit.get("collider")
	var part := str(col.get_meta("part", "wood")) if col != null else "wood"
	var pos: Vector3 = hit["position"]
	var dir: Vector3 = hit.get("direction", Vector3.FORWARD)
	match part:
		"paper":
			var mm := world_to_mm(pos)
			var sc := score_at(face_kind, mm)
			var rec := {"pos_mm": mm, "score": sc["score"], "x": sc["x"], "shot_index": int(hit.get("shot_index", -1)),
				"speed": float(hit.get("speed", 0.0)), "msec": Time.get_ticks_msec()}
			_hits.append(rec)
			_last_paper_shot = int(rec["shot_index"])
			var px := Vector2(face_size_mm.x * 0.5 + mm.x, face_size_mm.y * 0.5 - mm.y) * PAPER_PX_MM
			_paper_canvas.stamp(_paper_stamps[_rng.randi() % _paper_stamps.size()], px)
			_ui_dirty = true
			U.play(self, "impact_paper", pos, {"volume_db": -5.0, "pitch": _rng.randf_range(0.95, 1.06)})
			hit_registered.emit({"kind": "paper", "distance_m": distance_m, "score": sc["score"], "x": sc["x"], "pos_mm": mm, "target": self,
				"label": label, "shot_index": rec["shot_index"], "count": _hits.size()})
			return {"stop": false, "speed_scale": 0.998, "fx": false}
		"backer":
			_card_hits += 1
			var l := _card_body.to_local(pos)
			var cpx := Vector2(BACKER_SIZE.x * 0.5 + l.x, BACKER_SIZE.y * 0.5 - l.y) * 1000.0 * BACKER_PX_MM
			_card_canvas.stamp(_card_stamps[_rng.randi() % _card_stamps.size()], cpx)
			U.play(self, "impact_cardboard", pos, {"volume_db": -4.0, "pitch": _rng.randf_range(0.95, 1.06)})
			var fxn := U.fx(self)
			if fxn != null:
				# fluff leaves on the far side
				fxn.call("burst", "paper", pos + dir * 0.006, -dir, dir, 1.0)
			if int(hit.get("shot_index", -2)) != _last_paper_shot:
				hit_registered.emit({"kind": "cardboard", "distance_m": distance_m, "target": self, "label": label,
					"shot_index": int(hit.get("shot_index", -1))})
			return {"stop": false, "speed_scale": 0.992, "fx": false}
		_:
			# stand lumber: the bullet punches through (19 mm furring strip: ~0.9; a 2x4: ~0.8)
			_wood_hits += 1
			var size: Vector3 = _wood_sizes.get(col, Vector3(0.038, 1.0, 0.019))
			var thin := minf(size.x, minf(size.y, size.z)) < 0.03
			var fxn2 := U.fx(self)
			if fxn2 != null and col is Node3D:
				var ex := U.box_exit(col, size, pos, dir)
				if not ex.is_empty():
					var e := hit.duplicate()
					e["position"] = ex["position"]
					e["normal"] = ex["normal"]
					e["exit"] = true
					fxn2.call("spawn_world_impact", e)
			hit_registered.emit({"kind": "stand", "distance_m": distance_m, "target": self, "label": label, "shot_index": int(hit.get("shot_index", -1))})
			return {"stop": false, "speed_scale": 0.9 if thin else 0.8, "fx": true}

# ------------------------------------------------------------------------------------------------ API
func get_hits() -> Array[Dictionary]:
	return _hits

func hit_count() -> int:
	return _hits.size()

func total_score() -> int:
	var s := 0
	for h in _hits:
		s += int(h["score"])
	return s

func clear() -> void:
	_hits.clear()
	_card_hits = 0
	_wood_hits = 0
	_last_paper_shot = -1
	_paper_canvas.clear()
	_card_canvas.clear()
	_ui_dirty = true

## Flat picture of the face for 2D display (2 px/mm, sRGB) with every recorded hole drawn at its exact position.
func get_face_texture() -> Texture2D:
	if _ui_base == null:
		var t: Texture2D = load(FACES[face_kind]["ui"])
		_ui_base = t.get_image()
		if _ui_base.is_compressed():
			_ui_base.decompress()
		_ui_base.convert(Image.FORMAT_RGBA8)
		_ui_base.clear_mipmaps()
	if _ui_dirty or _ui_tex == null:
		var img: Image = _ui_base.duplicate()
		var hole := _ui_hole_stamp()
		var s := _ui_base.get_width() / face_size_mm.x
		for h in _hits:
			var mm: Vector2 = h["pos_mm"]
			var c := Vector2(face_size_mm.x * 0.5 + mm.x, face_size_mm.y * 0.5 - mm.y) * s
			img.blend_rect(hole, Rect2i(0, 0, hole.get_width(), hole.get_height()), Vector2i(c.round()) - hole.get_size() / 2)
		if _ui_tex == null:
			_ui_tex = ImageTexture.create_from_image(img)
		else:
			_ui_tex.update(img)
		_ui_dirty = false
	return _ui_tex

static var _ui_hole: Image
static func _ui_hole_stamp() -> Image:
	if _ui_hole == null:
		var n := 24            # 12 mm at 2 px/mm
		_ui_hole = Image.create(n, n, false, Image.FORMAT_RGBA8)
		for y in n:
			for x in n:
				var r := Vector2(x - 11.5, y - 11.5).length() / 2.0      # mm
				var c := Color(0, 0, 0, 0)
				if r < 3.4:
					c = Color(0.07, 0.065, 0.06, 1.0)
				elif r < 4.6:
					c = Color(0.3, 0.3, 0.31, clampf((4.6 - r) / 1.0, 0.0, 1.0) * 0.8)
				_ui_hole.set_pixel(x, y, c)
	return _ui_hole

func get_stats() -> Dictionary:
	return {"hits": _hits.size(), "card_hits": _card_hits, "wood_hits": _wood_hits, "paper_tiles": _paper_canvas.touched_tiles(),
		"card_tiles": _card_canvas.touched_tiles(), "uploads": _paper_canvas.uploads + _card_canvas.uploads}
