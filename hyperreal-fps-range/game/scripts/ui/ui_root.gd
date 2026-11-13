extends CanvasLayer
## UI root (scene res://scenes/ui/ui.tscn). Public API (docs/ARCHITECTURE.md):
##   bind(game), show_loading(progress, text), hide_loading(), toast(text, seconds),
##   fade_notice(text, seconds), open_group_inspector(), is_blocking_input()
## plus cycle_overlay() and set_perf_readout(on) for convenience.
##
## Structure: three scaled layers, each a Control whose `scale` is derived from the window height
## (reference 1080) and Settings.hud_scale -
##   HudLayer   in-play HUD                                   (hud scale)
##   MenuLayer  backdrop, pause menu, settings, controls,     (menu scale = hud scale, limited so that
##              shot-group inspector, confirm dialog           1280 x 720 layout units always fit)
##   TopLayer   toasts, fade notice, loading screen           (hud scale)
## Fonts are rasterised at the layer scale, so text is crisp at any window size.
##
## Input: while a screen is open this node consumes Esc / the pause action (back / resume) in _input and
## swallows remaining unhandled key and mouse-button events, so nothing reaches the game.

const UIStyle := preload("res://scripts/ui/ui_style.gd")
const UIMath := preload("res://scripts/ui/ui_math.gd")
const Hud := preload("res://scripts/ui/hud.gd")
const Notices := preload("res://scripts/ui/notices.gd")
const LoadingScreen := preload("res://scripts/ui/loading_screen.gd")
const PauseMenu := preload("res://scripts/ui/pause_menu.gd")
const SettingsScreen := preload("res://scripts/ui/settings_screen.gd")
const ControlsScreen := preload("res://scripts/ui/controls_screen.gd")
const GroupInspector := preload("res://scripts/ui/group_inspector.gd")
const ConfirmDialog := preload("res://scripts/ui/confirm_dialog.gd")

const SCREEN_NONE := ""
const SCREEN_PAUSE := "pause"
const SCREEN_SETTINGS := "settings"
const SCREEN_CONTROLS := "controls"
const SCREEN_INSPECTOR := "inspector"

const BACKDROP_SHADER := """
shader_type canvas_item;
render_mode unshaded;
uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap, repeat_disable;
uniform float blur_lod = 2.4;
uniform vec4 tint : source_color = vec4(0.015, 0.017, 0.02, 0.62);
void fragment() {
	vec3 c = textureLod(screen_tex, SCREEN_UV, blur_lod).rgb;
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	c = mix(c, vec3(l), 0.35);
	COLOR = vec4(mix(c, tint.rgb, tint.a), 1.0);
}
"""

var game: Node
var style

var hud: Control
var notices: Control
var loading: Control
var pause_menu: Control
var settings_screen: Control
var controls_screen: Control
var inspector: Control
var confirm_dialog: Control

var _hud_layer: Control
var _menu_layer: Control
var _top_layer: Control
var _backdrop: ColorRect
var _screen := SCREEN_NONE
var _inspector_from_play := false
var _closed_frame := -1
var _perf_on := false
var _hud_s := 1.0
var _menu_s := 1.0
var _targets: Node
var _rebuild_queued := false
var _loading_progress := 0.0
var _loading_text := ""

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if Settings.DEFAULTS.has(SettingsScreen.PERF_KEY):
		_perf_on = Settings.getb(SettingsScreen.PERF_KEY)
	_build()
	get_viewport().size_changed.connect(_update_scale)
	Settings.changed.connect(_on_setting_changed)

# ------------------------------------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------------------------------------

## Called once by main. `game` provides the methods/signals listed in docs/ARCHITECTURE.md.
func bind(p_game: Node) -> void:
	game = p_game
	if game == null:
		return
	if game.has_signal("paused_changed") and not game.is_connected("paused_changed", _on_paused_changed):
		game.connect("paused_changed", _on_paused_changed)
	if game.has_signal("notice") and not game.is_connected("notice", _on_notice):
		game.connect("notice", _on_notice)
	if game.has_signal("session_restarted") and not game.is_connected("session_restarted", _on_session_restarted):
		game.connect("session_restarted", _on_session_restarted)
	hud.bind(game)
	_connect_targets()
	if not loading.visible:
		hud.enter_range()
	if game.has_method("is_paused") and game.is_paused() and _screen == SCREEN_NONE:
		_show_screen(SCREEN_PAUSE)

func show_loading(progress: float, text: String) -> void:
	_loading_progress = progress
	_loading_text = text
	loading.set_progress(progress, text)
	if not loading.visible:
		loading.visible = true
		_sync_hud_visibility()

func hide_loading() -> void:
	if not loading.visible:
		return
	loading.visible = false
	_closed_frame = Engine.get_process_frames()
	_sync_hud_visibility()
	_connect_targets()
	hud.enter_range()

## One quiet line at the bottom centre.
func toast(text: String, seconds := 2.5) -> void:
	notices.toast(text, seconds)

## Quick dip to black with `text`; `seconds` is the time held fully black (plus ~0.15 s in, 0.3 s out).
func fade_notice(text: String, seconds := 0.6) -> void:
	notices.fade_notice(text, seconds)

## Opens the shot-group inspector. From play it pauses the game and resumes on close;
## from the pause menu it returns to the menu.
func open_group_inspector() -> void:
	if loading.visible or _screen == SCREEN_INSPECTOR:
		return
	_inspector_from_play = _screen == SCREEN_NONE
	_show_screen(SCREEN_INSPECTOR)
	if _inspector_from_play and game != null and game.has_method("set_paused"):
		if not (game.has_method("is_paused") and game.is_paused()):
			game.set_paused(true)

## True while a menu, the inspector or the loading screen owns input (and for the frame in which it closed,
## so a click or key that closed the UI cannot also act in the game).
func is_blocking_input() -> bool:
	return _screen != SCREEN_NONE or loading.visible or Engine.get_process_frames() <= _closed_frame

## Steps the overlay cycle (same as the toggle_overlay action) and names the new state in a toast.
func cycle_overlay() -> void:
	toast(hud.cycle_overlay(), 2.0)

func set_perf_readout(on: bool) -> void:
	_perf_on = on
	hud.show_perf = on
	if Settings.DEFAULTS.has(SettingsScreen.PERF_KEY):
		Settings.set_value(SettingsScreen.PERF_KEY, on)

func is_perf_readout() -> bool:
	return _perf_on

func get_screen() -> String:
	return _screen

## Shared modal question (used by the screens).
func confirm(title: String, text: String, ok_text: String, on_ok: Callable, cancel_text := "Cancel") -> void:
	confirm_dialog.ask(title, text, ok_text, on_ok, cancel_text)

# ------------------------------------------------------------------------------------------------
# Construction
# ------------------------------------------------------------------------------------------------

func _layer(layer_name: String, theme: Theme) -> Control:
	var c := Control.new()
	c.name = layer_name
	c.mouse_filter = Control.MOUSE_FILTER_IGNORE
	c.theme = theme
	add_child(c)
	return c

func _build() -> void:
	style = UIStyle.new(Settings.getb("high_contrast_hud"))
	_hud_layer = _layer("HudLayer", style.theme_hud)
	_menu_layer = _layer("MenuLayer", style.theme_menu)
	_top_layer = _layer("TopLayer", style.theme_hud)

	hud = Hud.new()
	hud.name = "Hud"
	_hud_layer.add_child(hud)
	hud.setup(style)
	hud.show_perf = _perf_on

	_backdrop = ColorRect.new()
	_backdrop.name = "Backdrop"
	_backdrop.mouse_filter = Control.MOUSE_FILTER_STOP
	_backdrop.color = style.c("backdrop")
	if not style.high_contrast:
		var sh := Shader.new()
		sh.code = BACKDROP_SHADER
		var mat := ShaderMaterial.new()
		mat.shader = sh
		mat.set_shader_parameter("tint", style.c("backdrop"))
		_backdrop.material = mat
	_menu_layer.add_child(_backdrop)
	_backdrop.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	pause_menu = PauseMenu.new()
	pause_menu.name = "PauseMenu"
	_menu_layer.add_child(pause_menu)
	pause_menu.setup(style)
	pause_menu.item_chosen.connect(_on_menu_item)

	settings_screen = SettingsScreen.new()
	settings_screen.name = "Settings"
	_menu_layer.add_child(settings_screen)
	settings_screen.setup(style, self)
	settings_screen.back_requested.connect(_back)

	controls_screen = ControlsScreen.new()
	controls_screen.name = "Controls"
	_menu_layer.add_child(controls_screen)
	controls_screen.setup(style, self)
	controls_screen.back_requested.connect(_back)

	inspector = GroupInspector.new()
	inspector.name = "GroupInspector"
	_menu_layer.add_child(inspector)
	inspector.setup(style, self)
	inspector.close_requested.connect(_back)

	confirm_dialog = ConfirmDialog.new()
	confirm_dialog.name = "Confirm"
	_menu_layer.add_child(confirm_dialog)
	confirm_dialog.setup(style)

	notices = Notices.new()
	notices.name = "Notices"
	_top_layer.add_child(notices)
	notices.setup(style)
	notices.obstacles = func() -> Array[Rect2]:
		return hud.get_obstacle_rects() if hud.visible else ([] as Array[Rect2])

	loading = LoadingScreen.new()
	loading.name = "Loading"
	_top_layer.add_child(loading)
	loading.setup(style)
	loading.visible = false

	for s: Control in [_backdrop, pause_menu, settings_screen, controls_screen, inspector]:
		s.visible = false
	_update_scale()

## Restyle (high-contrast switch): rebuild the tree with the new palette and restore what was showing.
func _rebuild() -> void:
	_rebuild_queued = false
	var screen := _screen
	var tab: int = settings_screen.get_tab()
	var focus_key: String = settings_screen.get_focused_key()
	var insp_index: int = inspector.get_target_index()
	var was_loading := loading.visible
	for l: Control in [_hud_layer, _menu_layer, _top_layer]:
		remove_child(l)
		l.queue_free()
	_screen = SCREEN_NONE
	_targets = null
	_build()
	if game != null and is_instance_valid(game):
		hud.bind(game)
		_connect_targets()
	hud.nudge_overlay()
	if was_loading:
		show_loading(_loading_progress, _loading_text)
	settings_screen.select_tab(tab)
	if screen != SCREEN_NONE:
		_show_screen(screen)
		if screen == SCREEN_INSPECTOR:
			inspector.set_target_index(insp_index)
		elif screen == SCREEN_SETTINGS and focus_key != "":
			settings_screen.focus_key(focus_key)
	_sync_hud_visibility()

func _update_scale() -> void:
	if _hud_layer == null:
		return
	var vp := get_viewport().get_visible_rect().size
	if vp.x < 1.0 or vp.y < 1.0:
		return
	var user := Settings.getf("hud_scale")
	_hud_s = UIMath.hud_scale_for(vp, user)
	_menu_s = UIMath.menu_scale_for(vp, user)
	style.set_oversampling(_hud_s, _menu_s)
	for pair: Array in [[_hud_layer, _hud_s], [_top_layer, _hud_s], [_menu_layer, _menu_s]]:
		var c: Control = pair[0]
		var s: float = pair[1]
		c.position = Vector2.ZERO
		c.scale = Vector2(s, s)
		c.size = vp / s
	# dividers stay at least one device pixel thick
	for n in get_tree().get_nodes_in_group(UIStyle.HAIR_GROUP):
		var r := n as Control
		if r == null or not is_ancestor_of(r):
			continue
		var s := _menu_s if _menu_layer.is_ancestor_of(r) else _hud_s
		var t := maxf(1.0, 1.0 / s)
		if int(r.get_meta("hair_axis", 1)) == 1:
			r.custom_minimum_size.y = t
		else:
			r.custom_minimum_size.x = t
	var space := vp / _menu_s
	settings_screen.layout(space)
	controls_screen.layout(space)
	inspector.layout(space)
	hud.on_scale_changed()

# ------------------------------------------------------------------------------------------------
# Screens
# ------------------------------------------------------------------------------------------------

func _show_screen(screen: String) -> void:
	var was := _screen
	_screen = screen
	confirm_dialog.dismiss()
	_backdrop.visible = screen != SCREEN_NONE
	pause_menu.visible = screen == SCREEN_PAUSE
	settings_screen.visible = screen == SCREEN_SETTINGS
	controls_screen.visible = screen == SCREEN_CONTROLS
	inspector.visible = screen == SCREEN_INSPECTOR
	_sync_hud_visibility()
	match screen:
		SCREEN_NONE:
			var f := get_viewport().gui_get_focus_owner()
			if f != null and is_ancestor_of(f):
				f.release_focus()
			if was != SCREEN_NONE:
				_closed_frame = Engine.get_process_frames()
		SCREEN_PAUSE:
			pause_menu.open(was)
		SCREEN_SETTINGS:
			settings_screen.open()
		SCREEN_CONTROLS:
			controls_screen.open()
		SCREEN_INSPECTOR:
			inspector.open(_get_targets())
	if screen != SCREEN_NONE and was == SCREEN_NONE:
		notices.clear_toast()       # in-play notices do not linger over the menu
	if screen != SCREEN_NONE and Input.mouse_mode != Input.MOUSE_MODE_VISIBLE:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _sync_hud_visibility() -> void:
	hud.visible = _screen == SCREEN_NONE and not loading.visible

## Esc / back: closes the innermost thing that is open.
func _back() -> void:
	if confirm_dialog.is_open():
		confirm_dialog.cancel()
		return
	match _screen:
		SCREEN_SETTINGS:
			_show_screen(SCREEN_PAUSE)
		SCREEN_CONTROLS:
			if not controls_screen.handle_back():
				_show_screen(SCREEN_PAUSE)
		SCREEN_INSPECTOR:
			if _inspector_from_play:
				_inspector_from_play = false
				_resume()
			else:
				_show_screen(SCREEN_PAUSE)
		SCREEN_PAUSE:
			_resume()

func _resume() -> void:
	if game != null and is_instance_valid(game) and game.has_method("set_paused"):
		game.set_paused(false)
		# main answers with paused_changed(false); close here too in case it does not
		if _screen != SCREEN_NONE and not (game.has_method("is_paused") and game.is_paused()):
			_show_screen(SCREEN_NONE)
	else:
		_show_screen(SCREEN_NONE)

func _on_menu_item(id: String) -> void:
	match id:
		"resume":
			_resume()
		"restart":
			confirm("Restart session?", "Targets, magazines and recorded shot groups return to their starting state.",
				"Restart", func() -> void:
					if game != null and game.has_method("restart_session"):
						game.restart_session()
					_resume())
		"reset_targets":
			if game != null and game.has_method("reset_targets"):
				game.reset_targets()       # main confirms with its own notice ("Targets reset")
		"groups":
			_inspector_from_play = false
			_show_screen(SCREEN_INSPECTOR)
		"settings":
			_show_screen(SCREEN_SETTINGS)
		"controls":
			_show_screen(SCREEN_CONTROLS)
		"quit":
			confirm("Quit Range Day?", "The session ends and the application closes.", "Quit", func() -> void:
				if game != null and game.has_method("quit_game"):
					game.quit_game()
				else:
					get_tree().quit())

# ------------------------------------------------------------------------------------------------
# Game / targets signals
# ------------------------------------------------------------------------------------------------

func _on_paused_changed(paused: bool) -> void:
	if paused:
		if _screen == SCREEN_NONE:
			_show_screen(SCREEN_PAUSE)
	else:
		_inspector_from_play = false
		if _screen != SCREEN_NONE:
			_show_screen(SCREEN_NONE)

func _on_notice(text: String) -> void:
	toast(text)

func _on_session_restarted() -> void:
	_connect_targets()
	hud.enter_range()
	if _screen == SCREEN_INSPECTOR:
		inspector.reload()

func _get_targets() -> Node:
	if _targets != null and is_instance_valid(_targets):
		return _targets
	_targets = null
	if game != null and is_instance_valid(game) and game.has_method("get_targets"):
		var t: Variant = game.get_targets()
		if t is Node and is_instance_valid(t):
			_targets = t
	return _targets

func _connect_targets() -> void:
	var t := _get_targets()
	if t == null:
		return
	if t.has_signal("target_hit") and not t.is_connected("target_hit", _on_target_hit):
		t.connect("target_hit", _on_target_hit)
	if t.has_signal("request_fade") and not t.is_connected("request_fade", _on_request_fade):
		t.connect("request_fade", _on_request_fade)
	if t.has_signal("layout_changed") and not t.is_connected("layout_changed", _on_layout_changed):
		t.connect("layout_changed", _on_layout_changed)

func _on_target_hit(info: Dictionary) -> void:
	hud._on_target_hit(info)

func _on_request_fade(text: String) -> void:
	# opaque from 0.14 s to 0.44 s: the stand jumps at 0.30 s (Targets.MOVE_DELAY)
	fade_notice(text, 0.3)

func _on_layout_changed() -> void:
	if _screen == SCREEN_INSPECTOR:
		inspector.reload()

func _on_setting_changed(key: String) -> void:
	match key:
		"hud_scale":
			_update_scale()
		"high_contrast_hud":
			if not _rebuild_queued:
				_rebuild_queued = true
				_rebuild.call_deferred()
		SettingsScreen.PERF_KEY:
			_perf_on = Settings.getb(key)
			hud.show_perf = _perf_on

# ------------------------------------------------------------------------------------------------
# Input
# ------------------------------------------------------------------------------------------------

func _input(event: InputEvent) -> void:
	if _screen == SCREEN_NONE:
		return
	if not (event is InputEventKey or event is InputEventMouseButton):
		return
	var back := event.is_action_pressed("ui_cancel") or (InputMap.has_action("pause") and event.is_action_pressed("pause"))
	if not back and _screen == SCREEN_INSPECTOR and not confirm_dialog.is_open():
		back = InputMap.has_action("inspect_group") and event.is_action_pressed("inspect_group")
	if back:
		get_viewport().set_input_as_handled()
		_back()

func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey or event is InputEventMouseButton):
		return
	if _screen != SCREEN_NONE or loading.visible:
		get_viewport().set_input_as_handled()
		return
	if InputMap.has_action("toggle_overlay") and event.is_action_pressed("toggle_overlay"):
		get_viewport().set_input_as_handled()
		cycle_overlay()
