extends Node3D
## Bounded CPU-simulated particles drawn with two MultiMeshes (one draw call each):
##   * "puffs"  - lit soft billboards (dust, powder smoke): relax toward the wind velocity, grow, fade
##   * "chunks" - small lit meshes (clods, stone chips, splinters, lead fragments, glass glints): ballistic,
##                bounce on the plane they were thrown from / the floor below, come to rest, shrink away
## Everything appears on the frame it is emitted (the buffer is written in _process of that same frame), nothing
## allocates after _ready, and the caps are hard: when full, the oldest particle is replaced.

const PUFF_CAP := 384
const CHUNK_CAP := 320
const STRIDE := 20            # 12 transform + 4 colour + 4 custom
const GRAVITY := 9.81

var wind := Vector3(0.9, 0.0, 0.35)

# --- puffs (structure of arrays)
var _pn := 0
var _p_pos := PackedVector3Array()
var _p_vel := PackedVector3Array()
var _p_age := PackedFloat32Array()
var _p_life := PackedFloat32Array()
var _p_s0 := PackedFloat32Array()
var _p_s1 := PackedFloat32Array()
var _p_drag := PackedFloat32Array()
var _p_buoy := PackedFloat32Array()
var _p_windk := PackedFloat32Array()
var _p_roll := PackedFloat32Array()
var _p_rollv := PackedFloat32Array()
var _p_col := PackedColorArray()
var _p_tex := PackedFloat32Array()
var _p_fadein := PackedFloat32Array()
var _p_buf := PackedFloat32Array()
var _p_mm: MultiMesh

# --- chunks
var _cn := 0
var _c_pos := PackedVector3Array()
var _c_vel := PackedVector3Array()
var _c_basis: Array[Basis] = []
var _c_axis := PackedVector3Array()
var _c_spin := PackedFloat32Array()
var _c_scale := PackedVector3Array()
var _c_col := PackedColorArray()
var _c_cus := PackedColorArray()          # metallic, roughness, emission, drag
var _c_age := PackedFloat32Array()
var _c_life := PackedFloat32Array()
var _c_pn := PackedVector3Array()         # bounce plane normal
var _c_pd := PackedFloat32Array()         # plane offset (n . p = d)
var _c_floor := PackedFloat32Array()      # horizontal floor height below
var _c_rest := PackedFloat32Array()       # restitution
var _c_state := PackedByteArray()         # 0 flying, 1 resting
var _c_buf := PackedFloat32Array()
var _c_mm: MultiMesh
var _rng := RandomNumberGenerator.new()

func _ready() -> void:
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	_rng.seed = 0x51ed
	for a in [_p_pos, _p_vel]:
		a.resize(PUFF_CAP)
	for a in [_p_age, _p_life, _p_s0, _p_s1, _p_drag, _p_buoy, _p_windk, _p_roll, _p_rollv, _p_tex, _p_fadein]:
		a.resize(PUFF_CAP)
	_p_col.resize(PUFF_CAP)
	_p_buf.resize(PUFF_CAP * STRIDE)
	for a in [_c_pos, _c_vel, _c_axis, _c_scale, _c_pn]:
		a.resize(CHUNK_CAP)
	for a in [_c_spin, _c_age, _c_life, _c_pd, _c_floor, _c_rest]:
		a.resize(CHUNK_CAP)
	_c_col.resize(CHUNK_CAP)
	_c_cus.resize(CHUNK_CAP)
	_c_state.resize(CHUNK_CAP)
	_c_basis.resize(CHUNK_CAP)
	_c_buf.resize(CHUNK_CAP * STRIDE)

	var quad := QuadMesh.new()
	quad.size = Vector2(1, 1)
	var pm := ShaderMaterial.new()
	pm.shader = preload("res://scripts/fx/shaders/puff.gdshader")
	pm.set_shader_parameter("atlas", preload("res://assets/fx/tex/puff_atlas.png"))
	pm.render_priority = 2
	quad.material = pm
	_p_mm = _make_mm(quad, PUFF_CAP, "Puffs")

	var cm := ShaderMaterial.new()
	cm.shader = preload("res://scripts/fx/shaders/chunk.gdshader")
	var rock := _make_rock_mesh()
	rock.surface_set_material(0, cm)
	_c_mm = _make_mm(rock, CHUNK_CAP, "Chunks")

func _make_mm(mesh: Mesh, cap: int, node_name: String) -> MultiMesh:
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.use_custom_data = true
	mm.mesh = mesh
	mm.instance_count = cap
	mm.visible_instance_count = 0
	mm.custom_aabb = AABB(Vector3(-400, -50, -400), Vector3(800, 200, 800))
	var mi := MultiMeshInstance3D.new()
	mi.name = node_name
	mi.multimesh = mm
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
	mi.extra_cull_margin = 16384.0
	mi.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	add_child(mi)
	return mm

## irregular flat-shaded lump (jittered icosahedron, unit radius ~0.5)
func _make_rock_mesh() -> ArrayMesh:
	var t := (1.0 + sqrt(5.0)) / 2.0
	var v := [Vector3(-1, t, 0), Vector3(1, t, 0), Vector3(-1, -t, 0), Vector3(1, -t, 0), Vector3(0, -1, t), Vector3(0, 1, t),
		Vector3(0, -1, -t), Vector3(0, 1, -t), Vector3(t, 0, -1), Vector3(t, 0, 1), Vector3(-t, 0, -1), Vector3(-t, 0, 1)]
	var f := [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
		3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]
	var r := RandomNumberGenerator.new()
	r.seed = 7
	for i in v.size():
		v[i] = (v[i] as Vector3).normalized() * 0.5 * r.randf_range(0.62, 1.0)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in range(0, f.size(), 3):
		var a: Vector3 = v[f[i]]
		var b: Vector3 = v[f[i + 1]]
		var c: Vector3 = v[f[i + 2]]
		# Godot front faces are clockwise
		var n := (c - a).cross(b - a).normalized()
		if n.dot(a + b + c) < 0.0:
			var tmp := b
			b = c
			c = tmp
			n = -n
		for p in [a, b, c]:
			st.set_normal(n)
			st.add_vertex(p)
	return st.commit()

func clear() -> void:
	_pn = 0
	_cn = 0
	_p_mm.visible_instance_count = 0
	_c_mm.visible_instance_count = 0

func puff_count() -> int:
	return _pn

func chunk_count() -> int:
	return _cn

## Soft billboard. size0 -> size1 (m) over its life; `color.a` is the peak opacity; drag (1/s) is how fast its
## velocity relaxes to wind * windk; buoyancy in m/s^2 (positive rises).
func puff(pos: Vector3, vel: Vector3, size0: float, size1: float, life: float, color: Color, drag := 3.0, buoyancy := 0.1,
		windk := 1.0, fade_in := 0.06) -> void:
	var i := _pn
	if i >= PUFF_CAP:
		i = _oldest_puff()
	else:
		_pn += 1
	_p_pos[i] = pos
	_p_vel[i] = vel
	_p_age[i] = 0.0
	_p_life[i] = maxf(life, 0.02)
	_p_s0[i] = size0
	_p_s1[i] = size1
	_p_drag[i] = drag
	_p_buoy[i] = buoyancy
	_p_windk[i] = windk
	_p_roll[i] = _rng.randf() * TAU
	_p_rollv[i] = _rng.randf_range(-0.5, 0.5)
	_p_col[i] = color
	_p_tex[i] = float(_rng.randi() % 4)
	_p_fadein[i] = fade_in

func _oldest_puff() -> int:
	var best := 0
	var frac := -1.0
	for i in _pn:
		var f := _p_age[i] / _p_life[i]
		if f > frac:
			frac = f
			best = i
	return best

## Small debris mesh. `plane_n`/`plane_p` describe the surface it was knocked out of (it bounces there when that
## surface faces up); `floor_y` is the ground below for pieces that fall clear.
func chunk(pos: Vector3, vel: Vector3, scale: Vector3, color: Color, life: float, plane_n: Vector3, plane_p: Vector3, floor_y: float,
		metallic := 0.0, roughness := 0.9, emission := 0.0, restitution := 0.3, air_drag := 0.3) -> void:
	var i := _cn
	if i >= CHUNK_CAP:
		i = _oldest_chunk()
	else:
		_cn += 1
	_c_pos[i] = pos
	_c_vel[i] = vel
	_c_basis[i] = Basis(Vector3(_rng.randf_range(-1, 1), _rng.randf_range(-1, 1), _rng.randf_range(-1, 1)).normalized(), _rng.randf() * TAU)
	_c_axis[i] = Vector3(_rng.randf_range(-1, 1), _rng.randf_range(-1, 1), _rng.randf_range(-1, 1)).normalized()
	_c_spin[i] = _rng.randf_range(8.0, 45.0) * clampf(vel.length() / 4.0, 0.2, 1.5)
	_c_scale[i] = scale
	_c_col[i] = color
	_c_cus[i] = Color(metallic, roughness, emission, air_drag)
	_c_age[i] = 0.0
	_c_life[i] = life
	if plane_n.y > 0.35:
		_c_pn[i] = plane_n
		_c_pd[i] = plane_n.dot(plane_p)
	else:
		_c_pn[i] = Vector3.UP
		_c_pd[i] = floor_y
	_c_floor[i] = floor_y
	_c_rest[i] = restitution
	_c_state[i] = 0

func _oldest_chunk() -> int:
	var best := 0
	var frac := -1.0
	for i in _cn:
		var f := _c_age[i] / _c_life[i]
		if f > frac:
			frac = f
			best = i
	return best

func _process(delta: float) -> void:
	if _pn > 0:
		_step_puffs(delta)
	elif _p_mm.visible_instance_count != 0:
		_p_mm.visible_instance_count = 0
	if _cn > 0:
		_step_chunks(delta)
	elif _c_mm.visible_instance_count != 0:
		_c_mm.visible_instance_count = 0

func _step_puffs(dt: float) -> void:
	var i := 0
	var buf := _p_buf
	while i < _pn:
		var age := _p_age[i] + dt
		var life := _p_life[i]
		if age >= life:
			_pn -= 1
			var l := _pn
			if i != l:
				_p_pos[i] = _p_pos[l]; _p_vel[i] = _p_vel[l]; _p_age[i] = _p_age[l]; _p_life[i] = _p_life[l]
				_p_s0[i] = _p_s0[l]; _p_s1[i] = _p_s1[l]; _p_drag[i] = _p_drag[l]; _p_buoy[i] = _p_buoy[l]
				_p_windk[i] = _p_windk[l]; _p_roll[i] = _p_roll[l]; _p_rollv[i] = _p_rollv[l]; _p_col[i] = _p_col[l]
				_p_tex[i] = _p_tex[l]; _p_fadein[i] = _p_fadein[l]
			continue
		_p_age[i] = age
		var v := _p_vel[i]
		var k := 1.0 - exp(-_p_drag[i] * dt)
		v += (wind * _p_windk[i] - v) * k
		v.y += _p_buoy[i] * dt
		_p_vel[i] = v
		var p := _p_pos[i] + v * dt
		_p_pos[i] = p
		var u := age / life
		var size := lerpf(_p_s0[i], _p_s1[i], 1.0 - (1.0 - u) * (1.0 - u))
		var c := _p_col[i]
		# quick rise, long thinning tail (opacity also drops as the puff spreads)
		var env := minf(age / _p_fadein[i], 1.0) * pow(1.0 - u, 1.5) * (_p_s0[i] / size * 0.5 + 0.5)
		var o := i * STRIDE
		buf[o] = size; buf[o + 1] = 0.0; buf[o + 2] = 0.0; buf[o + 3] = p.x
		buf[o + 4] = 0.0; buf[o + 5] = size; buf[o + 6] = 0.0; buf[o + 7] = p.y
		buf[o + 8] = 0.0; buf[o + 9] = 0.0; buf[o + 10] = size; buf[o + 11] = p.z
		buf[o + 12] = c.r; buf[o + 13] = c.g; buf[o + 14] = c.b; buf[o + 15] = c.a * env
		buf[o + 16] = _p_roll[i] + _p_rollv[i] * age; buf[o + 17] = u; buf[o + 18] = _p_tex[i]; buf[o + 19] = 0.0
		i += 1
	_p_mm.buffer = buf
	_p_mm.visible_instance_count = _pn

func _step_chunks(dt: float) -> void:
	var i := 0
	var buf := _c_buf
	while i < _cn:
		var age := _c_age[i] + dt
		var life := _c_life[i]
		if age >= life:
			_cn -= 1
			var l := _cn
			if i != l:
				_c_pos[i] = _c_pos[l]; _c_vel[i] = _c_vel[l]; _c_basis[i] = _c_basis[l]; _c_axis[i] = _c_axis[l]
				_c_spin[i] = _c_spin[l]; _c_scale[i] = _c_scale[l]; _c_col[i] = _c_col[l]; _c_cus[i] = _c_cus[l]
				_c_age[i] = _c_age[l]; _c_life[i] = _c_life[l]; _c_pn[i] = _c_pn[l]; _c_pd[i] = _c_pd[l]
				_c_floor[i] = _c_floor[l]; _c_rest[i] = _c_rest[l]; _c_state[i] = _c_state[l]
			continue
		_c_age[i] = age
		var p := _c_pos[i]
		var b := _c_basis[i]
		var cus := _c_cus[i]
		if _c_state[i] == 0:
			var v := _c_vel[i]
			v.y -= GRAVITY * dt
			v -= v * minf(cus.a * dt, 0.5)
			p += v * dt
			var n := _c_pn[i]
			var half := _c_scale[i].y * 0.35
			var depth := n.dot(p) - _c_pd[i] - half
			var hit := false
			if depth < 0.0:
				hit = true
			elif p.y - half < _c_floor[i] and n.y < 0.999:
				# left the sloped surface it came from: the flat floor below takes over
				n = Vector3.UP
				depth = p.y - half - _c_floor[i]
				hit = depth < 0.0
			if hit:
				p -= n * depth
				var vn := v.dot(n)
				if vn < 0.0:
					var vt := v - n * vn
					v = vt * 0.55 - n * vn * _c_rest[i]
					_c_spin[i] *= 0.5
					if -vn < 0.9 and vt.length() < 1.2:
						_c_state[i] = 1
						v = Vector3.ZERO
			_c_vel[i] = v
			_c_pos[i] = p
			b = Basis(_c_axis[i], _c_spin[i] * dt) * b
			_c_basis[i] = b
		var s := _c_scale[i]
		var tail := life - age
		if tail < 0.5:
			s *= tail * 2.0
		var c := _c_col[i]
		var o := i * STRIDE
		buf[o] = b.x.x * s.x; buf[o + 1] = b.y.x * s.y; buf[o + 2] = b.z.x * s.z; buf[o + 3] = p.x
		buf[o + 4] = b.x.y * s.x; buf[o + 5] = b.y.y * s.y; buf[o + 6] = b.z.y * s.z; buf[o + 7] = p.y
		buf[o + 8] = b.x.z * s.x; buf[o + 9] = b.y.z * s.y; buf[o + 10] = b.z.z * s.z; buf[o + 11] = p.z
		buf[o + 12] = c.r; buf[o + 13] = c.g; buf[o + 14] = c.b; buf[o + 15] = 1.0
		buf[o + 16] = cus.r; buf[o + 17] = cus.g; buf[o + 18] = cus.b; buf[o + 19] = 0.0
		i += 1
	_c_mm.buffer = buf
	_c_mm.visible_instance_count = _cn
