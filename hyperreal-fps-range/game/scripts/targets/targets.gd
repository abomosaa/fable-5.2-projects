extends Node3D
## Targets - everything downrange that reacts to bullets. See docs/ARCHITECTURE.md for the contract.
##
## Layout (world metres; firing line is z = 0, downrange is -Z; "distance" = firing line to target FACE):
##   paper   bay lane 1  x -4.8   7 m   B-8 pattern bullseye (fixed)
##           bay lane 2  x -3.2  10 m   ISSF 25 m precision pattern (fixed)
##           bay lane 3  x -1.6  7/10/15/25 m  B-8 pattern on the MOVABLE stand (starts at 10 m)
##           pad lane 1  x  5.6  25 m   B-8 pattern (fixed)
##           pad         x  6.4  7/10/15/25 m  ISSF pattern on the second MOVABLE stand (starts at 15 m)
##   steel   8 in gong   x -0.45 10 m | 10 in gong x +0.45 15 m (both for bay lane 4, offset so neither hides the other)
##           12 in gong  x  7.2  25 m (pad lane 2) | 12 in gong x 3.0 50 m (both positions)
##           6 in auto-reset pivot plate x 1.3, 12 m (both positions)
##   shelves bay: x -5.9 z -9.0 | pad: x 8.6 z -10.0  (bottles, clay pigeons, pots, tin cans)
##
## step_paper_distance() moves the movable stand of the firing position the player is at (bay or pad, decided by
## the active camera's x). The move happens behind a short UI fade - it stands in for walking downrange and
## carrying the stand to the next line.

signal target_hit(info: Dictionary)
signal layout_changed
signal request_fade(text: String)

const Layout := preload("res://scripts/range/layout.gd")
const PaperTarget := preload("res://scripts/targets/paper_target.gd")
const SteelGong := preload("res://scripts/targets/steel_gong.gd")
const PivotPlate := preload("res://scripts/targets/pivot_plate.gd")
const Breakables := preload("res://scripts/targets/breakables.gd")

const PAPER_DISTANCES := [7.0, 10.0, 15.0, 25.0]
const MOVE_DELAY := 0.3            # s after request_fade before the stand jumps (the fade is opaque by then)

var papers: Array = []
var gongs: Array = []
var pivot: Node3D
var breakables: Node3D
var _movable_bay: Node3D
var _movable_pad: Node3D
var _moving := false
var _hit_counts := {}
var _resets := 0

func _ready() -> void:
	add_to_group("targets")
	_add_paper("b8", "Bay lane 1 bullseye", -4.8, 7.0)
	_add_paper("issf", "Bay lane 2 precision", -3.2, 10.0)
	_movable_bay = _add_paper("b8", "Bay lane 3 movable stand", -1.6, 10.0, true)
	_add_paper("b8", "Pad lane 1 bullseye", 5.6, 25.0)
	_movable_pad = _add_paper("issf", "Pad movable stand", 6.4, 15.0, true)
	_add_gong(8, "8 in gong", -0.45, 10.0)
	_add_gong(10, "10 in gong", 0.45, 15.0)
	_add_gong(12, "12 in gong", 7.2, 25.0)
	_add_gong(12, "12 in gong (50 m)", 3.0, 50.0)
	pivot = PivotPlate.new()
	pivot.name = "PivotPlate"
	pivot.setup("6 in auto-reset plate", 1.3, 12.0)
	add_child(pivot)
	pivot.hit_registered.connect(_on_hit)
	breakables = Breakables.new()
	breakables.name = "Breakables"
	add_child(breakables)
	breakables.hit_registered.connect(_on_hit)
	_populate_shelves()

func _add_paper(kind: String, label: String, x: float, dist: float, selectable := false) -> Node3D:
	var p: Node3D = PaperTarget.new()
	p.name = "Paper%d" % papers.size()
	p.setup(kind, label, x, dist, selectable)
	add_child(p)
	p.hit_registered.connect(_on_hit)
	papers.append(p)
	return p

func _add_gong(size_in: int, label: String, x: float, dist: float) -> void:
	var g: Node3D = SteelGong.new()
	g.name = "Gong%d" % gongs.size()
	g.setup(size_in, label, x, dist)
	add_child(g)
	g.hit_registered.connect(_on_hit)
	gongs.append(g)

func _populate_shelves() -> void:
	var b := breakables
	# --- bay shelf: left of lane 1, 9 m
	var a := Vector3(-5.9, 0.0, -9.0)
	var sa: Node3D = b.add_shelf(a)
	var top := float(sa.get_meta("top_y"))
	b.add_brittle("bottle_wine", a + Vector3(-0.50, top, 0.01), 20.0, "green")
	b.add_brittle("bottle_beer", a + Vector3(-0.385, top, -0.02), 140.0, "amber")
	b.add_can("can_a", a + Vector3(-0.25, top, 0.0), 35.0)
	b.add_clay_on_holder(a + Vector3(-0.09, top, 0.0), 2.0)
	b.add_clay_on_holder(a + Vector3(0.075, top, 0.005), -3.0)
	b.add_can("can_b", a + Vector3(0.215, top, 0.01), 200.0)
	b.add_brittle("pot", a + Vector3(0.36, top, 0.0), 75.0)
	b.add_brittle("bottle_wine", a + Vector3(0.525, top, -0.01), 250.0, "clear")
	# --- pad shelf: right of the pad, 10 m
	var c := Vector3(8.6, 0.0, -10.0)
	var sc: Node3D = b.add_shelf(c, -4.0)
	var rot := Basis(Vector3.UP, deg_to_rad(-4.0))
	var topc := float(sc.get_meta("top_y"))
	b.add_brittle("bottle_beer", c + rot * Vector3(-0.50, topc, 0.0), 10.0, "amber")
	b.add_clay_on_holder(c + rot * Vector3(-0.36, topc, 0.0), -4.0)
	b.add_clay_on_holder(c + rot * Vector3(-0.19, topc, 0.0), -6.0)
	b.add_clay_on_holder(c + rot * Vector3(-0.02, topc, 0.0), -2.0)
	b.add_can("can_c", c + rot * Vector3(0.135, topc, 0.0), 60.0)
	b.add_can("can_a", c + rot * Vector3(0.265, topc, 0.01), 300.0)
	b.add_brittle("bottle_wine", c + rot * Vector3(0.395, topc, 0.0), 100.0, "green")
	b.add_brittle("bottle_beer", c + rot * Vector3(0.50, topc, 0.02), 190.0, "amber")
	# a cracked spare pot on the ground beside the shelf
	b.add_brittle("pot", c + rot * Vector3(-0.78, 0.0, 0.05), 30.0)

# ------------------------------------------------------------------------------------------------ hits
func _on_hit(info: Dictionary) -> void:
	var kind := str(info.get("kind", "?"))
	_hit_counts[kind] = int(_hit_counts.get(kind, 0)) + 1
	if not info.has("distance_m") and info.has("position"):
		info["distance_m"] = -(info["position"] as Vector3).z
	target_hit.emit(info)

# ------------------------------------------------------------------------------------------------ contract API
func reset_all() -> void:
	_resets += 1
	for p in papers:
		p.clear()
	for g in gongs:
		g.reset_target()
	pivot.reset_target()
	breakables.reset_all()
	_hit_counts.clear()
	layout_changed.emit()

func get_paper_targets() -> Array:
	return papers

## the movable stand of the firing position the player is standing at
func get_selected_paper_target() -> Node3D:
	var cam: Camera3D = get_viewport().get_camera_3d() if is_inside_tree() else null
	if cam != null and cam.global_position.x > (Layout.BAY_X_MAX + Layout.PAD_X_MIN) * 0.5:
		return _movable_pad
	return _movable_bay

func step_paper_distance(dir: int) -> void:
	if _moving or dir == 0:
		return
	var t := get_selected_paper_target()
	var i := PAPER_DISTANCES.find(t.distance_m)
	if i < 0:
		i = 1
	var j := clampi(i + signi(dir), 0, PAPER_DISTANCES.size() - 1)
	if j == i:
		return
	var d: float = PAPER_DISTANCES[j]
	_moving = true
	request_fade.emit("Target stand moved to %d m" % int(d))
	# The stand is repositioned while the screen is faded: this abstracts walking downrange and carrying it.
	if is_inside_tree():
		await get_tree().create_timer(MOVE_DELAY, true, false, true).timeout
	t.set_distance(d)
	_moving = false
	layout_changed.emit()

## immediate variant for tests and scripted captures (no fade, no delay)
func set_selected_distance(d: float) -> void:
	get_selected_paper_target().set_distance(d)
	layout_changed.emit()

func all_asleep() -> bool:
	for g in gongs:
		if not g.is_asleep():
			return false
	return pivot.is_asleep() and breakables.all_asleep()

func get_stats() -> Dictionary:
	var paper_hits := 0
	var uploads := 0
	for p in papers:
		paper_hits += p.hit_count()
		uploads += int(p.get_stats()["uploads"])
	var steel_marks := int(pivot.get_stats()["marks"])
	var awake := 0
	for g in gongs:
		steel_marks += int(g.get_stats()["marks"])
		if not g.is_asleep():
			awake += 1
	var d := {"paper_targets": papers.size(), "paper_hits": paper_hits, "field_uploads": uploads, "steel_marks": steel_marks,
		"gongs_awake": awake, "pivot_asleep": pivot.is_asleep(), "resets": _resets, "hits_by_kind": _hit_counts.duplicate(),
		"selected_distance_m": get_selected_paper_target().distance_m, "nodes": _count_nodes(self)}
	d.merge(breakables.get_stats())
	return d

func _count_nodes(n: Node) -> int:
	var c := 1
	for ch in n.get_children():
		c += _count_nodes(ch)
	return c
