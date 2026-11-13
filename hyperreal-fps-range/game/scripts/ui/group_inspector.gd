extends Control
## Shot-group inspector: one paper target at a time, drawn large at true proportions, with the
## group statistics computed from the target's recorded hits (millimetres on the face).

const UIStyle := preload("res://scripts/ui/ui_style.gd")
const UIMath := preload("res://scripts/ui/ui_math.gd")
const FaceView := preload("res://scripts/ui/target_face_view.gd")
const UIToggle := preload("res://scripts/ui/widgets/ui_toggle.gd")

signal close_requested

const MAX_SIZE := Vector2(1560, 960)

var style
var ui: Node
var _panel: PanelContainer
var _face: Control
var _title: Label
var _counter: Label
var _values := {}                    # id -> Label
var _markers: BaseButton
var _zoom: BaseButton
var _prev: Button
var _next: Button
var _clear: Button
var _close: Button
var _targets: Array = []
var _index := 0
var _targets_node: Node

func setup(p_style, p_ui: Node) -> void:
	style = p_style
	ui = p_ui
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel = style.panel()
	add_child(_panel)
	var m: MarginContainer = style.margin(40, 30, 40, 30)
	_panel.add_child(m)
	var col: VBoxContainer = style.vbox(0)
	m.add_child(col)

	var head: HBoxContainer = style.hbox(16)
	col.add_child(head)
	var titles: VBoxContainer = style.vbox(2)
	head.add_child(titles)
	titles.add_child(style.caps("Shot groups", "Caps"))
	_title = style.label("", "H1")
	titles.add_child(_title)
	head.add_child(style.spacer(0, 0, true))
	_counter = style.label("", "SmallDim")
	_counter.size_flags_vertical = Control.SIZE_SHRINK_END
	head.add_child(_counter)
	col.add_child(style.spacer(0, 14))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 18))

	var body: HBoxContainer = style.hbox(28)
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	col.add_child(body)
	_face = FaceView.new()
	_face.pal = style.pal
	body.add_child(_face)
	body.add_child(style.vline())

	var side: VBoxContainer = style.vbox(0)
	side.custom_minimum_size.x = 372
	body.add_child(side)
	var grid := GridContainer.new()
	grid.columns = 2
	grid.add_theme_constant_override("h_separation", 16)
	grid.add_theme_constant_override("v_separation", 9)
	side.add_child(grid)
	for row: Array in [["shots", "Shots"], ["spread", "Extreme spread"], ["spread_ang", ""], ["radius", "Mean radius"],
			["offset_x", "Group centre"], ["offset_y", ""], ["score", "Total score"], ["distance", "Distance"]]:
		var cap: Label = style.caps(row[1], "Caps")
		cap.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		grid.add_child(cap)
		var v: Label = style.label("—", "SmallDim" if row[0] == "spread_ang" else "Value")
		v.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		v.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		grid.add_child(v)
		_values[row[0]] = v
	side.add_child(style.spacer(0, 12))
	side.add_child(style.wrap_label("Extreme spread is the largest centre-to-centre distance between two shots; mean radius is the average distance from the group centre. All lengths are on the target face.", "SmallFaint"))
	side.add_child(style.spacer(0, 14))
	side.add_child(style.hline())
	side.add_child(style.spacer(0, 10))

	var mrow: HBoxContainer = style.hbox(12)
	side.add_child(mrow)
	var ml: Label = style.label("Hit markers", "Body")
	ml.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	mrow.add_child(ml)
	_markers = UIToggle.new()
	_markers.apply_palette(style.pal)
	_markers.set_pressed_no_signal(true)
	_markers.toggled.connect(func(on: bool) -> void:
		_face.show_markers = on
		_face.queue_redraw())
	mrow.add_child(_markers)
	var zrow: HBoxContainer = style.hbox(12)
	side.add_child(zrow)
	var zl: Label = style.label("Zoom to group", "Body")
	zl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	zrow.add_child(zl)
	_zoom = UIToggle.new()
	_zoom.apply_palette(style.pal)
	_zoom.toggled.connect(func(on: bool) -> void:
		_face.zoom_group = on
		_face.queue_redraw())
	zrow.add_child(_zoom)

	side.add_child(style.spacer(0, 0, true))
	var nav: HBoxContainer = style.hbox(10)
	side.add_child(nav)
	_prev = style.button("‹  Previous")
	_prev.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_prev.pressed.connect(_step.bind(-1))
	nav.add_child(_prev)
	_next = style.button("Next  ›")
	_next.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_next.pressed.connect(_step.bind(1))
	nav.add_child(_next)
	side.add_child(style.spacer(0, 10))
	_clear = style.button("Clear this target")
	_clear.pressed.connect(_ask_clear)
	side.add_child(_clear)
	side.add_child(style.spacer(0, 10))
	_close = style.button("Close")
	_close.pressed.connect(func() -> void: close_requested.emit())
	side.add_child(_close)
	_link()

func layout(space: Vector2) -> void:
	UIStyle.fit_center(_panel, space, MAX_SIZE, Vector2(40, 30))

func _link() -> void:
	# markers / [prev next] / clear / close; disabled buttons are skipped by pointing past them at open time
	for t: Control in [_markers, _zoom]:
		UIStyle.set_neighbor(t, SIDE_LEFT, t)
		UIStyle.set_neighbor(t, SIDE_RIGHT, t)
	UIStyle.set_neighbor(_markers, SIDE_TOP, _markers)
	UIStyle.set_neighbor(_markers, SIDE_BOTTOM, _zoom)
	UIStyle.set_neighbor(_zoom, SIDE_TOP, _markers)
	var nav_ok := not _prev.disabled
	var clear_ok := not _clear.disabled
	var below_toggles: Control = _prev if nav_ok else (_clear if clear_ok else _close)
	UIStyle.set_neighbor(_zoom, SIDE_BOTTOM, below_toggles)
	var below_nav: Control = _clear if clear_ok else _close
	for b: Button in [_prev, _next]:
		UIStyle.set_neighbor(b, SIDE_TOP, _zoom)
		UIStyle.set_neighbor(b, SIDE_BOTTOM, below_nav)
	UIStyle.set_neighbor(_prev, SIDE_LEFT, _prev)
	UIStyle.set_neighbor(_prev, SIDE_RIGHT, _next)
	UIStyle.set_neighbor(_next, SIDE_LEFT, _prev)
	UIStyle.set_neighbor(_next, SIDE_RIGHT, _next)
	UIStyle.set_neighbor(_clear, SIDE_TOP, _prev if nav_ok else _zoom)
	UIStyle.set_neighbor(_clear, SIDE_BOTTOM, _close)
	UIStyle.set_neighbor(_close, SIDE_TOP, _clear if clear_ok else (_prev if nav_ok else _zoom))
	UIStyle.set_neighbor(_close, SIDE_BOTTOM, _close)
	for b: Control in [_clear, _close]:
		UIStyle.set_neighbor(b, SIDE_LEFT, b)
		UIStyle.set_neighbor(b, SIDE_RIGHT, b)

## `targets_node` may be null (no Targets module) - the screen then says so.
func open(targets_node: Node) -> void:
	_targets_node = targets_node
	_collect()
	_index = 0
	_refresh()
	_close.grab_focus()

func get_target_index() -> int:
	return _index

func set_target_index(i: int) -> void:
	_index = clampi(i, 0, maxi(_targets.size() - 1, 0))
	_refresh()

## Re-read the target list (layout changed, session restarted) keeping the shown target if possible.
func reload() -> void:
	var cur: Variant = _targets[_index] if _index < _targets.size() else null
	_collect()
	var at := _targets.find(cur) if cur != null else -1
	_index = at if at >= 0 else clampi(_index, 0, maxi(_targets.size() - 1, 0))
	_refresh()

func _collect() -> void:
	_targets.clear()
	var tn := _targets_node
	if tn == null or not is_instance_valid(tn) or not tn.has_method("get_paper_targets"):
		return
	var list: Variant = tn.get_paper_targets()
	if not (list is Array):
		return
	var selected: Variant = tn.get_selected_paper_target() if tn.has_method("get_selected_paper_target") else null
	if selected != null and is_instance_valid(selected) and (list as Array).has(selected):
		_targets.append(selected)
	for t: Variant in list:
		if t != null and is_instance_valid(t) and not _targets.has(t):
			_targets.append(t)

func _step(dir: int) -> void:
	if _targets.size() < 2:
		return
	_index = (_index + dir + _targets.size()) % _targets.size()
	_refresh()

func _ask_clear() -> void:
	if _index >= _targets.size():
		return
	var t: Object = _targets[_index]
	ui.confirm("Clear this target?", "All recorded hits on %s are removed and the face is replaced with a clean one." % _target_name(t),
		"Clear", func() -> void:
			if is_instance_valid(t) and t.has_method("clear"):
				t.clear()
			_refresh())

static func _prop(o: Object, prop: String, fallback: Variant) -> Variant:
	if o != null and prop in o:
		var v: Variant = o.get(prop)
		if v != null:
			return v
	return fallback

func _target_name(t: Object) -> String:
	var label := str(_prop(t, "label", ""))
	return label if label != "" else "Paper target"

func _refresh() -> void:
	# drop targets that were freed since the list was read
	for i in range(_targets.size() - 1, -1, -1):
		if not is_instance_valid(_targets[i]):
			_targets.remove_at(i)
	var n := _targets.size()
	_index = clampi(_index, 0, maxi(n - 1, 0))
	_prev.disabled = n < 2
	_next.disabled = n < 2
	_clear.disabled = n == 0
	for b: Button in [_prev, _next, _clear]:
		b.focus_mode = Control.FOCUS_NONE if b.disabled else Control.FOCUS_ALL
	_link()
	if n == 0:
		_title.text = "No paper targets"
		_counter.text = ""
		_face.message = "No paper targets are set up on the range."
		_face.set_data(null, Vector2.ZERO, {})
		for id: String in _values:
			(_values[id] as Label).text = "—" if id != "spread_ang" and id != "offset_y" else ""
		return
	var t: Object = _targets[_index]
	var dist := float(_prop(t, "distance_m", 0.0))
	var face_mm: Vector2 = _prop(t, "face_size_mm", Vector2(500, 500))
	var hits: Array = t.get_hits() if t.has_method("get_hits") else []
	var tex: Texture2D = t.get_face_texture() if t.has_method("get_face_texture") else null
	var st := UIMath.group_stats(hits)
	var count := int(st["count"])
	_title.text = "%s  ·  %s" % [_target_name(t), UIMath.fmt_distance(dist)]
	_counter.text = "Target %d of %d" % [_index + 1, n]
	_face.message = ""
	_face.set_data(tex, face_mm, st)
	(_values["shots"] as Label).text = str(count)
	(_values["distance"] as Label).text = UIMath.fmt_distance(dist)
	(_values["score"] as Label).text = str(int(st["total_score"])) if count > 0 else "—"
	if count == 0:
		for id: String in ["spread", "radius", "offset_x"]:
			(_values[id] as Label).text = "—"
		(_values["spread_ang"] as Label).text = "no shots on this target"
		(_values["offset_y"] as Label).text = ""
		return
	var c: Vector2 = st["center"]
	(_values["radius"] as Label).text = UIMath.fmt_mm(st["mean_radius_mm"])
	(_values["offset_x"] as Label).text = _axis_text(c.x, "right", "left")
	(_values["offset_y"] as Label).text = _axis_text(c.y, "up", "down")
	if count >= 2:
		var es := float(st["extreme_spread_mm"])
		(_values["spread"] as Label).text = UIMath.fmt_mm(es)
		var mrad := UIMath.mm_to_mrad(es, dist)
		(_values["spread_ang"] as Label).text = "%.1f mrad  ·  %.1f MOA" % [mrad, UIMath.mrad_to_moa(mrad)] if dist > 0.0 else ""
	else:
		(_values["spread"] as Label).text = "—"
		(_values["spread_ang"] as Label).text = "needs two shots"

static func _axis_text(v: float, pos: String, neg: String) -> String:
	if absf(v) < 0.05:
		return "0.0 mm"
	return "%s %s" % [UIMath.fmt_mm(v), pos if v > 0.0 else neg]
