extends RefCounted
## Painted faces of one steel plate: a 2-layer damage field (front, back; 384 px across the diameter) shown by
## plate.gdshader, and the lead-splash stamps scaled to this plate's size. Used by the hanging gongs and by the
## pivot plate.

const U := preload("res://scripts/targets/target_util.gd")
const FieldCanvas := preload("res://scripts/targets/field_canvas.gd")
const TEX_PX := 384
const STAMP_MM := 120.0
const STAMP_CELL_PX := 288
const STAMP_SCALES := [0.86, 1.0, 1.14]        # hit-to-hit size variation
const _S := "res://assets/targets/steel/"

var radius := 0.1016
var thickness := 0.009525
var canvas: FieldCanvas
var marks := 0
var _stamps: Array[Image] = []
var _rng := RandomNumberGenerator.new()

static var _stamp_cache := {}

func setup(mesh_instance: MeshInstance3D, p_radius: float, p_thickness: float) -> void:
	radius = p_radius
	thickness = p_thickness
	_rng.seed = int(p_radius * 100000.0) + mesh_instance.get_instance_id() % 1000
	canvas = FieldCanvas.new()
	canvas.setup(Vector2i(TEX_PX * 2, TEX_PX), TEX_PX, true)
	var key := int(round(radius * 10000.0))
	if not _stamp_cache.has(key):
		var list: Array[Image] = []
		var base_px := STAMP_MM * TEX_PX / (2.0 * radius * 1000.0)
		var tex: Texture2D = load("res://assets/targets/stamps/plate_splash.png")
		var k := 0
		for sc in STAMP_SCALES:
			for img in FieldCanvas.load_stamps(tex, STAMP_CELL_PX, int(round(base_px * float(sc))), false):
				list.append(img)
				var r: Image = img.duplicate()
				for q in 1 + k % 3:
					r.rotate_90(CLOCKWISE)
				if k % 2 == 1:
					r.flip_x()
				list.append(r)
				k += 1
		_stamp_cache[key] = list
	_stamps = _stamp_cache[key]
	for side in 2:
		var m := ShaderMaterial.new()
		m.shader = preload("res://scripts/targets/shaders/plate.gdshader")
		m.set_shader_parameter("paint_albedo", load(_S + "plate_8_plate_white_col.jpg"))
		m.set_shader_parameter("paint_normal", load(_S + "plate_8_plate_white_nor.jpg"))
		m.set_shader_parameter("steel_albedo", load(_S + "plate_8_plate_edge_col.jpg"))
		m.set_shader_parameter("steel_normal", load(_S + "plate_8_plate_edge_nor.jpg"))
		m.set_shader_parameter("field", canvas.texture)
		m.set_shader_parameter("layer", float(side))
		mesh_instance.set_surface_override_material(side, m)
	mesh_instance.layers = U.RENDER_LAYER_TARGET

## pixel in a face's texture for a point in plate-local coordinates (front = +Z face)
func local_to_px(local: Vector3, front: bool) -> Vector2:
	var u := 0.5 + (local.x if front else -local.x) / (2.0 * radius)
	var v := 0.5 - local.y / (2.0 * radius)
	return Vector2(u, v) * TEX_PX

func px_to_local(px: Vector2, front: bool) -> Vector3:
	var u := px.x / TEX_PX - 0.5
	var v := 0.5 - px.y / TEX_PX
	return Vector3((u if front else -u) * 2.0 * radius, v * 2.0 * radius, thickness * (0.5 if front else -0.5))

## returns true when a splash mark was painted (rim hits leave none)
func mark(local: Vector3) -> bool:
	if absf(local.z) < thickness * 0.5 - 0.0008:
		return false
	var front := local.z > 0.0
	canvas.stamp_layer(0 if front else 1, _stamps[_rng.randi() % _stamps.size()], local_to_px(local, front))
	marks += 1
	return true

func clear() -> void:
	canvas.clear()
	marks = 0

## sound group + pitch for the plate size (free-plate fundamentals: 12 in 0.52 kHz, 10 in 0.75, 8 in 1.18, 6 in 2.1)
func ring_sound() -> Array:
	var inches := radius * 2.0 / 0.0254
	if inches >= 11.0:
		return ["impact_steel", 0.94]
	if inches >= 9.0:
		return ["impact_steel", 1.2]
	if inches >= 7.0:
		return ["impact_steel_small", 0.92]
	return ["impact_steel_small", 1.2]
