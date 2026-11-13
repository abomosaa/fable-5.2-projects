class_name WeaponView
extends Node3D
## First-person presentation of the pistol: everything here is a *view* of WeaponSim.
## One timeline drives hands, mechanical parts, flash, sound, projectile and casing: the sim's events.
##
## The weapon is rendered in the world pass with the world camera (no view-model FOV, no separate layer), so
## lighting, shadows and perspective are those of the scene. Near surfaces are handled by retracting the gun.

signal shot_fired(info: Dictionary)
signal sim_event(e: Dictionary)

const PISTOL_SCENE := "res://assets/weapon/service_pistol.gltf"
const ARMS_SCENE := "res://assets/arms/fp_arms.gltf"
const ARMS_EVENTS := "res://assets/arms/anim_events.json"

# rig placement in camera space (see docs/WEAPON_CONTRACT.md for the eye positions the hands were posed for)
const HIP_POS := Vector3(0.075, -0.145, -0.43)       # high ready: gun just below the line of sight
const EYE_RELIEF := 0.41                 # eye to rear sight when aiming
const AIM_IN_TIME := 0.24
const AIM_OUT_TIME := 0.20
const BLOCKED_POS := Vector3(0.05, -0.215, -0.215)
const BLOCKED_PITCH := deg_to_rad(68.0)
const LOW_READY_PITCH := deg_to_rad(-30.0)
const WRIST_PIVOT := Vector3(0.0, -0.01, 0.085)     # rig space: about where the wrists are behind the grip
const HANDS_LAYER := 2                   # render layer bit shared by arms and pistol (for the shade fill light)
const HANDS_FILL_ENERGY := 0.24         # [A] tuned from screenshots, see _update_hands_fill

var sim := WeaponSim.new()
var recoil := RecoilModel.new()
var player: Player
var projectiles: ProjectileManager
var fx: Node
var input_enabled := true

var rig: Node3D
var _gun_mount: Node3D
var _mag_mount: Node3D
var _pistol: Node3D
var _parts := {}                 # name -> Node3D
var _rest := {}                  # name -> Transform3D
var _rounds: Array[Node3D] = []
var _skel: Skeleton3D
var _anim: AnimationPlayer
var _skel_to_rig := Transform3D.IDENTITY
var _bone_gun := -1
var _bone_mag := -1
var _finger_bones: Array[int] = []
var _finger_poses := {}          # clip -> Array[Quaternion]
var _cur_clip := ""
var _finger_w := 0.0

var _ads_xform := Transform3D.IDENTITY
var _hip_xform := Transform3D.IDENTITY
var _depart_dir := Vector3.FORWARD      # bullet departure direction in pistol space
var _muzzle_local := Vector3.ZERO
var ads_t := 0.0                 # 0 hip .. 1 sights
var _aim_latched := false
var _blocked := 0.0
var _low_ready := 0.0
var _sway_t := 0.0
var _steady_time := 0.0
var _lag := Vector2.ZERO
var _lag_v := Vector2.ZERO
var _bob_s := Vector3.ZERO
var _rng := RandomNumberGenerator.new()
var _base_fov := 74.0
var _pending_frame_log := false
var last_shot := {}
var _post_shot := 0.0
var has_arms := false
var _need_fresh_press := false

func _ready() -> void:
	process_priority = 10           # after the player has moved the camera this frame
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	_rng.randomize()
	rig = Node3D.new()
	rig.name = "Rig"
	add_child(rig)
	_gun_mount = Node3D.new()
	_gun_mount.name = "GunMount"
	rig.add_child(_gun_mount)
	_mag_mount = Node3D.new()
	_mag_mount.name = "MagMount"
	rig.add_child(_mag_mount)
	_load_pistol()
	_load_arms()
	_compute_poses()
	_base_fov = Settings.getf("fov")
	Settings.changed.connect(func(k): if k == "fov": _base_fov = Settings.getf("fov"))
	_apply_parts()
	_update_rig(0.0)

# ------------------------------------------------------------------ assets
func _load_pistol() -> void:
	var ps: PackedScene = load(PISTOL_SCENE)
	_pistol = ps.instantiate()
	_gun_mount.add_child(_pistol)
	for n in ["Frame", "Slide", "Barrel", "Hammer", "Trigger", "Safety", "SlideStop", "MagRelease", "Mag", "ChamberRound",
			"S_Muzzle", "S_SightFront", "S_SightRear", "S_Eject", "MagBody"]:
		var node := _pistol.find_child(n, true, false) as Node3D
		if node == null:
			push_error("WeaponView: pistol part missing: " + n)
			continue
		_parts[n] = node
		_rest[n] = node.transform
	for i in range(1, WeaponDef.MAG_CAPACITY + 1):
		_rounds.append(_pistol.find_child("Round%d" % i, true, false) as Node3D)
	# the magazine follows the `mag` bone of the arms rig, not the frame
	var mag: Node3D = _parts["Mag"]
	mag.get_parent().remove_child(mag)
	_mag_mount.add_child(mag)
	mag.transform = Transform3D.IDENTITY
	for mi in _pistol.find_children("*", "MeshInstance3D", true, false) + _mag_mount.find_children("*", "MeshInstance3D", true, false):
		(mi as MeshInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		(mi as MeshInstance3D).gi_mode = GeometryInstance3D.GI_MODE_DYNAMIC
		(mi as MeshInstance3D).extra_cull_margin = 0.5

func _load_arms() -> void:
	if not ResourceLoader.exists(ARMS_SCENE):
		push_warning("WeaponView: arms asset missing (%s) - showing the pistol without hands" % ARMS_SCENE)
		return
	var arms: Node3D = (load(ARMS_SCENE) as PackedScene).instantiate()
	arms.name = "Arms"
	rig.add_child(arms)
	var sk := arms.find_children("*", "Skeleton3D", true, false)
	var ap := arms.find_children("*", "AnimationPlayer", true, false)
	if sk.is_empty() or ap.is_empty():
		push_warning("WeaponView: arms asset has no skeleton/animations")
		return
	_skel = sk[0]
	_anim = ap[0]
	_anim.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	_skel_to_rig = rig.global_transform.affine_inverse() * _skel.global_transform
	_bone_gun = _skel.find_bone("gun")
	_bone_mag = _skel.find_bone("mag")
	for b in ["index.01.R", "index.02.R", "index.03.R"]:
		_finger_bones.append(_skel.find_bone(b))
	for clip in ["pose_grip", "pose_trigger_touch", "pose_trigger_sa", "pose_trigger_break"]:
		if _anim.has_animation(clip):
			_finger_poses[clip] = _read_pose(_anim.get_animation(clip), _finger_bones)
	for mi in arms.find_children("*", "MeshInstance3D", true, false):
		# cloth and leather: far less specular than the engine's dielectric default, or they turn chalky in direct sun
		var m := mi as MeshInstance3D
		for si in m.mesh.get_surface_count():
			var mat := m.get_active_material(si)
			if mat is StandardMaterial3D:
				var dup: StandardMaterial3D = mat.duplicate()
				dup.metallic_specular = 0.06     # f90 in the engine is 50 x f0: this keeps grazing-angle sky reflection off cloth
				if String(m.name).to_lower().contains("glove") or String(mat.resource_name).to_lower().contains("glove"):
					dup.albedo_color = Color(1.45, 1.45, 1.45)     # charcoal, not black: stays readable in open shade
				else:
					dup.albedo_color = Color(1.1, 1.1, 1.1)        # sleeves: a touch lighter so folds read in shade
				m.set_surface_override_material(si, dup)
		(mi as MeshInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		(mi as MeshInstance3D).gi_mode = GeometryInstance3D.GI_MODE_DYNAMIC
		(mi as MeshInstance3D).extra_cull_margin = 2.0
		(mi as MeshInstance3D).layers |= HANDS_LAYER
	has_arms = _anim.has_animation("pose_grip")
	if FileAccess.file_exists(ARMS_EVENTS):
		var js: Variant = JSON.parse_string(FileAccess.get_file_as_string(ARMS_EVENTS))
		if js is Dictionary:
			var clips := {}
			for k in js:
				if WeaponDef.DEFAULT_CLIPS.has(k) and js[k] is Dictionary and js[k].has("duration") and js[k].has("events"):
					var ok := true
					for ev in WeaponDef.DEFAULT_CLIPS[k]["events"]:
						if not js[k]["events"].has(ev):
							ok = false
					if ok:
						clips[k] = js[k]
					else:
						push_warning("WeaponView: clip %s lacks required events; using default timing" % k)
			sim.set_clips(clips)
	if has_arms:
		_anim.play("pose_grip")
		_anim.advance(0.0)
		_cur_clip = "pose_grip"

func _read_pose(anim: Animation, bones: Array[int]) -> Array:
	var out := []
	for bi in bones:
		var q := _skel.get_bone_rest(bi).basis.get_rotation_quaternion() if bi >= 0 else Quaternion.IDENTITY
		if bi >= 0:
			var bname := _skel.get_bone_name(bi)
			for t in anim.get_track_count():
				if anim.track_get_type(t) == Animation.TYPE_ROTATION_3D and str(anim.track_get_path(t)).ends_with(":" + bname):
					q = anim.rotation_track_interpolate(t, 0.0)
					break
		out.append(q)
	return out

func _compute_poses() -> void:
	# sockets at rest, in pistol (= rig) space
	var rear: Vector3 = _socket_local("S_SightRear")
	var front: Vector3 = _socket_local("S_SightFront")
	_muzzle_local = _socket_local("S_Muzzle")
	var sight_dir := (front - rear).normalized()
	# rotate the rig so the sight line lies on the camera axis, rear sight EYE_RELIEF in front of the eye
	var q := Quaternion(sight_dir, Vector3.FORWARD)
	var b := Basis(q)
	_ads_xform = Transform3D(b, Vector3(0, 0, -EYE_RELIEF) - b * rear)
	# hip / ready: bore converging on the view axis ~12 m out
	var bore_h := _muzzle_local.y
	var hb := Basis.from_euler(Vector3(atan2(-(HIP_POS.y + bore_h), 12.0), atan2(HIP_POS.x, 12.0), 0.0))
	_hip_xform = Transform3D(hb, HIP_POS)
	# departure line: the sight line raised by the zero angle (see docs/APPROXIMATIONS.md)
	var sight_over_bore_at_muzzle := lerpf(rear.y, front.y, inverse_lerp(rear.z, front.z, _muzzle_local.z)) - bore_h
	var elev := Ballistics.zero_elevation(WeaponDef.ZERO_RANGE, WeaponDef.MUZZLE_VELOCITY, WeaponDef.BC_G1, sight_over_bore_at_muzzle)
	_depart_dir = (Basis(Vector3.RIGHT, elev) * sight_dir).normalized()

func _socket_local(n: String) -> Vector3:
	var node: Node3D = _parts[n]
	return _pistol.global_transform.affine_inverse() * node.global_position

# ------------------------------------------------------------------ frame
func _process(delta: float) -> void:
	if player == null:
		return
	_read_input()
	var events := sim.advance(delta)
	for e in events:
		var t_ev := Time.get_ticks_usec()
		_handle_event(e)
		var dt_ev := Time.get_ticks_usec() - t_ev
		if dt_ev > 3000:      # a weapon event whose handling took more than 3 ms is worth knowing about
			sim_event.emit({"name": "slow_handler", "of": e["name"], "ms": dt_ev / 1000.0, "t": e.get("t", 0.0)})
	recoil.step(delta)
	_update_hands_fill(delta)
	_update_aim(delta)
	_update_animation(delta)
	_update_rig(delta)
	_apply_parts()
	player.extra_pitch = recoil.view_pitch * Settings.getf("camera_motion")
	player.extra_yaw = recoil.view_yaw * Settings.getf("camera_motion")
	player.aiming = ads_t > 0.5
	player.camera.fov = lerpf(_base_fov, _base_fov * Settings.getf("ads_fov_scale"), smoothstep(0.0, 1.0, ads_t))
	AudioDirector.update_shooter(muzzle_position(), bore_direction(), player.is_crouched())

func _read_input() -> void:
	if not input_enabled:
		sim.release_inputs()
		return
	# after a pause / focus loss the trigger must be released and pressed again: a button that is still
	# held when play resumes never fires
	var fire := Input.is_action_pressed("fire")
	if _need_fresh_press:
		if fire:
			fire = false
		else:
			_need_fresh_press = false
	sim.set_trigger(fire)
	if Input.is_action_just_pressed("reload"):
		sim.request_reload()
	if Input.is_action_just_pressed("inspect"):
		sim.request_inspect()
	if Input.is_action_just_pressed("safety"):
		sim.request_safety_toggle()
	if Input.is_action_just_pressed("cock_hammer"):
		sim.request_cock_hammer()
	if Settings.getb("aim_toggle"):
		if Input.is_action_just_pressed("aim"):
			_aim_latched = not _aim_latched
	else:
		_aim_latched = Input.is_action_pressed("aim")

func release_inputs() -> void:
	sim.release_inputs()
	_aim_latched = false
	_need_fresh_press = true

func _update_aim(delta: float) -> void:
	var busy := sim.action == WeaponSim.Act.RELOAD or sim.action == WeaponSim.Act.INSPECT or sim.action == WeaponSim.Act.HAMMER_COCK
	var jogging := player.move_speed > 2.3
	var want := _aim_latched and input_enabled and not busy and not jogging
	if sim.action == WeaponSim.Act.INSPECT and _aim_latched:
		sim.request_inspect()        # raising the sights ends an inspection
	ads_t = move_toward(ads_t, 1.0 if want else 0.0, delta / (AIM_IN_TIME if want else AIM_OUT_TIME))
	_low_ready = move_toward(_low_ready, 1.0 if (jogging and not busy) else 0.0, delta / 0.3)
	if input_enabled and Input.is_action_pressed("steady") and ads_t > 0.6:
		_steady_time += delta
	else:
		_steady_time = maxf(_steady_time - delta * 2.0, 0.0)
	_post_shot = maxf(_post_shot - delta, 0.0)

# ------------------------------------------------------------------ animation
func _update_animation(delta: float) -> void:
	if not has_arms:
		return
	var clip := "pose_grip"
	if sim.action != WeaponSim.Act.NONE and _anim.has_animation(sim.action_clip):
		clip = sim.action_clip
	if clip != _cur_clip:
		# entering an action starts from the base grip, which is where every clip begins; leaving one early
		# (cancel / interrupted inspect) blends back to the grip instead of popping
		var leaving_mid := _cur_clip != "pose_grip" and clip == "pose_grip"
		# (a clip driven by seek() cannot cross-fade in: blend weights only advance with playback time)
		_anim.play(clip, 0.22 if leaving_mid else 0.0)
		_cur_clip = clip
	if clip == "pose_grip":
		_anim.advance(delta)
	else:
		var t := clampf(sim.action_time(), 0.0, _anim.get_animation(clip).length - 0.001)
		_anim.seek(t, true)
		_anim.advance(0.0)
	# trigger finger: blend between the authored finger poses by the trigger's actual angle
	var want_finger := sim.action == WeaponSim.Act.NONE and (sim.trigger_held or ads_t > 0.35 or _post_shot > 0.0 or sim.trigger_deg() < WeaponDef.TRIGGER_SA_REST_DEG - 1.0)
	_finger_w = move_toward(_finger_w, 1.0 if want_finger else 0.0, delta / 0.09)
	if _finger_w > 0.001 and _finger_poses.has("pose_trigger_touch"):
		var td := sim.trigger_deg()
		var a: Array = _finger_poses["pose_trigger_touch"]
		var b: Array = _finger_poses.get("pose_trigger_sa", a)
		var c: Array = _finger_poses.get("pose_trigger_break", b)
		for i in _finger_bones.size():
			var bi := _finger_bones[i]
			if bi < 0:
				continue
			var q: Quaternion
			if td > WeaponDef.TRIGGER_SA_REST_DEG:
				q = (a[i] as Quaternion).slerp(b[i], clampf(td / WeaponDef.TRIGGER_SA_REST_DEG, 0.0, 1.0))
			else:
				q = (b[i] as Quaternion).slerp(c[i], clampf((td - WeaponDef.TRIGGER_SA_REST_DEG) / (WeaponDef.TRIGGER_BREAK_DEG - WeaponDef.TRIGGER_SA_REST_DEG), 0.0, 1.15))
			_skel.set_bone_pose_rotation(bi, _skel.get_bone_pose_rotation(bi).slerp(q, _finger_w))
	# props follow their bones (relative to the rest pose, which is "pistol at the rig origin")
	if _bone_gun >= 0:
		_gun_mount.transform = _skel_to_rig * (_skel.get_bone_global_pose(_bone_gun) * _skel.get_bone_global_rest(_bone_gun).affine_inverse()) * _skel_to_rig.affine_inverse()
	if _bone_mag >= 0:
		_mag_mount.transform = _skel_to_rig * (_skel.get_bone_global_pose(_bone_mag) * _skel.get_bone_global_rest(_bone_mag).affine_inverse()) * _skel_to_rig.affine_inverse()

# ------------------------------------------------------------------ rig placement
func _update_rig(delta: float) -> void:
	var sway_scale := Settings.getf("weapon_sway")
	var e := smoothstep(0.0, 1.0, ads_t)
	var base := _hip_xform.interpolate_with(_ads_xform, e)
	# slight arc while coming up to the eye
	base.origin += Vector3(0.0, 0.012, 0.0) * sin(e * PI)
	# --- obstruction: keep the muzzle out of nearby surfaces by drawing the gun back and up
	if delta > 0.0 and player != null and is_inside_tree():
		var target_block := _measure_block(base)
		_blocked = lerpf(_blocked, target_block, 1.0 - exp(-delta * (16.0 if target_block > _blocked else 7.0)))
	if _blocked > 0.001:
		var bl := Transform3D(Basis.from_euler(Vector3(BLOCKED_PITCH, 0.0, deg_to_rad(-8.0))), BLOCKED_POS)
		base = base.interpolate_with(bl, smoothstep(0.0, 1.0, _blocked))
	if _low_ready > 0.001:
		var lr := Transform3D(Basis.from_euler(Vector3(LOW_READY_PITCH, deg_to_rad(4.0), 0.0)), HIP_POS + Vector3(-0.03, -0.07, 0.05))
		base = base.interpolate_with(lr, smoothstep(0.0, 1.0, _low_ready) * (1.0 - _blocked))
	# --- wobble of the hold (about the eye: the sights stay aligned with each other, their aim wanders)
	_sway_t += delta
	var amp := lerpf(0.0052, 0.0021, e)                       # rad: hip vs sights
	if player.is_crouched():
		amp *= 0.8
	amp *= 1.0 + 2.2 * clampf(player.move_speed / Player.SPEED_WALK, 0.0, 2.0)
	if _steady_time > 0.0:
		amp *= 0.45 if _steady_time < 6.0 else lerpf(0.45, 1.5, clampf((_steady_time - 6.0) / 3.0, 0.0, 1.0))
	amp *= 1.0 + 0.6 * clampf(_post_shot / 0.35, 0.0, 1.0)
	amp *= sway_scale
	var t := _sway_t
	var sx := (sin(t * 1.45) * 0.55 + sin(t * 3.83 + 1.3) * 0.3 + sin(t * 8.2 + 0.7) * 0.15) * amp
	var sy := (sin(t * 1.12 + 2.1) * 0.55 + sin(t * 3.11 + 0.4) * 0.3 + sin(t * 7.4 + 2.2) * 0.15) * amp
	# --- inertia: the gun trails fast view rotation and catches up
	if delta > 0.0:
		var lag_target := -player.look_rate * 0.030
		var lim := lerpf(deg_to_rad(2.4), deg_to_rad(0.7), e)
		lag_target = lag_target.clamp(Vector2(-lim, -lim), Vector2(lim, lim)) * sway_scale
		# integrate in small steps: a long frame (loading hitch, focus change) must not blow the spring up
		var w := 26.0
		var steps := clampi(int(ceil(minf(delta, 0.25) * 240.0)), 1, 60)
		var h := minf(delta, 0.25) / steps
		for i in steps:
			_lag_v += (w * w * (lag_target - _lag) - 2.0 * 0.85 * w * _lag_v) * h
			_lag += _lag_v * h
		if not (is_finite(_lag.x) and is_finite(_lag.y) and is_finite(_lag_v.x) and is_finite(_lag_v.y)):
			_lag = Vector2.ZERO
			_lag_v = Vector2.ZERO
		_bob_s = _bob_s.lerp(player.bob, 1.0 - exp(-delta * 14.0))
	# after a shot the arms do not bring the gun back to the same point: the whole hold (sights still lined up with
	# each other) returns a little off and is steered back. This is a rotation about the eye, which moves the sights
	# across the target; only a small part of the error is in the wrists (front post inside the notch, below).
	var eye_rot := Basis.from_euler(Vector3(sy + _lag.y + recoil.settle.x, sx + _lag.x + recoil.settle.y, 0.0))
	var xf := Transform3D(eye_rot, Vector3.ZERO) * base
	# stride: the gun does not ride rigidly on the head
	# Each footfall jolts the arms: the gun dips and rocks a little once per step and sways with the weight shift.
	var walk := clampf(player.move_speed / Player.SPEED_WALK, 0.0, 2.2) * sway_scale * (1.0 - 0.55 * e)
	var step := absf(sin(player.stride_phase))
	xf.origin += (player.bob - _bob_s) * -0.6 + Vector3(sin(player.stride_phase) * 0.004, -step * 0.009, 0.0) * walk
	xf = xf * Transform3D(Basis.from_euler(Vector3(-step * 0.010, sin(player.stride_phase) * 0.006, sin(player.stride_phase) * 0.012) * walk), Vector3.ZERO)
	# small independent wrist error: front post drifts a little inside the notch
	var wrist := Basis.from_euler(Vector3(sin(t * 2.3 + 0.5) * amp * 0.22, sin(t * 1.9 + 1.7) * amp * 0.22, 0.0))
	# --- recoil about the wrists, plus the push back into the hands
	var rec := Basis.from_euler(Vector3(recoil.pitch.x + recoil.misalign.x, recoil.yaw.x + recoil.misalign.y, recoil.roll.x))
	var local := Transform3D(Basis(), WRIST_PIVOT) * Transform3D(wrist * rec, Vector3.ZERO) * Transform3D(Basis(), -WRIST_PIVOT)
	local.origin += Vector3(0.0, recoil.up.x, recoil.back.x)
	var result := xf * local
	if result.is_finite():
		rig.transform = result
	else:
		# never present a broken pose: fall back to the base pose and clear the transient state
		recoil.reset()
		_lag = Vector2.ZERO
		_lag_v = Vector2.ZERO
		rig.transform = base

## 0..1 : how far the gun must be drawn back for the muzzle (and hands) to stay out of the surface ahead
func _measure_block(base: Transform3D) -> float:
	var cam := player.camera
	var space := cam.get_world_3d().direct_space_state
	var from := cam.global_position
	var muzzle_cam := base * (_muzzle_local + Vector3(0, 0, -0.06))
	var worst := 0.0
	for off: Vector3 in [Vector3.ZERO, Vector3(0.0, -0.07, 0.0), Vector3(-0.05, -0.04, 0.0)]:
		var to := cam.global_transform * (muzzle_cam + off)
		var q := PhysicsRayQueryParameters3D.create(from, to, 0b101)
		q.exclude = [player.get_rid()]
		var r := space.intersect_ray(q)
		if not r.is_empty():
			var full := from.distance_to(to)
			var d := from.distance_to(r["position"])
			worst = maxf(worst, clampf((full - d) / maxf(full - 0.34, 0.05), 0.0, 1.0))
	return worst

# ------------------------------------------------------------------ mechanical parts
func _apply_parts() -> void:
	var sp := sim.slide_pos()
	(_parts["Slide"] as Node3D).transform = (_rest["Slide"] as Transform3D).translated(Vector3(0, 0, sp))
	(_parts["Barrel"] as Node3D).transform = (_rest["Barrel"] as Transform3D).translated(Vector3(0, 0, sim.barrel_pos()))
	_rot_x("Hammer", sim.hammer_deg())
	_rot_x("Trigger", sim.trigger_deg())
	_rot_x("Safety", sim.safety_deg())
	(_parts["SlideStop"] as Node3D).transform = (_rest["SlideStop"] as Transform3D).translated(Vector3(0, 0.0015 * sim.slide_stop_up(), 0))
	(_parts["MagRelease"] as Node3D).transform = (_rest["MagRelease"] as Transform3D).translated(Vector3(0.0015 * sim.mag_release_in(), 0, 0))
	# a chambered round is only visible through the open top while the slide is back
	(_parts["ChamberRound"] as Node3D).visible = sim.chamber_live and sp > 0.008
	var vis := sim.visible_mag()
	(_parts["Mag"] as Node3D).visible = vis >= 0
	var n := sim.visible_mag_rounds()
	for i in _rounds.size():
		if _rounds[i] != null:
			_rounds[i].visible = i < n

func _rot_x(part: String, deg: float) -> void:
	var r: Transform3D = _rest[part]
	(_parts[part] as Node3D).transform = Transform3D(r.basis * Basis(Vector3.RIGHT, deg_to_rad(deg)), r.origin)

# ------------------------------------------------------------------ queries
func muzzle_position() -> Vector3:
	return (_parts["S_Muzzle"] as Node3D).global_position

func bore_direction() -> Vector3:
	return (_pistol.global_transform.basis * _depart_dir).normalized()

func eject_transform() -> Transform3D:
	return (_parts["S_Eject"] as Node3D).global_transform

func sight_line() -> Array:
	return [(_parts["S_SightRear"] as Node3D).global_position, (_parts["S_SightFront"] as Node3D).global_position]

func blocked_amount() -> float:
	return _blocked

func restart() -> void:
	sim.reset()
	recoil.reset()
	_aim_latched = false
	ads_t = 0.0
	if has_arms:
		_anim.play("pose_grip")
		_cur_clip = "pose_grip"

# ------------------------------------------------------------------ events
func _handle_event(e: Dictionary) -> void:
	match e["name"]:
		"shot":
			_fire_shot(e)
		"eject":
			_eject_case()
		"hammer_fall":
			recoil.apply_trigger_disturbance(_rng, bool(e.get("da", false)))
		"dry_fire":
			AudioDirector.play_mech("mech_hammer_fall", 0.0, 0.0, 0.02, [0, 2])
		"trigger_reset":
			if e.get("audible", false):
				AudioDirector.play_mech("mech_trigger_reset", -9.0, 0.0, 0.02, [1, 2])
		"safety_lever_move":
			AudioDirector.play_cloth(0.4)
		"safety_on":
			AudioDirector.play_mech("mech_safety_on", -3.0)
		"safety_off":
			AudioDirector.play_mech("mech_safety_off", -3.0)
		"decock":
			# the lever trips the hammer onto the blocked firing pin: a hammer fall without a primer strike
			AudioDirector.play_mech("mech_hammer_fall", -2.0, 0.0, 0.02, [0, 2])
		"hammer_cock_start":
			var ev: Dictionary = sim.clips["hammer_cock"]["events"]
			AudioDirector.play_mech("mech_hammer_cock", -2.0, 0.0, 0.02, [0, 1, 2, 3, 5, 6], float(ev["hammer_end"]) - float(ev["hammer_start"]))
		"reload_start", "inspect_start":
			AudioDirector.play_cloth(0.9)
		"support_hand_off":
			AudioDirector.play_mech("mech_grip", -8.0)
		"mag_release":
			# catch pressed and magazine starting to slide (complete detach takes; the P38-only takes have a long pause)
			AudioDirector.play_mech("mech_mag_release", -2.0, 0.0, 0.02, [2, 3, 4, 5])
		"mag_out":
			AudioDirector.play_mech("mech_mag_out", -7.0, 0.0, 0.02, [0, 1])       # real P38 magazine leaving the grip
		"mag_swap":
			AudioDirector.play_mech("mech_mag_handle", -8.0)
			AudioDirector.play_cloth(0.8)
		"mag_sliding_in":
			var evr: Dictionary = sim.clips[sim.action_clip]["events"] if sim.action_clip != "" else {}
			var lead := float(evr.get("mag_seated", 0.4)) - float(evr.get("mag_in_start", 0.0))
			AudioDirector.play_mech("mech_mag_in", 0.0, 0.0, 0.02, [], lead)      # seat click lands on the seating frame
		"slide_release":
			AudioDirector.play_mech("mech_slide_release", 0.0)
		"slide_stop_blocked":
			AudioDirector.play_mech("mech_safety_on", -8.0)
		"regrip":
			AudioDirector.play_mech("mech_grip", -6.0)
			AudioDirector.play_cloth(0.6)
		"reload_cancel":
			AudioDirector.play_mech("mech_grip", -8.0)
	sim_event.emit(e)

func _fire_shot(e: Dictionary) -> void:
	var muzzle := muzzle_position()
	var dir := bore_direction()
	# ammunition + mechanical dispersion (small, Gaussian); no artificial spread
	var sd := WeaponDef.DISPERSION_SD_MRAD * 0.001
	var right := dir.cross(Vector3.UP).normalized()
	var up := right.cross(dir).normalized()
	dir = (dir + right * _rng.randfn(0.0, sd) + up * _rng.randfn(0.0, sd)).normalized()
	var speed := WeaponDef.MUZZLE_VELOCITY + _rng.randfn(0.0, WeaponDef.MUZZLE_VELOCITY_SD)
	# a muzzle that is behind something (should not happen thanks to the retraction) still cannot shoot through it
	var origin := muzzle
	var cam_pos := player.camera.global_position
	var q := PhysicsRayQueryParameters3D.create(cam_pos, muzzle, 0b101)
	q.exclude = [player.get_rid()]
	var blocked := player.camera.get_world_3d().direct_space_state.intersect_ray(q)
	if not blocked.is_empty():
		origin = (blocked["position"] as Vector3) + (cam_pos - muzzle).normalized() * 0.02
	if projectiles != null:
		projectiles.fire(origin, dir, speed, int(e["index"]))
	var lum := _ambient_luminance(muzzle)
	if fx != null and is_instance_valid(fx):
		fx.call("muzzle_event", Transform3D(Basis.looking_at(dir, Vector3.UP), muzzle), lum, int(e["index"]))
	var grip_q := lerpf(0.55, 1.0, ads_t) * (1.0 - 0.3 * clampf(player.move_speed / Player.SPEED_WALK, 0.0, 1.0))
	recoil.apply_shot(_rng, grip_q)
	_post_shot = 0.4
	var info := AudioDirector.play_shot(muzzle, dir)
	last_shot = {"index": e["index"], "t": e["t"], "muzzle": muzzle, "dir": dir, "speed": speed, "da": e.get("da", false),
		"ads": ads_t, "audio": info, "ticks_usec": Time.get_ticks_usec(), "frame": Engine.get_process_frames()}
	shot_fired.emit(last_shot)

func _eject_case() -> void:
	if fx == null or not is_instance_valid(fx):
		return
	var xf := eject_transform()
	var b := _pistol.global_transform.basis.orthonormalized()
	# open-top slide, extractor on the left: brass leaves up and to the left, slightly rearward [O/A]
	var v := b * Vector3(_rng.randf_range(-3.1, -2.0), _rng.randf_range(1.5, 2.6), _rng.randf_range(0.1, 1.0)) + player.velocity
	var w := b * Vector3(_rng.randf_range(-25.0, 25.0), _rng.randf_range(30.0, 85.0), _rng.randf_range(-40.0, 40.0))
	fx.call("eject_casing", Transform3D(b, xf.origin), v, w)

## Standing under the roof and looking out at the sunlit range, the exposure follows the bright range and the hands
## and pistol in the foreground fall to near-black - a camera's dynamic range, not an eye's, which adapts locally.
## A weak shadowless light that only touches the arms and pistol lifts them in that one situation: under cover, and
## the more the view points out into the sun. [A] perceptual compensation, not a light that exists on the range.
var _hands_fill: OmniLight3D
var _hands_fill_t := 0.0
var _hands_fill_cover := 0.0
func _update_hands_fill(delta: float) -> void:
	if _hands_fill == null:
		_hands_fill = OmniLight3D.new()
		_hands_fill.name = "HandsFill"
		_hands_fill.light_cull_mask = HANDS_LAYER
		_hands_fill.shadow_enabled = false
		_hands_fill.omni_range = 1.8
		_hands_fill.omni_attenuation = 0.5
		_hands_fill.light_specular = 0.1
		_hands_fill.light_color = Color(1.0, 0.97, 0.92)
		_hands_fill.light_energy = 0.0
		_hands_fill.position = Vector3(-0.05, 0.30, 0.12)
		player.camera.add_child(_hands_fill)
		if _pistol != null:
			for mi in _pistol.find_children("*", "MeshInstance3D", true, false):
				(mi as MeshInstance3D).layers |= HANDS_LAYER
	_hands_fill_t -= delta
	if _hands_fill_t <= 0.0:
		_hands_fill_t = 0.2
		var cam := player.camera
		var space := cam.get_world_3d().direct_space_state
		var q := PhysicsRayQueryParameters3D.create(cam.global_position, cam.global_position + Vector3(0, 7.0, 0), 1)
		_hands_fill_cover = 0.0 if space.intersect_ray(q).is_empty() else 1.0
	var fwd := -player.camera.global_transform.basis.z
	var out := clampf(maxf(-fwd.z, 0.7 * fwd.x), 0.0, 1.0)      # downrange is -Z, the open pad is +X
	var target := HANDS_FILL_ENERGY * _hands_fill_cover * smoothstep(0.1, 0.8, out)
	_hands_fill.light_energy = lerpf(_hands_fill.light_energy, target, 1.0 - exp(-delta * 2.5))
	_hands_fill.visible = _hands_fill.light_energy > 0.003

## 1 = open sun, lower in shade. The flash of 9 mm FMJ is all but invisible in sunlight.
func _ambient_luminance(pos: Vector3) -> float:
	if Settings.getb("reduce_flashes"):
		return 4.0
	var space := player.camera.get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(pos, pos + Vector3(0, 7.0, 0), 1)
	return 0.35 if not space.intersect_ray(q).is_empty() else 1.0
