class_name Player
extends CharacterBody3D
## Grounded first-person body: walk / jog / crouch with real accelerations, mouse look applied on the frame the
## input arrives, subtle stride motion (scaled by the "camera motion" setting, zero is allowed).

signal footstep(surface: String, intensity: float)

const RADIUS := 0.30
const HEIGHT_STAND := 1.80
const HEIGHT_CROUCH := 1.18
const EYE_STAND := RangeLayout.EYE_HEIGHT
const EYE_CROUCH := 1.04
const SPEED_WALK := 1.55          # m/s
const SPEED_JOG := 3.3
const SPEED_CROUCH := 0.85
const SPEED_AIM := 1.0
const ACCEL := 8.5
const DECEL := 11.0
const STRIDE := 0.74              # m per step at a walk

var head: Node3D
var camera: Camera3D
var _shape: CapsuleShape3D
var _col: CollisionShape3D
var yaw := 0.0
var pitch := 0.0
var crouched := false
var crouch_t := 0.0               # 0 standing .. 1 crouched
var aiming := false               # set by the weapon (slows movement)
var input_enabled := true
var synthetic_look := false        # automated verification: accept injected mouse motion without pointer capture
var stride_phase := 0.0           # radians; one step per PI
var move_speed := 0.0             # horizontal speed, m/s
var bob := Vector3.ZERO           # current head-bob offset (also read by the weapon)
var extra_pitch := 0.0            # recoil share from the weapon, rad
var extra_yaw := 0.0
var _step_side := 1.0
var _land_dip := 0.0
var look_rate := Vector2.ZERO     # rad/s, smoothed, for weapon inertia
var _look_accum := Vector2.ZERO

func _ready() -> void:
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	collision_layer = 1 << (RangeLayout.LAYER_PLAYER - 1)
	collision_mask = (1 << (RangeLayout.LAYER_WORLD - 1)) | (1 << (RangeLayout.LAYER_TARGET - 1))
	floor_snap_length = 0.25
	floor_max_angle = deg_to_rad(40.0)
	_shape = CapsuleShape3D.new()
	_shape.radius = RADIUS
	_shape.height = HEIGHT_STAND
	_col = CollisionShape3D.new()
	_col.shape = _shape
	_col.position.y = HEIGHT_STAND * 0.5
	add_child(_col)
	_build_shadow_body()
	_load_visible_body()
	head = Node3D.new()
	head.name = "Head"
	head.position.y = EYE_STAND
	add_child(head)
	camera = Camera3D.new()
	camera.name = "Camera"
	camera.near = 0.03
	camera.far = 600.0
	camera.fov = Settings.getf("fov")
	head.add_child(camera)
	camera.make_current()

## There is no first-person body model (no licence-clean one that matches the arms was available): the torso, head
## and legs exist only as shadow casters so the shooter at least throws a body-shaped shadow on the ground.
var _shadow_body: Node3D
func _build_shadow_body() -> void:
	_shadow_body = Node3D.new()
	_shadow_body.name = "ShadowBody"
	add_child(_shadow_body)
	var parts := [
		[0.165, 0.62, Vector3(0.0, 1.17, 0.03)],      # torso
		[0.105, 0.25, Vector3(0.0, 1.62, 0.0)],       # head
		[0.085, 0.88, Vector3(-0.10, 0.44, 0.02)],    # legs
		[0.085, 0.88, Vector3(0.10, 0.44, 0.02)],
		[0.20, 0.42, Vector3(0.0, 1.36, 0.02)],       # shoulders (lying capsule)
	]
	for i in parts.size():
		var mi := MeshInstance3D.new()
		var cm := CapsuleMesh.new()
		cm.radius = parts[i][0]
		cm.height = maxf(parts[i][1], cm.radius * 2.0)
		cm.radial_segments = 12
		cm.rings = 4
		mi.mesh = cm
		mi.position = parts[i][2]
		if i == 4:
			mi.rotation.z = PI * 0.5
			cm.radius = 0.085
			cm.height = 0.46
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		_shadow_body.add_child(mi)

## Visible first-person body (torso, belt, trousers, boots) seen when looking down. Static meshes: the legs get a
## simple stride swing about the hips and a squat when crouched; there is no skeletal animation.
const BODY_SCENE := "res://assets/arms/fp_body.gltf"
const LEG_BACK := 0.045
var _body: Node3D
var _body_torso: Node3D
var _leg_l: Node3D
var _leg_r: Node3D
var _leg_rest_l := Transform3D.IDENTITY
var _leg_rest_r := Transform3D.IDENTITY
func _load_visible_body() -> void:
	if not ResourceLoader.exists(BODY_SCENE):
		return
	var ps := load(BODY_SCENE) as PackedScene
	if ps == null:
		return
	_body = ps.instantiate()
	_body.name = "Body"
	add_child(_body)
	_body_torso = _body.find_child("Torso", true, false) as Node3D
	_leg_l = _body.find_child("LegL", true, false) as Node3D
	_leg_r = _body.find_child("LegR", true, false) as Node3D
	if _leg_l != null:
		_leg_rest_l = _leg_l.transform
	if _leg_r != null:
		_leg_rest_r = _leg_r.transform
	for mi in _body.find_children("*", "MeshInstance3D", true, false):
		(mi as MeshInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		(mi as MeshInstance3D).gi_mode = GeometryInstance3D.GI_MODE_DYNAMIC
		(mi as MeshInstance3D).extra_cull_margin = 1.0
		var m := mi as MeshInstance3D
		for si in m.mesh.get_surface_count():
			var mat := m.get_active_material(si)
			if mat is StandardMaterial3D:
				var dup: StandardMaterial3D = mat.duplicate()
				dup.metallic_specular = 0.12      # cloth and matt leather: no white sheen at grazing sun angles
				if String(mat.resource_name).to_lower().contains("trouser"):
					# the baked cloth is near-black (sRGB 0.22): in the body's own shadow the legs read as flat black
					# cut-outs. Worn grey-khaki work cloth instead, with the weave/fold normals a little stronger.
					# The jacket's cloth maps (fold shading, weave) are reused, tinted darker and greyer: field
					# trousers of the same cloth. [A] the fold pattern does not follow the leg's own UV layout.
					var jt := "res://assets/arms/textures/body_jacket_%s.png"
					if ResourceLoader.exists(jt % "basecolor"):
						dup.albedo_texture = load(jt % "basecolor")
						dup.normal_texture = load(jt % "normal")
						dup.orm_texture = load(jt % "orm")
						dup.albedo_color = Color(0.92, 0.88, 0.80)
						dup.normal_scale = 1.3
					else:
						dup.albedo_color = Color(2.2, 2.05, 1.8)
				m.set_surface_override_material(si, dup)
		# own render layer: the contact-shade decals under the boots must not project onto the body itself
		m.layers = 4 | 2       # 2: also lit by the hands fill light (weapon_view), like the sleeves
	_build_contact_shade()
	# the real meshes cast the shadow now: keep only the head and shoulder proxies
	for i in _shadow_body.get_child_count():
		if i in [0, 2, 3]:
			(_shadow_body.get_child(i) as Node3D).visible = false

## Soft dark patches on the floor under each boot and under the body. In open sun the cast shadow does most of the
## work and these stay faint; under the roof (no direct light, shadowless fill) they are what makes the feet stand
## on the slab. [A] an ambient-occlusion stand-in, not computed from the geometry.
var _contact: Array[Decal] = []
var _contact_shade := 0.0
var _contact_probe_t := 0.0
func _build_contact_shade() -> void:
	var grad := Gradient.new()
	grad.offsets = PackedFloat32Array([0.0, 0.45, 1.0])
	grad.colors = PackedColorArray([Color(0, 0, 0, 1.0), Color(0, 0, 0, 0.55), Color(0, 0, 0, 0.0)])
	var tex := GradientTexture2D.new()
	tex.gradient = grad
	tex.fill = GradientTexture2D.FILL_RADIAL
	tex.fill_from = Vector2(0.5, 0.5)
	tex.fill_to = Vector2(1.0, 0.5)
	tex.width = 64
	tex.height = 64
	for sz: Vector3 in [Vector3(0.30, 0.16, 0.50), Vector3(0.30, 0.16, 0.50), Vector3(0.95, 0.16, 0.80)]:
		var d := Decal.new()
		d.texture_albedo = tex
		d.size = sz
		d.cull_mask = 1
		d.upper_fade = 0.2
		d.lower_fade = 0.2
		d.normal_fade = 0.6
		d.distance_fade_enabled = false
		add_child(d)
		_contact.append(d)

func _update_contact_shade(delta: float) -> void:
	if _contact.is_empty():
		return
	_contact_probe_t -= delta
	if _contact_probe_t <= 0.0:
		_contact_probe_t = 0.2
		var space := get_world_3d().direct_space_state
		var from := global_position + Vector3(0, HEIGHT_STAND + 0.1, 0)
		var q := PhysicsRayQueryParameters3D.create(from, from + Vector3(0, 7.0, 0), 1)
		q.exclude = [get_rid()]
		_contact_shade_target = 0.0 if space.intersect_ray(q).is_empty() else 1.0
	_contact_shade = lerpf(_contact_shade, _contact_shade_target, 1.0 - exp(-delta * 4.0))
	var legs := [_leg_l, _leg_r]
	for i in 2:
		var leg: Node3D = legs[i]
		if leg == null:
			continue
		var foot := leg.transform * Vector3(0.0, -0.93, -0.05)
		# a lifted, swinging foot throws a weaker, wider patch
		var lift := clampf(foot.y / 0.05, 0.0, 1.0)
		_contact[i].position = Vector3(foot.x, 0.02, foot.z)
		_contact[i].modulate = Color(1, 1, 1, lerpf(0.30, 0.62, _contact_shade) * lerpf(1.0, 0.55, lift))
	_contact[2].position = Vector3(0.0, 0.02, 0.10)
	_contact[2].modulate = Color(1, 1, 1, lerpf(0.0, 0.34, _contact_shade))
var _contact_shade_target := 0.0

func _update_visible_body() -> void:
	if _body == null:
		return
	var e := smoothstep(0.0, 1.0, crouch_t)
	var drop := (EYE_STAND - EYE_CROUCH) * e
	if _body_torso != null:
		_body_torso.position.y = -drop
	var swing := sin(stride_phase) * 0.30 * clampf(move_speed / SPEED_WALK, 0.0, 1.3)
	for pair in [[_leg_l, _leg_rest_l, 1.0], [_leg_r, _leg_rest_r, -1.0]]:
		var leg: Node3D = pair[0]
		if leg == null:
			continue
		var rest: Transform3D = pair[1]
		# the hips sit a little further back than modelled, so the trouser waist stays under the jacket hem
		var hip := rest.origin + Vector3(0, -drop, LEG_BACK)
		# crouch: there is no knee joint, so the legs are simply compressed under the lowered hips (seen from
		# above, which is the only view of them, the boots stay where they were)
		var b := rest.basis * Basis(Vector3.RIGHT, swing * float(pair[2]) * (1.0 - e) + 0.12 * e)
		b = b * Basis.from_scale(Vector3(1.0, maxf((rest.origin.y - drop) / maxf(rest.origin.y, 0.01), 0.2), 1.0))
		leg.transform = Transform3D(b, hip)

func place(pos: Vector3, yaw_rad := 0.0) -> void:
	global_position = pos
	velocity = Vector3.ZERO
	yaw = yaw_rad
	pitch = 0.0
	_apply_look()

func _unhandled_input(event: InputEvent) -> void:
	if not input_enabled:
		return
	if event is InputEventMouseMotion and (Input.mouse_mode == Input.MOUSE_MODE_CAPTURED or synthetic_look):
		var sens := deg_to_rad(Settings.getf("mouse_sensitivity")) * (Settings.getf("ads_sensitivity_scale") if aiming else 1.0)
		var rel: Vector2 = event.relative
		var dyaw := -rel.x * sens
		var dpitch := -rel.y * sens * (-1.0 if Settings.getb("invert_y") else 1.0)
		yaw = wrapf(yaw + dyaw, -PI, PI)
		pitch = clampf(pitch + dpitch, deg_to_rad(-85.0), deg_to_rad(85.0))
		_look_accum += Vector2(dyaw, dpitch)
		_apply_look()          # same-frame response; no smoothing on the view
	elif event.is_action_pressed("crouch"):
		if Settings.getb("crouch_toggle"):
			crouched = not crouched
		else:
			crouched = true
	elif event.is_action_released("crouch") and not Settings.getb("crouch_toggle"):
		crouched = false

func _apply_look() -> void:
	rotation.y = yaw
	if head != null:
		head.rotation.x = pitch + extra_pitch
		head.rotation.y = extra_yaw

func _process(delta: float) -> void:
	# --- stance
	if crouched and crouch_t < 1.0 or (not crouched and crouch_t > 0.0):
		if not crouched and _blocked_above():
			crouched = true
		crouch_t = move_toward(crouch_t, 1.0 if crouched else 0.0, delta / 0.28)
		var e := smoothstep(0.0, 1.0, crouch_t)
		_shape.height = lerpf(HEIGHT_STAND, HEIGHT_CROUCH, e)
		_shadow_body.scale.y = lerpf(1.0, HEIGHT_CROUCH / HEIGHT_STAND, e)
		_col.position.y = _shape.height * 0.5
	# --- horizontal movement
	var wish := Vector2.ZERO
	if input_enabled:
		wish = Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var max_speed := SPEED_WALK
	if crouch_t > 0.5:
		max_speed = SPEED_CROUCH
	elif aiming:
		max_speed = SPEED_AIM
	elif input_enabled and Input.is_action_pressed("jog") and wish.y < -0.1:
		max_speed = SPEED_JOG
	var dir := (global_transform.basis * Vector3(wish.x, 0, wish.y))
	dir.y = 0.0
	var target := dir.normalized() * max_speed * minf(wish.length(), 1.0) if wish.length() > 0.01 else Vector3.ZERO
	var hv := Vector3(velocity.x, 0, velocity.z)
	var rate := ACCEL if target.length() > hv.length() else DECEL
	hv = hv.move_toward(target, rate * delta)
	var was_on_floor := is_on_floor()
	var vy := velocity.y
	if not was_on_floor:
		vy -= 9.81 * delta
	else:
		vy = -0.5
	velocity = Vector3(hv.x, vy, hv.z)
	var fall_speed := velocity.y
	move_and_slide()
	if is_on_floor() and not was_on_floor and fall_speed < -2.0:
		_land_dip = clampf(-fall_speed * 0.012, 0.0, 0.08)
		footstep.emit(floor_surface(), 1.3)
	move_speed = Vector3(velocity.x, 0, velocity.z).length()
	# --- stride
	var cm := Settings.getf("camera_motion")
	if move_speed > 0.15 and is_on_floor():
		var stride := STRIDE * lerpf(0.8, 1.25, clampf(move_speed / SPEED_JOG, 0.0, 1.0)) * (0.7 if crouch_t > 0.5 else 1.0)
		var prev := stride_phase
		stride_phase += move_speed / stride * PI * delta
		if int(floor(prev / PI)) != int(floor(stride_phase / PI)):
			_step_side = -_step_side
			footstep.emit(floor_surface(), clampf(move_speed / SPEED_WALK, 0.5, 1.5) * (0.6 if crouch_t > 0.5 else 1.0))
	else:
		# settle to the nearest foot-down phase so stopping does not pop
		var tgt: float = roundf(stride_phase / PI) * PI
		stride_phase = move_toward(stride_phase, tgt, delta * 6.0)
	var amp := clampf(move_speed / SPEED_WALK, 0.0, 1.6)
	var by := -absf(sin(stride_phase)) * 0.024 * amp          # the head drops ~2-4 cm between footfalls
	var bx := sin(stride_phase) * 0.012 * amp                 # weight shifts once per two steps
	_land_dip = move_toward(_land_dip, 0.0, delta * 0.35)
	bob = Vector3(bx, by - _land_dip, 0.0) * cm
	head.position = Vector3(0, lerpf(EYE_STAND, EYE_CROUCH, smoothstep(0.0, 1.0, crouch_t)), 0) + bob
	_update_visible_body()
	_update_contact_shade(delta)
	# --- look bookkeeping
	var inst := _look_accum / maxf(delta, 1e-4)
	_look_accum = Vector2.ZERO
	look_rate = look_rate.lerp(inst, 1.0 - exp(-delta * 30.0))
	_apply_look()

func _blocked_above() -> bool:
	var space := get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(global_position + Vector3(0, HEIGHT_CROUCH, 0), global_position + Vector3(0, HEIGHT_STAND + 0.05, 0), 1)
	q.exclude = [get_rid()]
	return not space.intersect_ray(q).is_empty()

func floor_surface() -> String:
	var space := get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(global_position + Vector3(0, 0.3, 0), global_position + Vector3(0, -0.6, 0), 1)
	q.exclude = [get_rid()]
	var r := space.intersect_ray(q)
	if r.is_empty():
		return "dirt"
	return ProjectileManager.surface_of(r["collider"])

func eye_position() -> Vector3:
	return camera.global_position

func is_crouched() -> bool:
	return crouch_t > 0.5
