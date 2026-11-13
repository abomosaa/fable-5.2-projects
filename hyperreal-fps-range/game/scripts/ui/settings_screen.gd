extends Control
## Settings: four sections bound to the Settings autoload. Every widget writes through
## Settings.set_value() and is refreshed from Settings.changed, so external changes show up too.

const UIStyle := preload("res://scripts/ui/ui_style.gd")
const UIMath := preload("res://scripts/ui/ui_math.gd")
const UISlider := preload("res://scripts/ui/widgets/ui_slider.gd")
const UIToggle := preload("res://scripts/ui/widgets/ui_toggle.gd")

signal back_requested

const TABS := ["View & Input", "Audio", "Graphics", "Practice & Accessibility"]
const RIGHT_W := 430.0
const MAX_SIZE := Vector2(1160, 900)

const QUALITY_NOTES := {
	"low": "Low: lightest on the GPU — simpler shadows and lighting, less fine detail at distance.",
	"medium": "Medium: softer shadows and reduced indirect lighting for a clearly higher frame rate.",
	"high": "High: full lighting and shadow detail; the intended look on a mid-range graphics card.",
	"ultra": "Ultra: finest shadows, indirect light and reflections; costs noticeably more for a small gain.",
}
const DYNAMIC_NOTE := "Full: widest dynamics; Headphones: gentler peaks; Night: strongly compressed"
const PERF_KEY := "perf_readout"     # used if the Settings autoload defines it, otherwise per-session

var style
var ui: Node                         # ui_root (confirm(), perf read-out)
var _panel: PanelContainer
var _tab_buttons: Array[Button] = []
var _pages: Array[ScrollContainer] = []
var _lists: Array[VBoxContainer] = []
var _groups: Array = []              # per page: Array of Array[Control] (focus stops, top to bottom)
var _refreshers := {}                # setting key -> Array[Callable]
var _focus_of := {}                  # setting key -> Callable returning the control to focus
var _tab := 0
var _page := 0                       # page being built
var _reset_btn: Button
var _back_btn: Button
var _render_hint: Label

func setup(p_style, p_ui: Node) -> void:
	style = p_style
	ui = p_ui
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel = style.panel()
	add_child(_panel)
	var m: MarginContainer = style.margin(40, 30, 40, 26)
	_panel.add_child(m)
	var col: VBoxContainer = style.vbox(0)
	m.add_child(col)

	var head: HBoxContainer = style.hbox(16)
	col.add_child(head)
	head.add_child(style.label("Settings", "H1"))
	head.add_child(style.spacer(0, 0, true))
	var hint: Label = style.label("← →  adjust    ↑ ↓  move    Esc  back", "SmallFaint")
	hint.size_flags_vertical = Control.SIZE_SHRINK_END
	head.add_child(hint)
	col.add_child(style.spacer(0, 14))

	var tabs: HBoxContainer = style.hbox(4)
	col.add_child(tabs)
	var group := ButtonGroup.new()
	for i in TABS.size():
		var b: Button = style.button(TABS[i], "Tab")
		b.toggle_mode = true
		b.button_group = group
		b.pressed.connect(select_tab.bind(i))
		b.focus_entered.connect(select_tab.bind(i))
		tabs.add_child(b)
		_tab_buttons.append(b)
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 12))

	var body := Control.new()
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.mouse_filter = Control.MOUSE_FILTER_IGNORE
	body.clip_contents = true
	col.add_child(body)
	for i in TABS.size():
		var sc := ScrollContainer.new()
		sc.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
		sc.follow_focus = true
		body.add_child(sc)
		sc.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		var pad: MarginContainer = style.margin(0, 0, 18, 0)
		pad.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		sc.add_child(pad)
		var list: VBoxContainer = style.vbox(2)
		pad.add_child(list)
		_pages.append(sc)
		_lists.append(list)
		_groups.append([])

	_build_view()
	_build_audio()
	_build_graphics()
	_build_practice()

	col.add_child(style.spacer(0, 12))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 16))
	var foot: HBoxContainer = style.hbox(12)
	col.add_child(foot)
	_reset_btn = style.button("Reset all to defaults")
	_reset_btn.pressed.connect(_ask_reset)
	foot.add_child(_reset_btn)
	foot.add_child(style.spacer(0, 0, true))
	_back_btn = style.button("Back")
	_back_btn.custom_minimum_size.x = 120
	_back_btn.pressed.connect(func() -> void: back_requested.emit())
	foot.add_child(_back_btn)

	Settings.changed.connect(_on_setting_changed)
	select_tab(0)

func layout(space: Vector2) -> void:
	UIStyle.fit_center(_panel, space, MAX_SIZE, Vector2(40, 30))
	_refresh_render_hint()

func open() -> void:
	_refresh_render_hint()
	_tab_buttons[_tab].grab_focus()

func get_tab() -> int:
	return _tab

## Setting key of the focused widget ("" if none) - used to restore focus after a restyle.
func get_focused_key() -> String:
	var f := get_viewport().gui_get_focus_owner()
	if f != null and f.has_meta("setting_key"):
		return str(f.get_meta("setting_key"))
	return ""

func focus_key(key: String) -> void:
	if _focus_of.has(key):
		var c: Control = (_focus_of[key] as Callable).call()
		if c != null:
			c.grab_focus()

func select_tab(i: int) -> void:
	_tab = clampi(i, 0, TABS.size() - 1)
	for j in _pages.size():
		_pages[j].visible = j == _tab
		_tab_buttons[j].set_pressed_no_signal(j == _tab)
	_link()

# ------------------------------------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------------------------------------

func _build_view() -> void:
	_page = 0
	_slider("fov", "Field of view", "Vertical, in degrees.")
	_slider("ads_fov_scale", "Aim zoom", "Field of view while aiming down the sights, relative to the normal view.")
	_slider("mouse_sensitivity", "Mouse sensitivity", "Degrees turned per mouse count.")
	_slider("ads_sensitivity_scale", "Aim sensitivity", "Sensitivity while aiming, relative to the normal sensitivity.")
	_toggle("invert_y", "Invert vertical look")
	_choice("aim_toggle", "Aim down sights", "", [[false, "Hold"], [true, "Toggle"]])
	_choice("crouch_toggle", "Crouch", "", [[false, "Hold"], [true, "Toggle"]])
	_slider("camera_motion", "Camera motion", "Head bob, landing dip and recoil camera kick. 0 % turns them off.")
	_slider("weapon_sway", "Weapon sway", "How much the pistol drifts and lags with movement and breathing.")
	_static_row("Motion blur", "Off — this build renders no motion blur")

func _build_audio() -> void:
	_page = 1
	_note("Never raise volume to uncomfortable levels. The simulation does not reproduce real firearm sound pressure.", true)
	_slider("master_volume", "Master volume", "Start low: the default is deliberately conservative. Raise it gradually.")
	_slider("ambience_volume", "Ambience volume", "Wind, birds and other background sound.")
	_choice("dynamic_range", "Dynamic range", DYNAMIC_NOTE,
		[["full", "Full"], ["headphones", "Headphones"], ["night", "Night"]])
	_choice("spatial_mode", "Spatial mode", "HRTF gives binaural positioning and needs headphones.",
		[["hrtf", "HRTF binaural (headphones)"], ["stereo", "Stereo"]])
	_toggle("distant_range", "Distant range ambience", "Occasional far-off shots from a neighbouring range.")

func _build_graphics() -> void:
	_page = 2
	_choice("quality", "Quality preset", "",
		[["low", "Low"], ["medium", "Medium"], ["high", "High"], ["ultra", "Ultra"]], QUALITY_NOTES)
	_render_hint = _slider("render_scale", "Render scale", "Internal 3D resolution. Lower is faster and softer.")
	_toggle("vsync", "V-Sync", "Synchronises frames with the display; removes tearing, adds a little latency.")
	_fps_row()
	_toggle("fullscreen", "Fullscreen")
	_perf_row()

func _build_practice() -> void:
	_page = 3
	_toggle("controls_overlay", "Controls overlay", "Key list in the lower-left corner; recedes after a few seconds.")
	_toggle("practice_overlay", "Practice read-out", "Chamber, magazine, hammer, safety and slide as text. Off by default.")
	_toggle("hit_feedback", "Hit feedback text", "One line describing the last hit, shown for three seconds. No markers, no sounds.")
	_toggle("aim_dot", "Aim dot", "A small dot at the centre of the view. Accessibility aid; off by default.")
	_toggle("high_contrast_hud", "High-contrast HUD", "Opaque black panels, white text and stronger outlines.")
	_slider("hud_scale", "HUD scale", "Size of HUD and menu text. Applies when the slider is released.", true)
	_toggle("reduce_flashes", "Reduce flashes", "Dims the muzzle flash and softens sudden exposure changes and fades.")

# ------------------------------------------------------------------------------------------------
# Row builders
# ------------------------------------------------------------------------------------------------

## Returns [row panel, right-hand box, hint label or null].
func _row(title: String, hint := "") -> Array:
	var rp: PanelContainer = style.panel("Row")
	var h: HBoxContainer = style.hbox(28)
	rp.add_child(h)
	var left: VBoxContainer = style.vbox(1)
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	left.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	left.add_child(style.label(title, "Body"))
	var hl: Label = null
	if hint != "":
		hl = style.wrap_label(hint, "SmallDim")
		left.add_child(hl)
	h.add_child(left)
	var right: HBoxContainer = style.hbox(14)
	right.custom_minimum_size = Vector2(RIGHT_W, 36)
	right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	right.alignment = BoxContainer.ALIGNMENT_END
	h.add_child(right)
	_lists[_page].add_child(rp)
	return [rp, right, hl]

func _track(rp: PanelContainer, c: Control, key: String) -> void:
	c.set_meta("setting_key", key)
	c.focus_entered.connect(func() -> void: rp.theme_type_variation = "RowFocus")
	c.focus_exited.connect(func() -> void: rp.theme_type_variation = "Row")

func _register(key: String, refresh: Callable, focus: Callable) -> void:
	if not _refreshers.has(key):
		_refreshers[key] = []
	(_refreshers[key] as Array).append(refresh)
	_focus_of[key] = focus
	refresh.call()

func _value_label() -> Label:
	var val: Label = style.label("", "Value")
	val.custom_minimum_size.x = 112
	val.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	return val

## Numeric setting as a slider with its value and unit. `on_release`: write only when the drag ends
## (for settings that would move the slider under the pointer, i.e. the HUD scale).
func _slider(key: String, title: String, hint := "", on_release := false) -> Label:
	var r := _row(title, hint)
	var spec: Dictionary = UIMath.SLIDERS[key]
	var rng: Array = Settings.range_of(key)
	var lo := float(rng[0])
	var hi := float(rng[1])
	var sl := UISlider.new()
	sl.apply_palette(style.pal)
	sl.min_value = lo * float(spec["scale"])
	sl.max_value = hi * float(spec["scale"])
	sl.step = float(spec["step"])
	var val := _value_label()
	(r[1] as HBoxContainer).add_child(sl)
	(r[1] as HBoxContainer).add_child(val)
	_track(r[0], sl, key)
	sl.value_changed.connect(func(x: float) -> void:
		var v := UIMath.from_slider(key, x, lo, hi)
		val.text = UIMath.format_setting(key, v)
		if sl.dragging:
			if not on_release:
				Settings.set_value(key, v, false)      # live, saved once when the drag ends
		else:
			Settings.set_value(key, v))
	sl.drag_ended.connect(func(_changed: bool) -> void:
		Settings.set_value(key, UIMath.from_slider(key, sl.value, lo, hi), false)
		Settings.save())
	_groups[_page].append([sl])
	var refresh := func() -> void:
		var v := Settings.getf(key)
		if not sl.dragging:
			sl.set_value_no_signal(UIMath.to_slider(key, v))
			sl.queue_redraw()
		val.text = UIMath.format_setting(key, v)
	_register(key, refresh, func() -> Control: return sl)
	return r[2]

func _fps_row() -> void:
	var key := "max_fps"
	var r := _row("Frame-rate cap", "Limits the frame rate when V-Sync is off or the display is faster than the cap.")
	var sl := UISlider.new()
	sl.apply_palette(style.pal)
	sl.min_value = 0
	sl.max_value = UIMath.FPS_STEPS.size() - 1
	sl.step = 1
	var val := _value_label()
	(r[1] as HBoxContainer).add_child(sl)
	(r[1] as HBoxContainer).add_child(val)
	_track(r[0], sl, key)
	sl.value_changed.connect(func(x: float) -> void:
		var fps := UIMath.index_to_fps(int(round(x)))
		val.text = UIMath.format_fps(fps)
		Settings.set_value(key, fps, not sl.dragging))
	sl.drag_ended.connect(func(_changed: bool) -> void: Settings.save())
	_groups[_page].append([sl])
	var refresh := func() -> void:
		var fps := int(Settings.get_value(key))
		if not sl.dragging:
			sl.set_value_no_signal(UIMath.fps_to_index(fps))
			sl.queue_redraw()
		val.text = UIMath.format_fps(fps)
	_register(key, refresh, func() -> Control: return sl)

func _toggle(key: String, title: String, hint := "") -> void:
	var r := _row(title, hint)
	var tg := UIToggle.new()
	tg.apply_palette(style.pal)
	(r[1] as HBoxContainer).add_child(tg)
	_track(r[0], tg, key)
	tg.toggled.connect(func(on: bool) -> void: Settings.set_value(key, on))
	_groups[_page].append([tg])
	var refresh := func() -> void:
		tg.set_pressed_no_signal(Settings.getb(key))
		tg.queue_redraw()
	_register(key, refresh, func() -> Control: return tg)

## One of a few named values as a segmented control. `notes`: value -> hint line for the selected value.
func _choice(key: String, title: String, hint: String, options: Array, notes := {}) -> void:
	var r := _row(title, hint if notes.is_empty() else " ")
	var right: HBoxContainer = r[1]
	right.add_theme_constant_override("separation", -1)
	var group := ButtonGroup.new()
	var btns: Array = []
	for o: Array in options:
		var b: Button = style.button(o[1], "Seg")
		b.toggle_mode = true
		b.button_group = group
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.custom_minimum_size.y = 36
		b.pressed.connect(func() -> void: Settings.set_value(key, o[0]))
		right.add_child(b)
		_track(r[0], b, key)
		btns.append(b)
	_groups[_page].append(btns)
	var hl: Label = r[2]
	var refresh := func() -> void:
		var cur: Variant = Settings.get_value(key)
		for i in options.size():
			(btns[i] as Button).set_pressed_no_signal(typeof(cur) == typeof(options[i][0]) and cur == options[i][0])
		if not notes.is_empty() and hl != null:
			hl.text = str(notes.get(cur, ""))
		if is_inside_tree() and _reset_btn != null:
			_link()
	_register(key, refresh, func() -> Control: return _primary(btns))

func _static_row(title: String, text: String) -> void:
	var r := _row(title, "")
	var l: Label = style.label(text, "SmallFaint")
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	(r[1] as HBoxContainer).add_child(l)
	((r[0] as PanelContainer).get_child(0).get_child(0).get_child(0) as Label).theme_type_variation = "BodyDim"

func _note(text: String, warn := false) -> void:
	var p: PanelContainer = style.panel("NotePanel")
	var l: Label = style.wrap_label(text, "Warn" if warn else "SmallDim")
	p.add_child(l)
	_lists[_page].add_child(p)
	_lists[_page].add_child(style.spacer(0, 8))

func _perf_row() -> void:
	var persistent: bool = Settings.DEFAULTS.has(PERF_KEY)
	var r := _row("Performance read-out", "Debug: frames per second and frame time in the top-right corner."
		+ ("" if persistent else " Not saved between sessions."))
	var tg := UIToggle.new()
	tg.apply_palette(style.pal)
	(r[1] as HBoxContainer).add_child(tg)
	_track(r[0], tg, PERF_KEY)
	tg.set_pressed_no_signal(ui.is_perf_readout())
	tg.toggled.connect(func(on: bool) -> void: ui.set_perf_readout(on))
	_groups[_page].append([tg])
	if persistent:
		var refresh := func() -> void:
			tg.set_pressed_no_signal(Settings.getb(PERF_KEY))
			tg.queue_redraw()
		_register(PERF_KEY, refresh, func() -> Control: return tg)
	else:
		_focus_of[PERF_KEY] = func() -> Control: return tg

func _refresh_render_hint() -> void:
	if _render_hint == null or not is_inside_tree():
		return
	var win := Vector2(get_window().size)
	var s := Settings.getf("render_scale")
	_render_hint.text = "Internal 3D resolution: %d × %d. Lower is faster and softer." % [int(round(win.x * s)), int(round(win.y * s))]

# ------------------------------------------------------------------------------------------------

func _on_setting_changed(key: String) -> void:
	if _refreshers.has(key):
		for cb: Callable in _refreshers[key]:
			cb.call()
	if key == "render_scale":
		_refresh_render_hint()

func _ask_reset() -> void:
	ui.confirm("Reset all settings?",
		"Every setting on all four pages returns to its default, including volume and graphics quality. Key bindings are not affected.",
		"Reset", func() -> void: Settings.reset_all())

func _primary(group: Array) -> Control:
	for c: Control in group:
		if c is BaseButton and group.size() > 1 and (c as BaseButton).button_pressed:
			return c
	return group[0]

## Explicit focus neighbours for the visible page: tabs <-> rows <-> footer, no leaks to hidden pages.
func _link() -> void:
	if _reset_btn == null:
		return
	var groups: Array = _groups[_tab]
	var n := _tab_buttons.size()
	var first: Control = _primary(groups[0]) if not groups.is_empty() else _back_btn
	for i in n:
		var b := _tab_buttons[i]
		UIStyle.set_neighbor(b, SIDE_LEFT, _tab_buttons[maxi(i - 1, 0)])
		UIStyle.set_neighbor(b, SIDE_RIGHT, _tab_buttons[mini(i + 1, n - 1)])
		UIStyle.set_neighbor(b, SIDE_TOP, b)
		UIStyle.set_neighbor(b, SIDE_BOTTOM, first)
	var prev: Control = _tab_buttons[_tab]
	for gi in groups.size():
		var g: Array = groups[gi]
		var next: Control = _primary(groups[gi + 1]) if gi + 1 < groups.size() else _back_btn
		for ci in g.size():
			var c: Control = g[ci]
			UIStyle.set_neighbor(c, SIDE_TOP, prev)
			UIStyle.set_neighbor(c, SIDE_BOTTOM, next)
			if not (c is Slider):
				UIStyle.set_neighbor(c, SIDE_LEFT, g[maxi(ci - 1, 0)])
				UIStyle.set_neighbor(c, SIDE_RIGHT, g[mini(ci + 1, g.size() - 1)])
		prev = _primary(g)
	for b: Button in [_reset_btn, _back_btn]:
		UIStyle.set_neighbor(b, SIDE_TOP, prev)
		UIStyle.set_neighbor(b, SIDE_BOTTOM, b)
	UIStyle.set_neighbor(_reset_btn, SIDE_LEFT, _reset_btn)
	UIStyle.set_neighbor(_reset_btn, SIDE_RIGHT, _back_btn)
	UIStyle.set_neighbor(_back_btn, SIDE_LEFT, _reset_btn)
	UIStyle.set_neighbor(_back_btn, SIDE_RIGHT, _back_btn)
