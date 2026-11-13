extends Node3D
## Root of the simulation: loading, pause / focus handling, session control, settings application,
## and the glue between weapon, projectiles, targets, effects, audio and UI.

signal paused_changed(paused: bool)
signal notice(text: String)
signal session_restarted

const ENV_SCENE := "res://scenes/range_env.tscn"
const TARGETS_SCENE := "res://scenes/targets/targets.tscn"
const FX_SCENE := "res://scenes/fx/fx_world.tscn"
const UI_SCENE := "res://scenes/ui/ui.tscn"

var world: Node3D
var env: Node
var targets: Node
var fx: Node
var ui: Node
var player: Player
var weapon: WeaponView
var projectiles: ProjectileManager
var autoplay: Node
var ready_to_play := false
var _paused := false
var _args := {}
var _frame_ms: PackedFloat32Array = []
var _frame_i := 0
var _bench: Dictionary = {}
var _bench_samples := PackedFloat32Array()
var _last_usec := 0
var using_fallback_env := false
var event_log: FileAccess
var _input_latency_usec: Array[int] = []
var _last_fire_input_usec := -1

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	DisplayServer.window_set_title("Range Day")
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--"):
			var kv := a.substr(2).split("=", true, 1)
			_args[kv[0]] = kv[1] if kv.size() > 1 else "1"
	_frame_ms.resize(4096)
	world = Node3D.new()
	world.name = "World"
	world.process_mode = Node.PROCESS_MODE_PAUSABLE
	add_child(world)
	if ResourceLoader.exists(UI_SCENE):
		ui = (load(UI_SCENE) as PackedScene).instantiate()
		add_child(ui)
		if ui.has_method("bind"):
			ui.call("bind", self)
	if _args.has("capture-dir"):
		DirAccess.make_dir_recursive_absolute(str(_args["capture-dir"]))
		event_log = FileAccess.open(str(_args["capture-dir"]) + "/events.jsonl", FileAccess.WRITE)
		AudioDirector.log_events = true
	_apply_window_settings()
	Settings.changed.connect(_on_setting)
	_load.call_deferred()

# ------------------------------------------------------------------ loading
func _progress(p: float, text: String) -> void:
	if ui != null and ui.has_method("show_loading"):
		ui.call("show_loading", p, text)

func _load_scene(path: String, p0: float, p1: float, text: String) -> Node:
	if not ResourceLoader.exists(path):
		return null
	ResourceLoader.load_threaded_request(path)
	var prog := []
	while true:
		var st := ResourceLoader.load_threaded_get_status(path, prog)
		if st == ResourceLoader.THREAD_LOAD_LOADED:
			break
		if st == ResourceLoader.THREAD_LOAD_FAILED or st == ResourceLoader.THREAD_LOAD_INVALID_RESOURCE:
			push_error("Failed to load " + path)
			return null
		_progress(lerpf(p0, p1, float(prog[0]) if prog.size() > 0 else 0.0), text)
		await get_tree().process_frame
	var ps: PackedScene = ResourceLoader.load_threaded_get(path)
	return ps.instantiate() if ps != null else null

func _load() -> void:
	_progress(0.02, "Loading range…")
	await get_tree().process_frame
	env = await _load_scene(ENV_SCENE, 0.02, 0.45, "Loading range…")
	if env == null:
		using_fallback_env = true
		push_warning("Range environment scene missing: using the bare development stand-in")
		env = _make_fallback_env()
	world.add_child(env)
	_progress(0.5, "Setting up targets…")
	await get_tree().process_frame
	fx = await _load_scene(FX_SCENE, 0.5, 0.6, "Setting up effects…")
	if fx != null:
		world.add_child(fx)
	targets = await _load_scene(TARGETS_SCENE, 0.6, 0.7, "Setting up targets…")
	if targets != null:
		world.add_child(targets)
		if targets.has_signal("target_hit"):
			targets.connect("target_hit", _on_target_hit)
	projectiles = ProjectileManager.new()
	projectiles.name = "Projectiles"
	projectiles.fx = fx
	world.add_child(projectiles)
	projectiles.bullet_finished.connect(_on_bullet_finished)
	_progress(0.72, "Preparing shooter…")
	await get_tree().process_frame
	player = Player.new()
	player.name = "Player"
	world.add_child(player)
	player.place(RangeLayout.SPAWN, 0.0)
	player.input_enabled = false
	player.footstep.connect(func(s, i): AudioDirector.play_step(s, i))
	weapon = WeaponView.new()
	weapon.name = "Weapon"
	weapon.player = player
	weapon.projectiles = projectiles
	weapon.fx = fx
	weapon.input_enabled = false
	player.camera.add_child(weapon)
	weapon.sim_event.connect(_on_sim_event)
	weapon.shot_fired.connect(_on_shot)
	if env.has_method("get_camera_attributes"):
		player.camera.attributes = env.call("get_camera_attributes")
	elif ResourceLoader.exists("res://assets/env/camera_attributes.tres"):
		player.camera.attributes = load("res://assets/env/camera_attributes.tres")
	AudioDirector.set_listener(player.camera)
	_apply_quality()
	# --- shader / pipeline warm-up behind the loading screen
	_progress(0.8, "Compiling shaders…")
	if fx != null and fx.has_method("prewarm"):
		await fx.call("prewarm")
	var looks := [0.0, 0.6, -0.6, PI, 0.0]
	for i in looks.size():
		player.place(RangeLayout.SPAWN, looks[i])
		for k in 6:
			await get_tree().process_frame
		_progress(0.8 + 0.18 * float(i + 1) / looks.size(), "Compiling shaders…")
	player.place(RangeLayout.SPAWN, 0.0)
	_progress(1.0, "Ready")
	await get_tree().process_frame
	if ui != null and ui.has_method("hide_loading"):
		ui.call("hide_loading")
	ready_to_play = true
	player.input_enabled = true
	weapon.input_enabled = true
	AudioDirector.start_ambience()
	_last_usec = Time.get_ticks_usec()
	_log({"ev": "ready", "fallback_env": using_fallback_env, "audio_groups": AudioDirector.loaded_summary(),
		"adapter": RenderingServer.get_video_adapter_name(), "size": [get_viewport().size.x, get_viewport().size.y]})
	if _args.has("autoplay"):
		autoplay = load("res://scripts/core/autoplay.gd").new()
		autoplay.name = "Autoplay"
		add_child(autoplay)
		autoplay.call("start", self, str(_args["autoplay"]))
	else:
		_capture_mouse(true)

func _make_fallback_env() -> Node3D:
	var root := Node3D.new()
	root.name = "FallbackEnv"
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-38, 150, 0)
	sun.shadow_enabled = true
	root.add_child(sun)
	var we := WorldEnvironment.new()
	var e := Environment.new()
	e.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	sky.sky_material = ProceduralSkyMaterial.new()
	e.sky = sky
	e.tonemap_mode = Environment.TONE_MAPPER_AGX
	we.environment = e
	root.add_child(we)
	var body := StaticBody3D.new()
	body.set_meta("surface", "dirt")
	var cs := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(200, 1, 200)
	cs.shape = box
	cs.position.y = -0.5
	body.add_child(cs)
	var mi := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(200, 200)
	mi.mesh = pm
	body.add_child(mi)
	root.add_child(body)
	return root

# ------------------------------------------------------------------ settings
func _on_setting(key: String) -> void:
	match key:
		"quality", "render_scale":
			_apply_quality()
		"vsync", "max_fps", "fullscreen":
			_apply_window_settings()

func _apply_quality() -> void:
	if env != null and env.has_method("apply_quality"):
		env.call("apply_quality", Settings.gets("quality"))
	get_viewport().scaling_3d_scale = Settings.getf("render_scale")

func _apply_window_settings() -> void:
	if _args.has("no-vsync"):
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	else:
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if Settings.getb("vsync") else DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = int(Settings.get_value("max_fps"))
	if not _args.has("windowed"):
		var want := DisplayServer.WINDOW_MODE_FULLSCREEN if Settings.getb("fullscreen") else DisplayServer.WINDOW_MODE_WINDOWED
		if DisplayServer.window_get_mode() != want and (want == DisplayServer.WINDOW_MODE_FULLSCREEN or DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_FULLSCREEN):
			DisplayServer.window_set_mode(want)

# ------------------------------------------------------------------ pause / focus
func is_paused() -> bool:
	return _paused

func set_paused(p: bool) -> void:
	if not ready_to_play or p == _paused:
		return
	_paused = p
	get_tree().paused = p
	if weapon != null:
		weapon.release_inputs()
	_capture_mouse(not p)
	_last_usec = Time.get_ticks_usec()
	paused_changed.emit(p)
	_log({"ev": "paused" if p else "resumed"})

func _capture_mouse(c: bool) -> void:
	if autoplay != null:
		return
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED if c else Input.MOUSE_MODE_VISIBLE

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT or what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		if autoplay == null:
			on_focus_lost()
	elif what == NOTIFICATION_WM_CLOSE_REQUEST:
		quit_game()

## Losing focus must never leave a trigger held or an action half-registered: inputs are dropped, the game pauses.
func on_focus_lost() -> void:
	if weapon != null:
		weapon.release_inputs()
	if ready_to_play and not _paused:
		set_paused(true)

func _unhandled_input(event: InputEvent) -> void:
	if not ready_to_play:
		return
	if event.is_action_pressed("pause"):
		# (while a menu screen is open the UI consumes Esc itself; this only sees it during play or at the top level)
		set_paused(not _paused)
		get_viewport().set_input_as_handled()
		return
	if _paused:
		return
	if event is InputEventMouseButton and event.pressed and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED and autoplay == null:
		_capture_mouse(true)
		get_viewport().set_input_as_handled()
		return
	if event.is_action_pressed("fire"):
		_last_fire_input_usec = Time.get_ticks_usec()
	if event.is_action_pressed("reset_targets"):
		reset_targets()
	elif event.is_action_pressed("restart_session"):
		restart_session()
	elif event.is_action_pressed("target_nearer"):
		if targets != null and targets.has_method("step_paper_distance"):
			targets.call("step_paper_distance", -1)
	elif event.is_action_pressed("target_farther"):
		if targets != null and targets.has_method("step_paper_distance"):
			targets.call("step_paper_distance", 1)
	elif event.is_action_pressed("inspect_group"):
		if ui != null and ui.has_method("open_group_inspector"):
			ui.call("open_group_inspector")

# ------------------------------------------------------------------ session
func get_weapon_snapshot() -> Dictionary:
	return weapon.sim.snapshot() if weapon != null else {}

func get_targets() -> Node:
	return targets

func reset_targets() -> void:
	if targets != null and targets.has_method("reset_all"):
		targets.call("reset_all")
	notice.emit("Targets reset")
	_log({"ev": "reset_targets"})

func restart_session() -> void:
	if not ready_to_play:
		return
	if targets != null and targets.has_method("reset_all"):
		targets.call("reset_all")
	if fx != null and fx.has_method("clear"):
		fx.call("clear")
	projectiles.clear()
	AudioDirector.stop_all()
	weapon.restart()
	player.place(RangeLayout.SPAWN, 0.0)
	player.crouched = false
	set_paused(false)
	notice.emit("Session restarted — magazines refilled")
	session_restarted.emit()
	_log({"ev": "restart"})

func quit_game() -> void:
	_log({"ev": "quit"})
	if event_log != null:
		event_log.close()
	# (settings are written when they are changed; nothing to save here)
	get_tree().quit()

# ------------------------------------------------------------------ events / logging
func _on_sim_event(e: Dictionary) -> void:
	if e["name"] == "no_spare_magazine":
		notice.emit("No loaded magazine left — restart the session (%s) to restock" % Controls.binding_text("restart_session"))
	if event_log != null:
		var d := {"ev": "sim", "name": e["name"], "sim_t": e["t"]}
		for k in e:
			if k != "name" and k != "t":
				d[k] = e[k]
		_log(d)

func _on_shot(info: Dictionary) -> void:
	if _last_fire_input_usec >= 0:
		_input_latency_usec.append(int(info["ticks_usec"]) - _last_fire_input_usec)
		if _input_latency_usec.size() > 256:
			_input_latency_usec.pop_front()
	if event_log != null:
		var a: Dictionary = info["audio"]
		_log({"ev": "shot", "index": info["index"], "da": info["da"], "ads": info["ads"], "speed": info["speed"],
			"muzzle": _v(info["muzzle"]), "dir": _v(info["dir"]), "input_to_shot_ms": (int(info["ticks_usec"]) - _last_fire_input_usec) / 1000.0,
			"layers": a.get("layers", []), "enclosure": a.get("enclosure", 0.0), "refl_taps": a.get("refl_taps", 0),
			"audio_latency_ms": (AudioServer.get_output_latency() + AudioServer.get_time_to_next_mix()) * 1000.0})

func _on_bullet_finished(rec: Dictionary) -> void:
	if event_log != null:
		var hits := []
		for h in rec["hits"]:
			hits.append({"surface": h["surface"], "pos": _v(h["position"]), "tof_ms": float(h["tof"]) * 1000.0, "speed": h["speed"], "stop": h["stop"], "collider": h["collider"]})
		_log({"ev": "bullet", "index": rec["index"], "hits": hits, "end": _v(rec["end"])})

func _on_target_hit(info: Dictionary) -> void:
	if event_log != null:
		var d := {"ev": "target_hit"}
		for k in info:
			if info[k] is float or info[k] is int or info[k] is String or info[k] is bool:
				d[k] = info[k]
			elif info[k] is Vector2:
				d[k] = [info[k].x, info[k].y]
		_log(d)

static func _v(v: Vector3) -> Array:
	return [snappedf(v.x, 0.0001), snappedf(v.y, 0.0001), snappedf(v.z, 0.0001)]

func _log(d: Dictionary) -> void:
	if event_log == null or not event_log.is_open():
		return
	d["usec"] = Time.get_ticks_usec()
	d["frame"] = Engine.get_process_frames()
	event_log.store_line(JSON.stringify(d))
	event_log.flush()

func log_custom(d: Dictionary) -> void:
	_log(d)

# ------------------------------------------------------------------ perf
func _process(_delta: float) -> void:
	if event_log != null and not AudioDirector.event_log.is_empty():
		for a in AudioDirector.event_log:
			if a["type"] == "world":
				_log({"ev": "audio_world", "group": a["group"], "file": a["file"], "dist": a["dist"], "occlusion": a["occ"], "voice_db": a["vol_db"],
					"delay_ms": (float(a["t"]) - float(a["emit_t"])) * 1000.0})
		AudioDirector.event_log.clear()
	var now := Time.get_ticks_usec()
	if _last_usec > 0 and ready_to_play and not _paused:
		var ms := (now - _last_usec) / 1000.0
		_frame_ms[_frame_i % _frame_ms.size()] = ms
		_frame_i += 1
		if not _bench.is_empty():
			_bench_samples.append(ms)
		# capture runs only (an event log is open): every frame longer than two refreshes is recorded with the wall
		# clock, so it can be lined up with a log of what else the machine was doing
		if event_log != null:
			var pr := _probe_self()
			if ms > 34.0:
				# where did the time go? main thread computing / waiting for a CPU / neither (= blocked: a lock, the
				# GPU driver or compositor, or a page being read back from disk or swap). proc_ms is the engine's own
				# measure of the script-and-scene step of the frame that just ended.
				var cpu: float = (float(pr[0]) - float(_probe_prev[0])) / 1e6
				var wait: float = (float(pr[1]) - float(_probe_prev[1])) / 1e6
				_log({"ev": "hitch", "ms": ms, "unix": Time.get_unix_time_from_system(), "main_cpu_ms": cpu, "main_wait_ms": wait,
					"main_blocked_ms": maxf(ms - cpu - wait, 0.0), "majflt": int(float(pr[2]) - float(_probe_prev[2])),
					"proc_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
					"phys_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0})
			_probe_prev = pr
	_last_usec = now

## /proc files report a length of 0, so they have to be read as a line rather than "the whole file"
func _proc_line(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	return f.get_line()

## Capture runs only (Linux): [main-thread on-CPU ns, main-thread run-queue wait ns, process major page faults].
var _probe_prev := [0.0, 0.0, 0.0]
func _probe_self() -> Array:
	var out := [0.0, 0.0, 0.0]
	var ss := _proc_line("/proc/thread-self/schedstat").split(" ", false)
	if ss.size() >= 2:
		out[0] = float(ss[0])
		out[1] = float(ss[1])
	var st := _proc_line("/proc/self/stat")
	var k := st.rfind(")")
	if k > 0:
		var f := st.substr(k + 2).split(" ", false)
		if f.size() > 10:
			out[2] = float(f[9])
	return out

func get_perf() -> Dictionary:
	var n := mini(_frame_i, 120)
	var sum := 0.0
	var worst := 0.0
	for k in n:
		var v := _frame_ms[(_frame_i - 1 - k) % _frame_ms.size()]
		sum += v
		worst = maxf(worst, v)
	var avg := sum / maxf(n, 1)
	return {"fps": 1000.0 / maxf(avg, 0.001), "frame_ms": avg, "worst_ms": worst}

func bench_begin(tag: String) -> void:
	_bench_samples = PackedFloat32Array()
	_bench = {"tag": tag, "mem0": OS.get_static_memory_usage(), "t0": Time.get_ticks_msec(),
		"objs0": Performance.get_monitor(Performance.OBJECT_COUNT), "nodes0": Performance.get_monitor(Performance.OBJECT_NODE_COUNT)}

func bench_end() -> Dictionary:
	if _bench.is_empty():
		return {}
	var s := _bench_samples
	var arr := Array(s)
	arr.sort()
	var n := arr.size()
	var res := {"ev": "bench", "tag": _bench["tag"], "frames": n, "seconds": (Time.get_ticks_msec() - int(_bench["t0"])) / 1000.0}
	if n > 0:
		var sum := 0.0
		for v in arr:
			sum += v
		res["avg_ms"] = sum / n
		res["p50_ms"] = arr[int(n * 0.5)]
		res["p95_ms"] = arr[mini(int(n * 0.95), n - 1)]
		res["p99_ms"] = arr[mini(int(n * 0.99), n - 1)]
		res["max_ms"] = arr[n - 1]
		res["avg_fps"] = 1000.0 / maxf(sum / n, 0.001)
		var over := 0
		for v in arr:
			if v > 16.7:
				over += 1
		res["frames_over_16_7ms"] = over
	res["static_mem_mb_start"] = float(_bench["mem0"]) / 1048576.0
	res["static_mem_mb_end"] = OS.get_static_memory_usage() / 1048576.0
	res["objects_start"] = _bench["objs0"]
	res["objects_end"] = Performance.get_monitor(Performance.OBJECT_COUNT)
	res["nodes_start"] = _bench["nodes0"]
	res["nodes_end"] = Performance.get_monitor(Performance.OBJECT_NODE_COUNT)
	res["video_mem_mb"] = Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0
	res["draw_calls"] = Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	if _input_latency_usec.size() > 0:
		var l := _input_latency_usec.duplicate()
		l.sort()
		res["input_to_shot_ms_median"] = l[l.size() / 2] / 1000.0
		res["input_to_shot_ms_max"] = l[l.size() - 1] / 1000.0
	res["audio"] = AudioDirector.get_stats()
	if fx != null and fx.has_method("get_stats"):
		res["fx"] = fx.call("get_stats")
	if targets != null and targets.has_method("get_stats"):
		res["targets"] = targets.call("get_stats")
	_bench = {}
	_log(res)
	return res
