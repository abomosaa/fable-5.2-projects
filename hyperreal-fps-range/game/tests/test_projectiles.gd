extends RefCounted
## Projectile collision boundaries on the real physics engine: thin targets, edges, walls, pass-through rules.

class Catcher:
	extends StaticBody3D
	var hits: Array = []
	var reply := {"stop": true}
	func on_bullet_hit(hit: Dictionary) -> Dictionary:
		hits.append(hit)
		return reply

static func _box(parent: Node, size: Vector3, pos: Vector3, layer: int, surface: String, catcher := false) -> StaticBody3D:
	var b: StaticBody3D = Catcher.new() if catcher else StaticBody3D.new()
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = size
	cs.shape = sh
	b.add_child(cs)
	b.collision_layer = 1 << (layer - 1)
	b.collision_mask = 0
	b.set_meta("surface", surface)
	parent.add_child(b)
	b.global_position = pos
	return b

static func _fly(tree: SceneTree, pm: ProjectileManager) -> void:
	var guard := 0
	while not pm.active.is_empty() and guard < 600:
		guard += 1
		await tree.physics_frame

static func run_async(tree: SceneTree) -> Array:
	var f: Array = []
	var root := Node3D.new()
	tree.root.add_child(root)
	var pm := ProjectileManager.new()
	root.add_child(pm)
	# 1 mm "paper" sheet 25 m away, a 2 cm plywood board at 30 m, a concrete wall at 40 m, a target behind the wall
	var paper := _box(root, Vector3(0.5, 0.5, 0.001), Vector3(0, 1.5, -25.0), 3, "paper", true) as Catcher
	paper.reply = {"stop": false, "speed_scale": 0.99, "fx": false}
	var ply := _box(root, Vector3(2, 2, 0.02), Vector3(0, 1.5, -30.0), 1, "plywood")
	var wall := _box(root, Vector3(4, 4, 0.2), Vector3(0, 1.5, -40.0), 1, "concrete")
	var behind := _box(root, Vector3(1, 1, 0.01), Vector3(0, 1.5, -45.0), 3, "steel", true) as Catcher
	await tree.physics_frame
	await tree.physics_frame
	var recs: Array = []
	pm.bullet_finished.connect(func(r): recs.append(r))
	# --- straight through the paper centre
	pm.fire(Vector3(0, 1.5, 0), Vector3.FORWARD, 346.0, 1)
	await _fly(tree, pm)
	if paper.hits.size() != 1:
		f.append("1 mm sheet at 25 m must register exactly one hit (got %d): no tunnelling at 346 m/s" % paper.hits.size())
	else:
		var h: Dictionary = paper.hits[0]
		if absf((h["position"] as Vector3).z + 24.9995) > 0.002:
			f.append("paper hit not on its front face: z=%f" % (h["position"] as Vector3).z)
		if absf(float(h["tof"]) - 0.0742) > 0.004:
			f.append("time of flight to 25 m = %f s" % h["tof"])
		var drop := Ballistics.solve_at(25.0, 346.0, WeaponDef.BC_G1, 0.0, 0.0)
		if absf((h["position"] as Vector3).y - (1.5 + float(drop["y"]))) > 0.002:
			f.append("hit height disagrees with the ballistic table by %f m" % ((h["position"] as Vector3).y - 1.5 - float(drop["y"])))
	if recs.size() != 1:
		f.append("bullet did not finish")
	else:
		var surf := (recs[0]["hits"] as Array).map(func(x): return x["surface"])
		if surf != ["paper", "plywood", "concrete"]:
			f.append("expected paper -> plywood -> concrete, got %s" % str(surf))
		var hs: Array = recs[0]["hits"]
		if hs.size() == 3 and not (float(hs[1]["speed"]) < float(hs[0]["speed"]) and float(hs[2]["speed"]) < float(hs[1]["speed"]) * 0.9):
			f.append("speed must fall through paper and plywood: %s" % str(hs.map(func(x): return x["speed"])))
	if behind.hits.size() != 0:
		f.append("a target behind the concrete wall was hit")
	# --- edges: 1 mm inside / outside the sheet edge (sheet spans x = -0.25 .. 0.25)
	paper.hits.clear()
	pm.fire(Vector3(0.249, 1.6, -20), Vector3.FORWARD, 340.0, 2)
	pm.fire(Vector3(0.251, 1.6, -20), Vector3.FORWARD, 340.0, 3)
	await _fly(tree, pm)
	if paper.hits.size() != 1 or int(paper.hits[0]["shot_index"]) != 2:
		f.append("edge test: only the shot 1 mm inside the edge may hit (hits: %s)" % str(paper.hits.map(func(x): return x["shot_index"])))
	# --- oblique shot through the thin sheet still registers
	paper.hits.clear()
	pm.fire(Vector3(-20.0, 1.5, -5.02), Vector3(20.0, 0.0, -19.98).normalized(), 346.0, 4)
	await _fly(tree, pm)
	if paper.hits.size() != 1:
		f.append("oblique shot through the sheet missed (hits %d)" % paper.hits.size())
	# --- firing from inside contact distance of a wall stops at the wall
	recs.clear()
	pm.fire(Vector3(0, 1.5, -39.85), Vector3.FORWARD, 346.0, 5)
	await _fly(tree, pm)
	if recs.size() != 1 or (recs[0]["hits"] as Array).size() != 1 or recs[0]["hits"][0]["surface"] != "concrete":
		f.append("muzzle 5 cm from a wall must hit that wall")
	# --- a stopping handler ends the bullet
	behind.hits.clear()
	recs.clear()
	pm.fire(Vector3(0, 1.5, -42.0), Vector3.FORWARD, 346.0, 6)
	await _fly(tree, pm)
	if behind.hits.size() != 1 or recs.size() != 1 or (recs[0]["hits"] as Array).size() != 1:
		f.append("steel catcher should stop the bullet with one hit")
	elif absf(float(behind.hits[0]["energy"]) - 0.5 * WeaponDef.BULLET_MASS * pow(float(behind.hits[0]["speed"]), 2.0)) > 0.01:
		f.append("hit energy inconsistent with speed")
	# --- nothing left flying, bounded history
	for i in 100:
		pm.fire(Vector3(0, 1.5, -42.0), Vector3.FORWARD, 346.0, 100 + i)
	await _fly(tree, pm)
	if not pm.active.is_empty() or pm.history.size() > pm.history_limit:
		f.append("projectile bookkeeping not bounded (active %d, history %d)" % [pm.active.size(), pm.history.size()])
	root.queue_free()
	return f
