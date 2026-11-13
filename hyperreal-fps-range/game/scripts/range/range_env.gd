extends Node3D
## Static range environment + lighting (scene: res://scenes/range_env.tscn, built by tools/build/env/build_scene.gd).
##
## Contract
##   get_sun() -> DirectionalLight3D, get_world_environment() -> WorldEnvironment, apply_quality(preset)
##   StaticBody3D nodes: collision layer 1, meta "surface" (one of RangeLayout.SURFACES)
##   MeshInstance3D nodes in group "acoustic_geometry" carry meta "acoustic_material"
##   (concrete | metal | wood | soil | gravel | grass)
##
## Quality presets (measured on Intel Arc B580 @ 1920x1080, see evidence/env/NOTES.md):
##
## | setting                         | low        | medium      | high          | ultra          |
## |---------------------------------|------------|-------------|---------------|----------------|
## | GI (bay + pad volume)           | probe only | probe only  | probe only    | VoxelGI (high) |
## | sun shadow atlas                | 2048       | 4096        | 8192          | 8192           |
## | sun shadow distance / splits    | 45 m / 2   | 70 m / 4    | 90 m / 4      | 120 m / 4      |
## | soft shadow filter              | low        | medium      | high          | ultra          |
## | SSAO                            | off        | on (medium) | on (high)     | on (ultra)     |
## | SSIL                            | off        | off         | on            | on             |
## | volumetric fog (sun shafts)     | off        | off         | off           | on             |
## | vegetation density              | 35 %       | 65 %        | 100 %         | 100 %          |
## | vegetation shadows              | trees only | trees+bush  | all but turf  | all            |
## | anti-aliasing (if allowed)      | FXAA       | MSAA 2x     | MSAA 4x       | MSAA 4x + TAA  |
## | anisotropic filtering           | 4x         | 8x          | 16x           | 16x            |
## | glow                            | off        | on          | on            | on             |
##
## Measured through the full game (weapon, hands, targets, effects) at 1920x1080 uncapped, bay / pad viewpoints,
## docs/VERIFICATION.md has the table. Per-feature cost at High (ms): VoxelGI 4.9, all vegetation 3.2-4.4,
## sun shadows 4.1-4.7, MSAA 4x 2.2-3.4 (2x: 1.1-1.7 less), soft-shadow filter high vs low 1.1-1.6, vegetation
## shadows 1.1, 8192 vs 4096 atlas 0.8, SSIL 0.4, SSAO 0.2, glow 0.2.
## The honest trade-offs: without VoxelGI (Low-High) the bay is lit by the box-projected reflection probe's ambient
## (one irradiance sample for the whole bay: flatter interior, no darkening into the back corners, slight green
## bounce on the roof underside). Ultra adds VoxelGI and volumetric sun shafts and does not hold 60 fps on this GPU.
## SSIL only matters in the shaded bay; volumetric fog costs ~1 ms for a subtle effect.

const PRESETS := ["low", "medium", "high", "ultra"]
const BAY_AMBIENT_ENERGY := 0.20

@export var apply_viewport_settings := true   ## also set MSAA/TAA/anisotropy/shadow atlas on the main viewport
@export var initial_preset := "high"

var current_preset := ""

@onready var _sun: DirectionalLight3D = $Sun
@onready var _world_env: WorldEnvironment = $WorldEnvironment
@onready var _bay_probe: ReflectionProbe = $Lighting/BayProbe


func _ready() -> void:
	# the spare-frame rack behind the pad read as untextured placeholder boards (review round 1): removed
	var rack := get_node_or_null("Architecture/site_storage")
	if rack != null:
		(rack as Node3D).visible = false
	var rack_col := get_node_or_null("Collision/Col_site_storage_wood")
	if rack_col != null:
		rack_col.queue_free()
	# The probe's influence fades over `blend_distance` inside its box: with the box hugging the bay, the walls, slab
	# and roof sat in the fade zone and were lit by the open-sky ambient. Grow the box past the structure.
	var bp := get_node_or_null("Lighting/BayProbe") as ReflectionProbe
	if bp != null:
		bp.size = Vector3(10.6, 5.4, 7.8)
		bp.position = Vector3(-2.1, 1.75, 1.75)
		bp.origin_offset = Vector3(0, -0.2, -0.5)
		bp.blend_distance = 0.8
	_build_bounce_lights()
	if current_preset == "":
		apply_quality(initial_preset)


## Low-High presets have no real indirect light. What gives a covered bay its look is sunlight bouncing off the
## ground in front of it: bright low at the open front, falling off towards the back wall and the upper back
## corner. Stand-in: a row of shadowless warm lights lying on the sunlit ground just outside the slab, plus one
## at the open right side. They are fill lights with no physical counterpart other than that bounce.
var _bounce: Node3D
func _build_bounce_lights() -> void:
	_bounce = Node3D.new()
	_bounce.name = "BayBounce"
	$Lighting.add_child(_bounce)
	var spots := [Vector3(-5.2, 0.35, -2.6), Vector3(-3.1, 0.35, -2.8), Vector3(-1.0, 0.35, -2.8), Vector3(1.0, 0.35, -2.6), Vector3(3.4, 0.4, 1.6)]
	for p: Vector3 in spots:
		var l := OmniLight3D.new()
		l.position = p
		l.light_color = Color(1.0, 0.93, 0.80)
		l.light_energy = 0.55
		l.light_specular = 0.0
		l.omni_range = 8.5
		l.omni_attenuation = 1.3
		l.shadow_enabled = false
		l.light_bake_mode = Light3D.BAKE_DISABLED
		_bounce.add_child(l)

func get_sun() -> DirectionalLight3D:
	return $Sun as DirectionalLight3D


func get_world_environment() -> WorldEnvironment:
	return $WorldEnvironment as WorldEnvironment


func get_camera_attributes() -> CameraAttributes:
	return load("res://assets/env/camera_attributes.tres") as CameraAttributes


## Direction FROM the scene TOWARD the sun (unit vector).
func get_sun_direction() -> Vector3:
	return get_sun().global_transform.basis.z.normalized()


func apply_quality(preset: String) -> void:
	if not PRESETS.has(preset):
		push_warning("RangeEnv.apply_quality: unknown preset '%s', using 'high'" % preset)
		preset = "high"
	current_preset = preset
	var q := PRESETS.find(preset)
	var env: Environment = get_world_environment().environment
	var sun := get_sun()

	# --- global illumination -------------------------------------------------------------
	# VoxelGI (baked voxels, real-time lit) covers the bay, the pad and ~8 m in front: sun bounce off the ground and
	# sky occlusion under the roof. SDFGI was evaluated and rejected (see evidence/env/NOTES.md); it stays off.
	env.sdfgi_enabled = false
	var vgi := get_node_or_null("Lighting/BayVoxelGI") as VoxelGI
	if vgi != null:
		vgi.visible = q >= 3      # measured 4.9 ms at 1080p on the Arc B580: an Ultra-only luxury
	RenderingServer.voxel_gi_set_quality(RenderingServer.VOXEL_GI_QUALITY_HIGH if q >= 3 else RenderingServer.VOXEL_GI_QUALITY_LOW)
	RenderingServer.gi_set_use_half_resolution(q <= 2)
	var probe := $Lighting/BayProbe as ReflectionProbe
	# Without VoxelGI (Low-High) the sky ambient would light the slab under the roof as brightly as open ground.
	# Inside the probe's box the ambient term is therefore replaced by a constant that stands for what actually
	# reaches a covered bay: light bounced off the sunlit ground and a strip of sky through the open front.
	if _bounce != null:
		_bounce.visible = q < 3
	if q >= 3:
		probe.interior = false
		probe.ambient_mode = ReflectionProbe.AMBIENT_ENVIRONMENT
	else:
		probe.interior = false
		probe.ambient_mode = ReflectionProbe.AMBIENT_COLOR
		probe.ambient_color = Color(0.78, 0.74, 0.66)
		probe.ambient_color_energy = BAY_AMBIENT_ENERGY

	# --- sun shadows -----------------------------------------------------------------------
	var atlas: int = [2048, 4096, 8192, 8192][q]
	RenderingServer.directional_shadow_atlas_set_size(atlas, true)
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS if q == 0 else DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	sun.directional_shadow_max_distance = [45.0, 70.0, 90.0, 120.0][q]
	sun.directional_shadow_split_1 = 0.22 if q == 0 else [0.0, 0.07, 0.055, 0.042][q]
	sun.directional_shadow_split_2 = [0.5, 0.2, 0.16, 0.125][q]
	sun.directional_shadow_split_3 = [0.75, 0.47, 0.42, 0.36][q]
	sun.directional_shadow_blend_splits = q >= 1
	sun.directional_shadow_fade_start = 0.85
	sun.light_angular_distance = 0.0 if q == 0 else 0.27
	RenderingServer.directional_soft_shadow_filter_set_quality([RenderingServer.SHADOW_QUALITY_SOFT_LOW, RenderingServer.SHADOW_QUALITY_SOFT_MEDIUM,
		RenderingServer.SHADOW_QUALITY_SOFT_HIGH, RenderingServer.SHADOW_QUALITY_SOFT_ULTRA][q])

	# --- screen-space effects ----------------------------------------------------------------
	env.ssao_enabled = q >= 1
	RenderingServer.environment_set_ssao_quality([RenderingServer.ENV_SSAO_QUALITY_LOW, RenderingServer.ENV_SSAO_QUALITY_MEDIUM,
		RenderingServer.ENV_SSAO_QUALITY_HIGH, RenderingServer.ENV_SSAO_QUALITY_ULTRA][q], true, 0.5, 2, 50, 300)
	env.ssil_enabled = q >= 2
	RenderingServer.environment_set_ssil_quality(RenderingServer.ENV_SSIL_QUALITY_MEDIUM if q == 2 else RenderingServer.ENV_SSIL_QUALITY_HIGH, true, 0.5, 4, 50, 300)
	env.glow_enabled = q >= 1
	env.volumetric_fog_enabled = q >= 3

	# --- vegetation ------------------------------------------------------------------------
	var density: float = [0.35, 0.65, 1.0, 1.0][q]
	for n in get_tree().get_nodes_in_group("env_vegetation_single"):
		var gi3 := n as GeometryInstance3D
		var c := String(gi3.get_meta("veg_class", "tree"))
		var on := (c == "tree" and not gi3.has_meta("far")) or (c == "bush" and q >= 1) or q >= 3
		gi3.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if on else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for n in get_tree().get_nodes_in_group("env_vegetation"):
		var mmi := n as MultiMeshInstance3D
		if mmi == null or mmi.multimesh == null:
			continue
		var full := mmi.multimesh.instance_count
		var keep: float = density
		if mmi.has_meta("veg_class") and String(mmi.get_meta("veg_class")) in ["tree", "bush"]:
			keep = 1.0          # the tree line hides the HDRI horizon: never thinned
		mmi.multimesh.visible_instance_count = -1 if keep >= 0.999 else int(ceil(full * keep))
		var cls := String(mmi.get_meta("veg_class", "grass"))
		var shadows := true
		match cls:
			"tree": shadows = true
			"bush": shadows = q >= 1
			"weed", "rock": shadows = q >= 1
			"tall_grass": shadows = q >= 2
			_: shadows = q >= 3
		mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if shadows else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

	# --- viewport-level settings (owned by the game; only touched if allowed) ----------------
	if apply_viewport_settings and is_inside_tree():
		var vp := get_viewport()
		vp.msaa_3d = [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X, Viewport.MSAA_4X][q]
		vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA if q == 0 else Viewport.SCREEN_SPACE_AA_DISABLED
		vp.use_taa = q >= 3
		vp.use_debanding = true
		vp.anisotropic_filtering_level = [Viewport.ANISOTROPY_4X, Viewport.ANISOTROPY_8X, Viewport.ANISOTROPY_16X, Viewport.ANISOTROPY_16X][q]
		vp.mesh_lod_threshold = [3.0, 1.5, 1.0, 0.5][q]
		vp.positional_shadow_atlas_size = 2048
	_debug_overrides()


## Measurement hook (not used by the game): `-- --envdbg=novoxel,msaa2,nossil,...` toggles single features after a
## preset has been applied, so their cost can be measured through the real game. See evidence/env/NOTES.md.
func _debug_overrides() -> void:
	var flags := PackedStringArray()
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--envdbg="):
			flags = a.trim_prefix("--envdbg=").split(",")
	if flags.is_empty():
		return
	var env: Environment = get_world_environment().environment
	var vp := get_viewport()
	for f in flags:
		match f:
			"novoxel":
				var v := get_node_or_null("Lighting/BayVoxelGI")
				if v: v.visible = false
			"msaa0": vp.msaa_3d = Viewport.MSAA_DISABLED
			"msaa2": vp.msaa_3d = Viewport.MSAA_2X
			"msaa4": vp.msaa_3d = Viewport.MSAA_4X
			"taa": vp.use_taa = true
			"notaa": vp.use_taa = false
			"fxaa": vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
			"nossil": env.ssil_enabled = false
			"nossao": env.ssao_enabled = false
			"noglow": env.glow_enabled = false
			"novolfog": env.volumetric_fog_enabled = false
			"noveg": $Vegetation.visible = false
			"noprops": $Props.visible = false
			"notrees":
				for n in get_tree().get_nodes_in_group("env_vegetation_single"):
					(n as Node3D).visible = false
			"nograss":
				for n in get_tree().get_nodes_in_group("env_vegetation"):
					(n as Node3D).visible = false
			"novegshadow":
				for n in get_tree().get_nodes_in_group("env_vegetation") + get_tree().get_nodes_in_group("env_vegetation_single"):
					(n as GeometryInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			"shadow4096": RenderingServer.directional_shadow_atlas_set_size(4096, true)
			"shadow2048": RenderingServer.directional_shadow_atlas_set_size(2048, true)
			"softlow": RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_LOW)
			"noshadow": get_sun().shadow_enabled = false
			"noprobe": ($Lighting/BayProbe as Node3D).visible = false
			"aniso4": vp.anisotropic_filtering_level = Viewport.ANISOTROPY_4X
