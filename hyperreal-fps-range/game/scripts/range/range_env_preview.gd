extends Node3D
## Screenshot / benchmark harness for the static environment (NOT part of the game).
##
##   $GODOT --path game res://scenes/range_env_preview.tscn -- --out=<dir> [--preset=high] [--views=a,b,..]
##          [--settle=90] [--bench=600] [--gi=sdfgi|none|voxel] [--aa=msaa4|taa|fsr2|none|msaa2|fxaa] [--exposure=1.0]
##          [--shimmer]  (saves two frames 1/8 px apart per view to judge temporal stability)

const EYE := 1.66
var VIEWS := {
	"spawn_downrange": [Vector3(-1.6, EYE, 0.55), Vector3(-1.6, 1.25, -25.0), 75.0],
	"spawn_bench": [Vector3(-1.6, EYE, 0.55), Vector3(-1.55, 0.92, -0.42), 75.0],
	"pad_downrange": [Vector3(6.4, EYE, 0.6), Vector3(4.5, 1.2, -25.0), 75.0],
	"back_at_bay": [Vector3(-0.5, EYE, -10.0), Vector3(-2.0, 1.5, 1.0), 75.0],
	"turn_around": [Vector3(-1.6, EYE, 0.55), Vector3(1.5, 1.4, 12.0), 75.0],
	"bench_closeup": [Vector3(-1.95, 1.22, 0.02), Vector3(-2.4, 1.02, -0.5), 75.0],
	"roof_underside": [Vector3(-1.6, EYE, 1.6), Vector3(-2.6, 3.0, -0.6), 75.0],
	"berm_25m": [Vector3(1.0, EYE, -25.0), Vector3(0.0, 2.2, -58.0), 75.0],
	"pad_to_bay": [Vector3(7.6, EYE, 2.2), Vector3(-2.0, 1.4, 0.5), 75.0],
	"parking": [Vector3(4.5, EYE, 6.6), Vector3(-3.0, 1.5, 4.0), 75.0],
	"lane1_left": [Vector3(-4.8, EYE, 1.2), Vector3(-6.2, 1.3, -1.5), 75.0],
	"sun_check": [Vector3(6.4, EYE, 0.6), Vector3(6.4, EYE, 0.6) + Vector3(-0.292, 0.624, 0.725) * 10.0, 75.0],
	"overview": [Vector3(13.0, 14.0, 12.0), Vector3(0.0, 0.0, -14.0), 70.0],
	"backwall": [Vector3(-2.2, EYE, 1.4), Vector3(-2.2, 1.5, 4.6), 75.0],
	"exposure_bay": [Vector3(-1.6, EYE, 3.2), Vector3(-1.6, 1.3, -20.0), 75.0],
}

var args := {}
var env_node: Node3D
var cam: Camera3D


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--"):
			var kv := a.trim_prefix("--").split("=", true, 1)
			args[kv[0]] = kv[1] if kv.size() > 1 else "1"
	env_node = load("res://scenes/range_env.tscn").instantiate()
	add_child(env_node)
	cam = Camera3D.new()
	cam.near = 0.05
	cam.far = 400.0
	add_child(cam)
	cam.make_current()
	var ca := (load("res://assets/env/camera_attributes.tres") as CameraAttributesPractical).duplicate()
	if args.has("exposure"):
		ca.auto_exposure_enabled = false
		ca.exposure_multiplier = float(args["exposure"])
	cam.attributes = ca
	_run.call_deferred()


func _apply_overrides() -> void:
	var vp := get_viewport()
	var env: Environment = env_node.get_world_environment().environment
	match String(args.get("gi", "")):
		"none": env.sdfgi_enabled = false
		"sdfgi": env.sdfgi_enabled = true
	match String(args.get("aa", "")):
		"none":
			vp.msaa_3d = Viewport.MSAA_DISABLED; vp.use_taa = false; vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_DISABLED
		"fxaa":
			vp.msaa_3d = Viewport.MSAA_DISABLED; vp.use_taa = false; vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
		"msaa2":
			vp.msaa_3d = Viewport.MSAA_2X; vp.use_taa = false
		"msaa4":
			vp.msaa_3d = Viewport.MSAA_4X; vp.use_taa = false
		"taa":
			vp.msaa_3d = Viewport.MSAA_DISABLED; vp.use_taa = true
		"msaa4taa":
			vp.msaa_3d = Viewport.MSAA_4X; vp.use_taa = true
		"fsr2":
			vp.msaa_3d = Viewport.MSAA_DISABLED; vp.use_taa = false
			vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR2; vp.scaling_3d_scale = 1.0
	if args.has("tonemap"):
		env.tonemap_mode = {"agx": Environment.TONE_MAPPER_AGX, "filmic": Environment.TONE_MAPPER_FILMIC, "aces": Environment.TONE_MAPPER_ACES, "linear": Environment.TONE_MAPPER_LINEAR}[args["tonemap"]]
	if args.has("sdfgi_occ"):
		env.sdfgi_use_occlusion = args["sdfgi_occ"] == "1"
	if args.has("sdfgi_energy"):
		env.sdfgi_energy = float(args["sdfgi_energy"])
	if String(args.get("gi", "")) == "probe":
		var v0 := env_node.get_node_or_null("Lighting/BayVoxelGI")
		if v0:
			v0.visible = false
	if args.has("sky"):
		var id := String(args["sky"])
		var info: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://assets/env/sky/%s_sky.json" % id))
		(env.sky.sky_material as PanoramaSkyMaterial).panorama = load("res://assets/env/sky/%s_sky.exr" % id)
		var d: Array = info["sun_dir_to_sun"]
		var c: Array = info["light_color_linear"]
		var sun: DirectionalLight3D = env_node.get_sun()
		sun.transform = Transform3D(Basis.looking_at(-Vector3(d[0], d[1], d[2]), Vector3.UP), Vector3(0, 12, 0))
		sun.light_energy = float(info["light_energy"])
		sun.light_color = Color(c[0], c[1], c[2]).linear_to_srgb()
	if args.has("skyrot"):
		env.sky_rotation = Vector3(0.0, deg_to_rad(float(args["skyrot"])), 0.0)
	if args.has("ssao"):
		env.ssao_enabled = args["ssao"] == "1"
	if args.has("ssil"):
		env.ssil_enabled = args["ssil"] == "1"
	if args.has("hide"):
		var classes := String(args["hide"]).split(",")
		for n in env_node.get_node("Vegetation").get_children() + env_node.get_node("Props").get_children():
			if n.has_meta("veg_class") and String(n.get_meta("veg_class")) in classes:
				n.visible = false
	if args.has("vegshadow"):
		for n in env_node.get_node("Vegetation").get_children():
			(n as GeometryInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if args["vegshadow"] == "1" else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	if args.has("noveg"):
		env_node.get_node("Vegetation").visible = false
	if args.has("nosun"):
		env_node.get_sun().visible = false


func _set_view(v: Array) -> void:
	cam.fov = v[2]
	cam.look_at_from_position(v[0], v[1], Vector3.UP)


func _frames(n: int) -> void:
	for i in n:
		await get_tree().process_frame


const BAKE_ALBEDO := {
	"slab_concrete": Color(0.23, 0.23, 0.22), "footing_concrete": Color(0.08, 0.08, 0.08), "block_concrete": Color(0.27, 0.25, 0.2), "mortar": Color(0.3, 0.28, 0.24),
	"corrugated": Color(0.34, 0.36, 0.36), "galv_steel": Color(0.3, 0.3, 0.3), "plywood": Color(0.27, 0.17, 0.09), "osb": Color(0.38, 0.25, 0.14),
	"planks_light": Color(0.3, 0.23, 0.15), "planks_grey": Color(0.19, 0.14, 0.1), "planks_dark": Color(0.13, 0.1, 0.07), "terrain": Color(0.19, 0.17, 0.1),
	"rubber": Color(0.03, 0.03, 0.035), "carpet": Color(0.05, 0.06, 0.09), "signs": Color(0.5, 0.5, 0.48), "burlap": Color(0.3, 0.22, 0.12),
}


## Bakes the VoxelGI volume for the bay/pad and saves res://assets/env/voxelgi_bay.res.
## The voxelizer cannot read ShaderMaterials, so every surface gets a flat stand-in of its mean albedo; thin shells
## (roof sheet, back wall, block wall) are backed by temporary thick blockers so sun-lit voxels cannot leak inside.
func _bake_voxel() -> void:
	var bake_root := Node3D.new()
	add_child(bake_root)
	for grp in ["Architecture", "Terrain"]:
		for c in env_node.get_node(grp).get_children():
			var mi := c as MeshInstance3D
			if mi == null or mi.gi_mode != GeometryInstance3D.GI_MODE_STATIC:
				continue
			if String(mi.name) in ["bay_roof", "bay_siding"]:
				continue
			var d := MeshInstance3D.new()
			d.mesh = mi.mesh
			d.transform = mi.global_transform
			d.gi_mode = GeometryInstance3D.GI_MODE_STATIC
			for s in mi.mesh.get_surface_count():
				var m := mi.mesh.surface_get_material(s)
				var key := m.resource_path.get_file().get_basename() if m != null else ""
				var sm := StandardMaterial3D.new()
				sm.albedo_color = BAKE_ALBEDO.get(key, Color(0.2, 0.2, 0.2))
				d.set_surface_override_material(s, sm)
			bake_root.add_child(d)
	var slope := 0.5 / 5.5
	var blockers := [
		[Vector3(-2.1, 2.55 + (4.6 - 1.65) * slope + 0.33, 1.65), Vector3(8.96, 0.6, 6.95), Vector3(atan(slope), 0, 0), Color(0.33, 0.35, 0.35)],
		[Vector3(-2.15, 1.25, 4.97), Vector3(8.5, 2.5, 0.5), Vector3.ZERO, Color(0.3, 0.3, 0.3)],
		[Vector3(-6.65, 1.5, 1.95), Vector3(0.5, 3.0, 5.7), Vector3.ZERO, Color(0.27, 0.25, 0.2)],
	]
	for b in blockers:
		var bm := MeshInstance3D.new()
		var box := BoxMesh.new()
		box.size = b[1]
		var sm2 := StandardMaterial3D.new()
		sm2.albedo_color = b[3]
		box.material = sm2
		bm.mesh = box
		bm.position = b[0]
		bm.rotation = b[2]
		bm.gi_mode = GeometryInstance3D.GI_MODE_STATIC
		bake_root.add_child(bm)
	var vg := VoxelGI.new()
	vg.size = Vector3(22.0, 6.4, 16.0)
	vg.position = Vector3(1.5, 2.7, 0.5)
	vg.subdiv = VoxelGI.SUBDIV_256
	add_child(vg)
	env_node.visible = false
	await _frames(3)
	vg.bake(bake_root)
	var d2 := vg.data
	d2.interior = false
	d2.energy = float(args.get("vg_energy", "1.0"))
	d2.propagation = float(args.get("vg_prop", "0.5"))
	d2.bias = 1.5
	d2.normal_bias = 0.6
	d2.dynamic_range = 4.0
	d2.use_two_bounces = true
	var err := ResourceSaver.save(d2, "res://assets/env/voxelgi_bay.res")
	print("VOXEL BAKE saved err=", err)
	get_tree().quit()


func _run() -> void:
	if args.has("bakevoxel"):
		await _bake_voxel()
		return
	var preset := String(args.get("preset", "high"))
	env_node.apply_quality(preset)
	_apply_overrides()
	var out := String(args.get("out", "user://env_shots"))
	DirAccess.make_dir_recursive_absolute(out)
	var names: Array = VIEWS.keys()
	if args.has("views"):
		names = Array(String(args["views"]).split(","))
	var settle := int(args.get("settle", "90"))
	var bench := int(args.get("bench", "0"))
	var first := true
	var report := []
	for nm in names:
		if not VIEWS.has(nm):
			continue
		_set_view(VIEWS[nm])
		await _frames(settle + (90 if first else 0))
		first = false
		if bench > 0:
			var times := PackedFloat64Array()
			var t0 := Time.get_ticks_usec()
			for i in bench:
				await get_tree().process_frame
				var t1 := Time.get_ticks_usec()
				times.append((t1 - t0) / 1000.0)
				t0 = t1
			var arr := Array(times)
			arr.sort()
			var mean := 0.0
			for t in arr:
				mean += t
			mean /= arr.size()
			var line := "BENCH preset=%s view=%s frames=%d mean_ms=%.3f fps_mean=%.1f p50=%.3f p95=%.3f p99=%.3f max=%.3f engine_fps=%.1f draw_calls=%d prims=%d vram_mb=%.0f" % [
				preset, nm, arr.size(), mean, 1000.0 / mean, arr[arr.size() / 2], arr[int(arr.size() * 0.95)], arr[int(arr.size() * 0.99)], arr[-1],
				Performance.get_monitor(Performance.TIME_FPS), int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
				int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)), Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0]
			print(line)
			report.append(line)
		else:
			await RenderingServer.frame_post_draw
			var img := get_viewport().get_texture().get_image()
			img.save_png(out.path_join(nm + ".png"))
			if args.has("shimmer"):
				cam.rotate_y(deg_to_rad(0.02))
				await _frames(2)
				await RenderingServer.frame_post_draw
				get_viewport().get_texture().get_image().save_png(out.path_join(nm + "_b.png"))
			print("SHOT ", nm)
	if bench > 0:
		var f := FileAccess.open(out.path_join("bench_%s%s.txt" % [preset, String(args.get("tag", ""))]), FileAccess.WRITE)
		f.store_string("\n".join(report) + "\n")
	get_tree().quit()
