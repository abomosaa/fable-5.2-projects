extends Node3D
## Visual test bench for the targets + FX modules (not part of the game).
##   godot --path game res://scenes/targets/targets_preview.tscn -- --mode=<name> --out=<abs dir>
## Builds a sunlit stand-in range (dirt ground, concrete slab, one panel per surface tag), instances FXWorld and
## Targets, and fires REAL projectiles (ProjectileManager) at them, saving viewport PNGs + frame-time numbers.

const Layout := preload("res://scripts/range/layout.gd")
const TEX := "res://assets/env/tex/"

var fx: Node
var targets: Node
var pm: Node
var cam: Camera3D
var out_dir := "user://preview"
var mode := "fx"
var sun: DirectionalLight3D
var env: Environment
var _shot := 1000
var _frame_ms := PackedFloat32Array()
var _rec := false
var panels := {}

func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--mode="):
			mode = a.substr(7)
		elif a.begins_with("--out="):
			out_dir = a.substr(6)
	DirAccess.make_dir_recursive_absolute(out_dir)
	if mode.begins_with("env"):
		# the real range environment instead of the stand-in world
		add_child(load("res://scenes/range_env.tscn").instantiate())
	else:
		_build_world()
	var with_targets := not mode.begins_with("fx") and mode != "muzzle" and mode != "casings" and not mode.begins_with("env")
	fx = load("res://scenes/fx/fx_world.tscn").instantiate()
	add_child(fx)
	if with_targets and ResourceLoader.exists("res://scenes/targets/targets.tscn"):
		targets = load("res://scenes/targets/targets.tscn").instantiate()
		add_child(targets)
	pm = ClassDB.instantiate("Node3D")
	pm.set_script(load("res://scripts/weapon/projectiles.gd"))
	pm.set("fx", fx)
	add_child(pm)
	cam = Camera3D.new()
	cam.fov = 74.0
	cam.near = 0.03
	cam.far = 400.0
	add_child(cam)
	cam.make_current()
	cam.global_position = Vector3(0, 1.66, 0.5)
	await _frames(20)
	if fx.has_method("prewarm"):
		await fx.call("prewarm")
	await _frames(40)
	var t0 := Time.get_ticks_msec()
	if has_method("_mode_" + mode):
		await call("_mode_" + mode)
	else:
		push_error("unknown mode " + mode)
	print("PREVIEW %s done in %.1f s; fx=%s" % [mode, (Time.get_ticks_msec() - t0) / 1000.0, str(fx.call("get_stats"))])
	if targets != null:
		print("targets=", targets.call("get_stats"))
	get_tree().quit()

func _process(delta: float) -> void:
	if _rec:
		_frame_ms.append(delta * 1000.0)
		if delta > 0.03 and not mode.ends_with("hitch"):
			print("  SLOW FRAME %.1f ms at sample %d (process frame %d)" % [delta * 1000.0, _frame_ms.size(), Engine.get_process_frames()])

# ----------------------------------------------------------------------------------------------- world
func _mat(tex_name: String, uv_scale: float, tint := Color.WHITE) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	if ResourceLoader.exists(TEX + tex_name + "_albedo.jpg"):
		m.albedo_texture = load(TEX + tex_name + "_albedo.jpg")
		m.normal_enabled = true
		m.normal_texture = load(TEX + tex_name + "_normal.jpg")
		var orm: Texture2D = load(TEX + tex_name + "_orm.jpg")
		m.roughness_texture = orm
		m.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GREEN
		m.ao_enabled = true
		m.ao_texture = orm
		m.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
		if tex_name in ["corrugated", "paint_green", "paint_white_rust"]:
			m.metallic_texture = orm
			m.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_BLUE
			m.metallic = 1.0
	m.albedo_color = tint
	m.uv1_triplanar = true
	m.uv1_world_triplanar = true
	m.uv1_scale = Vector3.ONE * uv_scale
	return m

func _box(name_: String, center: Vector3, size: Vector3, surface: String, mat: Material, rot := Vector3.ZERO) -> StaticBody3D:
	var b := StaticBody3D.new()
	b.name = name_
	b.set_meta("surface", surface)
	b.collision_layer = 1
	b.collision_mask = 0
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = size
	cs.shape = sh
	b.add_child(cs)
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = mat
	b.add_child(mi)
	add_child(b)
	b.position = center
	b.rotation_degrees = rot
	panels[name_] = b
	return b

func _build_world() -> void:
	var we := WorldEnvironment.new()
	env = Environment.new()
	env.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sky_ok := false
	for cand in ["res://assets/env/sky/suburban_field_02_sky.hdr", "res://assets/env/sky/alps_field_sky.hdr"]:
		if ResourceLoader.exists(cand):
			var pmat := PanoramaSkyMaterial.new()
			pmat.panorama = load(cand)
			sky.sky_material = pmat
			sky_ok = true
			break
	if not sky_ok:
		sky.sky_material = ProceduralSkyMaterial.new()
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.ssao_enabled = true
	env.glow_enabled = true
	we.environment = env
	add_child(we)
	sun = DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-48, -35, 0)
	sun.light_energy = 2.2
	sun.light_color = Color(1.0, 0.96, 0.9)
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 60.0
	add_child(sun)
	_box("ground", Vector3(0, -0.5, -30), Vector3(120, 1.0, 140), "dirt", _mat("ground_dirt", 0.4))
	_box("slab", Vector3(0, 0.03, 1.5), Vector3(7.0, 0.06, 5.0), "concrete", _mat("slab_concrete", 0.5))
	if mode.begins_with("fx"):
		_box("gravel", Vector3(-6.0, 0.01, -4.0), Vector3(3.0, 0.02, 3.0), "gravel", _mat("ground_gravel", 0.6))
		_box("grass", Vector3(6.0, 0.01, -4.0), Vector3(3.0, 0.02, 3.0), "grass", _mat("ground_grass", 0.5))
	# berm slope 1:1 at z = -52
	_box("berm", Vector3(0, 1.0, -56.0), Vector3(60, 8.0, 8.0), "dirt", _mat("ground_soil", 0.35), Vector3(45, 0, 0))
	if not (mode.begins_with("fx") or mode == "muzzle" or mode == "casings"):
		return
	# one panel per surface tag, 1.0 m wide, in a row at z = -5 (x from -4.2)
	var z := -5.0
	_box("p_block", Vector3(-4.2, 0.9, z), Vector3(1.0, 1.8, 0.19), "block", _mat("block_concrete", 0.6))
	_box("p_concrete", Vector3(-3.0, 0.9, z), Vector3(1.0, 1.8, 0.15), "concrete", _mat("slab_concrete", 0.6))
	_box("p_wood", Vector3(-1.8, 0.9, z), Vector3(1.0, 1.8, 0.038), "wood", _mat("planks_light", 0.8))
	_box("p_plywood", Vector3(-0.6, 0.9, z), Vector3(1.0, 1.8, 0.018), "plywood", _mat("plywood", 0.8))
	_box("p_sheet_metal", Vector3(0.6, 0.9, z), Vector3(1.0, 1.8, 0.002), "sheet_metal", _mat("paint_green", 0.8))
	_box("p_steel", Vector3(1.8, 0.9, z), Vector3(0.6, 1.8, 0.01), "steel", _mat("paint_white_rust", 0.9))
	_box("p_rubber", Vector3(3.0, 0.5, z), Vector3(1.0, 1.0, 0.3), "rubber", _mat("rubber", 0.8))
	_box("p_sandbag", Vector3(4.2, 0.3, z), Vector3(1.0, 0.6, 0.4), "sandbag", _mat("ground_soil", 1.0, Color(1.5, 1.4, 1.2)))
	# a low roof of corrugated sheet over the back of the slab (daylight holes when shot from below)
	_box("roof", Vector3(0, 2.6, 3.0), Vector3(7.0, 0.002, 2.0), "sheet_metal", _mat("corrugated", 0.8))

# ----------------------------------------------------------------------------------------------- utilities
func _frames(n: int) -> void:
	for i in n:
		await get_tree().process_frame

func _secs(s: float) -> void:
	var until := Time.get_ticks_msec() + int(s * 1000.0)
	while Time.get_ticks_msec() < until:
		await get_tree().process_frame

func _view(pos: Vector3, look: Vector3, fov := 74.0) -> void:
	cam.fov = fov
	cam.global_position = pos
	cam.look_at(look, Vector3.UP)
	cam.reset_physics_interpolation()

func _snap(name_: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(out_dir + "/" + name_ + ".png")

func _shoot(from: Vector3, at: Vector3, speed := 340.0) -> void:
	_shot += 1
	pm.call("fire", from, (at - from).normalized(), speed, _shot)
	if _rec and not mode.ends_with("hitch"):
		print("  shot %d at sample %d" % [_shot, _frame_ms.size()])

func _rec_begin() -> void:
	_frame_ms.clear()
	_rec = true

func _rec_end(tag: String) -> void:
	_rec = false
	var a := Array(_frame_ms)
	if a.is_empty():
		return
	var mx: float = a.max()
	a.sort()
	print("FRAMES %s: n=%d median=%.2f ms p95=%.2f ms max=%.2f ms" % [tag, a.size(), a[a.size() / 2], a[int(a.size() * 0.95)], mx])

# ----------------------------------------------------------------------------------------------- FX modes
func _mode_fx() -> void:
	var eye := Vector3(0, 1.66, 0.5)
	_view(eye, Vector3(0, 0.9, -5.0))
	await _frames(30)
	await _snap("fx_00_panels_before")
	var names := ["p_block", "p_concrete", "p_wood", "p_plywood", "p_sheet_metal", "p_steel", "p_rubber", "p_sandbag"]
	_rec_begin()
	for nm in names:
		var b: Node3D = panels[nm]
		for k in 3:
			var tgt: Vector3 = b.global_position + Vector3(randf_range(-0.3, 0.3), randf_range(-0.15, 0.25), 0.0)
			_shoot(eye + Vector3(0, -0.2, -0.5), tgt)
			await _frames(3)
	await _frames(2)
	await _snap("fx_01_panels_burst")
	await _secs(0.4)
	await _snap("fx_02_panels_0p4s")
	await _secs(2.0)
	_rec_end("panel impacts (24 shots)")
	await _snap("fx_03_panels_after")
	for nm in names:
		var b: Node3D = panels[nm]
		var p := b.global_position
		_view(p + Vector3(0.12, 0.1, 0.62), p + Vector3(0, 0.05, 0), 60.0)
		await _frames(12)
		await _snap("fx_10_close_" + nm.substr(2))
	# rear faces (exit holes) of the thin panels
	for nm in ["p_wood", "p_plywood", "p_sheet_metal"]:
		var p2: Vector3 = (panels[nm] as Node3D).global_position
		_view(p2 + Vector3(0.12, 0.1, -0.62), p2 + Vector3(0, 0.05, 0), 60.0)
		await _frames(12)
		await _snap("fx_11_exit_" + nm.substr(2))
	# ground surfaces: dirt, gravel, grass, slab (normal + shallow skid)
	var grounds := {"dirt": Vector3(0.0, 0.0, -9.0), "gravel": Vector3(-6.0, 0.02, -4.0), "grass": Vector3(6.0, 0.02, -4.0)}
	for g in grounds:
		var gp: Vector3 = grounds[g]
		_view(gp + Vector3(0.9, 0.7, 2.2), gp + Vector3(0, 0.15, 0), 50.0)
		await _frames(10)
		_shoot(eye, gp)
		_shoot(eye, gp + Vector3(0.35, 0, -0.3))
		await _frames(3)
		await _snap("fx_20_%s_burst" % g)
		await _secs(0.5)
		await _snap("fx_21_%s_0p5s" % g)
		await _secs(1.5)
		await _snap("fx_22_%s_2s" % g)
		_view(gp + Vector3(0.1, 0.45, 0.35), gp, 55.0)
		await _frames(12)
		await _snap("fx_23_%s_close" % g)
	# slab: steep hit and a shallow-angle skid
	var sp := Vector3(1.5, 0.06, 1.0)
	_view(sp + Vector3(-0.5, 0.5, 0.9), sp, 55.0)
	await _frames(10)
	_shoot(sp + Vector3(0.2, 1.4, 0.5), sp)
	_shoot(sp + Vector3(0.3, 0.12, 1.6), sp + Vector3(0.3, 0, 0.3))      # ~5 degrees
	await _frames(3)
	await _snap("fx_30_slab_burst")
	await _secs(1.5)
	await _snap("fx_31_slab_after")
	_view(sp + Vector3(0.15, 0.4, 0.5), sp + Vector3(0.15, 0, 0.15), 55.0)
	await _frames(12)
	await _snap("fx_32_slab_close")
	# berm from the firing line
	_view(eye, Vector3(0, 2.0, -53.0), 20.0)
	await _frames(10)
	_shoot(eye, Vector3(0.5, 2.0, -54.0))
	await _secs(0.35)
	await _snap("fx_40_berm_puff_0p35s")
	await _secs(1.0)
	await _snap("fx_41_berm_puff_1p35s")
	# roof from below: daylight dots
	_view(Vector3(0, 1.5, 3.4), Vector3(0.0, 2.6, 3.0), 60.0)
	await _frames(10)
	for k in 4:
		_shoot(Vector3(0, 1.5, 3.3), Vector3(randf_range(-0.3, 0.3), 2.6, 3.0 + randf_range(-0.25, 0.25)))
	await _secs(1.0)
	await _snap("fx_50_roof_holes_from_below")

func _mode_muzzle() -> void:
	# side-on view of a muzzle position; dark background = the shaded underside box, bright = open sunlit dirt
	var sets := [
		{"tag": "bright", "lum": 1.0, "muzzle": Vector3(0.0, 1.45, -1.5)},
		{"tag": "shade", "lum": 0.35, "muzzle": Vector3(0.0, 1.45, 3.0)},
		{"tag": "dusk", "lum": 0.05, "muzzle": Vector3(0.0, 1.45, 3.0)},
	]
	# a dark backdrop + a bench-like box under the shaded muzzle position
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color(0.03, 0.03, 0.035)
	_box("backdrop", Vector3(-1.2, 1.4, 2.6), Vector3(0.05, 2.4, 2.4), "wood", dark)
	_box("bench", Vector3(0.0, 0.9, 2.9), Vector3(1.2, 0.04, 0.6), "wood", _mat("planks_light", 0.8))
	for s in sets:
		var m: Vector3 = s["muzzle"]
		if s["tag"] == "dusk":
			sun.light_energy = 0.04
			env.background_energy_multiplier = 0.03
			env.ambient_light_energy = 0.05
			await _frames(30)
		var xf := Transform3D(Basis.looking_at(Vector3(0, 0, -1), Vector3.UP), m)
		_view(m + Vector3(0.55, 0.06, -0.08), m + Vector3(0, 0.0, -0.1), 40.0)
		await _frames(20)
		await _snap("muzzle_%s_before" % s["tag"])
		# three consecutive frames of one event (retry until a flash actually occurs so the evidence shows one)
		var before: int = fx.call("get_stats")["flashes"]
		var tries := 0
		_rec_begin()
		while true:
			tries += 1
			fx.call("muzzle_event", xf, s["lum"], tries)
			if int(fx.call("get_stats")["flashes"]) > before or tries > 12:
				break
			await _secs(1.6)
		await _snap("muzzle_%s_f0" % s["tag"])
		await _snap("muzzle_%s_f1" % s["tag"])
		await _snap("muzzle_%s_f2" % s["tag"])
		var t0 := Time.get_ticks_msec()
		while Time.get_ticks_msec() - t0 < 100 - 50:
			await get_tree().process_frame
		await _snap("muzzle_%s_smoke_0p1s" % s["tag"])
		await _secs(0.4)
		await _snap("muzzle_%s_smoke_0p5s" % s["tag"])
		await _secs(0.5)
		await _snap("muzzle_%s_smoke_1p0s" % s["tag"])
		_rec_end("muzzle %s (tries=%d)" % [s["tag"], tries])
		# shooter's-eye view (camera 41 cm behind the muzzle, 2 cm above the bore)
		_view(m + Vector3(0.0, 0.02, 0.58), m + Vector3(0, 0.0, -3.0), 74.0)
		await _frames(20)
		before = fx.call("get_stats")["flashes"]
		tries = 0
		while true:
			tries += 1
			fx.call("muzzle_event", xf, s["lum"], 100 + tries)
			if int(fx.call("get_stats")["flashes"]) > before or tries > 12:
				break
			await _secs(1.6)
		await _snap("muzzle_%s_eye_f0" % s["tag"])
		await _snap("muzzle_%s_eye_f1" % s["tag"])
		await _secs(0.25)
		await _snap("muzzle_%s_eye_smoke_0p3s" % s["tag"])
		await _secs(1.5)
	# flash statistics in daylight: how often is there one at all
	var n0: int = fx.call("get_stats")["flashes"]
	for i in 200:
		fx.call("muzzle_event", Transform3D(Basis.IDENTITY, Vector3(0, -50, 0)), 1.0, i)
	print("flash share in sunlight: %d / 200" % (int(fx.call("get_stats")["flashes"]) - n0))

func _mode_casings() -> void:
	# brass from a pistol held over the slab edge: half lands on concrete, half on dirt
	_view(Vector3(-1.2, 0.9, -0.2), Vector3(-2.2, 0.1, -1.0), 55.0)
	await _frames(20)
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	_rec_begin()
	for i in 14:
		var o := Vector3(-1.6, 1.45, -0.55 - 0.1 * (i % 2) * 8.0)
		var v := Vector3(rng.randf_range(-3.1, -2.0), rng.randf_range(1.5, 2.6), rng.randf_range(0.1, 1.0)) * 0.6
		var w := Vector3(rng.randf_range(-25, 25), rng.randf_range(30, 85), rng.randf_range(-40, 40))
		fx.call("eject_casing", Transform3D(Basis.IDENTITY, o), v, w)
		await _secs(0.12)
		if i == 2:
			await _snap("casings_00_in_flight")
	await _secs(0.5)
	await _snap("casings_01_bouncing")
	await _secs(4.0)
	_rec_end("casings")
	await _snap("casings_02_settled")
	var st: Dictionary = fx.call("get_stats")
	print("casing stats: ", st)
	for c in fx.get_node("Casings").get_children():
		if c.get("active"):
			print("  casing at ", (c as Node3D).global_position, " settled=", c.get("settled"))
	_view(Vector3(-2.3, 0.35, 0.3), Vector3(-2.6, 0.06, -0.3), 40.0)
	await _frames(15)
	await _snap("casings_03_close")

# ----------------------------------------------------------------------------------------------- target modes
func _eye(x: float) -> Vector3:
	return Vector3(x, 1.66, 0.3)

func _muzzle(x: float) -> Vector3:
	return Vector3(x + 0.02, 1.58, -0.25)

func _paper_set(tag: String, t: Node3D, shots: Array) -> void:
	var x: float = t.global_position.x
	var c: Vector3 = t.call("mm_to_world", Vector2.ZERO)
	_view(_eye(x), c, 74.0)
	await _frames(20)
	await _snap("paper_%s_00_before_fov74" % tag)
	_view(_eye(x), c, 20.0)
	await _frames(12)
	await _snap("paper_%s_01_before_fov20" % tag)
	_rec_begin()
	for mm in shots:
		_shoot(_muzzle(x), t.call("mm_to_world", mm))
		await _secs(0.25)
	_rec_end("paper %s (%d shots)" % [tag, shots.size()])
	await _secs(0.6)
	await _snap("paper_%s_02_after_fov20" % tag)
	_view(_eye(x), c, 74.0)
	await _frames(12)
	await _snap("paper_%s_03_after_fov74" % tag)
	_view(c + Vector3(0.05, 0.02, 0.5), c, 40.0)
	await _frames(12)
	await _snap("paper_%s_04_close_0p5m" % tag)
	_view(c + Vector3(0.03, 0.01, 0.16), c + Vector3(0.0, 0.0, 0.0), 40.0)
	await _frames(12)
	await _snap("paper_%s_05_macro" % tag)
	_view(c + Vector3(0.25, 0.1, -0.6), c, 50.0)
	await _frames(12)
	await _snap("paper_%s_06_back" % tag)
	print("paper %s hits: %s" % [tag, str(t.call("get_hits").map(func(h): return [h["pos_mm"], h["score"]]))])

func _mode_tg_paper() -> void:
	var papers: Array = targets.call("get_paper_targets")
	# 7 m B-8: a group low-left of centre, two overlapping pairs, one on the paper edge, one in the backer only,
	# one through the left upright
	await _paper_set("b8_7m", papers[0], [Vector2(-12, -8), Vector2(-20, 4), Vector2(-6, -22), Vector2(-14, -14), Vector2(-9.5, -12),
		Vector2(18, 30), Vector2(-60, 50), Vector2(-100, -120), Vector2(264, 200), Vector2(280, -150), Vector2(-215, 120), Vector2(0, 0)])
	await _paper_set("issf_10m", papers[1], [Vector2(5, 10), Vector2(-15, -5), Vector2(22, -18), Vector2(8, 3), Vector2(-40, 35), Vector2(60, -70)])
	# overview of the whole paper line from the bay
	_view(Vector3(-3.2, 1.66, 0.6), Vector3(-3.2, 1.3, -10.0), 74.0)
	await _frames(20)
	await _snap("paper_10_line_overview")
	# movable stand: step through the distances
	_view(_eye(-1.6), Vector3(-1.6, 1.4, -15.0), 74.0)
	for d in [7.0, 10.0, 15.0, 25.0]:
		targets.call("set_selected_distance", d)
		await _frames(10)
		await _snap("paper_20_movable_%dm" % int(d))
	var tex: Texture2D = papers[0].call("get_face_texture")
	tex.get_image().save_png(out_dir + "/paper_30_ui_face_texture.png")

func _mode_tg_steel() -> void:
	var gongs: Array = targets.get("gongs")
	var g: Node3D = gongs[0]
	var plate: Node3D = g.get("plate")
	var c := plate.global_position
	_view(_eye(0.0), c, 74.0)
	await _frames(20)
	await _snap("steel_00_before_fov74")
	_view(_eye(0.0), c, 20.0)
	await _frames(12)
	await _snap("steel_01_before_fov20")
	# centre hit: frames while it swings
	_shoot(_muzzle(0.0), c)
	for t in [0.06, 0.2, 0.45, 0.9]:
		await _secs(t if t == 0.06 else 0.2)
		await _snap("steel_02_centre_hit_%03dms" % int(t * 1000.0))
	await _secs(9.0)
	# off-centre and edge hits
	_shoot(_muzzle(0.0), c + Vector3(0.07, 0.02, 0))
	await _secs(0.3)
	await _snap("steel_03_offcentre_twist_0p3s")
	await _secs(6.0)
	_shoot(_muzzle(0.0), c + Vector3(-0.092, -0.03, 0))
	await _secs(0.25)
	await _snap("steel_04_edge_hit_0p25s")
	await _secs(6.0)
	for k in 5:
		_shoot(_muzzle(0.0), c + Vector3(randf_range(-0.06, 0.06), randf_range(-0.06, 0.06), 0))
		await _secs(0.5)
	await _secs(8.0)
	_view(_eye(0.0), c, 20.0)
	await _frames(10)
	await _snap("steel_05_after_fov20")
	_view(_eye(0.0), c, 74.0)
	await _frames(10)
	await _snap("steel_06_after_fov74")
	_view(c + Vector3(0.12, 0.03, 0.5), c, 45.0)
	await _frames(12)
	await _snap("steel_07_close_0p5m")
	_view(c + Vector3(0.6, 0.3, 1.4), c + Vector3(0, -0.2, 0), 60.0)
	await _frames(12)
	await _snap("steel_08_stand")
	# the other plates from the line
	for i in [1, 2, 3]:
		var gi: Node3D = gongs[i]
		var pi: Node3D = gi.get("plate")
		var x := 0.0 if i != 2 else 7.2
		_view(_eye(x), pi.global_position, 20.0)
		await _frames(10)
		_shoot(_muzzle(x), pi.global_position + Vector3(0.02, 0.01, 0))
		await _secs(0.5)
		await _snap("steel_10_gong%d_hit_fov20" % i)
	# pivot plate
	var pv: Node3D = targets.get("pivot")
	var pc := pv.global_position + Vector3(0, 0.57, 0)
	_view(pc + Vector3(1.6, 0.4, 2.2), pc + Vector3(0, -0.2, 0), 40.0)
	await _frames(12)
	await _snap("steel_20_pivot_before")
	_shoot(_muzzle(1.3), pc)
	for k in 5:
		await _secs(0.12)
		await _snap("steel_21_pivot_hit_%d" % k)
	await _secs(2.0)
	await _snap("steel_22_pivot_after")
	print("pivot: ", pv.call("get_stats"))

func _mode_tg_break() -> void:
	var a := Vector3(-5.9, 1.1, -9.0)
	var ex := -4.8
	_view(_eye(ex), a, 74.0)
	await _frames(20)
	await _snap("break_00_before_fov74")
	_view(_eye(ex), a, 20.0)
	await _frames(12)
	await _snap("break_01_before_fov20")
	_view(a + Vector3(0.1, 0.25, 1.1), a + Vector3(0, 0.02, 0), 55.0)
	await _frames(12)
	await _snap("break_02_before_close")
	# green wine bottle
	_view(a + Vector3(-0.1, 0.2, 1.3), a + Vector3(-0.3, 0.0, 0), 50.0)
	await _frames(10)
	_rec_begin()
	_shoot(_muzzle(ex), a + Vector3(-0.50, 0.0, 0.01))
	var names := ["030", "100", "250", "600"]
	var waits := [0.05, 0.07, 0.15, 0.35]
	for i in 4:
		await _secs(waits[i])
		await _snap("break_10_bottle_%sms" % names[i])
	_rec_end("bottle break")
	await _secs(2.0)
	# clay
	_shoot(_muzzle(ex), a + Vector3(-0.09, -0.03, 0.0))
	for i in 3:
		await _secs([0.05, 0.08, 0.25][i])
		await _snap("break_11_clay_%d" % i)
	await _secs(1.5)
	# can (low on the body), then the pot, then the beer bottle
	_view(a + Vector3(0.2, 0.25, 1.4), a + Vector3(0.15, 0.0, 0), 50.0)
	await _frames(10)
	_shoot(_muzzle(ex), a + Vector3(0.215, -0.08, 0.01))
	for i in 3:
		await _secs([0.06, 0.15, 0.4][i])
		await _snap("break_12_can_%d" % i)
	await _secs(1.0)
	_shoot(_muzzle(ex), a + Vector3(0.36, -0.04, 0.0))
	for i in 3:
		await _secs([0.05, 0.1, 0.3][i])
		await _snap("break_13_pot_%d" % i)
	await _secs(0.8)
	_shoot(_muzzle(ex), a + Vector3(0.525, 0.0, -0.01))
	await _secs(0.12)
	await _snap("break_14_clear_bottle_120ms")
	await _secs(6.0)
	_view(a + Vector3(0.1, 0.25, 1.1), a + Vector3(0, 0.02, 0), 55.0)
	await _frames(12)
	await _snap("break_20_after_close")
	_view(a + Vector3(0.3, 0.0, 1.6), a + Vector3(0, -1.0, -0.3), 50.0)
	await _frames(12)
	await _snap("break_21_debris_on_ground")
	_view(Vector3(-6.75, 0.45, -8.75), Vector3(-6.3, 0.0, -9.35), 50.0)
	await _frames(12)
	await _snap("break_22_shards_close")
	_view(_eye(ex), a, 20.0)
	await _frames(12)
	await _snap("break_23_after_fov20")
	print("breakables: ", targets.get("breakables").call("get_stats"))
	targets.call("reset_all")
	await _frames(20)
	_view(a + Vector3(0.1, 0.25, 1.1), a + Vector3(0, 0.02, 0), 55.0)
	await _frames(12)
	await _snap("break_30_after_reset")
	# pad shelf overview
	var c := Vector3(8.6, 1.1, -10.0)
	_view(c + Vector3(-0.2, 0.25, 1.3), c, 60.0)
	await _frames(12)
	await _snap("break_40_pad_shelf")

# ----------------------------------------------------------------------------------------------- hitch check
## CPU cost of the hit handlers (first call of each kind and the following ones) and the longest frame around
## them. No screenshots here: a viewport read-back stalls a frame by itself.
func _mode_tg_hitch() -> void:
	_view(Vector3(-2.0, 1.66, 0.3), Vector3(-2.5, 1.2, -10.0), 74.0)
	await _frames(60)
	var papers: Array = targets.call("get_paper_targets")
	var gongs: Array = targets.get("gongs")
	var br: Node3D = targets.get("breakables")
	var jobs := []
	var p0: Node3D = papers[0]
	jobs.append(["paper (hole in face + backer)", func(i: int) -> void: _shoot(_muzzle(-4.8), p0.call("mm_to_world", Vector2(-80 + i * 23, 40 - i * 17)))])
	var pl: Node3D = gongs[0].get("plate")
	jobs.append(["steel gong (splash + impulse)", func(i: int) -> void: _shoot(_muzzle(0.0), pl.global_position + Vector3(-0.05 + 0.02 * i, 0.03 - 0.012 * i, 0))])
	jobs.append(["dirt", func(i: int) -> void: _shoot(_muzzle(-2.0), Vector3(-2.0 + 0.2 * i, 0, -8.0))])
	jobs.append(["concrete slab", func(i: int) -> void: _shoot(Vector3(-2.0, 1.5, 0.5), Vector3(-2.0 + 0.2 * i, 0.06, -0.6))])
	jobs.append(["brittle (bottle, clay, pot, bottle, bottle)", func(i: int) -> void:
		var it: RefCounted = br.call("get_item", [0, 2, 4, 5, 1][i])
		var b: Node3D = it.get("body")
		_shoot(_muzzle(-4.8), b.global_position + Vector3(0, 0.05 if str(it.get("type")) != "clay" else 0.0, 0))])
	jobs.append(["tin can", func(i: int) -> void:
		var c: Node3D = br.call("get_cans")[i % 2]
		_shoot(_muzzle(-4.8), c.global_position + Vector3(0, 0.04, 0))])
	jobs.append(["muzzle event + casing", func(i: int) -> void:
		fx.call("muzzle_event", Transform3D(Basis.IDENTITY, Vector3(-2.0, 1.5, -0.8)), 0.35, i)
		fx.call("eject_casing", Transform3D(Basis.IDENTITY, Vector3(-2.0, 1.55, -0.7)), Vector3(-2.5, 2.0, 0.4), Vector3(5, 60, 10))])
	for job in jobs:
		var worst_first := 0.0
		var worst_rest := 0.0
		var cpu_first := 0.0
		var cpu_rest := 0.0
		for i in 5:
			_frame_ms.clear()
			_rec = true
			await _frames(2)
			var t0 := Time.get_ticks_usec()
			(job[1] as Callable).call(i)
			# the bullet flies inside the physics step: time the frames that contain the hit
			await _frames(1)
			_frame_ms.clear()
			var cpu := 0.0
			for k in 24:
				var f0 := Time.get_ticks_usec()
				await get_tree().process_frame
				cpu = maxf(cpu, 0.0)
			_rec = false
			var mx := 0.0
			for v in _frame_ms:
				mx = maxf(mx, v)
			if i == 0:
				worst_first = mx
			else:
				worst_rest = maxf(worst_rest, mx)
			await _frames(20)
		print("HITCH %-44s longest frame after the FIRST event %.2f ms, after events 2-5 %.2f ms" % [job[0], worst_first, worst_rest])
	# direct CPU cost of the handlers (synthetic hit dictionaries, same code path as bullets)
	targets.call("reset_all")
	await _frames(10)
	var hit := {"position": Vector3.ZERO, "normal": Vector3.BACK, "direction": Vector3.FORWARD, "speed": 335.0, "mass": 0.008035, "energy": 450.0,
		"collider": null, "shape": 0, "surface": "paper", "tof": 0.03, "origin": Vector3.ZERO, "shot_index": 1}
	var kinds := [["paper on_bullet_hit", p0, p0.get_node("Paper"), func(i: int) -> Vector3: return p0.call("mm_to_world", Vector2(i * 9 - 100, i * 5 - 60))],
		["backer on_bullet_hit", p0, p0.get_node("Backer"), func(i: int) -> Vector3: return p0.call("mm_to_world", Vector2(i * 9 - 100, i * 5 - 60)) + Vector3(0, 0, -0.001)],
		["plate on_bullet_hit", pl, pl, func(i: int) -> Vector3: return pl.to_global(Vector3(0.05 * cos(i * 1.0), 0.05 * sin(i * 1.0), 0.0048))]]
	for k in kinds:
		var first := 0.0
		var worst := 0.0
		var sum := 0.0
		for i in 30:
			var h := hit.duplicate()
			h["collider"] = k[2]
			h["position"] = (k[3] as Callable).call(i)
			h["shot_index"] = 100 + i
			var t0 := Time.get_ticks_usec()
			(k[1] as Object).call("on_bullet_hit", h)
			var dt := (Time.get_ticks_usec() - t0) / 1000.0
			if i == 0:
				first = dt
			else:
				worst = maxf(worst, dt)
				sum += dt
			await get_tree().process_frame
		print("CPU   %-24s first %.3f ms, then mean %.3f ms, worst %.3f ms" % [k[0], first, sum / 29.0, worst])
	for surf in ["dirt", "concrete", "wood", "sheet_metal", "steel", "gravel", "grass", "rubber"]:
		var worst2 := 0.0
		var first2 := 0.0
		for i in 10:
			var h2 := hit.duplicate()
			h2["surface"] = surf
			h2["position"] = Vector3(-2.0 + i * 0.1, 0.0, -6.0)
			h2["normal"] = Vector3.UP
			h2["direction"] = Vector3(0, -0.3, -1).normalized()
			h2["collider"] = panels["ground"]
			var t1 := Time.get_ticks_usec()
			fx.call("spawn_world_impact", h2)
			var d2 := (Time.get_ticks_usec() - t1) / 1000.0
			if i == 0:
				first2 = d2
			else:
				worst2 = maxf(worst2, d2)
			await get_tree().process_frame
		print("CPU   spawn_world_impact %-12s first %.3f ms, worst of the next nine %.3f ms" % [surf, first2, worst2])
	var t2 := Time.get_ticks_usec()
	for i in 20:
		fx.call("muzzle_event", Transform3D(Basis.IDENTITY, Vector3(-2.0, 1.5, -0.8)), 0.35, i)
	print("CPU   muzzle_event mean %.3f ms" % ((Time.get_ticks_usec() - t2) / 20000.0))

# ----------------------------------------------------------------------------------------------- real environment
## marks and dust on the real terrain: berm from 3 m, flat ground, and the berm seen from 25 m and the firing line
func _mode_env_marks() -> void:
	var space := get_world_3d().direct_space_state
	var spots := {"berm": [Vector3(1.0, 1.6, -50.0), Vector3(1.0, 1.4, -56.0)], "ground": [Vector3(-1.0, 1.6, -20.0), Vector3(-1.0, 0.0, -23.0)],
		"grass": [Vector3(-3.0, 1.6, -3.0), Vector3(-3.0, 0.0, -6.0)]}
	for k in spots:
		var from: Vector3 = spots[k][0]
		var to: Vector3 = spots[k][1]
		var r := space.intersect_ray(PhysicsRayQueryParameters3D.create(from, from + (to - from).normalized() * 30.0, 1))
		if r.is_empty():
			print("no hit for ", k)
			continue
		var p: Vector3 = r["position"]
		var n: Vector3 = r["normal"]
		print("ENV %s: hit %s normal %s (n.dir = %.2f) collider %s" % [k, p, n, n.dot((to - from).normalized()), r["collider"].name])
		var n_up := n if n.dot(to - from) < 0.0 else -n
		_view(p + n_up * 1.6 + Vector3(0.3, 0.5, 0.6), p, 50.0)
		await _frames(30)
		await _snap("env_%s_0_before" % k)
		_shoot(from, to)
		await _secs(0.15)
		await _snap("env_%s_1_150ms" % k)
		await _secs(0.6)
		await _snap("env_%s_2_750ms" % k)
		await _secs(3.5)
		await _snap("env_%s_3_mark_after" % k)
		_view(p + n_up * 0.5 + Vector3(0.05, 0.1, 0.1), p, 50.0)
		await _frames(20)
		await _snap("env_%s_4_mark_close" % k)
	# the berm from 25 m and from the firing line
	for d in [[25.0, Vector3(1.5, 1.66, -29.0)], [55.0, Vector3(-1.6, 1.66, 0.3)]]:
		var eye: Vector3 = d[1]
		var tgt := Vector3(eye.x + 0.5, 2.3, -56.5)
		_view(eye, tgt, 74.0)
		await _frames(30)
		_shoot(eye + Vector3(0, -0.08, -0.5), tgt)
		for t in [0.5, 1.0, 2.0]:
			await _secs(0.5 if t < 1.5 else 1.0)
			await _snap("env_berm_from_%dm_%04dms" % [int(d[0]), int(t * 1000)])
