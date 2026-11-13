extends Node3D
## Stand-alone harness for the UI module (not part of the game). Provides a fake `game` and a fake
## Targets node, walks through every screen, checks behaviour and saves viewport PNGs.
##
##   XDG_DATA_HOME=/tmp/fpsr-ui-xdg $GODOT --path game res://scenes/ui/ui_harness.tscn -- --out=<dir>
##       [--no-targets] [--trace] [--interactive]
##
## Use a private XDG_DATA_HOME: the walk-through changes settings and bindings.

const UI_SCENE := "res://scenes/ui/ui.tscn"

# ------------------------------------------------------------------------------------------------
class FakePaper extends RefCounted:
	var label := "Paper A"
	var distance_m := 15.0
	var face_size_mm := Vector2(500, 500)
	var _hits: Array[Dictionary] = []
	var _tex: ImageTexture
	var _px_per_mm := 2.0

	func _init(p_label: String, p_dist: float, p_face: Vector2) -> void:
		label = p_label
		distance_m = p_dist
		face_size_mm = p_face
		_redraw()

	func get_hits() -> Array[Dictionary]:
		return _hits

	func get_face_texture() -> Texture2D:
		return _tex

	func clear() -> void:
		_hits.clear()
		_redraw()

	static func score_at(p: Vector2) -> int:
		return maxi(0, 10 - int(floor(p.length() / 25.0)))

	func add_hit(p: Vector2) -> Dictionary:
		var h := {"pos_mm": p, "score": score_at(p)}
		_hits.append(h)
		_redraw()
		return h

	func _redraw() -> void:
		var w := int(face_size_mm.x * _px_per_mm)
		var h := int(face_size_mm.y * _px_per_mm)
		var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
		var c := Vector2(w, h) * 0.5
		for y in h:
			for x in w:
				var r_mm := Vector2(x + 0.5 - c.x, y + 0.5 - c.y).length() / _px_per_mm
				var col := Color(0.87, 0.85, 0.8)
				if r_mm < 100.0:
					col = Color(0.07, 0.07, 0.07)
				var ring := fmod(r_mm, 25.0)
				if r_mm < 250.0 and ring > 24.0:
					col = Color(0.8, 0.8, 0.78) if r_mm < 100.0 else Color(0.1, 0.1, 0.1)
				img.set_pixel(x, y, col)
		for hit in _hits:
			var p: Vector2 = c + Vector2(hit["pos_mm"].x, -hit["pos_mm"].y) * _px_per_mm
			var rr := 4.5 * _px_per_mm
			for y in range(int(p.y - rr - 2), int(p.y + rr + 3)):
				for x in range(int(p.x - rr - 2), int(p.x + rr + 3)):
					if x < 0 or y < 0 or x >= w or y >= h:
						continue
					var d := Vector2(x + 0.5, y + 0.5).distance_to(p)
					if d < rr:
						img.set_pixel(x, y, Color(0.02, 0.02, 0.02))
					elif d < rr + 1.6:
						img.set_pixel(x, y, Color(0.62, 0.6, 0.55))
		_tex = ImageTexture.create_from_image(img)

# ------------------------------------------------------------------------------------------------
class FakeTargets extends Node:
	signal target_hit(info: Dictionary)
	signal layout_changed
	signal request_fade(text: String)
	var papers: Array = []
	var selected := 1

	func get_paper_targets() -> Array:
		return papers

	func get_selected_paper_target() -> Variant:
		return papers[selected] if selected < papers.size() else null

	func reset_all() -> void:
		for p in papers:
			p.clear()

	func get_stats() -> Dictionary:
		return {}

# ------------------------------------------------------------------------------------------------
class FakeGame extends Node:
	signal paused_changed(paused: bool)
	signal notice(text: String)
	signal session_restarted
	var targets: Node
	var snap := {"chamber": true, "mag": 5, "mag_in": true, "hammer_cocked": true, "safety": false, "slide": 0,
		"spares": 5, "total": 46, "shots": 3}
	var _paused := false
	var log: Array[String] = []

	func get_weapon_snapshot() -> Dictionary:
		return snap
	func get_targets() -> Node:
		return targets
	func set_paused(p: bool) -> void:
		if p == _paused:
			return
		_paused = p
		get_tree().paused = p
		log.append("set_paused(%s)" % p)
		paused_changed.emit(p)
	func is_paused() -> bool:
		return _paused
	func restart_session() -> void:
		log.append("restart_session")
		session_restarted.emit()
	func reset_targets() -> void:
		log.append("reset_targets")
		if targets != null:
			targets.reset_all()
		notice.emit("Targets reset")
	func quit_game() -> void:
		log.append("quit_game")
	func get_perf() -> Dictionary:
		var fps := Engine.get_frames_per_second()
		return {"fps": fps, "frame_ms": 1000.0 / maxf(fps, 1.0)}

# ------------------------------------------------------------------------------------------------
var ui: CanvasLayer
var game: FakeGame
var targets: FakeTargets
var out_dir := "user://ui_shots"
var tag := ""
var interactive := false
var no_targets := false
var failures: Array[String] = []
var checks := 0

func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--out="):
			out_dir = a.substr(6)
		elif a == "--interactive":
			interactive = true
		elif a == "--no-targets":
			no_targets = true
	DirAccess.make_dir_recursive_absolute(out_dir)
	if OS.get_cmdline_user_args().has("--trace"):
		Settings.changed.connect(func(k: String) -> void: print("  setting ", k, " = ", Settings.get_value(k)))
	_build_world()
	game = FakeGame.new()
	game.name = "FakeGame"
	add_child(game)
	if not no_targets:
		targets = FakeTargets.new()
		targets.name = "Targets"
		add_child(targets)
		var a := FakePaper.new("Lane 2 paper", 10.0, Vector2(500, 500))
		var b := FakePaper.new("Lane 3 paper", 15.0, Vector2(450, 600))
		targets.papers = [a, b]
		var rng := RandomNumberGenerator.new()
		rng.seed = 7
		for i in 8:
			b.add_hit(Vector2(18.0 + rng.randfn(0.0, 26.0), -12.0 + rng.randfn(0.0, 30.0)))
		for p in [Vector2(-40, 22), Vector2(-12, 60), Vector2(30, 5)]:
			a.add_hit(p)
		game.targets = targets
	ui = (load(UI_SCENE) as PackedScene).instantiate()
	add_child(ui)
	ui.show_loading(0.0, "Starting…")
	if interactive:
		_interactive.call_deferred()
	else:
		_walk.call_deferred()

func _build_world() -> void:
	var env := Environment.new()
	var sky_mat := ProceduralSkyMaterial.new()
	sky_mat.sky_top_color = Color(0.25, 0.45, 0.8)
	sky_mat.sky_horizon_color = Color(0.75, 0.82, 0.9)
	sky_mat.ground_horizon_color = Color(0.6, 0.6, 0.55)
	var sky := Sky.new()
	sky.sky_material = sky_mat
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-48, 35, 0)
	sun.light_energy = 1.4
	sun.shadow_enabled = true
	add_child(sun)
	var ground := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(200, 200)
	ground.mesh = pm
	var gm := StandardMaterial3D.new()
	gm.albedo_color = Color(0.62, 0.6, 0.54)
	ground.material_override = gm
	add_child(ground)
	for i in 5:
		var box := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(0.5, 0.7, 0.02)
		box.mesh = bm
		var m := StandardMaterial3D.new()
		m.albedo_color = Color(0.95, 0.94, 0.9)
		box.material_override = m
		box.position = Vector3(-4.0 + i * 2.0, 1.4, -10.0 - i * 3.0)
		add_child(box)
		var post := MeshInstance3D.new()
		var pmesh := BoxMesh.new()
		pmesh.size = Vector3(0.06, 1.1, 0.06)
		post.mesh = pmesh
		post.position = box.position + Vector3(0, -0.85, 0)
		add_child(post)
	var berm := MeshInstance3D.new()
	var berm_mesh := BoxMesh.new()
	berm_mesh.size = Vector3(60, 6, 4)
	berm.mesh = berm_mesh
	var berm_mat := StandardMaterial3D.new()
	berm_mat.albedo_color = Color(0.42, 0.36, 0.26)
	berm.material_override = berm_mat
	berm.position = Vector3(0, 3, -40)
	add_child(berm)
	var cam := Camera3D.new()
	cam.position = Vector3(0, 1.62, 0)
	cam.fov = 74
	add_child(cam)
	cam.make_current()

# ------------------------------------------------------------------------------------------------
func _frames(n: int) -> void:
	for i in n:
		await get_tree().process_frame

## Waits in game time (the same smoothed frame delta the UI's own timers see), also while paused.
func _wait(seconds: float) -> void:
	await get_tree().create_timer(seconds, true, false, false).timeout

func _shot(shot_name: String) -> void:
	await _frames(3)
	if DisplayServer.get_name() == "headless":
		return
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var path := "%s/%s%s.png" % [out_dir, shot_name, tag]
	img.save_png(path)
	print("shot ", path, " ", img.get_size())

func _check(ok: bool, what: String) -> void:
	checks += 1
	if not ok:
		failures.append(what)
		print("  FAIL: ", what)

func _key(code: Key) -> void:
	for pressed in [true, false]:
		var ev := InputEventKey.new()
		ev.keycode = code
		ev.physical_keycode = code
		ev.pressed = pressed
		Input.parse_input_event(ev)
		await _frames(2)

func _click(pos: Vector2, button := MOUSE_BUTTON_LEFT) -> void:
	var mm := InputEventMouseMotion.new()
	mm.position = pos
	mm.global_position = pos
	Input.parse_input_event(mm)
	await _frames(2)
	for pressed in [true, false]:
		var ev := InputEventMouseButton.new()
		ev.button_index = button
		ev.pressed = pressed
		ev.position = pos
		ev.global_position = pos
		Input.parse_input_event(ev)
		await _frames(2)

func _focus_text() -> String:
	var f := get_viewport().gui_get_focus_owner()
	if f == null:
		return "<none>"
	if f.has_meta("setting_key"):
		return "setting:" + str(f.get_meta("setting_key"))
	if f is Button:
		return (f as Button).text
	return f.get_class()

func _center_of(c: Control) -> Vector2:
	return c.get_global_transform() * (c.size * 0.5)

func _interactive() -> void:
	await _wait(0.8)
	ui.show_loading(1.0, "Ready")
	await _wait(0.4)
	ui.hide_loading()
	ui.bind(game)
	print("interactive: Esc menu, F1 overlays, T shot groups (forwarded by the harness)")

func _unhandled_input(event: InputEvent) -> void:
	if not interactive or ui == null or ui.is_blocking_input():
		return
	if event.is_action_pressed("pause"):
		game.set_paused(true)
	elif event.is_action_pressed("inspect_group"):
		ui.open_group_inspector()
	elif event.is_action_pressed("fire") and targets != null:
		var p: FakePaper = targets.papers[targets.selected]
		var pos := Vector2(randfn(0.0, 40.0), randfn(0.0, 40.0))
		var h := p.add_hit(pos)
		targets.target_hit.emit({"kind": "paper", "distance_m": p.distance_m, "score": h["score"], "pos_mm": pos, "target": p})

# ------------------------------------------------------------------------------------------------
func _walk() -> void:
	await _frames(10)
	await _run_resolution("")
	# 1280 x 720
	get_window().size = Vector2i(1280, 720)
	await _frames(12)
	var vs := get_viewport().get_visible_rect().size
	if vs.is_equal_approx(Vector2(1280, 720)):
		tag = "_720p"
		await _run_small()
	else:
		print("window resize to 1280x720 not honoured (", vs, "); skipping 720p shots")
	# 2560 x 1440 (if the compositor allows a window that large), then fullscreen and back
	get_window().size = Vector2i(2560, 1440)
	await _frames(12)
	vs = get_viewport().get_visible_rect().size
	if vs.is_equal_approx(Vector2(2560, 1440)):
		tag = "_1440p"
		await _run_large()
	else:
		print("window resize to 2560x1440 not honoured (", vs, "); skipping 1440p shots")
	for mode in [Window.MODE_FULLSCREEN, Window.MODE_WINDOWED]:
		get_window().mode = mode
		await _frames(12)
		_check_layers("after window mode %d" % mode)
	print("CHECKS %d  FAILURES %d" % [checks, failures.size()])
	for f in failures:
		print("FAILED: ", f)
	get_tree().quit(1 if not failures.is_empty() else 0)

func _run_resolution(_t: String) -> void:
	# ---- loading
	ui.show_loading(0.42, "Compiling shaders…")
	_check(ui.is_blocking_input(), "loading blocks input")
	await _shot("01_loading")
	ui.show_loading(1.0, "Ready")
	ui.hide_loading()
	ui.bind(game)
	await _frames(2)
	_check(not ui.is_blocking_input(), "not blocking in play")

	# ---- HUD: controls overlay full, then receded
	await _wait(0.6)
	await _shot("02_hud_controls_full")
	_check(is_equal_approx(ui.hud._controls_panel.modulate.a, 1.0), "overlay full after entering the range")
	ui.hud._overlay_full_t = 0.0
	await _wait(1.3)
	_check(absf(ui.hud._controls_panel.modulate.a - 0.25) < 0.01, "overlay recedes to 25 %")
	await _shot("03_hud_controls_receded")

	# ---- F1 cycle (through the real input path)
	var names: Array[String] = []
	for i in 4:
		await _key(KEY_F1)
		names.append("%s/%s" % [Settings.getb("controls_overlay"), Settings.getb("practice_overlay")])
	_check(",".join(names) == "false/false,false/true,true/true,true/false", "F1 cycle order: %s" % [names])
	await _shot("04_hud_toast_cycle")

	# ---- practice read-out + last hit + aim dot + perf
	Settings.set_value("practice_overlay", true)
	Settings.set_value("aim_dot", true)
	ui.set_perf_readout(true)
	await _wait(0.3)
	if targets != null:
		var p: FakePaper = targets.papers[1]
		targets.target_hit.emit({"kind": "paper", "distance_m": 15.0, "score": 9, "pos_mm": Vector2(34, -12), "target": p})
	else:
		ui.hud._on_target_hit({"kind": "paper", "distance_m": 15.0, "score": 9, "pos_mm": Vector2(34, -12)})
	await _wait(0.5)
	_check(ui.hud._last_panel.visible, "last-hit line visible with practice read-out on")
	_check(ui.hud._v_safety.text == "FIRE" and ui.hud._v_chamber.text == "Loaded", "practice read-out reflects snapshot")
	await _shot("05_hud_practice_hit_aimdot_perf")
	game.snap = {"chamber": false, "mag": 0, "mag_in": true, "hammer_cocked": false, "safety": true, "slide": 2, "spares": 4}
	if targets != null:
		targets.target_hit.emit({"kind": "steel", "distance_m": 15.0})
	else:
		ui.hud._on_target_hit({"kind": "steel", "distance_m": 15.0})
	await _wait(0.4)
	_check(ui.hud._v_slide.text == "Locked open" and ui.hud._v_safety.text == "SAFE", "read-out follows snapshot changes")
	_check(ui.hud._last_label.text == "Steel  ·  15 m", "steel hit text: " + ui.hud._last_label.text)
	await _shot("06_hud_practice_empty_steel")
	await _wait(3.2)
	_check(not ui.hud._last_panel.visible, "last-hit line gone after 3 s (remaining %.2f s)" % ui.hud._last_t)
	Settings.set_value("practice_overlay", false)
	Settings.set_value("hit_feedback", false)
	ui.hud._on_target_hit({"kind": "steel", "distance_m": 15.0})
	_check(not ui.hud._last_panel.visible, "no hit text when hit feedback and practice read-out are off")
	Settings.set_value("aim_dot", false)
	ui.set_perf_readout(false)
	game.snap = {"chamber": true, "mag": 5, "mag_in": true, "hammer_cocked": true, "safety": false, "slide": 0, "spares": 5}

	# ---- fade notice
	if targets != null:
		targets.request_fade.emit("Moving target to 20 m")
	else:
		ui.fade_notice("Moving target to 20 m")
	await _wait(0.35)
	await _shot("07_fade_notice")
	await _wait(1.2)
	_check(not ui.notices.is_fading(), "fade notice ends")

	# ---- pause menu
	game.set_paused(true)
	await _frames(3)
	_check(ui.is_blocking_input(), "pause menu blocks input")
	_check(_focus_text() == "Resume", "pause menu focuses Resume: " + _focus_text())
	await _shot("08_pause_menu")
	await _key(KEY_DOWN)
	await _key(KEY_DOWN)
	_check(_focus_text() == "Reset targets", "arrow keys move focus: " + _focus_text())
	await _key(KEY_UP)
	await _key(KEY_UP)
	await _key(KEY_UP)
	_check(_focus_text() == "Quit", "focus wraps around: " + _focus_text())
	await _key(KEY_LEFT)
	_check(_focus_text() == "Quit", "left does not leave the menu: " + _focus_text())
	await _key(KEY_ENTER)
	_check(ui.confirm_dialog.is_open(), "Quit asks first")
	await _shot("09_pause_quit_confirm")
	await _key(KEY_ESCAPE)
	_check(not ui.confirm_dialog.is_open() and ui.get_screen() == "pause", "Esc cancels the question only")
	_check(not game.log.has("quit_game"), "quit not called on cancel")
	await _key(KEY_ESCAPE)
	_check(not game.is_paused() and ui.get_screen() == "", "Esc resumes")
	await _frames(3)
	_check(not ui.is_blocking_input(), "not blocking after resume")
	game.set_paused(true)
	await _frames(2)
	ui._back()
	_check(not game.is_paused() and ui.is_blocking_input(), "still blocking in the frame the menu closed")
	await _frames(3)
	_check(not ui.is_blocking_input(), "not blocking one frame later")

	# mouse: click "Settings"
	game.set_paused(true)
	await _frames(3)
	await _click(_center_of(ui.pause_menu._buttons["settings"]))
	_check(ui.get_screen() == "settings", "mouse click opens Settings: " + ui.get_screen())
	if ui.get_screen() != "settings":
		ui._show_screen("settings")

	# ---- settings pages
	var tabs := ["view", "audio", "graphics", "practice"]
	for i in 4:
		ui.settings_screen.select_tab(i)
		ui.settings_screen._tab_buttons[i].grab_focus()
		await _key(KEY_DOWN)
		if i == 1:
			await _key(KEY_DOWN)
		await _shot("1%d_settings_%s" % [i, tabs[i]])
	# keyboard: View tab, slider changes value through Settings
	ui.settings_screen.select_tab(0)
	ui.settings_screen._tab_buttons[0].grab_focus()
	await _key(KEY_DOWN)
	_check(_focus_text() == "setting:fov", "down from tab reaches first row: " + _focus_text())
	var fov0 := Settings.getf("fov")
	await _key(KEY_RIGHT)
	_check(is_equal_approx(Settings.getf("fov"), fov0 + 1.0), "right arrow changes FOV by one degree: %s" % Settings.getf("fov"))
	Settings.set_value("fov", 90.0)
	await _frames(2)
	_check(is_equal_approx((ui.settings_screen._focus_of["fov"] as Callable).call().value, 90.0), "slider reflects external change")
	await _key(KEY_RIGHT)
	await _key(KEY_RIGHT)
	_check(_focus_text() == "setting:fov", "left/right stay on the slider")
	# walk down through every row to the footer, then back up to the tab
	var seen: Array[String] = []
	for i in 14:
		await _key(KEY_DOWN)
		seen.append(_focus_text())
	_check(seen.has("Back"), "down reaches the footer: %s" % [seen])
	_check(seen.has("setting:aim_toggle") and seen.has("setting:weapon_sway"), "down visits every row: %s" % [seen])
	for i in 14:
		await _key(KEY_UP)
	_check(_focus_text() == "View & Input", "up returns to the active tab: " + _focus_text())
	await _key(KEY_RIGHT)
	_check(ui.settings_screen.get_tab() == 1, "right on the tab bar switches tab")
	# segmented choice with keys
	ui.settings_screen.focus_key("dynamic_range")
	await _key(KEY_RIGHT)
	await _key(KEY_ENTER)
	_check(Settings.gets("dynamic_range") == "headphones", "segmented choice via keyboard: " + Settings.gets("dynamic_range"))
	Settings.set_value("dynamic_range", "full")
	# toggle with Enter
	ui.settings_screen.select_tab(3)
	ui.settings_screen.focus_key("reduce_flashes")
	await _key(KEY_ENTER)
	_check(Settings.getb("reduce_flashes"), "toggle via Enter")
	# mouse drag on a slider
	ui.settings_screen.select_tab(1)
	await _frames(3)
	var sl: HSlider = (ui.settings_screen._focus_of["master_volume"] as Callable).call()
	await _click(sl.get_global_transform() * Vector2(sl.size.x * 0.25, sl.size.y * 0.5))
	_check(absf(Settings.getf("master_volume") - 0.25) < 0.03, "click on the slider sets the value: %s" % Settings.getf("master_volume"))
	# reset all
	ui.settings_screen._reset_btn.grab_focus()
	await _key(KEY_ENTER)
	_check(ui.confirm_dialog.is_open(), "reset asks for confirmation")
	await _shot("14_settings_reset_confirm")
	await _key(KEY_RIGHT)
	await _key(KEY_ENTER)
	_check(is_equal_approx(Settings.getf("fov"), 74.0) and is_equal_approx(Settings.getf("master_volume"), 0.6)
		and not Settings.getb("reduce_flashes"), "reset restores defaults")
	_check(is_equal_approx(sl.value, 60.0), "widgets follow the reset: %s" % sl.value)
	await _key(KEY_ESCAPE)
	_check(ui.get_screen() == "pause" and _focus_text() == "Settings", "Esc returns to the menu on Settings: " + _focus_text())

	# ---- controls
	await _key(KEY_DOWN)
	await _key(KEY_ENTER)
	_check(ui.get_screen() == "controls", "Controls opens via keyboard")
	await _shot("20_controls")
	var cs: Control = ui.controls_screen
	cs._buttons["inspect"].grab_focus()
	await _key(KEY_ENTER)
	_check(cs.is_capturing(), "Enter starts the capture")
	await _shot("21_controls_capture")
	await _key(KEY_ESCAPE)
	_check(not cs.is_capturing() and ui.get_screen() == "controls", "Esc cancels the capture, stays on the screen")
	_check(Controls.binding_text("inspect") == "F", "cancel leaves the binding alone")
	await _key(KEY_ENTER)
	await _key(KEY_K)
	_check(Controls.binding_text("inspect") == "K" and not cs.is_capturing(), "free key binds: " + Controls.binding_text("inspect"))
	await _key(KEY_ENTER)
	await _key(KEY_R)
	_check(ui.confirm_dialog.is_open() and Controls.binding_text("inspect") == "K", "conflict asks before changing anything")
	await _shot("22_controls_conflict")
	await _key(KEY_RIGHT)
	await _key(KEY_ENTER)
	_check(Controls.binding_text("inspect") == "R" and Controls.binding_text("reload") == "K", "swap exchanges the two bindings: %s / %s" % [
		Controls.binding_text("inspect"), Controls.binding_text("reload")])
	# mouse button capture
	await _key(KEY_ENTER)
	await _click(Vector2(900, 500), MOUSE_BUTTON_MIDDLE)
	_check(Controls.binding_text("inspect") == "MMB", "mouse button binds: " + Controls.binding_text("inspect"))
	# pause must keep a key
	cs._buttons["pause"].grab_focus()
	await _key(KEY_ENTER)
	await _click(Vector2(900, 500), MOUSE_BUTTON_MIDDLE)
	_check(cs.is_capturing() and Controls.binding_text("pause") == "Escape", "pause refuses a mouse button")
	await _shot("23_controls_pause_needs_key")
	await _key(KEY_P)
	_check(Controls.binding_text("pause") == "P", "pause can move to another key: " + Controls.binding_text("pause"))
	# taking the pause key for an action whose old binding is a mouse button is refused
	cs._buttons["fire"].grab_focus()
	await _key(KEY_ENTER)
	await _key(KEY_P)
	_check(ui.confirm_dialog.is_open() and not ui.confirm_dialog._ok.visible, "no swap that would leave pause on the mouse")
	await _key(KEY_ESCAPE)
	_check(Controls.binding_text("pause") == "P" and Controls.binding_text("fire") == "LMB", "bindings unchanged after refusal")
	_check(ui.get_screen() == "controls", "Esc still works as back/cancel with pause rebound")
	for action: String in Controls.list_actions():
		_check(not InputMap.action_get_events(action).is_empty(), "action keeps a binding: " + action)
	cs._reset_btn.grab_focus()
	await _key(KEY_ENTER)
	await _key(KEY_RIGHT)
	await _key(KEY_ENTER)
	_check(Controls.binding_text("pause") == "Escape" and Controls.binding_text("reload") == "R", "reset bindings")
	await _key(KEY_ESCAPE)
	_check(ui.get_screen() == "pause", "Esc leaves Controls")

	# ---- inspector from the menu
	ui.pause_menu.focus_item("groups")
	await _key(KEY_ENTER)
	_check(ui.get_screen() == "inspector", "Shot groups opens the inspector")
	await _shot("30_inspector")
	if targets != null:
		var st: Dictionary = preload("res://scripts/ui/ui_math.gd").group_stats(targets.papers[1].get_hits())
		_check(ui.inspector._values["shots"].text == "8", "inspector shows the selected target first: " + ui.inspector._title.text)
		_check(ui.inspector._values["spread"].text == preload("res://scripts/ui/ui_math.gd").fmt_mm(st["extreme_spread_mm"]), "spread label matches the statistics")
		ui.inspector._markers.grab_focus()
		await _key(KEY_ENTER)
		await _shot("31_inspector_markers_off")
		await _key(KEY_ENTER)
		await _key(KEY_DOWN)
		await _key(KEY_ENTER)
		_check(ui.inspector._face.zoom_group, "zoom toggle via keyboard")
		await _shot("34_inspector_zoom_group")
		await _key(KEY_DOWN)
		await _key(KEY_RIGHT)
		_check(_focus_text().begins_with("Next"), "inspector focus chain: " + _focus_text())
		await _key(KEY_ENTER)
		_check(ui.inspector.get_target_index() == 1, "next target")
		await _shot("32_inspector_second_target")
		await _key(KEY_DOWN)
		await _key(KEY_ENTER)
		_check(ui.confirm_dialog.is_open(), "clear asks first")
		await _key(KEY_RIGHT)
		await _key(KEY_ENTER)
		_check(targets.papers[0].get_hits().is_empty(), "clear() called on the shown target")
		await _shot("33_inspector_cleared")
	else:
		_check(ui.inspector._title.text == "No paper targets", "inspector handles a missing Targets node")
	await _key(KEY_ESCAPE)
	_check(ui.get_screen() == "pause" and game.is_paused(), "inspector from the menu returns to the menu")
	await _key(KEY_ESCAPE)
	await _frames(3)
	_check(not game.is_paused(), "resumed")

	# ---- inspector from play pauses and restores
	ui.open_group_inspector()
	await _frames(3)
	_check(game.is_paused() and ui.get_screen() == "inspector", "inspector from play pauses the game")
	await _key(KEY_T)
	await _frames(3)
	_check(not game.is_paused() and ui.get_screen() == "", "closing it resumes play")

	# ---- restart session through the menu
	game.set_paused(true)
	await _frames(3)
	ui.pause_menu.focus_item("restart")
	await _key(KEY_ENTER)
	await _key(KEY_RIGHT)
	await _key(KEY_ENTER)
	await _frames(3)
	_check(game.log.has("restart_session") and not game.is_paused(), "restart session calls the game and resumes")

	# ---- high contrast
	Settings.set_value("high_contrast_hud", true)
	Settings.set_value("practice_overlay", true)
	await _wait(0.6)
	ui.hud._on_target_hit({"kind": "paper", "distance_m": 15.0, "score": 7, "pos_mm": Vector2(-61, 48)})
	ui.toast("Targets reset")
	await _wait(0.4)
	await _shot("40_hc_hud")
	game.set_paused(true)
	await _frames(3)
	await _shot("41_hc_pause_menu")
	ui.pause_menu.focus_item("settings")
	await _key(KEY_ENTER)
	ui.settings_screen.select_tab(3)
	ui.settings_screen.focus_key("high_contrast_hud")
	await _shot("42_hc_settings_practice")
	await _key(KEY_ENTER)
	await _frames(4)
	_check(not Settings.getb("high_contrast_hud") and ui.get_screen() == "settings" and ui.settings_screen.get_tab() == 3,
		"restyle keeps the open screen and tab")
	_check(_focus_text() == "setting:high_contrast_hud", "restyle keeps focus: " + _focus_text())
	Settings.set_value("practice_overlay", false)
	await _key(KEY_ESCAPE)
	await _key(KEY_ESCAPE)
	await _frames(3)
	_check(not game.is_paused(), "resumed after high-contrast round trip")

## Every scaled layer must cover the viewport exactly, whatever the window does.
func _check_layers(what: String) -> void:
	var vs := get_viewport().get_visible_rect().size
	for layer: Control in [ui._hud_layer, ui._menu_layer, ui._top_layer]:
		var covered := layer.size * layer.scale
		_check(covered.is_equal_approx(vs) and layer.position == Vector2.ZERO, "%s covers the viewport %s (%s): %s" % [layer.name, vs, what, covered])
	var panel: Control = ui.settings_screen._panel
	var space: Vector2 = ui._menu_layer.size
	_check(panel.size.x <= space.x - 79.0 and panel.size.y <= space.y - 59.0, "settings panel fits the menu space %s (%s): %s" % [space, what, panel.size])

func _run_large() -> void:
	_check_layers("2560x1440")
	ui.hud.enter_range()
	Settings.set_value("practice_overlay", true)
	await _wait(0.5)
	ui.hud._on_target_hit({"kind": "steel", "distance_m": 25.0})
	await _wait(0.4)
	await _shot("60_hud")
	Settings.set_value("practice_overlay", false)
	game.set_paused(true)
	await _frames(3)
	ui.pause_menu.focus_item("settings")
	await _key(KEY_ENTER)
	ui.settings_screen._tab_buttons[2].grab_focus()
	await _shot("61_settings_graphics")
	await _key(KEY_ESCAPE)
	ui.pause_menu.focus_item("groups")
	await _key(KEY_ENTER)
	await _shot("62_inspector")
	await _key(KEY_ESCAPE)
	await _key(KEY_ESCAPE)
	await _frames(3)

func _run_small() -> void:
	_check_layers("1280x720")
	ui.hud.enter_range()
	Settings.set_value("practice_overlay", true)
	await _wait(0.5)
	ui.hud._on_target_hit({"kind": "paper", "distance_m": 15.0, "score": 9, "pos_mm": Vector2(34, -12), "target": targets.papers[1] if targets != null else null})
	ui.toast("Paper target at 15 m")
	await _wait(0.5)
	await _shot("50_hud")
	Settings.set_value("practice_overlay", false)
	game.set_paused(true)
	await _frames(3)
	await _shot("51_pause_menu")
	ui.pause_menu.focus_item("settings")
	await _key(KEY_ENTER)
	var tabs := ["view", "audio", "graphics", "practice"]
	for i in 4:
		ui.settings_screen.select_tab(i)
		ui.settings_screen._tab_buttons[i].grab_focus()
		await _key(KEY_DOWN)
		await _shot("52_settings_%s" % tabs[i])
	# keyboard focus scrolls rows into view
	ui.settings_screen.select_tab(0)
	ui.settings_screen._tab_buttons[0].grab_focus()
	for i in 9:
		await _key(KEY_DOWN)
	var f := get_viewport().gui_get_focus_owner()
	var page: ScrollContainer = ui.settings_screen._pages[0]
	_check(f != null and page.get_global_rect().grow(2).encloses(f.get_global_rect()), "focused row is scrolled into view at 720p: " + _focus_text())
	await _shot("53_settings_view_scrolled")
	await _key(KEY_ESCAPE)
	ui.pause_menu.focus_item("controls")
	await _key(KEY_ENTER)
	await _shot("54_controls")
	await _key(KEY_ESCAPE)
	ui.pause_menu.focus_item("groups")
	await _key(KEY_ENTER)
	await _shot("55_inspector")
	await _key(KEY_ESCAPE)
	await _key(KEY_ESCAPE)
	ui.show_loading(0.7, "Loading range…")
	await _shot("56_loading")
	ui.hide_loading()
	# largest HUD scale at the smallest supported window: everything must still be on screen
	Settings.set_value("hud_scale", 1.75)
	Settings.set_value("practice_overlay", true)
	ui.hud.enter_range()
	await _wait(0.5)
	ui.hud._on_target_hit({"kind": "paper", "distance_m": 25.0, "score": 0, "pos_mm": Vector2(-260, 110)})
	ui.toast("No loaded magazine left — restart the session (F5) to restock")
	await _wait(0.4)
	_check_layers("hud scale 175 % at 720p")
	var screen_rect := Rect2(Vector2.ZERO, get_viewport().get_visible_rect().size)
	for c: Control in [ui.hud._controls_panel, ui.hud._practice_panel, ui.hud._last_panel, ui.notices._toast_panel]:
		_check(screen_rect.encloses(c.get_global_rect()), "%s on screen at hud scale 175 %% / 720p: %s" % [c.get_parent().name + "/" + c.get_class(), c.get_global_rect()])
	_check(not ui.hud._controls_panel.get_global_rect().intersects(ui.hud._corner.get_global_rect()), "corner panels do not overlap at hud scale 175 % / 720p")
	var toast_rect: Rect2 = ui.notices._toast_panel.get_global_rect()
	for c: Control in [ui.hud._controls_panel, ui.hud._corner]:
		_check(not toast_rect.intersects(c.get_global_rect()), "toast clears %s at hud scale 175 %% / 720p" % c.get_class())
	await _shot("57_hud_scale_175")
	game.set_paused(true)
	await _frames(3)
	ui.pause_menu.focus_item("settings")
	await _key(KEY_ENTER)
	ui.settings_screen.select_tab(3)
	await _shot("58_settings_hud_scale_175")
	await _key(KEY_ESCAPE)
	await _key(KEY_ESCAPE)
	Settings.set_value("hud_scale", 1.0)
	Settings.set_value("practice_overlay", false)
	await _frames(3)
