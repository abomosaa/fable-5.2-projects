extends SceneTree
## Stress + stability run for the Targets and FXWorld modules on a stub range (dirt ground + concrete slab):
##
##   godot --headless --fixed-fps 120 --path game --script res://tests/stress_targets.gd
##
## Phase A measures the steel reactions to one centred 9 mm hit (swing amplitude, time to rest).
## Phase B fires 500 real projectiles (ProjectileManager -> on_bullet_hit / spawn_world_impact) at every kind of
## target and surface, with a muzzle event and an ejected case per shot, in 10 cycles of 50 with reset_all() +
## clear() after each. It fails (exit code 1) on: node / object growth between the first and the last cycle,
## non-finite or runaway transforms, pools over their caps, or anything still awake 10 s after the last shot.

const BULLET_SPEED := 335.0
var fails: Array[String] = []
var fx: Node
var targets: Node3D
var pm: ProjectileManager
var rng := RandomNumberGenerator.new()
var shot := 0

func _initialize() -> void:
	_run.call_deferred()

func _fail(msg: String) -> void:
	fails.append(msg)
	print("FAIL: ", msg)

func _frames(n: int) -> void:
	for i in n:
		await physics_frame

func _static_box(center: Vector3, size: Vector3, surface: String) -> void:
	var b := StaticBody3D.new()
	b.set_meta("surface", surface)
	b.collision_layer = 1
	b.collision_mask = 0
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = size
	cs.shape = sh
	b.add_child(cs)
	b.position = center
	root.add_child(b)

func _counts() -> Dictionary:
	return {"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)), "objects": int(Performance.get_monitor(Performance.OBJECT_COUNT)),
		"resources": int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT)), "orphans": int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)),
		"mem_mb": snappedf(OS.get_static_memory_usage() / 1048576.0, 0.01), "fx_nodes": int(fx.call("get_stats")["nodes"]),
		"target_nodes": int(targets.call("get_stats")["nodes"])}

func _fire(from: Vector3, at: Vector3) -> void:
	shot += 1
	var dir := (at - from).normalized()
	pm.fire(from, dir, BULLET_SPEED + rng.randf_range(-6.0, 6.0), shot)
	var xf := Transform3D(Basis.looking_at(dir, Vector3.UP), from)
	fx.call("muzzle_event", xf, [1.0, 0.35, 0.05][shot % 3], shot)
	fx.call("eject_casing", Transform3D(Basis.IDENTITY, Vector3(rng.randf_range(-5.0, 1.0), 1.45, rng.randf_range(-1.6, 0.6))),
		Vector3(rng.randf_range(-3.1, -2.0), rng.randf_range(1.5, 2.6), rng.randf_range(0.1, 1.0)),
		Vector3(rng.randf_range(-25, 25), rng.randf_range(30, 85), rng.randf_range(-40, 40)))

func _check_sane(tag: String) -> void:
	for g in targets.get("gongs"):
		var pl: RigidBody3D = g.get("plate")
		var rest: Transform3D = pl.call("rest_transform")
		if not pl.global_transform.origin.is_finite() or not pl.global_transform.basis.x.is_finite():
			_fail("%s: %s plate transform is not finite" % [tag, g.get("label")])
		elif pl.global_position.distance_to(rest.origin) > 0.75:
			_fail("%s: %s plate is %.2f m from its rest position" % [tag, g.get("label"), pl.global_position.distance_to(rest.origin)])
		for c in g.get("chains"):
			if not (c as Node3D).global_position.is_finite():
				_fail("%s: chain transform is not finite" % tag)
	for c in targets.get("breakables").call("get_cans"):
		var p: Vector3 = (c as Node3D).global_position
		if not p.is_finite() or p.length() > 400.0:
			_fail("%s: can at %s" % [tag, p])
	for c in fx.get_node("Casings").get_children():
		if c.get("active") and not (c as Node3D).global_position.is_finite():
			_fail("%s: casing transform is not finite" % tag)
	var fs: Dictionary = fx.call("get_stats")
	if int(fs["decals"]) > int(fs["decal_cap"]) or int(fs["puffs"]) > int(fs["puff_cap"]) or int(fs["chunks"]) > int(fs["chunk_cap"]) \
			or int(fs["casings_flying"]) + int(fs["casings_settled"]) > int(fs["casing_cap"]):
		_fail("%s: FX pool over its cap: %s" % [tag, str(fs)])
	var ts: Dictionary = targets.call("get_stats")
	if int(ts["fragments_live"]) > int(ts["live_cap"]) or int(ts["fragments_static"]) > int(ts["static_cap"]):
		_fail("%s: fragment pool over its cap: %s" % [tag, str(ts)])

func _run() -> void:
	rng.seed = 20261111
	_static_box(Vector3(0, -0.5, -40), Vector3(300, 1.0, 300), "dirt")
	_static_box(Vector3(-2.1, 0.02, 1.85), Vector3(8.2, 0.04, 5.5), "concrete")
	fx = load("res://scenes/fx/fx_world.tscn").instantiate()
	root.add_child(fx)
	targets = load("res://scenes/targets/targets.tscn").instantiate()
	root.add_child(targets)
	pm = ProjectileManager.new()
	pm.fx = fx
	root.add_child(pm)
	var cam := Camera3D.new()
	root.add_child(cam)
	cam.global_position = Vector3(-1.6, 1.66, 0.5)
	cam.make_current()
	await _frames(30)
	await fx.call("prewarm")
	var tick := 1.0 / float(Engine.physics_ticks_per_second)

	# ------------------------------------------------------------------ phase A: steel reaction to one hit
	print("--- steel: one centred hit at %.0f m/s (bullet momentum %.2f N s)" % [BULLET_SPEED, 0.008035 * BULLET_SPEED])
	for g in targets.get("gongs"):
		var pl: RigidBody3D = g.get("plate")
		var settle0 := 0
		while not bool(g.call("is_asleep")) and settle0 < 1200:
			settle0 += 1
			await physics_frame
		shot += 1
		pm.fire(pl.global_position + Vector3(0, 0, 0.5), Vector3.FORWARD, BULLET_SPEED, shot)
		var peak := 0.0
		var v0 := 0.0
		var t_rest := -1.0
		var t_small := -1.0
		for k in 30 * Engine.physics_ticks_per_second:
			await physics_frame
			if int(pl.get("hits")) > 0 and v0 == 0.0:
				v0 = pl.linear_velocity.length()
			var a: float = g.call("swing_deg")
			peak = maxf(peak, a)
			if a > 1.0:
				t_small = -1.0
			elif t_small < 0.0 and v0 > 0.0:
				t_small = k * tick
			if v0 > 0.0 and bool(g.call("is_asleep")):
				t_rest = k * tick
				break
		print("  %-18s M=%.2f kg  v0=%.2f m/s (m v / M = %.2f)  peak swing %.1f deg  under 1 deg after %.1f s  asleep after %.1f s" % [
			g.get("label"), pl.mass, v0, 0.008035 * BULLET_SPEED / pl.mass, peak, t_small, t_rest])
		if t_rest < 0.0:
			_fail("%s never went to sleep after a single hit" % g.get("label"))
		if peak > 80.0:
			_fail("%s swung %.0f degrees from one 9 mm hit" % [g.get("label"), peak])
	var pv: Node3D = targets.get("pivot")
	shot += 1
	pm.fire(pv.global_position + Vector3(0, 0.57, 0.5), Vector3.FORWARD, BULLET_SPEED, shot)
	var t_pv := -1.0
	var started := false
	for k in 10 * Engine.physics_ticks_per_second:
		await physics_frame
		if not bool(pv.call("is_asleep")):
			started = true
		elif started:
			t_pv = k * tick
			break
	print("  pivot plate (6 in)  leans back %.1f deg, upright and still again after %.2f s" % [float(pv.call("get_stats")["peak_deg"]), t_pv])
	if t_pv < 0.0:
		_fail("pivot plate did not come to rest")

	# ------------------------------------------------------------------ phase B: 500 shots, 10 resets
	targets.call("reset_all")
	fx.call("clear")
	pm.clear()
	await _frames(60)
	var papers: Array = targets.call("get_paper_targets")
	var gongs: Array = targets.get("gongs")
	var br: Node3D = targets.get("breakables")
	var first := {}
	var last := {}
	print("--- 500 shots / 10 resets")
	print("  start      ", _counts())
	for cycle in 10:
		for i in 50:
			var k := i % 10
			match k:
				0, 1, 2:
					var p: Node3D = papers[rng.randi() % papers.size()]
					var at: Vector3 = p.call("mm_to_world", Vector2(rng.randf_range(-320, 320), rng.randf_range(-400, 400)))
					_fire(Vector3(p.global_position.x, 1.5, 0.0), at)
				3, 4:
					var g: Node3D = gongs[rng.randi() % gongs.size()]
					var pl: RigidBody3D = g.get("plate")
					var r := float(pl.get("radius")) * 1.1
					_fire(Vector3(pl.global_position.x, 1.5, 0.0), (pl.call("rest_transform") as Transform3D).origin + Vector3(rng.randf_range(-r, r), rng.randf_range(-r, r), 0))
				5:
					_fire(Vector3(1.3, 1.5, 0.0), pv.global_position + Vector3(rng.randf_range(-0.07, 0.07), 0.57 + rng.randf_range(-0.07, 0.07), 0))
				6, 7:
					var n: int = br.call("item_count")
					var cans: Array = br.call("get_cans")
					if rng.randf() < 0.3:
						var c: Node3D = cans[rng.randi() % cans.size()]
						_fire(Vector3(c.global_position.x, 1.5, 0.0), c.global_position + Vector3(rng.randf_range(-0.02, 0.02), 0.04, 0))
					else:
						var it: RefCounted = br.call("get_item", rng.randi() % n)
						var body: Node3D = it.get("body")
						_fire(Vector3(body.global_position.x, 1.5, 0.0), body.global_position + Vector3(rng.randf_range(-0.02, 0.02), rng.randf_range(0.0, 0.1), 0))
				8:
					_fire(Vector3(rng.randf_range(-5, 1), 1.5, 0.0), Vector3(rng.randf_range(-8, 8), 0.0, rng.randf_range(-45, -3)))
				_:
					# concrete slab: steep and shallow
					_fire(Vector3(rng.randf_range(-5, 1), 1.5, 0.5), Vector3(rng.randf_range(-5, 1), 0.04, rng.randf_range(-0.8, 0.3) if i % 20 < 10 else 3.5))
			await _frames(5)
		await _frames(150)
		_check_sane("cycle %d" % (cycle + 1))
		if cycle == 9:
			# 10 s after the last shot everything must be at rest
			await _frames(10 * Engine.physics_ticks_per_second - 150)
			var fs: Dictionary = fx.call("get_stats")
			var ts: Dictionary = targets.call("get_stats")
			print("  before the last reset: fx=", fs)
			print("  before the last reset: targets=", ts)
			if not bool(targets.call("all_asleep")):
				var awake := []
				for c in br.call("get_cans"):
					if not (c as RigidBody3D).sleeping:
						awake.append("%s at %s v=%s w=%s" % [c.name, (c as Node3D).global_position, (c as RigidBody3D).linear_velocity, (c as RigidBody3D).angular_velocity])
				_fail("targets still awake 10 s after the last shot: gongs_awake=%d pivot_asleep=%s fragments_live=%d cans=%s" % [ts["gongs_awake"], ts["pivot_asleep"], ts["fragments_live"], str(awake)])
			if int(fs["casings_flying"]) != 0:
				_fail("%d casings still moving 10 s after the last shot" % fs["casings_flying"])
			if int(fs["puffs"]) != 0 or int(fs["chunks"]) != 0:
				_fail("particles still alive 10 s after the last shot: %d puffs, %d chunks" % [fs["puffs"], fs["chunks"]])
			if int(fs["casings_settled"]) > 60:
				_fail("more than 60 casings on the ground")
		targets.call("reset_all")
		fx.call("clear")
		pm.clear()
		await _frames(20)
		var c := _counts()
		if cycle == 0:
			first = c
		last = c
		print("  after reset %2d: %s" % [cycle + 1, str(c)])
		var ts2: Dictionary = targets.call("get_stats")
		if int(ts2["paper_hits"]) != 0 or int(ts2["steel_marks"]) != 0 or int(ts2["broken"]) != 0 or int(ts2["fragments_static"]) != 0 or int(ts2["cans_moved"]) != 0:
			_fail("reset %d left state behind: %s" % [cycle + 1, str(ts2)])
		var fs2: Dictionary = fx.call("get_stats")
		if int(fs2["decals"]) != 0 or int(fs2["casings_settled"]) != 0 or int(fs2["puffs"]) != 0:
			_fail("clear %d left FX behind: %s" % [cycle + 1, str(fs2)])
	print("  shots fired: %d, bullets simulated: %d" % [shot, pm.total_fired])
	for key in ["nodes", "fx_nodes", "target_nodes", "orphans"]:
		if int(last[key]) != int(first[key]):
			_fail("%s grew from %d (after reset 1) to %d (after reset 10)" % [key, first[key], last[key]])
	if int(last["objects"]) - int(first["objects"]) > 40:
		_fail("object count grew from %d to %d" % [first["objects"], last["objects"]])
	if float(last["mem_mb"]) - float(first["mem_mb"]) > 4.0:
		_fail("static memory grew from %.2f MB to %.2f MB" % [first["mem_mb"], last["mem_mb"]])
	print("RESULT: %s (%d failures)" % ["OK" if fails.is_empty() else "FAILED", fails.size()])
	quit(1 if not fails.is_empty() else 0)
