extends Node3D
## FXWorld - bullet impact marks/debris on world surfaces, ejected brass, muzzle gas. See docs/ARCHITECTURE.md.
##
## Contract API: spawn_world_impact(hit), eject_casing(xform, lin, ang), muzzle_event(xform, lum, shot_index),
## prewarm() [awaitable], clear(), get_stats().
## Extra (used by the Targets module): burst(kind, pos, normal, dir, strength, tint), `wind` (m/s, world space).
##
## Everything is pooled: 300 decals, 384 dust/smoke billboards, 320 debris meshes, 64 brass cases, 1 light,
## 2 flash quads. Nothing is allocated after _ready.
##
## `ambient_luminance` convention (set by the weapon): 1.0 = open sunlight, ~0.35 = under the bay roof,
## <= 0.05 = dusk; >= 3 means "reduce flashes" and suppresses flash and light completely.

const Particles := preload("res://scripts/fx/fx_particles.gd")
const Decals := preload("res://scripts/fx/fx_decals.gd")
const CasingBody := preload("res://scripts/fx/casing_body.gd")
const Layout := preload("res://scripts/range/layout.gd")
const CASING_SCENE := "res://assets/weapon/casing.gltf"

const CASING_CAP := 64                 # bodies in the pool; at most 60 stay on the ground
const CASING_GROUND_CAP := 60
const CASING_RADIUS := 0.00495
const CASING_LENGTH := 0.019
const CASING_MASS := 0.0041
const CASING_CENTER_Z := 0.00515       # mesh spans z = -4.37 .. +14.67 mm

const _T := "res://assets/fx/tex/"
const DECAL_TEX := {
	"dirt": [[preload(_T + "decal_dirt_0.png"), preload(_T + "decal_dirt_0_n.png")], [preload(_T + "decal_dirt_1.png"), preload(_T + "decal_dirt_1_n.png")],
		[preload(_T + "decal_dirt_2.png"), preload(_T + "decal_dirt_2_n.png")]],
	"chip": [[preload(_T + "decal_chip_0.png"), preload(_T + "decal_chip_0_n.png")], [preload(_T + "decal_chip_1.png"), preload(_T + "decal_chip_1_n.png")],
		[preload(_T + "decal_chip_2.png"), preload(_T + "decal_chip_2_n.png")]],
	"skid": [[preload(_T + "decal_skid_0.png"), preload(_T + "decal_skid_0_n.png")], [preload(_T + "decal_skid_1.png"), preload(_T + "decal_skid_1_n.png")]],
	"wood": [[preload(_T + "decal_wood_0.png"), preload(_T + "decal_wood_0_n.png")], [preload(_T + "decal_wood_1.png"), preload(_T + "decal_wood_1_n.png")],
		[preload(_T + "decal_wood_2.png"), preload(_T + "decal_wood_2_n.png")]],
	"woodexit": [[preload(_T + "decal_woodexit_0.png"), preload(_T + "decal_woodexit_0_n.png")], [preload(_T + "decal_woodexit_1.png"), preload(_T + "decal_woodexit_1_n.png")]],
	"metal": [[preload(_T + "decal_metal_0.png"), preload(_T + "decal_metal_0_n.png")], [preload(_T + "decal_metal_1.png"), preload(_T + "decal_metal_1_n.png")],
		[preload(_T + "decal_metal_2.png"), preload(_T + "decal_metal_2_n.png")]],
	"metalexit": [[preload(_T + "decal_metalexit_0.png"), preload(_T + "decal_metalexit_0_n.png")], [preload(_T + "decal_metalexit_1.png"), preload(_T + "decal_metalexit_1_n.png")]],
	"splash": [[preload(_T + "decal_splash_0.png"), preload(_T + "decal_splash_0_n.png")], [preload(_T + "decal_splash_1.png"), preload(_T + "decal_splash_1_n.png")],
		[preload(_T + "decal_splash_2.png"), preload(_T + "decal_splash_2_n.png")]],
	"rubber": [[preload(_T + "decal_rubber_0.png"), preload(_T + "decal_rubber_0_n.png")], [preload(_T + "decal_rubber_1.png"), preload(_T + "decal_rubber_1_n.png")]],
}
const SKY_EMISSION := preload(_T + "decal_metal_sky_e.png")
const FLASH_ATLAS := preload(_T + "flash_atlas.png")

## sound group per surface tag: [group, volume_db, pitch]
const SURFACE_SOUND := {
	"dirt": ["impact_dirt", 0.0, 1.0], "sandbag": ["impact_dirt", -3.0, 1.05], "grass": ["impact_dirt", -2.0, 1.0],
	"gravel": ["impact_dirt", 0.0, 1.06], "concrete": ["impact_concrete", 0.0, 1.0], "block": ["impact_concrete", -1.0, 0.96],
	"wood": ["impact_wood", 0.0, 1.0], "plywood": ["impact_wood", -1.0, 1.04], "sheet_metal": ["impact_sheet_metal", 0.0, 1.0],
	"steel": ["impact_steel_small", -8.0, 1.06], "rubber": ["impact_dirt", -5.0, 0.94],
}
const CASING_SOUND := {
	"concrete": "casing_concrete_hit", "block": "casing_concrete_hit", "steel": "casing_concrete_hit", "sheet_metal": "casing_concrete_hit",
	"wood": "casing_wood_hit", "plywood": "casing_wood_hit",
	"dirt": "casing_dirt_hit", "grass": "casing_dirt_hit", "gravel": "casing_dirt_hit", "sandbag": "casing_dirt_hit", "rubber": "casing_dirt_hit",
}

## Global wind (m/s). Dust and smoke relax toward it; a slow gust factor is applied on top.
@export var wind := Vector3(0.9, 0.0, 0.35)
## Colour of the daylight seen through a hole shot in the roof (unshaded disc on the decal).
@export var sky_hole_color := Color(0.62, 0.78, 1.0)
@export var sky_hole_energy := 3.0

var particles: Node3D
var decals: Node3D
var _rng := RandomNumberGenerator.new()
var _audio: Node
var _time := 0.0

# casings
var _casings: Array = []
var _casing_next := 0
var _settle_order: Array = []          # settled casings, oldest first

# muzzle
var _flash: Array[MeshInstance3D] = []
var _flash_mat: Array[ShaderMaterial] = []
var _flash_frame := -1
var _last_flash_cell := -1
var _light: OmniLight3D
var _light_frames := 0
var _light_energy := 0.0
var _stats := {"impacts": 0, "muzzle_events": 0, "flashes": 0, "casings_ejected": 0, "casing_sounds": 0}

func _ready() -> void:
	add_to_group("fx_world")
	_rng.randomize()
	_audio = get_node_or_null("/root/AudioDirector")
	particles = Particles.new()
	particles.name = "Particles"
	add_child(particles)
	decals = Decals.new()
	decals.name = "Decals"
	add_child(decals)
	var all := []
	for k in DECAL_TEX:
		for pair in DECAL_TEX[k]:
			all.append(pair[0])
			all.append(pair[1])
	all.append(SKY_EMISSION)
	decals.register_textures(all)
	_build_casings()
	_build_muzzle()

# ------------------------------------------------------------------------------------------------ helpers
func _play(group: String, pos: Vector3, opts := {}) -> void:
	if _audio != null:
		_audio.call("play_world", group, pos, opts)

func _has_sound(group: String) -> bool:
	return _audio != null and (not _audio.has_method("has_group") or bool(_audio.call("has_group", group)))

func _cone(axis: Vector3, half_angle_deg: float) -> Vector3:
	var a := axis.normalized()
	var t := a.cross(Vector3.UP if absf(a.y) < 0.95 else Vector3.RIGHT).normalized()
	var b := a.cross(t)
	var ang := deg_to_rad(half_angle_deg) * sqrt(_rng.randf())
	var az := _rng.randf() * TAU
	return (a * cos(ang) + (t * cos(az) + b * sin(az)) * sin(ang)).normalized()

func _in_plane(n: Vector3, spread_deg: float) -> Vector3:
	var t := n.cross(Vector3.UP if absf(n.y) < 0.95 else Vector3.RIGHT).normalized()
	var b := n.cross(t)
	var az := _rng.randf() * TAU
	var el := deg_to_rad(_rng.randf_range(-spread_deg * 0.3, spread_deg))
	return ((t * cos(az) + b * sin(az)) * cos(el) + n * sin(el)).normalized()

func _surface_xform(pos: Vector3, n: Vector3, hint: Vector3, roll: float) -> Transform3D:
	var x := hint - n * hint.dot(n)
	if x.length_squared() < 1e-6:
		x = n.cross(Vector3.FORWARD if absf(n.z) < 0.9 else Vector3.RIGHT)
	x = x.normalized().rotated(n, roll)
	return Transform3D(Basis(x, n, x.cross(n).normalized()), pos)

func _floor_below(pos: Vector3, n: Vector3) -> float:
	if not is_inside_tree():
		return pos.y
	var space := get_world_3d().direct_space_state
	if space == null:
		return pos.y
	var from := pos + n * 0.06
	var q := PhysicsRayQueryParameters3D.create(from, from + Vector3.DOWN * 12.0, 1)
	var r := space.intersect_ray(q)
	return (r["position"] as Vector3).y if not r.is_empty() else minf(pos.y, 0.0)

func _wind_now() -> Vector3:
	return wind * (1.0 + 0.25 * sin(_time * 0.43) + 0.12 * sin(_time * 1.31 + 1.7))

func _jit(c: Color, amount: float) -> Color:
	var k := 1.0 + _rng.randf_range(-amount, amount)
	return Color(c.r * k, c.g * k, c.b * k, c.a)

func _n(base: float, scale: float) -> int:
	return maxi(0, roundi(base * scale * _rng.randf_range(0.7, 1.3)))

func _dust(pos: Vector3, axis: Vector3, cone: float, count: int, color: Color, alpha: float, speed: Vector2, size0: Vector2, size1: Vector2,
		life: Vector2, drag := 5.0, buoy := 0.12, windk := 1.0) -> void:
	for i in count:
		var dir := _cone(axis, cone)
		var c := _jit(color, 0.12)
		c.a = minf(alpha * 1.25 * _rng.randf_range(0.7, 1.15), 1.0)
		particles.puff(pos + dir * _rng.randf_range(0.0, size0.x), dir * _rng.randf_range(speed.x, speed.y), _rng.randf_range(size0.x, size0.y),
			_rng.randf_range(size1.x, size1.y), _rng.randf_range(life.x, life.y), c, drag * _rng.randf_range(0.75, 1.3), buoy, windk)

func _debris(pos: Vector3, axis: Vector3, cone: float, count: int, color: Color, speed: Vector2, size: Vector2, aspect: Vector3,
		n: Vector3, floor_y: float, life := Vector2(4.0, 8.0), metallic := 0.0, roughness := 0.9, emission := 0.0, rest := 0.3, in_plane := false) -> void:
	for i in count:
		var dir := _in_plane(n, cone) if in_plane else _cone(axis, cone)
		var s := _rng.randf_range(size.x, size.y)
		# small bits fly faster than big ones
		var v := lerpf(speed.y, speed.x, clampf((s - size.x) / maxf(size.y - size.x, 1e-5), 0.0, 1.0)) * _rng.randf_range(0.6, 1.2)
		var sc := Vector3(aspect.x * _rng.randf_range(0.7, 1.3), aspect.y * _rng.randf_range(0.7, 1.3), aspect.z * _rng.randf_range(0.7, 1.3)) * s
		particles.chunk(pos + n * 0.004, dir * v, sc, _jit(color, 0.25), _rng.randf_range(life.x, life.y), n, pos, floor_y,
			metallic, roughness, emission, rest)

func _mark(kind: String, hit: Dictionary, size_m: Vector2, depth: float, hint: Vector3, roll: float, opts := {}) -> void:
	var set: Array = DECAL_TEX[kind]
	var pair: Array = set[_rng.randi() % set.size()]
	var n: Vector3 = hit["normal"]
	var col: Object = hit.get("collider")
	if col != null and is_instance_valid(col) and (not (col is StaticBody3D) or col.has_meta("fx_follow")):
		opts["follow"] = col
	decals.spawn(pair[0], pair[1], _surface_xform(hit["position"], n, hint, roll), Vector3(size_m.x, depth, size_m.y), opts)

# ------------------------------------------------------------------------------------------------ impacts
func spawn_world_impact(hit: Dictionary) -> void:
	_stats["impacts"] += 1
	var pos: Vector3 = hit["position"]
	var n: Vector3 = (hit.get("normal", Vector3.UP) as Vector3).normalized()
	var d: Vector3 = (hit.get("direction", -n) as Vector3).normalized()
	var surface := str(hit.get("surface", "dirt"))
	var energy := float(hit.get("energy", 0.5 * float(hit.get("mass", 0.008)) * pow(float(hit.get("speed", 330.0)), 2.0)))
	var es := clampf(energy / 450.0, 0.12, 1.3)
	var is_exit := bool(hit.get("exit", false))
	# Some colliders (triangle-mesh terrain) report the face normal of the triangle's winding rather than the side
	# that was struck. An entry mark always faces the bullet, an exit mark faces along it.
	if (n.dot(d) > 0.0) != is_exit and absf(n.dot(d)) > 1e-4:
		n = -n
		hit = hit.duplicate()
		hit["normal"] = n
	var cosi := clampf(-d.dot(n), 0.0, 1.0) if not is_exit else clampf(d.dot(n), 0.0, 1.0)
	var graze := rad_to_deg(asin(cosi))                 # angle between the path and the surface
	var along := d - n * d.dot(n)                        # travel direction in the surface plane
	if along.length_squared() > 1e-6:
		along = along.normalized()
	# ejecta axis: mostly the surface normal, leaning with the reflected path for oblique hits
	var refl := d.bounce(n) if not is_exit else d
	var axis := (n * (0.55 + 0.45 * cosi) + refl * (1.0 - cosi) * 0.8).normalized()
	var floor_y := _floor_below(pos, n)
	var roll := _rng.randf() * TAU
	var up_hint := Vector3.UP if absf(n.y) < 0.9 else Vector3.FORWARD
	match surface:
		"dirt", "sandbag":
			var sand := surface == "sandbag"
			# airborne fines are paler than the damp ground they came from
			var dust := Color(0.66, 0.58, 0.46) if not sand else Color(0.74, 0.67, 0.54)
			# fast spurt that stalls within a metre ...
			_dust(pos + n * 0.03, axis, 26.0, _n(9.0, 0.5 + 0.5 * es), dust, 0.60, Vector2(1.5, 6.5) * (0.6 + 0.4 * es), Vector2(0.06, 0.12), Vector2(0.45, 0.95),
				Vector2(1.2, 2.4), 4.5, 0.15)
			# ... and the slower cloud it leaves, which hangs, spreads and drifts off with the wind (seen from the line)
			_dust(pos + n * 0.08, axis, 40.0, _n(9.0, 0.5 + 0.5 * es), dust, 0.50, Vector2(0.4, 2.0), Vector2(0.16, 0.28), Vector2(1.0, 1.9),
				Vector2(2.8, 5.0), 2.2, 0.22)
			if sand:
				_debris(pos, axis, 30.0, _n(10.0, es), Color(0.55, 0.48, 0.36), Vector2(0.8, 2.5), Vector2(0.003, 0.007), Vector3.ONE, n, floor_y, Vector2(2.0, 4.0))
				_mark("rubber", hit, Vector2.ONE * _rng.randf_range(0.03, 0.04), 0.08, up_hint, roll, {"modulate": Color(0.5, 0.42, 0.3, 0.9)})
			else:
				_debris(pos, axis, 38.0, _n(9.0, es), Color(0.17, 0.125, 0.085), Vector2(1.6, 6.0), Vector2(0.006, 0.024), Vector3(1.0, 0.7, 0.85), n, floor_y,
					Vector2(5.0, 9.0), 0.0, 0.95, 0.0, 0.12)
				var sz := _rng.randf_range(0.22, 0.30) * (0.75 + 0.25 * es)
				var stretch := 1.0 + (1.0 - cosi) * 0.5
				# texture +x = the side the soil is thrown to = back toward where the bullet came from
				_mark("dirt", hit, Vector2(sz * stretch, sz), 0.5, -along if along.length_squared() > 0.5 else up_hint, _rng.randf_range(-0.3, 0.3),
					{"normal_fade": 0.0})
		"gravel":
			_dust(pos + n * 0.03, axis, 35.0, _n(4.0, 0.5 + 0.5 * es), Color(0.56, 0.52, 0.46), 0.34, Vector2(0.8, 3.0), Vector2(0.05, 0.10), Vector2(0.3, 0.6),
				Vector2(1.0, 2.2), 5.0, 0.15)
			_debris(pos, axis, 50.0, _n(5.0, es), Color(0.44, 0.42, 0.39), Vector2(1.5, 5.0), Vector2(0.008, 0.02), Vector3(1.0, 0.75, 0.9), n, floor_y,
				Vector2(5.0, 9.0), 0.0, 0.9, 0.0, 0.45)
			var sg := _rng.randf_range(0.11, 0.16)
			_mark("dirt", hit, Vector2(sg, sg), 0.35, up_hint, roll, {"normal_fade": 0.0, "modulate": Color(1.5, 1.45, 1.4, 0.8)})
		"grass":
			_dust(pos + n * 0.03, axis, 30.0, _n(3.0, 0.5 + 0.5 * es), Color(0.42, 0.36, 0.27), 0.30, Vector2(0.6, 2.2), Vector2(0.05, 0.09), Vector2(0.25, 0.45),
				Vector2(0.9, 1.8), 5.5, 0.12)
			_debris(pos, axis, 35.0, _n(4.0, es), Color(0.14, 0.2, 0.07), Vector2(1.5, 4.5), Vector2(0.012, 0.03), Vector3(1.0, 0.12, 0.2), n, floor_y,
				Vector2(4.0, 8.0), 0.0, 0.9, 0.0, 0.05)
			_debris(pos, axis, 35.0, _n(4.0, es), Color(0.16, 0.12, 0.08), Vector2(1.5, 4.0), Vector2(0.005, 0.016), Vector3(1.0, 0.7, 0.85), n, floor_y,
				Vector2(4.0, 8.0), 0.0, 0.95, 0.0, 0.08)
			var sgr := _rng.randf_range(0.13, 0.19)
			_mark("dirt", hit, Vector2(sgr, sgr), 0.45, up_hint, roll, {"normal_fade": 0.0})
		"concrete", "block":
			var grey := Color(0.66, 0.65, 0.62) if surface == "concrete" else Color(0.6, 0.6, 0.58)
			if graze < 12.0 and not is_exit:
				# skid: the bullet scrapes along and leaves; dust is dragged along the path, no crater
				var ln := _rng.randf_range(0.14, 0.26)
				_mark("skid", hit, Vector2(ln, _rng.randf_range(0.022, 0.034)), 0.04, along, 0.0, {"normal_fade": 0.5})
				_dust(pos + n * 0.02, (along + n * 0.35).normalized(), 18.0, _n(4.0, es), grey, 0.32, Vector2(2.0, 6.0), Vector2(0.03, 0.06), Vector2(0.2, 0.4),
					Vector2(0.6, 1.3), 6.5, 0.05)
				_debris(pos, (along + n * 0.3).normalized(), 20.0, _n(2.0, es), grey * 1.05, Vector2(2.0, 6.0), Vector2(0.003, 0.008), Vector3(1.0, 0.5, 0.8), n, floor_y,
					Vector2(4.0, 7.0), 0.0, 0.9, 0.0, 0.35)
			else:
				_dust(pos + n * 0.02, axis, 28.0, _n(5.0, 0.4 + 0.6 * es), grey, 0.40, Vector2(1.5, 5.5) * (0.5 + 0.5 * es), Vector2(0.04, 0.07), Vector2(0.25, 0.5),
					Vector2(0.8, 1.7), 6.5, 0.06)
				_debris(pos, axis, 48.0, _n(4.5, es), grey * 1.08, Vector2(1.5, 6.5), Vector2(0.004, 0.014), Vector3(1.0, 0.45, 0.8), n, floor_y,
					Vector2(5.0, 9.0), 0.0, 0.9, 0.0, 0.38)
				var sc := _rng.randf_range(0.10, 0.145) * (0.75 + 0.25 * es)
				_mark("chip", hit, Vector2(sc * (1.0 + (1.0 - cosi) * 0.5), sc), 0.10, along if along.length_squared() > 0.5 else up_hint, roll if cosi > 0.8 else 0.0,
					{"normal_fade": 0.5})
		"wood", "plywood":
			var pale := Color(0.78, 0.64, 0.43)
			if is_exit:
				_debris(pos, d, 28.0, _n(7.0, es), pale, Vector2(2.0, 7.0), Vector2(0.012, 0.04), Vector3(1.0, 0.1, 0.16), n, floor_y, Vector2(4.0, 8.0), 0.0, 0.85, 0.0, 0.2)
				_dust(pos + n * 0.01, d, 25.0, 2, Color(0.74, 0.63, 0.46), 0.22, Vector2(1.0, 3.0), Vector2(0.03, 0.05), Vector2(0.12, 0.22), Vector2(0.45, 0.9), 7.0, 0.05)
				var se := _rng.randf_range(0.105, 0.135)
				_mark("woodexit", hit, Vector2(se, se), 0.08, up_hint, PI * 0.5 + _rng.randf_range(-0.06, 0.06), {"normal_fade": 0.5})
			else:
				_debris(pos, axis, 40.0, _n(4.0, es), pale, Vector2(1.5, 5.0), Vector2(0.008, 0.024), Vector3(1.0, 0.1, 0.16), n, floor_y, Vector2(4.0, 8.0), 0.0, 0.85, 0.0, 0.2)
				_dust(pos + n * 0.01, axis, 30.0, 2, Color(0.74, 0.63, 0.46), 0.2, Vector2(0.6, 2.0), Vector2(0.025, 0.04), Vector2(0.1, 0.18), Vector2(0.4, 0.8), 7.0, 0.05)
				var sw := _rng.randf_range(0.062, 0.078)
				# decal Z (texture V) = grain: up the surface on walls and posts, across the lane on bench tops
				_mark("wood", hit, Vector2(sw, sw), 0.08, up_hint if absf(n.y) < 0.9 else Vector3.RIGHT, PI * 0.5 + _rng.randf_range(-0.06, 0.06),
					{"normal_fade": 0.5})
		"sheet_metal":
			var inside := _faces_indoors(pos, n)
			var o := {"normal_fade": 0.3}
			if inside:
				# seen from under the roof / inside the bay the hole shows daylight
				o["emission"] = SKY_EMISSION
				o["emission_energy"] = sky_hole_energy
				o["modulate"] = Color(sky_hole_color.r, sky_hole_color.g, sky_hole_color.b, 1.0)
			var sm := _rng.randf_range(0.038, 0.044)
			_mark("metalexit" if is_exit else "metal", hit, Vector2(sm, sm), 0.14, up_hint, roll, o)
			_debris(pos, axis if not is_exit else d, 45.0, _n(3.0, es), Color(0.32, 0.33, 0.31), Vector2(1.0, 4.0), Vector2(0.002, 0.006), Vector3(1.0, 0.15, 0.8), n, floor_y,
				Vector2(3.0, 6.0), 0.3, 0.6, 0.0, 0.2)
			_dust(pos + n * 0.01, axis, 30.0, 1, Color(0.5, 0.5, 0.5), 0.16, Vector2(0.5, 1.5), Vector2(0.02, 0.04), Vector2(0.1, 0.16), Vector2(0.35, 0.7), 7.0, 0.05)
		"steel":
			var ss := _rng.randf_range(0.05, 0.08)
			_mark("splash", hit, Vector2(ss, ss), 0.03, up_hint, roll, {"normal_fade": 0.4, "modulate": Color(1, 1, 1, 0.9)})
			_debris(pos, n, 18.0, _n(5.0, es), Color(0.55, 0.55, 0.58), Vector2(2.0, 8.0), Vector2(0.002, 0.005), Vector3(1.0, 0.3, 0.8), n, floor_y,
				Vector2(3.0, 6.0), 0.9, 0.38, 0.0, 0.15, true)
			_dust(pos + n * 0.01, axis, 60.0, 2, Color(0.42, 0.42, 0.44), 0.22, Vector2(1.0, 3.0), Vector2(0.02, 0.04), Vector2(0.1, 0.2), Vector2(0.4, 0.8), 8.0, 0.05)
			if _rng.randf() < 0.12:
				_sparks(pos, n, 1 + _rng.randi() % 2, floor_y)
		"rubber":
			var sr := _rng.randf_range(0.024, 0.032)
			_mark("rubber", hit, Vector2(sr, sr), 0.05, up_hint, roll, {"normal_fade": 0.2})
			_dust(pos + n * 0.01, axis, 30.0, 2, Color(0.07, 0.07, 0.07), 0.3, Vector2(0.6, 2.0), Vector2(0.025, 0.045), Vector2(0.12, 0.2), Vector2(0.4, 0.8), 7.0, 0.05)
			_debris(pos, axis, 40.0, _n(3.0, es), Color(0.03, 0.03, 0.03), Vector2(1.0, 4.0), Vector2(0.002, 0.005), Vector3.ONE, n, floor_y, Vector2(3.0, 6.0), 0.0, 0.8, 0.0, 0.4)
		_:
			# unknown tag: treat like dirt, quietly
			_dust(pos + n * 0.03, axis, 32.0, 3, Color(0.47, 0.39, 0.29), 0.3, Vector2(0.8, 2.5), Vector2(0.05, 0.1), Vector2(0.3, 0.5), Vector2(1.0, 2.0))
	if not is_exit:
		var snd: Array = SURFACE_SOUND.get(surface, SURFACE_SOUND["dirt"])
		_play(snd[0], pos, {"volume_db": float(snd[1]) + lerpf(-7.0, 0.0, clampf(es, 0.0, 1.0)), "pitch": float(snd[2]) * _rng.randf_range(0.96, 1.04)})

## is the side of a panel the normal points to inside the covered bay (so a hole there shows the sky)?
func _faces_indoors(pos: Vector3, n: Vector3) -> bool:
	if n.y < -0.25:
		return true
	var p := pos + n * 0.4
	return p.x > Layout.BAY_X_MIN and p.x < Layout.BAY_X_MAX and p.z < Layout.BAY_Z_BACK and p.z > Layout.BAY_ROOF_Z_FRONT \
		and p.y < Layout.BAY_ROOF_H_FRONT

func _sparks(pos: Vector3, n: Vector3, count: int, floor_y: float) -> void:
	for i in count:
		var dir := _in_plane(n, 25.0)
		particles.chunk(pos + n * 0.004, dir * _rng.randf_range(4.0, 9.0), Vector3(0.0035, 0.0012, 0.0012), Color(1.0, 0.62, 0.25),
			_rng.randf_range(0.12, 0.28), n, pos, floor_y, 0.0, 0.5, 2.5, 0.2)

## Effects for the Targets module (same pools): kind = plate | glass | clay | ceramic | paper | can | wood_dust
func burst(kind: String, pos: Vector3, normal: Vector3, dir: Vector3, strength := 1.0, tint := Color.WHITE) -> void:
	var n := normal.normalized()
	var d := dir.normalized()
	var floor_y := _floor_below(pos, n)
	match kind:
		"plate":
			# lead spall leaves as a flat disc along the plate face; a few flakes drop to the ground below
			for i in _n(4.0, strength):
				var dirp := _in_plane(n, 14.0)
				var c := _jit(Color(0.45, 0.45, 0.47), 0.1)
				c.a = _rng.randf_range(0.22, 0.34)
				particles.puff(pos + n * 0.01 + dirp * 0.02, dirp * _rng.randf_range(2.0, 6.5), _rng.randf_range(0.025, 0.045), _rng.randf_range(0.14, 0.26),
					_rng.randf_range(0.45, 0.95), c, 8.0, 0.02, 1.0, 0.03)
			_debris(pos, n, 16.0, _n(7.0, strength), Color(0.6, 0.6, 0.63), Vector2(2.5, 9.0), Vector2(0.002, 0.006), Vector3(1.0, 0.25, 0.8), n, floor_y,
				Vector2(4.0, 8.0), 0.9, 0.35, 0.0, 0.12, true)
			if _rng.randf() < 0.15:
				_sparks(pos, n, 1 + _rng.randi() % 2, floor_y)
		"glass":
			# glints spray onward along the bullet path
			for i in _n(13.0, strength):
				var dg := _cone(d, 34.0)
				var s := _rng.randf_range(0.002, 0.007)
				particles.chunk(pos, dg * _rng.randf_range(3.0, 10.0), Vector3(s, s * _rng.randf_range(0.15, 0.4), s * _rng.randf_range(0.5, 1.6)),
					_jit(Color(tint.r * 0.9 + 0.1, tint.g * 0.9 + 0.1, tint.b * 0.9 + 0.1), 0.15), _rng.randf_range(2.5, 6.0), Vector3.UP, pos, floor_y, 0.85, 0.08, 0.0, 0.25)
			_dust(pos, d, 40.0, 2, Color(0.85, 0.88, 0.86), 0.10, Vector2(1.0, 3.5), Vector2(0.03, 0.05), Vector2(0.14, 0.24), Vector2(0.35, 0.7), 7.0, 0.0)
		"clay":
			_dust(pos, (n + d * 0.6).normalized(), 70.0, _n(4.0, strength), Color(0.42, 0.2, 0.09), 0.34, Vector2(0.8, 3.0), Vector2(0.04, 0.07), Vector2(0.2, 0.4),
				Vector2(0.6, 1.4), 6.0, 0.04)
			_dust(pos, (n + d * 0.6).normalized(), 70.0, 2, Color(0.07, 0.065, 0.06), 0.3, Vector2(0.8, 2.6), Vector2(0.04, 0.06), Vector2(0.18, 0.3), Vector2(0.5, 1.1), 6.0, 0.04)
			_debris(pos, d, 75.0, _n(7.0, strength), Color(0.75, 0.28, 0.06), Vector2(1.5, 6.0), Vector2(0.003, 0.009), Vector3(1.0, 0.4, 0.8), Vector3.UP, floor_y,
				Vector2(4.0, 8.0), 0.0, 0.8, 0.0, 0.2)
			_debris(pos, d, 75.0, _n(5.0, strength), Color(0.035, 0.035, 0.035), Vector2(1.5, 6.0), Vector2(0.003, 0.008), Vector3(1.0, 0.5, 0.8), Vector3.UP, floor_y,
				Vector2(4.0, 8.0), 0.0, 0.7, 0.0, 0.2)
		"ceramic":
			_dust(pos, (n * 0.5 + d).normalized(), 60.0, _n(4.0, strength), Color(0.58, 0.33, 0.21), 0.36, Vector2(0.8, 3.2), Vector2(0.05, 0.08), Vector2(0.25, 0.45),
				Vector2(0.7, 1.6), 6.0, 0.05)
			_debris(pos, d, 60.0, _n(9.0, strength), Color(0.62, 0.32, 0.19), Vector2(1.5, 6.0), Vector2(0.003, 0.011), Vector3(1.0, 0.5, 0.8), Vector3.UP, floor_y,
				Vector2(4.0, 8.0), 0.0, 0.9, 0.0, 0.25)
		"paper":
			# a little paper/cardboard fluff leaves on the exit side
			_dust(pos, d, 30.0, 1 + _rng.randi() % 2, Color(0.8, 0.74, 0.62), 0.12, Vector2(0.6, 2.0), Vector2(0.015, 0.03), Vector2(0.07, 0.12), Vector2(0.3, 0.6), 8.0, 0.0)
			_debris(pos, d, 35.0, _n(2.5, strength), Color(0.72, 0.62, 0.45), Vector2(1.0, 3.5), Vector2(0.002, 0.005), Vector3(1.0, 0.08, 0.9), Vector3.UP, floor_y,
				Vector2(2.5, 5.0), 0.0, 0.95, 0.0, 0.05)
		"can":
			_dust(pos, n, 50.0, 1, Color(0.4, 0.32, 0.26), 0.16, Vector2(0.5, 1.5), Vector2(0.02, 0.035), Vector2(0.08, 0.14), Vector2(0.3, 0.6), 7.0, 0.03)
			_debris(pos, n, 50.0, _n(3.0, strength), Color(0.36, 0.2, 0.12), Vector2(1.0, 3.5), Vector2(0.0015, 0.004), Vector3(1.0, 0.12, 0.8), Vector3.UP, floor_y,
				Vector2(3.0, 6.0), 0.4, 0.6, 0.0, 0.2)
		_:
			pass

# ------------------------------------------------------------------------------------------------ casings
func _build_casings() -> void:
	var mesh: Mesh = null
	var mesh_xf := Transform3D.IDENTITY
	if ResourceLoader.exists(CASING_SCENE):
		var ps: PackedScene = load(CASING_SCENE)
		if ps != null:
			var inst := ps.instantiate()
			var mi := _find_mesh(inst)
			if mi != null:
				mesh = mi.mesh
				mesh_xf = _xf_to_root(mi, inst)
			inst.free()
	if mesh == null:
		var cm := CylinderMesh.new()
		cm.top_radius = CASING_RADIUS
		cm.bottom_radius = CASING_RADIUS
		cm.height = CASING_LENGTH
		cm.radial_segments = 12
		var m := StandardMaterial3D.new()
		m.albedo_color = Color(0.85, 0.66, 0.3)
		m.metallic = 1.0
		m.roughness = 0.3
		cm.material = m
		mesh = cm
		mesh_xf = Transform3D(Basis(Vector3.RIGHT, PI * 0.5), Vector3(0, 0, CASING_CENTER_Z))
	var shape := CylinderShape3D.new()
	shape.radius = CASING_RADIUS
	shape.height = CASING_LENGTH
	var pm := PhysicsMaterial.new()
	pm.bounce = 0.46
	pm.friction = 0.38
	var holder := Node3D.new()
	holder.name = "Casings"
	add_child(holder)
	for i in CASING_CAP:
		var b: RigidBody3D = CasingBody.new()
		b.name = "Casing%02d" % i
		b.owner_fx = self
		b.slot = i
		b.mass = CASING_MASS
		b.physics_material_override = pm
		b.center_of_mass_mode = RigidBody3D.CENTER_OF_MASS_MODE_CUSTOM
		b.center_of_mass = Vector3(0, 0, CASING_CENTER_Z)
		b.continuous_cd = true
		b.contact_monitor = true
		b.max_contacts_reported = 3
		b.collision_layer = 1 << (Layout.LAYER_DEBRIS - 1)
		b.collision_mask = 0
		b.linear_damp = 0.02
		b.angular_damp = 0.05
		b.freeze_mode = RigidBody3D.FREEZE_MODE_STATIC
		b.freeze = true
		b.can_sleep = true
		b.visible = false
		var cs := CollisionShape3D.new()
		cs.shape = shape
		cs.transform = Transform3D(Basis(Vector3.RIGHT, PI * 0.5), Vector3(0, 0, CASING_CENTER_Z))
		b.add_child(cs)
		var mi2 := MeshInstance3D.new()
		mi2.mesh = mesh
		mi2.transform = mesh_xf
		mi2.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		b.add_child(mi2)
		holder.add_child(b)
		_casings.append(b)

func _find_mesh(n: Node) -> MeshInstance3D:
	if n is MeshInstance3D:
		return n
	for c in n.get_children():
		var r := _find_mesh(c)
		if r != null:
			return r
	return null

func _xf_to_root(n: Node3D, root: Node) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var cur: Node = n
	while cur != null and cur != root:
		if cur is Node3D:
			xf = (cur as Node3D).transform * xf
		cur = cur.get_parent()
	if root is Node3D:
		xf = (root as Node3D).transform * xf
	return xf

func eject_casing(xform: Transform3D, linear_velocity: Vector3, angular_velocity: Vector3) -> void:
	_stats["casings_ejected"] += 1
	# prefer a parked body; otherwise recycle the casing that has been lying longest
	var b: RigidBody3D = null
	for k in CASING_CAP:
		var c: RigidBody3D = _casings[(_casing_next + k) % CASING_CAP]
		if not c.active:
			b = c
			_casing_next = (_casing_next + k + 1) % CASING_CAP
			break
	if b == null:
		if not _settle_order.is_empty():
			b = _settle_order.pop_front()
		else:
			b = _casings[_casing_next]
			_casing_next = (_casing_next + 1) % CASING_CAP
	_settle_order.erase(b)
	b.launch(Transform3D(xform.basis.orthonormalized(), xform.origin), linear_velocity, angular_velocity)

func _on_casing_contact(body: Node3D, pos: Vector3, surface: String, dv: float) -> void:
	var group: String = CASING_SOUND.get(surface, "casing_concrete_hit")
	if not _has_sound(group):
		# no single-hit samples for soft ground: a case on dirt is close to silent anyway
		return
	_stats["casing_sounds"] += 1
	_play(group, pos, {"intensity": clampf(dv / 3.5, 0.08, 1.0), "pitch": _rng.randf_range(0.96, 1.05)})

func _on_casing_settled(body: RigidBody3D) -> void:
	if not body.active or body.settled:
		return
	body.settle()
	_settle_order.append(body)
	while _settle_order.size() > CASING_GROUND_CAP:
		var old: RigidBody3D = _settle_order.pop_front()
		old.park()

# ------------------------------------------------------------------------------------------------ muzzle
func _build_muzzle() -> void:
	var quad := QuadMesh.new()
	quad.size = Vector2(1, 1)
	for i in 2:
		var m := ShaderMaterial.new()
		m.shader = preload("res://scripts/fx/shaders/flash.gdshader")
		m.set_shader_parameter("atlas", FLASH_ATLAS)
		m.render_priority = 3
		var mi := MeshInstance3D.new()
		mi.name = "Flash%d" % i
		mi.mesh = quad
		mi.material_override = m
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		mi.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
		mi.visible = false
		add_child(mi)
		_flash.append(mi)
		_flash_mat.append(m)
	_light = OmniLight3D.new()
	_light.name = "FlashLight"
	_light.light_color = Color(1.0, 0.72, 0.42)
	_light.omni_range = 2.6
	_light.omni_attenuation = 1.6
	_light.shadow_enabled = false
	_light.light_specular = 0.4
	_light.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	_light.visible = false
	add_child(_light)

## 0 = flash invisible (bright sun / reduced flashes) .. 1 = dusk
static func flash_visibility(ambient_luminance: float) -> float:
	if ambient_luminance >= 3.0:
		return 0.0
	return clampf(pow(0.05 / maxf(ambient_luminance, 0.05), 0.8), 0.0, 1.0)

func muzzle_event(muzzle_xform: Transform3D, ambient_luminance: float, shot_index: int) -> void:
	_stats["muzzle_events"] += 1
	var pos := muzzle_xform.origin
	var bore := -muzzle_xform.basis.z.normalized()
	var up := muzzle_xform.basis.y.normalized()
	var vis := flash_visibility(ambient_luminance)
	# --- flash: unburnt powder gas lighting up for ~1 ms. Absent on a share of shots, faint in daylight.
	var chance := lerpf(0.45, 1.0, sqrt(vis)) if vis > 0.0 else 0.0
	if _rng.randf() < chance:
		_stats["flashes"] += 1
		var cell := _rng.randi() % 6
		if cell == _last_flash_cell:
			cell = (cell + 1 + _rng.randi() % 5) % 6
		_last_flash_cell = cell
		var size := lerpf(0.045, 0.09, vis) * _rng.randf_range(0.8, 1.25)
		var inten := 0.5 * pow(1.0 / maxf(ambient_luminance, 0.05), 0.35) * _rng.randf_range(0.65, 1.2)
		for i in 2:
			var mi := _flash[i]
			var m := _flash_mat[i]
			var c := cell if i == 0 else (cell + 1 + _rng.randi() % 5) % 6
			m.set_shader_parameter("cell", Vector2(c % 3, c / 3))
			m.set_shader_parameter("roll", _rng.randf() * TAU)
			m.set_shader_parameter("flip", Vector2(1.0 if _rng.randf() < 0.5 else -1.0, 1.0))
			# the quad is 3x the visible flash (the shape sits in the middle of its atlas cell)
			var s := size * 3.0 * (1.0 if i == 0 else _rng.randf_range(0.45, 0.7))
			m.set_shader_parameter("intensity", inten * (1.0 if i == 0 else 1.5))
			mi.global_transform = Transform3D(Basis.IDENTITY.scaled(Vector3(s, s, s)), pos + bore * (0.012 + 0.035 * i + size * 0.25))
			mi.visible = true
		_flash_frame = Engine.get_process_frames()
		if vis > 0.45:
			_light.global_position = pos + bore * 0.06 + up * 0.01
			_light_energy = lerpf(0.0, 1.6, (vis - 0.45) / 0.55) * _rng.randf_range(0.8, 1.2)
			_light.light_energy = _light_energy
			_light.visible = true
			_light_frames = 2
	# --- smoke: thin grey gas jet that stalls within half a metre and thins out in about a second
	var w := _wind_now()
	var grey := Color(0.46, 0.46, 0.48)
	var jets := 16 + _rng.randi() % 5
	for i in jets:
		var f := float(i) / float(jets)
		var dirj := _cone(bore, 5.0 + 9.0 * f)
		var sp := lerpf(7.5, 1.2, f) * _rng.randf_range(0.75, 1.2)
		var c := _jit(grey, 0.06)
		c.a = _rng.randf_range(0.13, 0.21) * (0.7 + 0.3 * f)
		particles.puff(pos + bore * (0.01 + 0.06 * f), dirj * sp, _rng.randf_range(0.026, 0.04), _rng.randf_range(0.13, 0.24), _rng.randf_range(0.5, 1.4),
			c, _rng.randf_range(8.0, 12.0), 0.12, 1.0, 0.02)
	# ejection port / open slide: a smaller wisp rising from above the chamber (12.7 cm behind the crown)
	var port := pos - bore * 0.127 + up * 0.008
	for i in 2 + _rng.randi() % 2:
		var c2 := _jit(grey, 0.06)
		c2.a = _rng.randf_range(0.10, 0.16)
		particles.puff(port + up * 0.005 * i, _cone(up, 30.0) * _rng.randf_range(0.25, 0.7) + bore * 0.2, _rng.randf_range(0.01, 0.018), _rng.randf_range(0.06, 0.11),
			_rng.randf_range(0.5, 1.1), c2, 6.0, 0.25, 1.0, 0.05)

# ------------------------------------------------------------------------------------------------ housekeeping
func _process(delta: float) -> void:
	_time += delta
	particles.wind = _wind_now()
	if _flash_frame >= 0 and Engine.get_process_frames() > _flash_frame:
		for mi in _flash:
			mi.visible = false
		_flash_frame = -1
	if _light_frames > 0 and Engine.get_process_frames() > _flash_frame + 0:
		_light_frames -= 1
		if _light_frames <= 0:
			_light.visible = false
		else:
			_light.light_energy = _light_energy * 0.45

## Renders one of everything for a few frames (call behind the loading screen) so the first shot compiles nothing.
func prewarm() -> void:
	var cam: Camera3D = get_viewport().get_camera_3d() if is_inside_tree() else null
	var p := Vector3(0, 1.2, -2.0)
	if cam != null:
		p = cam.global_position - cam.global_transform.basis.z * 1.2
	for k in 3:
		particles.puff(p, Vector3.ZERO, 0.05, 0.06, 0.25, Color(0.5, 0.5, 0.5, 0.02), 1.0, 0.0, 0.0)
		particles.chunk(p, Vector3.ZERO, Vector3.ONE * 0.002, Color(0.3, 0.3, 0.3), 0.25, Vector3.UP, p - Vector3(0, 5, 0), p.y - 5.0)
	for i in 2:
		_flash_mat[i].set_shader_parameter("intensity", 0.01)
		_flash[i].global_transform = Transform3D(Basis.IDENTITY.scaled(Vector3.ONE * 0.02), p)
		_flash[i].visible = true
	_flash_frame = Engine.get_process_frames() + 3
	_light.global_position = p
	_light.light_energy = 0.001
	_light.visible = true
	_light_frames = 0
	var c: RigidBody3D = _casings[0]
	var was_active: bool = c.active
	if not was_active:
		c.global_transform = Transform3D(Basis.IDENTITY, p + Vector3(0, -0.05, 0))
		c.visible = true
	if is_inside_tree():
		for k in 4:
			await get_tree().process_frame
	_light.visible = false
	for mi in _flash:
		mi.visible = false
	_flash_frame = -1
	if not was_active:
		c.visible = false
	particles.clear()

func clear() -> void:
	particles.clear()
	decals.clear()
	for c in _casings:
		c.park()
	_settle_order.clear()
	for mi in _flash:
		mi.visible = false
	_light.visible = false
	_light_frames = 0

func get_stats() -> Dictionary:
	var flying := 0
	var settled := 0
	for c in _casings:
		if c.active:
			if c.settled:
				settled += 1
			else:
				flying += 1
	var d := _stats.duplicate()
	d.merge({"decals": decals.count(), "decal_cap": Decals.CAP, "puffs": particles.puff_count(), "puff_cap": Particles.PUFF_CAP,
		"chunks": particles.chunk_count(), "chunk_cap": Particles.CHUNK_CAP, "casings_flying": flying, "casings_settled": settled,
		"casing_cap": CASING_CAP, "nodes": _count_nodes(self)})
	return d

func _count_nodes(n: Node) -> int:
	var c := 1
	for ch in n.get_children():
		c += _count_nodes(ch)
	return c
