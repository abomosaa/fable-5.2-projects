extends Control
## In-play HUD: controls overlay, optional practice read-out, last-hit line, optional aim dot and
## performance read-out. Deliberately quiet - no markers, counters or animations beyond slow fades.

const UIMath := preload("res://scripts/ui/ui_math.gd")
const UIStyle := preload("res://scripts/ui/ui_style.gd")
const Pips := preload("res://scripts/ui/widgets/ui_pips.gd")

const OVERLAY_ENTER_SECONDS := 10.0
const OVERLAY_NUDGE_SECONDS := 4.0
const OVERLAY_DIM := 0.0          # fully hidden after the initial display; F1 brings it back
const OVERLAY_DIM_HC := 0.6
const LAST_HIT_SECONDS := 3.0
const POLL_INTERVAL := 0.1
const PERF_INTERVAL := 0.25
const SLIDE_LOCKED := 2          # WeaponSim.Slide.LOCKED
const EDGE := 28.0               # distance of the corner panels from the screen edge

## label, actions, joiner
const OVERLAY_ROWS := [
	["Move", ["move_forward", "move_left", "move_back", "move_right"], " "],
	["Jog", ["jog"], ""],
	["Crouch", ["crouch"], ""],
	["Aim", ["aim"], ""],
	["Steady aim", ["steady"], ""],
	["Fire", ["fire"], ""],
	["Reload", ["reload"], ""],
	["Inspect pistol", ["inspect"], ""],
	["Safety / decock", ["safety"], ""],
	["Cock hammer", ["cock_hammer"], ""],
	["Target nearer / farther", ["target_nearer", "target_farther"], "  "],
	["Reset targets", ["reset_targets"], ""],
	["Inspect shot group", ["inspect_group"], ""],
	["Restart session", ["restart_session"], ""],
	["Overlays", ["toggle_overlay"], ""],
	["Menu", ["pause"], ""],
]

var style
var game: Node
var show_perf := false: set = set_show_perf

var _controls_panel: PanelContainer
var _key_labels: Array[Label] = []
var _overlay_on := true
var _overlay_full_t := 0.0
var _overlay_alpha := 0.0

var _corner: VBoxContainer
var _practice_panel: PanelContainer
var _practice_on := false
var _v_chamber: Label
var _v_mag: Label
var _v_spare: Label
var _v_hammer: Label
var _v_safety: Label
var _v_slide: Label
var _pips: Control
var _snap_sig := -1
var _poll_t := 0.0

var _last_panel: PanelContainer
var _last_label: Label
var _last_t := 0.0

var _aim_dot: Control
var _perf_panel: PanelContainer
var _perf_label: Label
var _perf_t := 0.0

func setup(p_style) -> void:
	style = p_style
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_build_controls_overlay()
	_build_corner()
	_build_aim_dot()
	_build_perf()
	_overlay_on = Settings.getb("controls_overlay")
	_practice_on = Settings.getb("practice_overlay")
	_practice_panel.visible = _practice_on
	_aim_dot.visible = Settings.getb("aim_dot")
	_controls_panel.modulate.a = 0.0
	_controls_panel.visible = false
	Settings.changed.connect(_on_setting_changed)
	Controls.bindings_changed.connect(_on_bindings_changed)
	visibility_changed.connect(func() -> void: set_process(is_visible_in_tree()))

func bind(p_game: Node) -> void:
	game = p_game
	_snap_sig = -1
	_refresh_weapon()

## Called when play (re)starts: the overlay is fully visible for a while, then recedes.
func enter_range() -> void:
	_overlay_full_t = OVERLAY_ENTER_SECONDS
	_snap_sig = -1

func nudge_overlay() -> void:
	_overlay_full_t = maxf(_overlay_full_t, OVERLAY_NUDGE_SECONDS)

# ------------------------------------------------------------------------------------------------
# Controls overlay
# ------------------------------------------------------------------------------------------------

func _build_controls_overlay() -> void:
	_controls_panel = style.panel("HudPanel")
	_controls_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_controls_panel)
	UIStyle.pin(_controls_panel, Vector2(0, 1), Vector2(EDGE, -EDGE))
	var grid := GridContainer.new()
	grid.columns = 5
	grid.mouse_filter = Control.MOUSE_FILTER_IGNORE
	grid.add_theme_constant_override("h_separation", 12)
	grid.add_theme_constant_override("v_separation", 3)
	_controls_panel.add_child(grid)
	var half := int(ceil(OVERLAY_ROWS.size() / 2.0))
	_key_labels.resize(OVERLAY_ROWS.size())
	for r in half:
		for col in 2:
			var i := r + col * half
			if col == 1:
				grid.add_child(style.spacer(14, 0))
			if i >= OVERLAY_ROWS.size():
				grid.add_child(style.spacer())
				grid.add_child(style.spacer())
				continue
			var key: Label = style.label("", "SmallValue")
			key.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
			key.size_flags_horizontal = Control.SIZE_FILL
			grid.add_child(key)
			_key_labels[i] = key
			grid.add_child(style.label(OVERLAY_ROWS[i][0], "SmallDim"))
	_refresh_bindings()

func _refresh_bindings() -> void:
	for i in OVERLAY_ROWS.size():
		var parts: PackedStringArray = []
		for action: String in OVERLAY_ROWS[i][1]:
			if InputMap.has_action(action):
				parts.append(UIMath.pretty_binding(Controls.binding_text(action)))
		var joiner: String = OVERLAY_ROWS[i][2]
		_key_labels[i].text = joiner.join(parts)
	UIStyle.repin(_controls_panel)

func _on_bindings_changed() -> void:
	_refresh_bindings()
	nudge_overlay()

## F1: controls -> hidden -> practice read-out -> controls + practice -> ... Returns the state name.
func cycle_overlay() -> String:
	var c := Settings.getb("controls_overlay")
	var p := Settings.getb("practice_overlay")
	var state_name := ""
	if c and not p:
		c = false
		state_name = "Overlays hidden"
	elif not c and not p:
		p = true
		state_name = "Practice read-out"
	elif not c and p:
		c = true
		state_name = "Controls + practice read-out"
	else:
		p = false
		state_name = "Controls overlay"
	Settings.set_value("controls_overlay", c)
	Settings.set_value("practice_overlay", p)
	if c:
		nudge_overlay()
	return state_name

# ------------------------------------------------------------------------------------------------
# Practice read-out + last hit (bottom-right corner)
# ------------------------------------------------------------------------------------------------

func _build_corner() -> void:
	_corner = style.vbox(8)
	_corner.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_corner.alignment = BoxContainer.ALIGNMENT_END
	add_child(_corner)
	UIStyle.pin(_corner, Vector2(1, 1), Vector2(-EDGE, -EDGE))

	_last_panel = style.panel("HudPanel")
	_last_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_last_panel.size_flags_horizontal = Control.SIZE_SHRINK_END
	_last_label = style.label("", "Small")
	_last_panel.add_child(_last_label)
	_last_panel.modulate.a = 0.0
	_last_panel.visible = false
	_corner.add_child(_last_panel)

	_practice_panel = style.panel("HudPanel")
	_practice_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_practice_panel.size_flags_horizontal = Control.SIZE_SHRINK_END
	_corner.add_child(_practice_panel)
	var grid := GridContainer.new()
	grid.columns = 2
	grid.mouse_filter = Control.MOUSE_FILTER_IGNORE
	grid.add_theme_constant_override("h_separation", 18)
	grid.add_theme_constant_override("v_separation", 5)
	_practice_panel.add_child(grid)

	_v_chamber = _practice_row(grid, "Chamber")
	grid.add_child(style.caps("Magazine", "CapsDim"))
	var mag_box: HBoxContainer = style.hbox(10)
	mag_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_pips = Pips.new()
	_pips.c_on = style.c("text")
	_pips.c_off = style.c("text_dim")
	mag_box.add_child(_pips)
	_v_mag = style.label("", "SmallValue")
	_v_mag.custom_minimum_size.x = 34
	mag_box.add_child(_v_mag)
	grid.add_child(mag_box)
	_v_spare = _practice_row(grid, "Spare mags")
	_v_hammer = _practice_row(grid, "Hammer")
	_v_safety = _practice_row(grid, "Safety")
	_v_slide = _practice_row(grid, "Slide")

func _practice_row(grid: GridContainer, title: String) -> Label:
	grid.add_child(style.caps(title, "CapsDim"))
	var v: Label = style.label("—", "SmallValue")
	grid.add_child(v)
	return v

func _refresh_weapon() -> void:
	if game == null or not is_instance_valid(game) or not game.has_method("get_weapon_snapshot"):
		return
	var s: Dictionary = game.get_weapon_snapshot()
	var chamber := bool(s.get("chamber", false))
	var mag := int(s.get("mag", 0))
	var mag_in := bool(s.get("mag_in", true))
	var cocked := bool(s.get("hammer_cocked", false))
	var safe := bool(s.get("safety", false))
	var spares := int(s.get("spares", 0))
	var locked := bool(s.get("slide_locked", int(s.get("slide", 0)) == SLIDE_LOCKED))
	var sig := (int(chamber)) | (int(mag_in) << 1) | (int(cocked) << 2) | (int(safe) << 3) | (int(locked) << 4) \
		| ((mag & 0xff) << 8) | ((spares & 0xff) << 16)
	if sig == _snap_sig:
		return
	_snap_sig = sig
	_v_chamber.text = "Loaded" if chamber else "Empty"
	_pips.set_state(mag, 8, mag_in)
	_v_mag.text = str(mag) if mag_in else "out"
	_v_spare.text = str(spares)
	_v_hammer.text = "Cocked" if cocked else "Down"
	_v_safety.text = "SAFE" if safe else "FIRE"
	_v_safety.add_theme_color_override("font_color", style.c("text") if safe else style.c("alert"))
	_v_slide.text = "Locked open" if locked else "Forward"

func _on_target_hit(info: Dictionary) -> void:
	if not (Settings.getb("hit_feedback") or Settings.getb("practice_overlay")):
		return
	var label := ""
	var tgt: Variant = info.get("target")
	if tgt is Object and is_instance_valid(tgt) and "label" in tgt:
		label = str(tgt.get("label"))
	_last_label.text = UIMath.hit_text(info, label)
	# one line normally; wraps only if it would otherwise run into the controls overlay
	var room := size.x - 2.0 * EDGE - 34.0
	if _overlay_on and _controls_panel.visible:
		room -= _controls_panel.size.x + EDGE
	var font := _last_label.get_theme_font("font")
	var need := font.get_string_size(_last_label.text, HORIZONTAL_ALIGNMENT_LEFT, -1, _last_label.get_theme_font_size("font_size")).x
	var wrap := need > room and room > 120.0
	_last_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART if wrap else TextServer.AUTOWRAP_OFF
	_last_label.custom_minimum_size.x = room if wrap else 0.0
	_last_panel.reset_size()
	UIStyle.repin(_corner)
	_last_t = LAST_HIT_SECONDS
	_last_panel.visible = true

# ------------------------------------------------------------------------------------------------
# Aim dot, performance read-out
# ------------------------------------------------------------------------------------------------

func _build_aim_dot() -> void:
	_aim_dot = Control.new()
	_aim_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_aim_dot)
	UIStyle.pin(_aim_dot, Vector2(0.5, 0.5), Vector2.ZERO)
	_aim_dot.draw.connect(_draw_aim_dot)

func _draw_aim_dot() -> void:
	# sized in device pixels: an even-sized light core with a one-pixel dark outline, centred on the view centre
	var s := maxf(_aim_dot.get_global_transform().get_scale().x, 0.01)
	var core := maxf(2.0, 2.0 * roundf(s)) / s
	var px := 1.0 / s
	_aim_dot.draw_rect(Rect2(-core * 0.5 - px, -core * 0.5 - px, core + 2.0 * px, core + 2.0 * px), Color(0, 0, 0, 0.85))
	_aim_dot.draw_rect(Rect2(-core * 0.5, -core * 0.5, core, core), Color(1, 1, 1, 0.95))

func _build_perf() -> void:
	_perf_panel = style.panel("HudPanel")
	_perf_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_perf_panel)
	UIStyle.pin(_perf_panel, Vector2(1, 0), Vector2(-EDGE, EDGE))
	_perf_label = style.label("", "SmallValue")
	_perf_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_perf_label.custom_minimum_size.x = 132
	_perf_panel.add_child(_perf_label)
	_perf_panel.visible = false

func set_show_perf(on: bool) -> void:
	show_perf = on
	if _perf_panel != null:
		_perf_panel.visible = on
		_perf_t = PERF_INTERVAL

# ------------------------------------------------------------------------------------------------

func _on_setting_changed(key: String) -> void:
	match key:
		"controls_overlay":
			_overlay_on = Settings.getb(key)
			if _overlay_on:
				nudge_overlay()
		"practice_overlay":
			_practice_on = Settings.getb(key)
			_practice_panel.visible = _practice_on
			_snap_sig = -1
			_poll_t = POLL_INTERVAL
		"aim_dot":
			_aim_dot.visible = Settings.getb(key)

## Rectangles (HUD layer units) of the corner panels that are currently showing.
func get_obstacle_rects() -> Array[Rect2]:
	var out: Array[Rect2] = []
	if _overlay_on and _controls_panel.visible:
		out.append(_controls_panel.get_rect())
	if _practice_on or _last_panel.visible:
		out.append(_corner.get_rect())
	return out

func on_scale_changed() -> void:
	_aim_dot.queue_redraw()

func _process(delta: float) -> void:
	# controls overlay: full -> dim -> hidden, slow fades
	if _overlay_full_t > 0.0:
		_overlay_full_t -= delta
	var target := 0.0
	if _overlay_on:
		target = 1.0 if _overlay_full_t > 0.0 else (OVERLAY_DIM_HC if style.high_contrast else OVERLAY_DIM)
	if _overlay_alpha != target:
		_overlay_alpha = move_toward(_overlay_alpha, target, delta * (3.0 if target > _overlay_alpha else 0.9))
		_controls_panel.modulate.a = _overlay_alpha
		_controls_panel.visible = _overlay_alpha > 0.004

	if _practice_on:
		_poll_t += delta
		if _poll_t >= POLL_INTERVAL:
			_poll_t = 0.0
			_refresh_weapon()

	if _last_panel.visible:
		_last_t -= delta
		var a := clampf(_last_t / 0.5, 0.0, 1.0)
		_last_panel.modulate.a = minf(a, clampf((LAST_HIT_SECONDS - _last_t) / 0.15, 0.0, 1.0))
		if _last_t <= 0.0:
			_last_panel.visible = false

	if show_perf:
		_perf_t += delta
		if _perf_t >= PERF_INTERVAL:
			_perf_t = 0.0
			var fps := Engine.get_frames_per_second()
			var ms := 0.0
			if game != null and is_instance_valid(game) and game.has_method("get_perf"):
				var p: Dictionary = game.get_perf()
				fps = float(p.get("fps", fps))
				ms = float(p.get("frame_ms", 0.0))
			elif fps > 0.0:
				ms = 1000.0 / fps
			_perf_label.text = "%d fps  ·  %.1f ms" % [int(round(fps)), ms]
