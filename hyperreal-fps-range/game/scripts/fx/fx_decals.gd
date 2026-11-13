extends Node3D
## Fixed pool of Decal nodes for bullet marks on world surfaces. Decals project onto the real surface inside a
## thin box, so a mark sits exactly on the geometry (also on uneven ground and corrugated sheet). The oldest marks
## fade out shortly before their slot is reused. Marks on colliders that can move follow them.

const CAP := 300
const FADE_AHEAD := 10         # slots ahead of the write cursor that are already fading
const FADE_TIME := 0.8
const RENDER_LAYERS := 1       # decals only paint render layer 1 (targets' paper/steel/glass live on layer 2)

var _nodes: Array[Decal] = []
var _live := PackedByteArray()
var _fade := PackedFloat32Array()      # > 0: fading out, seconds left
var _alpha := PackedFloat32Array()
var _follow: Array = []                # WeakRef of the collider or null
var _local: Array[Transform3D] = []
var _next := 0
var _count := 0
var _following := 0
var _keepers: Array[Decal] = []

func _ready() -> void:
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	_live.resize(CAP)
	_fade.resize(CAP)
	_alpha.resize(CAP)
	_follow.resize(CAP)
	_local.resize(CAP)
	for i in CAP:
		var d := Decal.new()
		d.visible = false
		d.cull_mask = RENDER_LAYERS
		d.upper_fade = 0.02
		d.lower_fade = 0.02
		d.distance_fade_enabled = true
		d.distance_fade_begin = 70.0
		d.distance_fade_length = 20.0
		add_child(d)
		_nodes.append(d)

## Keeps every decal texture referenced for the whole session so the renderer's decal atlas is built once at
## load and never re-packed when a mark appears.
func register_textures(textures: Array) -> void:
	for t in textures:
		if t == null:
			continue
		var k := Decal.new()
		k.texture_albedo = t
		k.size = Vector3(0.01, 0.01, 0.01)
		k.position = Vector3(0, -500, 0)
		k.cull_mask = 0
		add_child(k)
		_keepers.append(k)

func count() -> int:
	return _count

func clear() -> void:
	for i in CAP:
		if _live[i] != 0:
			_release(i)

func _release(i: int) -> void:
	_nodes[i].visible = false
	_live[i] = 0
	_fade[i] = 0.0
	if _follow[i] != null:
		_follow[i] = null
		_following -= 1
	_count -= 1

## xform: origin on the surface, basis Y = surface normal. size = (width, projection depth, height) in metres.
func spawn(albedo: Texture2D, normal: Texture2D, xform: Transform3D, size: Vector3, opts := {}) -> Decal:
	var i := _next
	_next = (_next + 1) % CAP
	if _live[i] != 0:
		_release(i)
	var ahead := (i + FADE_AHEAD) % CAP
	if _live[ahead] != 0 and _fade[ahead] <= 0.0:
		_fade[ahead] = FADE_TIME
	var d := _nodes[i]
	d.texture_albedo = albedo
	d.texture_normal = normal
	d.texture_emission = opts.get("emission")
	d.emission_energy = float(opts.get("emission_energy", 1.0))
	var m: Color = opts.get("modulate", Color.WHITE)
	d.modulate = m
	d.albedo_mix = float(opts.get("albedo_mix", 1.0))
	d.normal_fade = float(opts.get("normal_fade", 0.35))
	d.size = size
	d.global_transform = xform
	d.visible = true
	_live[i] = 1
	_fade[i] = 0.0
	_alpha[i] = m.a
	_count += 1
	var col: Object = opts.get("follow")
	if col != null and col is Node3D:
		_follow[i] = weakref(col)
		_local[i] = (col as Node3D).global_transform.affine_inverse() * xform
		_following += 1
	else:
		_follow[i] = null
	return d

func _process(delta: float) -> void:
	if _count == 0:
		return
	for i in CAP:
		if _live[i] == 0:
			continue
		if _fade[i] > 0.0:
			_fade[i] -= delta
			if _fade[i] <= 0.0:
				_release(i)
				continue
			var m := _nodes[i].modulate
			m.a = _alpha[i] * _fade[i] / FADE_TIME
			_nodes[i].modulate = m
		if _following > 0 and _follow[i] != null:
			var c: Node3D = (_follow[i] as WeakRef).get_ref()
			if c == null or not c.is_inside_tree():
				_release(i)
			else:
				_nodes[i].global_transform = c.global_transform * _local[i]
