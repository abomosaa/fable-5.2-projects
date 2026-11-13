extends SceneTree
## Headless deterministic test runner:  godot --headless --path game --script res://tests/run_tests.gd
## Each test file exposes `static func run() -> Array` (failure strings) and/or
## `static func run_async(tree: SceneTree) -> Array` (may await physics frames).

const TESTS := [
	"res://tests/test_weapon_sim.gd",
	"res://tests/test_ballistics.gd",
	"res://tests/test_audio_schedule.gd",
	"res://tests/test_projectiles.gd",
	"res://tests/test_targets.gd",
	"res://tests/test_ui_math.gd",
]

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var total_fail := 0
	var only := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--only="):
			only = a.substr(7)
	for path in TESTS:
		if only != "" and not path.contains(only):
			continue
		if not ResourceLoader.exists(path):
			print("SKIP  %s (not present)" % path)
			continue
		var scr: GDScript = load(path)
		if scr == null or not scr.can_instantiate():
			print("FAIL  %s (does not load)" % path)
			total_fail += 1
			continue
		var fails: Array = []
		var m := {}
		for d in scr.get_script_method_list():
			m[d["name"]] = true
		if not m.has("run") and not m.has("run_async"):
			fails.append("no run()/run_async() entry point")
		if m.has("run"):
			fails.append_array(scr.call("run"))
		if m.has("run_async"):
			fails.append_array(await scr.call("run_async", self))
		if fails.is_empty():
			print("PASS  %s" % path)
		else:
			total_fail += fails.size()
			print("FAIL  %s (%d)" % [path, fails.size()])
			for f in fails:
				print("        - ", f)
	print("RESULT: %s (%d failures)" % ["OK" if total_fail == 0 else "FAILED", total_fail])
	quit(1 if total_fail > 0 else 0)
