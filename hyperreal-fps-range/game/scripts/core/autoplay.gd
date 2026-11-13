extends Node
## Scripted play for verification captures. Drives the game through the same input path a person uses
## (Input.parse_input_event with actions and relative mouse motion); it never calls weapon or target logic
## directly, except for the explicitly named `teleport`, `set`, `call` and bookkeeping steps.
## Script: JSON array of steps {"wait": s | "at": s, "do": "...", ...}. See tools/capture/scripts/*.json.

var main: Node
var steps: Array = []
var _t0 := 0
var _held := {}
var out_dir := ""
var _save_tasks: Array[int] = []

func start(p_main: Node, path: String) -> void:
	main = p_main
	process_mode = Node.PROCESS_MODE_ALWAYS
	out_dir = str(main._args.get("capture-dir", "user://capture"))
	DirAccess.make_dir_recursive_absolute(out_dir)
	var js: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (js is Array):
		push_error("autoplay: cannot parse " + path)
		main.quit_game()
		return
	steps = js
	main.player.synthetic_look = true
	_t0 = Time.get_ticks_msec()
	_run.call_deferred()

func _now() -> float:
	return (Time.get_ticks_msec() - _t0) / 1000.0

func _sleep(sec: float) -> void:
	var until := Time.get_ticks_msec() + int(sec * 1000.0)
	while Time.get_ticks_msec() < until:
		await get_tree().process_frame

func _action(name: String, down: bool) -> void:
	var ev := InputEventAction.new()
	ev.action = name
	ev.pressed = down
	ev.strength = 1.0 if down else 0.0
	Input.parse_input_event(ev)
	_held[name] = down

func _mouse(rel: Vector2) -> void:
	var ev := InputEventMouseMotion.new()
	ev.relative = rel
	ev.screen_relative = rel
	Input.parse_input_event(ev)

func _sens() -> float:
	return deg_to_rad(Settings.getf("mouse_sensitivity")) * (Settings.getf("ads_sensitivity_scale") if main.player.aiming else 1.0)

## turn by (yaw, pitch) radians over `dur` seconds using mouse motion with an ease in/out
func _turn(dyaw: float, dpitch: float, dur: float) -> void:
	var done := 0.0
	var t_start := Time.get_ticks_msec()
	var sent := Vector2.ZERO
	while true:
		var u := clampf((Time.get_ticks_msec() - t_start) / maxf(dur * 1000.0, 1.0), 0.0, 1.0)
		var e := u * u * (3.0 - 2.0 * u)
		var s := _sens()
		var inv := -1.0 if Settings.getb("invert_y") else 1.0
		var want := Vector2(-dyaw * e / s, -dpitch * e / s * inv)
		_mouse(want - sent)
		sent = want
		if u >= 1.0:
			break
		await get_tree().process_frame
	done = 1.0

func _aim_at(target: Vector3, dur: float, sights := true) -> void:
	var p: Player = main.player
	# two passes: the second removes the small error from sensitivity changes while raising the sights
	for i in 2:
		var eye := p.camera.global_position
		var d := target - eye
		var yaw := atan2(-d.x, -d.z)
		var pitch := atan2(d.y, Vector2(d.x, d.z).length())
		if not sights:
			# hip: the bore, not the view axis, should point at the target
			var bore: Vector3 = main.weapon.bore_direction()
			var view := -p.camera.global_transform.basis.z
			yaw += atan2(-view.x, -view.z) - atan2(-bore.x, -bore.z)
			pitch += asin(clampf(view.y, -1, 1)) - asin(clampf(bore.y, -1, 1))
		await _turn(wrapf(yaw - p.yaw, -PI, PI), pitch - p.pitch, dur if i == 0 else 0.12)

func _goto(x: float, z: float, tol: float, timeout: float) -> void:
	var p: Player = main.player
	var t_end := Time.get_ticks_msec() + int(timeout * 1000.0)
	while Time.get_ticks_msec() < t_end:
		var to := Vector3(x - p.global_position.x, 0, z - p.global_position.z)
		if to.length() < tol:
			break
		var loc := p.global_transform.basis.inverse() * to.normalized()
		for pair in [["move_forward", loc.z < -0.35], ["move_back", loc.z > 0.35], ["move_left", loc.x < -0.35], ["move_right", loc.x > 0.35]]:
			if bool(_held.get(pair[0], false)) != pair[1]:
				_action(pair[0], pair[1])
		await get_tree().process_frame
	for a in ["move_forward", "move_back", "move_left", "move_right"]:
		if _held.get(a, false):
			_action(a, false)

func _state(tag: String) -> void:
	var p: Player = main.player
	var d := {"ev": "state", "tag": tag, "t": _now(), "weapon": main.get_weapon_snapshot(), "pos": main._v(p.global_position),
		"yaw_deg": rad_to_deg(p.yaw), "pitch_deg": rad_to_deg(p.pitch), "ads": main.weapon.ads_t, "blocked": main.weapon.blocked_amount(),
		"paused": main.is_paused(), "perf": main.get_perf(), "audio": AudioDirector.get_stats(),
		"mem_mb": OS.get_static_memory_usage() / 1048576.0, "nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"muzzle": main._v(main.weapon.muzzle_position()), "crouch": p.crouch_t}
	if main.fx != null and main.fx.has_method("get_stats"):
		d["fx"] = main.fx.call("get_stats")
	if main.targets != null and main.targets.has_method("get_stats"):
		d["targets"] = main.targets.call("get_stats")
	main.log_custom(d)

func _run() -> void:
	var clock := 0.0
	for st in steps:
		if st.has("at"):
			clock = float(st["at"])
		elif st.has("wait"):
			clock = _now() + float(st["wait"])
		while _now() < clock:
			await get_tree().process_frame
		var op := str(st.get("do", "wait"))
		match op:
			"wait":
				pass
			"press":
				_action(str(st["action"]), true)
			"release":
				_action(str(st["action"]), false)
			"tap":
				_action(str(st["action"]), true)
				# hold for the requested time AND at least two rendered frames (a hitch must not swallow the press)
				await get_tree().process_frame
				await get_tree().process_frame
				await _sleep(float(st.get("hold", 0.06)))
				_action(str(st["action"]), false)
			"look":
				await _turn(deg_to_rad(float(st.get("yaw", 0.0))), deg_to_rad(float(st.get("pitch", 0.0))), float(st.get("dur", 0.4)))
			"aim_at":
				await _aim_at(Vector3(st["x"], st["y"], st["z"]), float(st.get("dur", 0.5)), bool(st.get("sights", true)))
			"aim_node":
				# aim at a node below Targets (by node path), optional offset in metres
				var n := main.targets.get_node_or_null(str(st["path"])) as Node3D if main.targets != null else null
				if n != null:
					var off := Vector3(st.get("ox", 0.0), st.get("oy", 0.0), st.get("oz", 0.0))
					await _aim_at(n.global_position + off, float(st.get("dur", 0.5)), bool(st.get("sights", true)))
				else:
					push_warning("autoplay: no target node " + str(st["path"]))
			"dump_targets":
				if main.targets != null:
					var lines := []
					for c in main.targets.find_children("*", "Node3D", true, false):
						if c is RigidBody3D or c is StaticBody3D or c.get_parent() == main.targets or c.get_parent().get_parent() == main.targets:
							lines.append({"path": str(main.targets.get_path_to(c)), "type": c.get_class(), "pos": main._v((c as Node3D).global_position)})
					main.log_custom({"ev": "targets_dump", "nodes": lines})
			"goto":
				await _goto(float(st["x"]), float(st["z"]), float(st.get("tol", 0.12)), float(st.get("timeout", 20.0)))
			"teleport":
				main.player.place(Vector3(st["x"], st.get("y", 0.0), st["z"]), deg_to_rad(float(st.get("yaw", 0.0))))
			"screenshot":
				await RenderingServer.frame_post_draw
				var img := get_viewport().get_texture().get_image()
				var path := out_dir + "/" + str(st["name"]) + ".png"
				_save_tasks.append(WorkerThreadPool.add_task(func(): img.save_png(path)))   # encode off the main thread
				main.log_custom({"ev": "screenshot", "name": st["name"], "t": _now()})
			"state":
				_state(str(st.get("tag", "")))
			"settings_dump":
				var vals := {}
				for k in Settings.DEFAULTS:
					vals[k] = Settings.get_value(k)
				main.log_custom({"ev": "settings", "tag": str(st.get("tag", "")), "values": vals, "bindings": {"reload": Controls.binding_text("reload"), "fire": Controls.binding_text("fire")}})
			"rebind_key":
				var k := InputEventKey.new()
				k.physical_keycode = int(st["keycode"])
				Controls.rebind(str(st["action"]), k)
			"key":
				# raw physical key event (exercises the binding layer rather than the action directly)
				var ke := InputEventKey.new()
				ke.physical_keycode = int(st["keycode"])
				ke.pressed = bool(st.get("down", true))
				Input.parse_input_event(ke)
			"play_world":
				# audio calibration only: emit a world sound at a point relative to the listener
				var lp: Vector3 = AudioDirector.listener_position()
				AudioDirector.play_world(str(st["group"]), lp + Vector3(st.get("x", 0.0), st.get("y", 0.0), st.get("z", -10.0)), st.get("opts", {}))
			"log":
				main.log_custom({"ev": "note", "text": str(st.get("text", "")), "t": _now()})
			"set":
				Settings.set_value(str(st["key"]), st["value"], bool(st.get("persist", false)))
			"pause":
				main.set_paused(bool(st.get("on", true)))
			"focus_out":
				main.on_focus_lost()
			"restart":
				_action("restart_session", true)
				await get_tree().process_frame
				_action("restart_session", false)
			"bench_begin":
				main.bench_begin(str(st.get("tag", "")))
			"bench_end":
				main.bench_end()
			"call":
				var tgt: Object = main.get(str(st["target"]))
				if tgt != null and tgt.has_method(str(st["method"])):
					tgt.callv(str(st["method"]), st.get("args", []))
			"quit":
				for a in _held:
					if _held[a]:
						_action(a, false)
				await _sleep(0.2)
				for t in _save_tasks:
					WorkerThreadPool.wait_for_task_completion(t)
				main.quit_game()
				return
			_:
				push_warning("autoplay: unknown step " + op)
	main.quit_game()
